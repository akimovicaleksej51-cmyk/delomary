// Serverless function (Vercel Node.js runtime).
// Password-protected endpoint behind the admin panel (admin.html). Every
// request — GET or POST — must include the header:
//   X-Admin-Password: <the same value as the ADMIN_PASSWORD env var>
// Requests without a matching header get 401 and nothing else runs. Wrong
// passwords are rate-limited per IP (see ../_ratelimit.js, shared with
// api/admin/login.js) — after too many failures in a row, requests get 429
// for a while regardless of the password given.
//
// GET  → returns every booking AND history entry (customer or technical) in
//         the booking window, oldest first, full details included (name,
//         phone, players, price, comment...). Each item carries a `status`
//         of 'active' | 'cancelled' | 'rescheduled' and a unique `id`, so the
//         panel can show what actually happened at a slot instead of just
//         what's booked right now — a cancelled or rescheduled record stays
//         visible at its original date/time instead of disappearing.
// POST → body.action selects what to do:
//   { action:'create', dateISO, time, comment }
//       Creates a "technical" booking (blocks the slot, no customer info).
//   { action:'cancel', dateISO, time }
//       Removes a booking, freeing the slot again. The removed record is
//       kept in a separate history hash (see below) instead of being lost.
//   { action:'edit', dateISO, time, name, phone, players, price, comment }
//       Updates a booking's details in place (same date/time).
//   { action:'setCallStatus', dateISO, time, callStatus }
//       Отмечает, прозвонили ли клиента для подтверждения брони.
//       callStatus — одно из 'called' (прозвонили), 'no_answer' (не
//       подняли) или '' (сброс — считается, что ещё не прозвонили).
//       Ничего больше в брони не меняет. Отсутствие поля callStatus у
//       брони равносильно '' — так все брони, созданные до этой функции,
//       по умолчанию считаются непрозвоненными без отдельной миграции.
//   { action:'reschedule', fromDateISO, fromTime, toDateISO, toTime }
//       Moves a booking to a different date/time (fails with 409 if the
//       new slot is already taken). The vacated slot isn't just deleted —
//       it's recorded in history as 'rescheduled', with rescheduledTo
//       pointing at the new date/time, so the move stays visible in the
//       panel. The new slot's record carries a matching rescheduledFrom.
//   { action:'cancelCloseout', dateISO, time }
//       Undoes an ALREADY-COMPLETED sverka (closeoutStatus 'confirmed' or
//       'edited') — clears closeoutStatus, the per-performer send-tracking,
//       payCash/payCard/payErip, closeoutCashCollected/RepliedAt,
//       paymentReportedBy, workedActor/workedActress and discountNote, so
//       the booking looks like sverka never happened. Does NOT touch price/
//       players/comment (real booking data) and does NOT re-schedule the
//       automatic QStash job — use "Сверка сейчас" in Смены и напоминания
//       afterwards to actually resend it.
//   { action:'manualCloseout', dateISO, time, played, price, players,
//     discountNote, payCash, payCard, payErip, confirmedBy }
//       РУЧНАЯ СВЕРКА (staff.html) — с 16.09.2026 сверка через Telegram-бота
//       отключена (см. BOT_CLOSEOUT_ENABLED в api/_closeout.js); вместо неё
//       сотрудник сам отмечает в панели, состоялась ли игра (played), и
//       вписывает актуальные цену/число игроков, скидку и способ оплаты.
//       Первый раз, когда для этой брони проводится сверка, ИСХОДНЫЕ
//       price/players замораживаются в manualCloseout.priceBefore/
//       playersBefore, чтобы позже показать стрелку "было → стало" — даже
//       если сверку потом ещё раз поправят. discountNote/payCash/payCard/
//       payErip такой стрелки не получают — они просто перезаписываются,
//       как в обычном редактировании брони (и НЕ откатываются кнопкой
//       «Сбросить сверку» — только price/players).
//       Если played=false, ни одно из этих полей не трогается (нечего
//       сверять).
//       См. setManualCloseout() в api/_closeout.js.
//   { action:'cancelManualCloseout', dateISO, time }
//       Отменяет ручную сверку: возвращает price/players к значениям ДО
//       сверки (если они менялись) и убирает manualCloseout с брони, чтобы
//       сотрудник мог провести её заново. Скидку и способ оплаты, введённые
//       во время сверки, не трогает — см. setManualCloseout() выше.
//       См. cancelManualCloseout().
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
// Cancelled AND rescheduled bookings move to a parallel HASH at
// "history:<ISO date>" instead of being deleted outright, so what happened
// at a slot can still be looked up later (and so stats aggregation has
// something to count). Each history field is keyed "<time>@<ms-timestamp>"
// (rather than plain "<time>") so cancelling/rescheduling and re-booking the
// same slot more than once on the same date doesn't overwrite an earlier
// history entry. A history record's own `status` field says which of the two
// it was.
//
// A booking created or cancelled here is also forwarded to Telegram, same as
// public bookings from api/book.js, so nothing done in the admin panel goes
// unnoticed there. Uses the same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env
// vars as api/book.js; if they're not set, the action still completes — the
// Telegram step is just skipped.

import { kv, kvPipeline, pairsToObject, isKvConfigured } from '../_kv.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel, safeEqual } from '../_ratelimit.js';
import { scheduleReminder, cancelReminder, stripReminderFields } from '../_reminders.js';
import { scheduleGameCloseout, cancelGameCloseout, stripCloseoutFields, setManualCloseout, cancelManualCloseout } from '../_closeout.js';
import { toAmount } from '../_finance.js';
import { businessToday, businessDateTime } from '../_time.js';

// Was 3 (just enough buffer for very recent ACTIVE bookings) until
// 22.09.2026 — with the new "Проведённые" tab (see admin.html/staff.html),
// active bookings whose date has already passed still need to be readable
// well past 3 days, or they'd fall out of the query window and just
// disappear from the panel entirely (looked exactly like the booking had
// been deleted, even though the Redis record was still there — this is
// what the owner reported as "active bookings vanish"). Matches
// HISTORY_WINDOW_DAYS_BACK below so a conducted booking stays visible for
// as long as a cancelled/rescheduled one does; SLOT_TTL_SECONDS (90 days)
// is still the hard ceiling either way, since Redis actually deletes the
// underlying record after that.
const WINDOW_DAYS_BACK = 60;
const WINDOW_DAYS_AHEAD = 65;
const HISTORY_WINDOW_DAYS_BACK = 60; // cancelled/rescheduled entries are worth looking up further back
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
  const today = businessToday();
  const dates = [];
  for (let i = -WINDOW_DAYS_BACK; i < WINDOW_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }
  return dates;
}

function historyWindowDates() {
  const today = businessToday();
  const dates = [];
  for (let i = -HISTORY_WINDOW_DAYS_BACK; i < WINDOW_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }
  return dates;
}

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && typeof provided === 'string' && safeEqual(provided, adminPassword);
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

// 22.09.2026: no longer backslash-escapes anything, and sendTelegram()
// below sends plain text (no parse_mode) — the old escaping was written
// for MarkdownV2's reserved-character set, but every call here actually
// used the LEGACY 'Markdown' mode, which has no backslash-escape mechanism
// at all. The result: a stray literal backslash in real notifications
// (e.g. a date rendered as "2026\-09\-28"). Plain text needs no escaping,
// so this is now just a passthrough — kept as a named function so each
// call site's "this might be someone else's text" intent stays visible.
function escapeMd(s) {
  return String(s);
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
      body: JSON.stringify({ chat_id: chatId, text }), // plain text — see the escapeMd() comment above
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
      // Phone stays unescaped — see the comment next to it in api/book.js —
      // so Telegram still recognizes it as a tappable/copyable number.
      `📞 Телефон: ${record.phone}`,
      record.players ? `👥 Игроков: ${escapeMd(record.players)}` : null,
      dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
      record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
      record.price ? `💰 Цена: ${escapeMd(record.price)} Br` : null,
      record.comment ? `💬 Комментарий: ${escapeMd(record.comment)}` : null,
    ].filter(Boolean).join('\n');
    text = `🩺 Новая бронь — из админки\n\n${fields}`;
  } else {
    const fields = [
      dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
      record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
      record.comment ? `💬 Комментарий: ${escapeMd(record.comment)}` : null,
    ].filter(Boolean).join('\n');
    text = `🔧 Техническая бронь — из админки\n\n${fields}`;
  }

  await sendTelegram(text, 'admin create');
}

async function notifyTelegramCancel(record) {
  const dateLabelText = record.dateISO ? formatDateLabel(record.dateISO) : '';
  const fields = [
    record.type === 'customer' && record.name ? `👤 Имя: ${escapeMd(record.name)}` : null,
    record.type === 'customer' && record.phone ? `📞 Телефон: ${record.phone}` : null,
    dateLabelText ? `📅 Дата: ${escapeMd(dateLabelText)}` : null,
    record.time ? `🕒 Время: ${escapeMd(record.time)}` : null,
  ].filter(Boolean).join('\n');
  const kind = record.type === 'customer' ? 'Бронь отменена' : 'Техническая бронь снята';
  await sendTelegram(`❌ ${kind}\n\n${fields}`, 'admin cancel');
}

async function notifyTelegramReschedule(record, fromDateISO, fromTime, toDateISO, toTime) {
  const fromLabel = formatDateLabel(fromDateISO);
  const toLabel = formatDateLabel(toDateISO);
  const fields = [
    record.type === 'customer' && record.name ? `👤 Имя: ${escapeMd(record.name)}` : null,
    record.type === 'customer' && record.phone ? `📞 Телефон: ${record.phone}` : null,
    `📅 Было: ${escapeMd(fromLabel)} в ${escapeMd(fromTime)}`,
    `📅 Стало: ${escapeMd(toLabel)} в ${escapeMd(toTime)}`,
  ].filter(Boolean).join('\n');
  const kind = record.type === 'customer' ? 'Бронь перенесена' : 'Техническая бронь перенесена';
  await sendTelegram(`🔁 ${kind}\n\n${fields}`, 'admin reschedule');
}

async function notifyTelegramDayAction(dateISO, kindLabel, count) {
  const dateLabelText = formatDateLabel(dateISO);
  await sendTelegram(`🗓 ${escapeMd(kindLabel)}\n\n📅 Дата: ${escapeMd(dateLabelText)}\nСлотов: ${count}`, 'admin day action');
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
    const bookingDates = windowDates();
    const historyDates = historyWindowDates();

    const [bookingResults, historyResults] = await Promise.all([
      kvPipeline(bookingDates.map((iso) => ['HGETALL', `bookings:${iso}`])),
      kvPipeline(historyDates.map((iso) => ['HGETALL', `history:${iso}`])),
    ]);

    const bookings = [];

    (bookingResults || []).forEach((entry, i) => {
      const obj = pairsToObject(entry && entry.result);
      Object.entries(obj).forEach(([time, raw]) => {
        try {
          const record = JSON.parse(raw);
          const dateISO = record.dateISO || bookingDates[i];
          const recordTime = record.time || time;
          bookings.push({
            ...record,
            dateISO,
            time: recordTime,
            status: 'active',
            id: `active:${dateISO}:${recordTime}`,
          });
        } catch {
          // Skip a malformed entry instead of failing the whole list.
        }
      });
    });

    (historyResults || []).forEach((entry, i) => {
      const obj = pairsToObject(entry && entry.result);
      Object.entries(obj).forEach(([field, raw]) => {
        try {
          const record = JSON.parse(raw);
          const dateISO = record.dateISO || historyDates[i];
          bookings.push({
            ...record,
            dateISO,
            time: record.time || field.split('@')[0],
            status: record.status === 'rescheduled' ? 'rescheduled' : 'cancelled',
            id: `history:${dateISO}:${field}`,
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
          players: body.players != null ? String(body.players).trim().slice(0, 40) : '',
          price: body.price != null ? String(body.price).trim().slice(0, 20) : '',
          // Payment breakdown, booking source/channel, and who worked the
          // session are normally filled in later via the "edit" action
          // (after the game, once the admin actually knows them) — see the
          // Касса feature. Left blank here so creating a booking from the
          // admin panel behaves exactly as it always did.
          payCash: '',
          payCard: '',
          payErip: '',
          channel: '',
          discountNote: '',
          workedActor: '',
          workedActress: '',
          handledByAdmin: '',
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
      // 23.09.2026: `added` is also `null` if KV IS connected but this
      // write failed/timed out — that used to be silently treated as
      // success (the code just carried on to notifyTelegram() and returned
      // ok:true below) even though nothing was actually saved. See the
      // matching fix + explanation in api/book.js.
      if (added === null && isKvConfigured()) {
        return res.status(503).json({ error: 'Не удалось сохранить — временные неполадки с базой данных. Попробуйте ещё раз.' });
      }
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      await notifyTelegram(record);

      let finalRecord = record;
      if (isCustomer) {
        const [reminderPatch, closeoutPatch] = await Promise.all([
          scheduleReminder(record),
          scheduleGameCloseout(record),
        ]);
        const patch = { ...reminderPatch, ...closeoutPatch };
        if (Object.keys(patch).length) {
          finalRecord = { ...record, ...patch };
          await kv('hset', hashKey, cleanTime, JSON.stringify(finalRecord));
        }
      }

      return res.status(200).json({ ok: true, booking: finalRecord });
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
          await Promise.all([cancelReminder(existing), cancelGameCloseout(existing)]);
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

    if (action === 'cancelCloseout') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hget', hashKey, cleanTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена.' });
      }
      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = null; }
      if (!existing) {
        return res.status(400).json({ error: 'Повреждённая запись брони.' });
      }
      if (existing.type !== 'customer') {
        return res.status(400).json({ error: 'Это не клиентская бронь.' });
      }
      if (existing.closeoutStatus !== 'confirmed' && existing.closeoutStatus !== 'edited') {
        return res.status(400).json({ error: 'По этой брони ещё нет завершённой сверки — отменять нечего.' });
      }

      const {
        closeoutStatus, closeouts, payCash, payCard, payErip,
        closeoutCashCollected, closeoutRepliedAt, paymentReportedBy,
        workedActor, workedActress, discountNote,
        ...rest
      } = existing;
      await kv('hset', hashKey, cleanTime, JSON.stringify(rest));

      return res.status(200).json({ ok: true });
    }

    if (action === 'manualCloseout') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }
      const played = body.played !== false;
      const price = typeof body.price === 'string' || typeof body.price === 'number' ? String(body.price).trim() : '';
      const players = typeof body.players === 'string' || typeof body.players === 'number' ? String(body.players).trim() : '';
      const confirmedBy = typeof body.confirmedBy === 'string' ? body.confirmedBy.trim().slice(0, 80) : '';
      const discountNote = typeof body.discountNote === 'string' ? body.discountNote.trim().slice(0, 200) : undefined;
      const payCash = typeof body.payCash === 'string' || typeof body.payCash === 'number' ? String(body.payCash).trim() : undefined;
      const payCard = typeof body.payCard === 'string' || typeof body.payCard === 'number' ? String(body.payCard).trim() : undefined;
      const payErip = typeof body.payErip === 'string' || typeof body.payErip === 'number' ? String(body.payErip).trim() : undefined;

      const result = await setManualCloseout(cleanDateISO, cleanTime, { played, price, players, discountNote, payCash, payCard, payErip, confirmedBy });
      if (!result.ok) {
        const status = result.reason === 'no-booking' ? 404 : 400;
        return res.status(status).json({ error: result.message });
      }
      return res.status(200).json({ ok: true, booking: result.booking });
    }

    if (action === 'cancelManualCloseout') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }
      const result = await cancelManualCloseout(cleanDateISO, cleanTime);
      if (!result.ok) {
        const status = result.reason === 'no-booking' ? 404 : 400;
        return res.status(status).json({ error: result.message });
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

      const nextPlayers = body.players != null ? String(body.players).trim().slice(0, 40) : existing.players;

      // The admin panel's edit form sends the cash/card/ERIP breakdown
      // instead of a single price — the total is derived from it here so
      // there's only ever one place ("Касса") that reads payment amounts
      // off a booking. If the breakdown comes back all-empty (e.g. a
      // booking created before this feature existed, whose fields were
      // never touched), the previous single `price` is kept as-is instead
      // of being wiped to 0.
      const nextPayCash = body.payCash != null ? String(body.payCash).trim().slice(0, 20) : (existing.payCash || '');
      const nextPayCard = body.payCard != null ? String(body.payCard).trim().slice(0, 20) : (existing.payCard || '');
      const nextPayErip = body.payErip != null ? String(body.payErip).trim().slice(0, 20) : (existing.payErip || '');
      const paySum = toAmount(nextPayCash) + toAmount(nextPayCard) + toAmount(nextPayErip);
      const nextPrice = paySum > 0 ? String(paySum) : existing.price;

      let updated = {
        ...existing,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : existing.name,
        phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : existing.phone,
        players: nextPlayers,
        price: nextPrice,
        payCash: nextPayCash,
        payCard: nextPayCard,
        payErip: nextPayErip,
        channel: typeof body.channel === 'string' ? body.channel.trim().slice(0, 60) : (existing.channel || ''),
        discountNote: typeof body.discountNote === 'string' ? body.discountNote.trim().slice(0, 200) : (existing.discountNote || ''),
        workedActor: typeof body.workedActor === 'string' ? body.workedActor.trim().slice(0, 60) : (existing.workedActor || ''),
        workedActress: typeof body.workedActress === 'string' ? body.workedActress.trim().slice(0, 60) : (existing.workedActress || ''),
        handledByAdmin: typeof body.handledByAdmin === 'string' ? body.handledByAdmin.trim().slice(0, 60) : (existing.handledByAdmin || ''),
        comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : existing.comment,
      };

      // The reminder text includes the player count — if it changed and a
      // reminder was already scheduled, cancel the stale one and schedule a
      // fresh one so the actor sees the right number.
      if (updated.type === 'customer' && nextPlayers !== existing.players) {
        await cancelReminder(existing);
        const reminderPatch = await scheduleReminder(stripReminderFields(updated));
        updated = { ...stripReminderFields(updated), ...reminderPatch };
      }

      const editSaved = await kv('hset', hashKey, cleanTime, JSON.stringify(updated));
      // 23.09.2026: this hset's result was never checked — a failed/timed-
      // out write (KV connected but this one call errored) looked exactly
      // like a successful edit to the admin: "ok:true" with the new data,
      // while the OLD record was still what's actually stored. The next
      // page load would then show the edit as silently reverted with no
      // error ever having been shown. See the matching fix in api/book.js.
      if (editSaved === null && isKvConfigured()) {
        return res.status(503).json({ error: 'Не удалось сохранить изменения — временные неполадки с базой данных. Попробуйте ещё раз.' });
      }
      return res.status(200).json({ ok: true, booking: updated });
    }

    if (action === 'setCallStatus') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      const ALLOWED_CALL_STATUSES = ['called', 'no_answer', ''];
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }
      if (!ALLOWED_CALL_STATUSES.includes(body.callStatus)) {
        return res.status(400).json({ error: 'Некорректный статус звонка.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hget', hashKey, cleanTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена — возможно, её уже отменили.' });
      }

      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = null; }
      if (!existing) {
        return res.status(404).json({ error: 'Бронь не найдена.' });
      }

      const updated = { ...existing, callStatus: body.callStatus };
      const callStatusSaved = await kv('hset', hashKey, cleanTime, JSON.stringify(updated));
      if (callStatusSaved === null && isKvConfigured()) {
        return res.status(503).json({ error: 'Не удалось сохранить — временные неполадки с базой данных. Попробуйте ещё раз.' });
      }
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

      // A moved booking may now fall under a different (or no) shift, so
      // the old reminder AND the old per-game sverka — if either was
      // scheduled — are cancelled outright; fresh ones get scheduled below
      // for the new date/time.
      await Promise.all([cancelReminder(existing), cancelGameCloseout(existing)]);

      let updated = {
        ...stripCloseoutFields(stripReminderFields(existing)),
        dateISO: toDateISO,
        time: toTime,
        rescheduledFrom: { dateISO: fromDateISO, time: fromTime },
      };

      const added = await kv('hsetnx', toKey, toTime, JSON.stringify(updated));
      if (added === 0) {
        return res.status(409).json({ error: 'Это время уже занято — выберите другое.' });
      }
      if (added === null && isKvConfigured()) {
        return res.status(503).json({ error: 'Не удалось перенести бронь — временные неполадки с базой данных. Попробуйте ещё раз.' });
      }
      await kv('expire', toKey, SLOT_TTL_SECONDS);

      // 23.09.2026: the old slot used to only be freed (hdel, below) AFTER
      // scheduling the new reminder/closeout and writing the history
      // record — both of which are extra network calls that can fail or
      // time out. If any of them did, the booking was left sitting at BOTH
      // the old and new slot at once: still fully occupying `fromKey`
      // (blocking it for everyone else) while also now live at `toKey`,
      // and — since sumCashInForDates()/report.js's ingestRecord() count
      // every 'customer' record across bookings:* AND history:* with no
      // special-casing — its price/cash would double-count in Касса and
      // Финансы too, on top of the phantom double booking. Freeing the old
      // slot right away, before any of those later steps, means a failure
      // further down can no longer leave the booking in two places.
      await kv('hdel', fromKey, fromTime);

      if (updated.type === 'customer') {
        const [reminderPatch, closeoutPatch] = await Promise.all([
          scheduleReminder(updated),
          scheduleGameCloseout(updated),
        ]);
        const patch = { ...reminderPatch, ...closeoutPatch };
        if (Object.keys(patch).length) {
          updated = { ...updated, ...patch };
          await kv('hset', toKey, toTime, JSON.stringify(updated));
        }
      }

      // The vacated slot isn't just deleted — it's kept in history as
      // 'rescheduled' (same idea as a cancellation) so the move itself
      // stays visible: whoever looks at the old date/time can see it was
      // moved, and to where.
      const rescheduledAt = new Date().toISOString();
      const historyRecord = {
        ...existing,
        status: 'rescheduled',
        rescheduledAt,
        rescheduledTo: { dateISO: toDateISO, time: toTime },
      };
      const historyKey = `history:${fromDateISO}`;
      const historyField = `${fromTime}@${Date.now()}`;
      await kv('hset', historyKey, historyField, JSON.stringify(historyRecord));
      await kv('expire', historyKey, HISTORY_TTL_SECONDS);
      // (the old slot itself was already freed right after the new slot was
      // reserved, above — see the 23.09.2026 comment there)

      await notifyTelegramReschedule(existing, fromDateISO, fromTime, toDateISO, toTime);

      return res.status(200).json({ ok: true, booking: updated });
    }

    if (action === 'stats') {
      const STATS_DAYS_BACK = 60;
      const STATS_DAYS_FORWARD = 30;
      const CHART_DAYS = 21;

      const today = businessToday();
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
          // hh:mm is Minsk wall-clock time — businessDateTime() converts it
          // to the correct absolute instant instead of letting the server's
          // own (UTC) clock reinterpret those numbers as UTC.
          const sessionEnd = businessDateTime(dISO, hh || 0, (mm || 0) + 60);

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

    if (action === 'resetAllData') {
      // ЕДИНОРАЗОВАЯ полная очистка тестовых данных перед стартом работы с
      // реальными бронями (по просьбе владельца, 22.09.2026). Стирает:
      //   - bookings:*          — все текущие брони (клиентские и
      //                           технические), на всех датах, не только в
      //                           обычном окне windowDates() — ищет ключи
      //                           через SCAN, чтобы не оставить "хвостов"
      //                           за пределами обычного окна показа.
      //   - history:*           — весь журнал отмен и переносов.
      //   - cashouts:*          — все расходы/инкассации кассы.
      //   - cashRegisterOpening — точка отсчёта кассы; после удаления
      //                           баланс снова считается от 0, как будто
      //                           кассу никогда не открывали.
      // НЕ трогает: shifts:* (расписание смен актёров/актрис) и actors
      // (привязка их Telegram-аккаунтов к боту) — это не "брони" и не
      // "расчёты", а рабочая инфраструктура, которую стирать не просили.
      // Кнопка есть только в admin.html (не в staff.html) — это решение
      // владельца, не сотрудников.
      //
      // Требует точного подтверждения (body.confirm === 'ОЧИСТИТЬ'), чтобы
      // случайный повторный вызов этого действия не мог снести уже реальные
      // брони после того, как сайт заработает вживую — обычного "Да/Нет" в
      // таком необратимом действии недостаточно.
      if (body.confirm !== 'ОЧИСТИТЬ') {
        return res.status(400).json({ error: 'Требуется подтверждение.' });
      }

      async function scanAllKeys(pattern) {
        let cursor = '0';
        const keys = [];
        let guard = 0;
        do {
          const result = await kv('scan', cursor, 'match', pattern, 'count', 1000);
          if (!Array.isArray(result)) break;
          cursor = String(result[0]);
          const found = Array.isArray(result[1]) ? result[1] : [];
          keys.push(...found);
          guard += 1;
        } while (cursor !== '0' && guard < 1000); // guard: never loop forever on an unexpected SCAN reply
        return keys;
      }

      const [bookingKeys, historyKeys, cashoutKeys] = await Promise.all([
        scanAllKeys('bookings:*'),
        scanAllKeys('history:*'),
        scanAllKeys('cashouts:*'),
      ]);

      const allKeys = [...bookingKeys, ...historyKeys, ...cashoutKeys, 'cashRegisterOpening'];
      // DEL in chunks rather than one giant command — normal data volumes
      // here are small, but there's no reason to risk a single oversized
      // request over it.
      const CHUNK = 200;
      for (let i = 0; i < allKeys.length; i += CHUNK) {
        const chunk = allKeys.slice(i, i + CHUNK);
        if (chunk.length) await kv('del', ...chunk);
      }

      return res.status(200).json({
        ok: true,
        deletedBookingKeys: bookingKeys.length,
        deletedHistoryKeys: historyKeys.length,
        deletedCashoutKeys: cashoutKeys.length,
      });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
