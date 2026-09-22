// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the Мир Квестов aggregator integration. Combines
// what would otherwise be two separate files (a GET "schedule" endpoint and
// a POST "booking" endpoint) into one, since Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions total — see api/internal-jobs.js's
// header comment for the full picture of how this site stayed under that
// cap while adding both the Мир Квестов and ExtraReality integrations.
//
// Give Mir Kvestov exactly ONE URL in their partner setup form (their form
// only has one field for this anyway — same URL, just GET vs POST):
//   https://loonygames.by/api/mirkvestov
//
// ===========================================================================
// GET — "Получение расписания", from Mir Kvestov's own API spec
// (https://mir-kvestov.ru/integration, shared with us as a Google Doc):
// their servers call this URL with a plain GET (no parameters) and expect a
// JSON array covering roughly the next two weeks, one entry per bookable
// time slot.
//
// Fields, per their spec:
//   date      "YYYY-MM-DD"
//   time      "HH:MM" (24-hour)
//   is_free   false if already booked/blocked OR if that time has already
//             passed today — true otherwise
//   price     integer, in Br — see the note below on why this is the
//             CHEAPEST tier's price, not a per-team-size breakdown
//   our_slot_id  optional custom field (allowed by their spec) — not
//             actually relied on by the POST handler below (which
//             re-derives everything from date+time+the DB), just a
//             harmless, spec-legal extra for debugging.
//
// Reuses the exact same source of truth as the site's own public
// api/slots.js: the `bookings:<date>` Redis hash. A slot's key existing
// there means SOMETHING holds it — a real customer booking (any channel)
// or an admin's "blockDay" technical closure — so `is_free` here always
// matches what a visitor on the site itself would see.
//
// NOTE ON PRICING — no per-team-size tariffs (Mir Kvestov's optional
// "Получение тарифов" feature) are implemented here on purpose. The site's
// real price depends on team size (140–240 Br depending on weekday/weekend
// and team size — see api/_pricing.js), but Mir Kvestov's own docs are
// explicit that sending the standard single price here is a complete,
// valid integration on its own. We show the CHEAPEST tier ("от X Br"), and
// — exactly like every other booking channel this site already has — the
// admin panel's existing "Позвонить/подтвердить" workflow is where the
// exact price for that team's size gets confirmed by phone before the
// game.
//
// ===========================================================================
// POST — "Бронирование", from the same spec. Mir Kvestov's servers POST
// here whenever a customer books through mir-kvestov.ru, using
// application/x-www-form-urlencoded (per their own curl example) — Vercel's
// Node runtime parses that into req.body automatically, same as JSON; a
// defensive string-fallback below covers either form just in case.
//
// Incoming fields, per their spec: first_name, family_name, phone, email,
// comment (optional), source (defaults to 'mir-kvestov.ru'), md5 (optional
// signature — see verifySignature below), date, time, price, unique_id,
// and our_slot_id (echoed back from the GET side, unused here).
//
// Required response shapes, per their spec (always HTTP 200 — they read the
// `success` field, not the status code):
//   {"success": true}
//   {"success": false, "message": "..."}
//   {"success": false, "message": "Указанное время занято"}   <- EXACT
//     wording required by their spec for an already-taken slot.
//
// SIGNATURE VERIFICATION (optional per their spec): if the
// MIRKVESTOV_SECRET env var is set, an incoming `md5` field is checked
// against md5(first_name+family_name+phone+email+MIRKVESTOV_SECRET) and the
// request is rejected if it doesn't match. Until that env var is set,
// verification is skipped entirely and the endpoint still works.
//
// Reuses the exact same reservation mechanism as the site's own
// api/book.js (HSETNX on the `bookings:<date>` Redis hash) so a Mir
// Kvestov booking can never double-book a slot the website (or any other
// channel) already holds, and shows up identically in the admin/staff
// panels — tagged channel: 'Мир Квестов'.

import crypto from 'crypto';
import { kv, kvPipeline } from './_kv.js';
import { businessToday, businessDateTime } from './_time.js';
import { SLOTS, startingPriceFor } from './_pricing.js';
import { scheduleReminder } from './_reminders.js';
import { scheduleGameCloseout } from './_closeout.js';
import { sendBookingConfirmationSms } from './_sms.js';

const DAYS_AHEAD = 14; // Mir Kvestov's spec: "расписание на 2 недели"
const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // same retention as every other booking

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function handleTimetable(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const today = businessToday();
  const dates = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  const results = await kvPipeline(dates.map((iso) => ['HKEYS', `bookings:${iso}`]));
  const takenByDate = {};
  if (results) {
    results.forEach((entry, i) => {
      const times = entry && entry.result;
      takenByDate[dates[i]] = Array.isArray(times) ? times : [];
    });
  }

  const now = new Date();
  const out = [];
  for (const dateISO of dates) {
    const taken = takenByDate[dateISO] || [];
    for (const time of SLOTS) {
      const [hh, mm] = time.split(':').map(Number);
      const alreadyPassed = businessDateTime(dateISO, hh, mm).getTime() <= now.getTime();
      out.push({
        date: dateISO,
        time,
        is_free: !alreadyPassed && !taken.includes(time),
        price: startingPriceFor(dateISO, time),
        our_slot_id: `${dateISO}_${time}`,
      });
    }
  }

  return res.status(200).json(out);
}

function parseBody(req) {
  let body = req.body;
  if (body == null) return {};
  if (typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  try {
    return Object.fromEntries(new URLSearchParams(trimmed));
  } catch {
    return {};
  }
}

function verifySignature(body) {
  const secret = process.env.MIRKVESTOV_SECRET;
  if (!secret) return true; // not configured yet — skip check, endpoint still works
  const provided = typeof body.md5 === 'string' ? body.md5.trim().toLowerCase() : '';
  if (!provided) return true; // Mir Kvestov's own spec: sending no md5 at all is allowed
  const source = `${body.first_name || ''}${body.family_name || ''}${body.phone || ''}${body.email || ''}${secret}`;
  const expected = crypto.createHash('md5').update(source, 'utf8').digest('hex');
  return provided === expected;
}

async function handleOrder(req, res) {
  const body = parseBody(req);

  const cleanFirst = typeof body.first_name === 'string' ? body.first_name.trim().slice(0, 60) : '';
  const cleanLast = typeof body.family_name === 'string' ? body.family_name.trim().slice(0, 60) : '';
  const cleanPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
  const cleanEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 100) : '';
  const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  const cleanDateISO = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date.trim()) ? body.date.trim() : '';
  const cleanTime = typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time.trim()) ? body.time.trim() : '';
  const cleanPrice = body.price != null ? String(body.price).slice(0, 20) : '';
  const cleanUniqueId = body.unique_id != null ? String(body.unique_id).slice(0, 100) : '';

  const cleanName = [cleanFirst, cleanLast].filter(Boolean).join(' ').trim();

  if (!cleanName || !cleanPhone || !cleanDateISO || !cleanTime) {
    return res.status(200).json({ success: false, message: 'Не хватает обязательных полей (имя, телефон, дата, время).' });
  }

  if (!verifySignature(body)) {
    return res.status(200).json({ success: false, message: 'Ошибка проверки подписи.' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(200).json({ success: false, message: 'Бронирование временно недоступно, попробуйте позже.' });
  }

  const commentParts = [cleanComment, cleanEmail ? `Email: ${cleanEmail}` : ''].filter(Boolean);

  const record = {
    type: 'customer',
    name: cleanName,
    phone: cleanPhone,
    players: '',
    price: cleanPrice,
    payCash: '',
    payCard: '',
    payErip: '',
    channel: 'Мир Квестов',
    discountNote: '',
    workedActor: '',
    workedActress: '',
    handledByAdmin: '',
    comment: commentParts.join(' · '),
    animator: false,
    dateISO: cleanDateISO,
    dateLabel: '',
    time: cleanTime,
    externalRef: cleanUniqueId ? `mirkvestov:${cleanUniqueId}` : '',
    createdAt: new Date().toISOString(),
  };

  const hashKey = `bookings:${cleanDateISO}`;
  const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
  if (added === 0) {
    return res.status(200).json({ success: false, message: 'Указанное время занято' });
  }
  const reserved = added === 1;

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    `📞 Телефон: ${cleanPhone}`,
    cleanDateISO ? `📅 Дата: ${escapeMd(cleanDateISO)}` : null,
    cleanTime ? `🕒 Время: ${escapeMd(cleanTime)}` : null,
    cleanPrice ? `💰 Цена: ${escapeMd(cleanPrice)} Br` : null,
    cleanComment ? `💬 Комментарий: ${escapeMd(cleanComment)}` : null,
  ].filter(Boolean).join('\n');
  const text = `🩺 *Новая бронь — Мир Квестов*\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      if (reserved) await kv('hdel', hashKey, cleanTime);
      return res.status(200).json({ success: false, message: 'Внутренняя ошибка, попробуйте ещё раз.' });
    }

    if (reserved) {
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      const [reminderPatch, closeoutPatch] = await Promise.all([
        scheduleReminder(record),
        scheduleGameCloseout(record),
      ]);
      const patch = { ...reminderPatch, ...closeoutPatch };
      if (Object.keys(patch).length) {
        await kv('hset', hashKey, cleanTime, JSON.stringify({ ...record, ...patch }));
      }
    }

    await sendBookingConfirmationSms(record);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    if (reserved) await kv('hdel', hashKey, cleanTime);
    return res.status(200).json({ success: false, message: 'Внутренняя ошибка, попробуйте ещё раз.' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleTimetable(req, res);
  if (req.method === 'POST') return handleOrder(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(200).json({ success: false, message: 'Method not allowed' });
}
