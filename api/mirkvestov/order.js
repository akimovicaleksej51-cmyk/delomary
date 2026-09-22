// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the Мир Квестов aggregator integration.
//
// This is the "Бронирование" endpoint from Mir Kvestov's own API spec
// (shared with us as a Google Doc): their servers POST here whenever a
// customer books through mir-kvestov.ru, using
// application/x-www-form-urlencoded (per their own curl example) — Vercel's
// Node runtime parses that into req.body automatically, same as JSON, so no
// special handling is needed for that; a defensive string-fallback below
// covers either form just in case.
//   POST https://loonygames.by/api/mirkvestov/order
//
// Give Mir Kvestov exactly this URL in their partner setup form.
//
// Incoming fields, per their spec: first_name, family_name, phone, email,
// comment (optional), source (defaults to 'mir-kvestov.ru'), md5 (optional
// signature — see verifySignature below), date, time, price, unique_id,
// and our_slot_id (echoed back from api/mirkvestov/timetable.js, unused
// here — date+time is all that's needed to find/reserve the slot).
//
// Required response shapes, per their spec (always HTTP 200 — they read the
// `success` field, not the status code):
//   {"success": true}
//   {"success": false, "message": "..."}
//   {"success": false, "message": "Указанное время занято"}   <- EXACT
//     wording required by their spec for an already-taken slot, so it must
//     never be reworded even for consistency with this site's own Russian.
//
// SIGNATURE VERIFICATION (optional per their spec — "если вы не будете
// делать подобную проверку, просто пропустите этот пункт"): if the
// MIRKVESTOV_SECRET env var is set, an incoming `md5` field is checked
// against md5(first_name+family_name+phone+email+MIRKVESTOV_SECRET) and the
// request is rejected if it doesn't match, so nobody but Mir Kvestov's own
// servers can create bookings through this URL. Until that env var is set,
// verification is skipped entirely and the endpoint still works — exactly
// like this site's existing TELEGRAM_BOT_TOKEN/ROCKETSMS_* env vars being
// optional (see api/book.js, api/_sms.js).
//
// Reuses the exact same reservation mechanism as the site's own
// api/book.js (HSETNX on the `bookings:<date>` Redis hash) so a Mir
// Kvestov booking can never double-book a slot the website (or any other
// channel) already holds, and shows up identically in the admin/staff
// panels — just tagged with channel: 'Мир Квестов' so it's easy to filter
// and count separately in the existing per-channel stats.

import crypto from 'crypto';
import { kv } from '../_kv.js';
import { scheduleReminder } from '../_reminders.js';
import { scheduleGameCloseout } from '../_closeout.js';
import { sendBookingConfirmationSms } from '../_sms.js';

const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // same retention as every other booking — see api/book.js

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(200).json({ success: false, message: 'Method not allowed' });
  }

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
  const reserved = added === 1; // null means KV isn't connected — proceed unchecked, same as api/book.js

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
