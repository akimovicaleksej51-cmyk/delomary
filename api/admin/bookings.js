// Serverless function (Vercel Node.js runtime).
// Password-protected endpoint behind the admin panel (admin.html). Every
// request — GET or POST — must include the header:
//   X-Admin-Password: <the same value as the ADMIN_PASSWORD env var>
// Requests without a matching header get 401 and nothing else runs. Wrong
// passwords are rate-limited per IP (see ../_ratelimit.js, shared with
// api/admin/login.js) — after too many failures in a row, requests get 429
// for a while regardless of the password given.
//
// GET  → returns every booking (customer or technical) in the booking
//         window, oldest first, full details included (name, phone,
//         players, price, comment...).
// POST → body.action selects what to do:
//   { action:'create', dateISO, time, comment }
//       Creates a "technical" booking (blocks the slot, no customer info).
//   { action:'cancel', dateISO, time }
//       Removes a booking, freeing the slot again. The removed record is
//       kept in a separate history hash (see below) instead of being lost.
//   { action:'edit', dateISO, time, name, phone, players, price, comment }
//       Updates a booking's details in place (same date/time).
//   { action:'reschedule', fromDateISO, fromTime, toDateISO, toTime }
//       Moves a booking to a different date/time (fails with 409 if the
//       new slot is already taken).
//   { action:'blockDay', dateISO, comment }
//       Blocks every slot on a date that isn't already taken by a customer
//       (fills in "technical" bookings for the gaps). Existing customer
//       bookings on that date are left alone.
//   { action:'unblockDay', dateISO }
//       Removes every "technical" booking on a date, leaving customer
//       bookings untouched.
//   { action:'stats' }
//       Aggregates customer bookings + cancellation history over a rolling
//       window (60 days back, 30 forward — bounded by SLOT_TTL_SECONDS /
//       HISTORY_TTL_SECONDS, since anything older has already expired out of
//       Redis) into totals (completed / cancelled / upcoming / technical),
//       a cancellation rate, a site-vs-admin split, and a day-by-day series
//       for the last 21 days for the admin stats dashboard.
//
// Data model: each date has a Redis HASH at key "bookings:<ISO date>", one
// field per booked time, whose value is a JSON string with the full
// booking record. See api/book.js for how customer bookings are created,
// and api/slots.js for the public (PII-free) read side.
//
// Cancelled bookings move to a parallel HASH at "history:<ISO date>" instead
// of being deleted outright, so a cancellation can still be looked up later
// (and so api/admin/stats-style aggregation has something to count). Each
// history field is keyed "<time>@<cancelledAt-ms>" (rather than plain
// "<time>") so cancelling and re-booking the same slot more than once on the
// same date doesn't overwrite an earlier history entry.
//
// A booking created or cancelled here is also forwarded to Telegram, same as
// public bookings from api/book.js, so nothing done in the admin panel goes
// unnoticed there. Uses the same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env
// vars as api/book.js; if they're not set, the action still completes — the
// Telegram step is just skipped.

import { kv, kvPipeline, pairsToObject } from '../_kv.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';

const WINDOW_DAYS_BACK = 3; // small buffer so very recent bookings stay visible
const WINDOW_DAYS_AHEAD = 65;
const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 95; // slightly outlives SLOT_TTL_SECONDS
const SLOTS = ['11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00', '21:30', '23:00'];

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function windowDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = -WINDOW_DAYS_BACK; i < WINDOW_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }
  return dates;
}

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && provided === adminPassword;
}

function isValidDateISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTime(s) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 20;
}

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateLabel(iso) {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}, ${WEEKDAY_NAMES[d.getDay()]}`;
}

function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Best-effort notification for a booking created from the admin panel. Unlike
// the public api/book.js flow (where Telegram IS the record, so a failure
// there rolls back the reservation), the admin already sees the booking in
// the panel the moment it's created — so a Telegram hiccup here is only
// logged, never allowed to fail the request or undo the booking.
async function sendTelegram(text, label) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    const tgData = await tgRes.json().catch(() => ({}));
    if (!tgData.ok) {
      console.error(`Telegram API error (${label}):`, tgData);
    }
  } catch (err) {
    console.error(`Failed to reach Telegram API (${label}):`, err);
  }
}

async function notifyTelegram(record) {
  const dateLabelText = record.dateISO ? formatDateLabel(record.dateISO) : '';
  let text;

  if (record.type === 'customer') {
    const fields = [
      `👤 Имя: ${escapeMd(record.name)}`,
      `📞 Телефон: ${escapeMd(record.phone)}`,
      record.players ? `👥 Игроков: ${escapeMd(record.players)}` : null,
      dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
      record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
      record.price ? `💰 Цена: ${escapeMd(record.price)} Br` : null,
      record.comment ? `💬 Комментарий: ${escapeMd(record.comment)}` : null,
    ].filter(Boolean).join('\n');
    text = `🩺 *Новая бронь — из админки*\n\n${fields}`;
  } else {
    const fields = [
      dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
      record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
      record.comment ? `💬 Комментарий: ${escapeMd(record.comment)}` : null,
    ].filter(Boolean).join('\n');
    text = `🔧 *Техническая бронь — из админки*\n\n${fields}`;
  }

  await sendTelegram(text, 'admin create');
}

async function notifyTelegramCancel(record) {
  const dateLabelText = record.dateISO ? formatDateLabel(record.dateISO) : '';
  const fields = [
    record.type === 'customer' && record.name ? `👤 Имя: ${escapeMd(record.name)}` : null,
    record.type === 'customer' && record.phone ? `📞 Телефон: ${escapeMd(record.phone)}` : null,
    dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
    record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
  ].filter(Boolean).join('\n');
  const kind = record.type === 'customer' ? 'Бронь отменена' : 'Техническая бронь снята';
  await sendTelegram(`❌ *${kind}*\n\n${fields}`, 'admin cancel');
}

async function notifyTelegramDayAction(dateISO, kindLabel, count) {
  const dateLabelText = formatDateLabel(dateISO);
  await sendTelegram(`🗓 *${escapeMd(kindLabel)}*\n\n📅 Дата: ${escapeMd(dateLabelText)}\nСлотов: ${count}`, 'admin day action');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const ip = getClientIp(req);
  const rate = await checkRateLimit(ip);
  if (rate.limited) {
    return res.status(429).json({
      error: `Слишком много попыток входа. Попробуйте снова через ${retryAfterMinutesLabel(rate.retryAfterSeconds)}`,
    });
  }

  if (!checkAuth(req)) {
    await recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Неверный пароль.' });
  }
  await clearAttempts(ip);

  if (req.method === 'GET') {
    const dates = windowDates();
    const commands = dates.map((iso) => ['HGETALL', `bookings:${iso}`]);
    const results = await kvPipeline(commands);

    if (!results) {
      return res.status(200).json({ bookings: [] });
    }

    const bookings = [];
    results.forEach((entry, i) => {
      const obj = pairsToObject(entry && entry.result);
      Object.entries(obj).forEach(([time, raw]) => {
        try {
          const record = JSON.parse(raw);
          bookings.push({
            ...record,
            dateISO: record.dateISO || dates[i],
            time: record.time || time,
          });
        } catch {
          // Skip a malformed entry instead of failing the whole list.
        }
      });
    });

    bookings.sort((a, b) => (a.dateISO + a.time).localeCompare(b.dateISO + b.time));

    return res.status(200).json({ bookings });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const { action } = body;

    if (action === 'create') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim().slice(0, 20) : '';
      const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
      const isCustomer = body.type === 'customer';

      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время.' });
      }

      let record;
      if (isCustomer) {
        const cleanName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
        const cleanPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
        if (!cleanName || !cleanPhone) {
          return res.status(400).json({ error: 'Укажите имя и телефон клиента.' });
        }
        record = {
          type: 'customer',
          name: cleanName,
          phone: cleanPhone,
          players: body.players != null ? String(body.players).trim().slice(0, 10) : '',
          price: body.price != null ? String(body.price).trim().slice(0, 20) : '',
          comment: cleanComment,
          dateISO: cleanDateISO,
          dateLabel: '',
          time: cleanTime,
          createdAt: new Date().toISOString(),
          source: 'admin', // created manually from the admin panel, not the public booking form
        };
      } else {
        record = {
          type: 'technical',
          name: 'Техническая бронь',
          phone: '',
          players: '',
          price: '',
          comment: cleanComment,
          dateISO: cleanDateISO,
          dateLabel: '',
          time: cleanTime,
          createdAt: new Date().toISOString(),
        };
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
      if (added === 0) {
        return res.status(409).json({ error: 'Этот слот уже занят.' });
      }
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      await notifyTelegram(record);

      return res.status(200).json({ ok: true, booking: record });
    }

    if (action === 'cancel') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hget', hashKey, cleanTime);
      await kv('hdel', hashKey, cleanTime);

      if (existingRaw) {
        let existing;
        try { existing = JSON.parse(existingRaw); } catch { existing = null; }
        if (existing) {
          const cancelledAt = new Date().toISOString();
          const cancelled = { ...existing, status: 'cancelled', cancelledAt };
          const historyKey = `history:${cleanDateISO}`;
          const historyField = `${cleanTime}@${Date.now()}`;
          await kv('hset', historyKey, historyField, JSON.stringify(cancelled));
          await kv('expire', historyKey, HISTORY_TTL_SECONDS);
          await notifyTelegramCancel(existing);
        }
      }

      return res.status(200).json({ ok: true });
    }

    if (action === 'blockDay') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
      if (!cleanDateISO) {
        return res.status(400).json({ error: 'Укажите дату.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hgetall', hashKey);
      const existing = pairsToObject(existingRaw);

      const toBlock = SLOTS.filter((s) => !existing[s]);
      let blocked = 0;
      for (const time of toBlock) {
        const record = {
          type: 'technical',
          name: 'Техническая бронь',
          phone: '', players: '', price: '',
          comment: cleanComment,
          dateISO: cleanDateISO, dateLabel: '', time,
          createdAt: new Date().toISOString(),
        };
        const added = await kv('hsetnx', hashKey, time, JSON.stringify(record));
        if (added === 1) blocked++;
      }
      if (blocked > 0) {
        await kv('expire', hashKey, SLOT_TTL_SECONDS);
        await notifyTelegramDayAction(cleanDateISO, 'День закрыт из админки', blocked);
      }

      return res.status(200).json({ ok: true, blocked, alreadyTaken: SLOTS.length - toBlock.length });
    }

    if (action === 'unblockDay') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      if (!cleanDateISO) {
        return res.status(400).json({ error: 'Укажите дату.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hgetall', hashKey);
      const existing = pairsToObject(existingRaw);

      let unblocked = 0;
      for (const [time, raw] of Object.entries(existing)) {
        let record;
        try { record = JSON.parse(raw); } catch { record = null; }
        if (record && record.type === 'technical') {
          await kv('hdel', hashKey, time);
          unblocked++;
        }
      }
      if (unblocked > 0) {
        await notifyTelegramDayAction(cleanDateISO, 'День снова открыт из админки', unblocked);
      }

      return res.status(200).json({ ok: true, unblocked });
    }

    if (action === 'edit') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hget', hashKey, cleanTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена — возможно, её уже отменили.' });
      }

      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = {}; }

      const updated = {
        ...existing,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : existing.name,
        phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : existing.phone,
        players: body.players != null ? String(body.players).trim().slice(0, 10) : existing.players,
        price: body.price != null ? String(body.price).trim().slice(0, 20) : existing.price,
        comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : existing.comment,
      };

      await kv('hset', hashKey, cleanTime, JSON.stringify(updated));
      return res.status(200).json({ ok: true, booking: updated });
    }

    if (action === 'reschedule') {
      const fromDateISO = isValidDateISO(body.fromDateISO) ? body.fromDateISO : '';
      const fromTime = isValidTime(body.fromTime) ? body.fromTime.trim() : '';
      const toDateISO = isValidDateISO(body.toDateISO) ? body.toDateISO : '';
      const toTime = isValidTime(body.toTime) ? body.toTime.trim().slice(0, 20) : '';

      if (!fromDateISO || !fromTime || !toDateISO || !toTime) {
        return res.status(400).json({ error: 'Укажите текущие и новые дату и время.' });
      }
      if (fromDateISO === toDateISO && fromTime === toTime) {
        return res.status(400).json({ error: 'Новое время совпадает с текущим.' });
      }

      const fromKey = `bookings:${fromDateISO}`;
      const toKey = `bookings:${toDateISO}`;

      const existingRaw = await kv('hget', fromKey, fromTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена — возможно, её уже отменили.' });
      }

      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = {}; }

      const updated = { ...existing, dateISO: toDateISO, time: toTime };

      const added = await kv('hsetnx', toKey, toTime, JSON.stringify(updated));
      if (added === 0) {
        return res.status(409).json({ error: 'Это время уже занято — выберите другое.' });
      }
      await kv('expire', toKey, SLOT_TTL_SECONDS);
      await kv('hdel', fromKey, fromTime);

      return res.status(200).json({ ok: true, booking: updated });
    }

    if (action === 'stats') {
      const STATS_DAYS_BACK = 60;
      const STATS_DAYS_FORWARD = 30;
      const CHART_DAYS = 21;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dates = [];
      for (let i = -STATS_DAYS_BACK; i <= STATS_DAYS_FORWARD; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        dates.push(isoDate(d));
      }

      const [bookingResults, historyResults] = await Promise.all([
        kvPipeline(dates.map((iso) => ['HGETALL', `bookings:${iso}`])),
        kvPipeline(dates.map((iso) => ['HGETALL', `history:${iso}`])),
      ]);

      const now = new Date();
      let completed = 0;
      let upcoming = 0;
      let technical = 0;
      let sourceSite = 0;
      let sourceAdmin = 0;
      const byDayMap = {};
      dates.forEach((iso) => { byDayMap[iso] = { completed: 0, cancelled: 0 }; });

      (bookingResults || []).forEach((entry, i) => {
        const obj = pairsToObject(entry && entry.result);
        Object.entries(obj).forEach(([time, raw]) => {
          let record;
          try { record = JSON.parse(raw); } catch { return; }
          if (record.type === 'technical') { technical++; return; }

          const dISO = record.dateISO || dates[i];
          const recordTime = record.time || time;
          const [hh, mm] = recordTime.split(':').map(Number);
          const [y, m, d] = dISO.split('-').map(Number);
          const sessionEnd = new Date(y, (m || 1) - 1, d || 1, hh || 0, (mm || 0) + 60);

          if (sessionEnd <= now) {
            completed++;
            if (byDayMap[dISO]) byDayMap[dISO].completed++;
          } else {
            upcoming++;
          }
          if (record.source === 'admin') sourceAdmin++; else sourceSite++;
        });
      });

      let cancelled = 0;
      (historyResults || []).forEach((entry, i) => {
        const obj = pairsToObject(entry && entry.result);
        Object.values(obj).forEach((raw) => {
          let record;
          try { record = JSON.parse(raw); } catch { return; }
          if (record.type === 'technical') return; // day open/close isn't a "cancellation" worth counting here
          cancelled++;
          const dISO = record.dateISO || dates[i];
          if (byDayMap[dISO]) byDayMap[dISO].cancelled++;
        });
      });

      const todayIdx = STATS_DAYS_BACK;
      const chartStart = Math.max(0, todayIdx - (CHART_DAYS - 1));
      const byDay = dates.slice(chartStart, todayIdx + 1).map((iso) => ({ dateISO: iso, ...byDayMap[iso] }));

      const decided = completed + cancelled;
      const cancelRate = decided > 0 ? Math.round((cancelled / decided) * 1000) / 10 : 0;

      return res.status(200).json({
        completed, cancelled, upcoming, technical,
        cancelRate, sourceSite, sourceAdmin, byDay,
      });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
