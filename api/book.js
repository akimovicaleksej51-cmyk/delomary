// Serverless function (Vercel Node.js runtime).
// Receives a booking request from the site's form, reserves the slot (so it
// shows as taken for every other visitor), and forwards it as a Telegram
// message to the quest owner. It does NOT reply to the customer —
// confirmation is done by the owner manually, by phone.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN  — token from @BotFather
//   TELEGRAM_CHAT_ID    — the owner's chat id (message your bot once, then
//                          open https://api.telegram.org/bot<TOKEN>/getUpdates
//                          and look for "chat":{"id":...})
//
// Optional (needed for slot availability + the admin panel to work — see
// api/slots.js and api/admin/bookings.js):
//   KV_REST_API_URL, KV_REST_API_TOKEN — added automatically once you
//   connect a Vercel KV database (Storage tab → Create Database → KV) to
//   this project. Without them, bookings still work, they just aren't
//   checked against each other and won't show up in the admin panel.
//
// Bookings are stored in KV as a Redis HASH per date — key "bookings:<ISO
// date>", one field per booked time, whose value is a JSON string with the
// full booking details (name, phone, players, price, comment...). This lets
// the admin panel list/view/cancel/reschedule bookings, while the public
// api/slots.js endpoint only ever reads the field NAMES (the times), never
// these JSON values, so customer details are never exposed publicly.

import { kv } from './_kv.js';
import { scheduleReminder } from './_reminders.js';
import { scheduleGameCloseout } from './_closeout.js';

const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // auto-clean ~90 days after the date

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { name, phone, players, date, dateISO, time, price, website, comment } = body;

  // Honeypot: real visitors never fill a field hidden with CSS. If it's
  // filled, silently pretend success so bots don't learn anything.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';
  const cleanDateISO = typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : '';
  const cleanTime = typeof time === 'string' ? time.trim().slice(0, 20) : '';
  const cleanDateLabel = typeof date === 'string' ? date.trim().slice(0, 60) : '';
  const cleanPlayers = players != null ? String(players).slice(0, 40) : '';
  const cleanPrice = price != null ? String(price).slice(0, 20) : '';

  if (!cleanName || !cleanPhone) {
    return res.status(400).json({ error: 'Укажите имя и телефон.' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(500).json({
      error: 'Форма временно не работает. Пожалуйста, позвоните нам напрямую.',
    });
  }

  // Reserve the slot atomically: HSETNX only sets the field if it doesn't
  // already exist in the hash, so two simultaneous requests can never both
  // "win" the same (date, time) pair.
  const hashKey = cleanDateISO && cleanTime ? `bookings:${cleanDateISO}` : null;
  let reserved = false;

  const record = {
    type: 'customer',
    name: cleanName,
    phone: cleanPhone,
    players: cleanPlayers,
    price: cleanPrice,
    // Payment breakdown, discount notes, and who actually worked the
    // session aren't known yet at booking time — the admin fills these in
    // later via the admin panel's "Редактировать" (see the Касса feature
    // in api/admin/bookings.js / api/admin/finance.js). `channel` defaults
    // to 'Сайт' here since that's simply true for every booking that goes
    // through this endpoint.
    payCash: '',
    payCard: '',
    payErip: '',
    channel: 'Сайт',
    discountNote: '',
    workedActor: '',
    workedActress: '',
    handledByAdmin: '',
    comment: cleanComment,
    dateISO: cleanDateISO,
    dateLabel: cleanDateLabel,
    time: cleanTime,
    createdAt: new Date().toISOString(),
  };

  if (hashKey) {
    const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
    if (added === 0) {
      return res.status(409).json({
        conflict: true,
        error: 'Это время только что заняли — пожалуйста, выберите другое.',
      });
    }
    if (added === 1) reserved = true; // null means KV isn't connected — proceed unchecked
  }

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    // Phone is sent RAW (not escapeMd'd) so Telegram recognizes and
    // auto-links it as a tappable/copyable phone number — a phone number
    // never contains Markdown-special characters, so nothing needs escaping
    // here, and escaping it (stray backslashes) breaks that auto-detection.
    `📞 Телефон: ${cleanPhone}`,
    cleanPlayers ? `👥 Игроков: ${escapeMd(cleanPlayers)}` : null,
    cleanDateLabel ? `📅 Дата: ${escapeMd(cleanDateLabel)}` : null,
    cleanTime ? `🕒 Время: ${escapeMd(cleanTime)}` : null,
    cleanPrice ? `💰 Цена: ${escapeMd(cleanPrice)} Br` : null,
    cleanComment ? `💬 Комментарий: ${escapeMd(cleanComment)}` : null,
  ].filter(Boolean).join('\n');

  const text = `🩺 *Новая заявка — Дело Мэри*\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      if (reserved) await kv('hdel', hashKey, cleanTime); // release — the owner never got notified
      return res.status(502).json({
        error: 'Не удалось отправить заявку. Попробуйте позвонить нам.',
      });
    }

    if (reserved) {
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      // Best-effort: if a shift schedule assigns a performer to this slot,
      // this schedules their private 1.5h-before reminder AND their sverka
      // (game closeout) message, timed 80 minutes after THIS game's own
      // start time — see api/_reminders.js and api/_closeout.js. Neither
      // ever blocks or fails the booking itself.
      const [reminderPatch, closeoutPatch] = await Promise.all([
        scheduleReminder(record),
        scheduleGameCloseout(record),
      ]);
      const patch = { ...reminderPatch, ...closeoutPatch };
      if (Object.keys(patch).length) {
        await kv('hset', hashKey, cleanTime, JSON.stringify({ ...record, ...patch }));
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    if (reserved) await kv('hdel', hashKey, cleanTime); // release — the owner never got notified
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз позже.',
    });
  }
}
