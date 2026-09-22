// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the ExtraReality aggregator integration.
//
// This is the "Бронь" endpoint from your ExtraReality settings screenshot.
// Give ExtraReality exactly this URL in the "Бронь" field:
//   https://loonygames.by/api/extrareality/book
//
// See api/extrareality/schedule.js's file comment for the full context on
// why this is a best-effort implementation (no verified first-party
// ExtraReality spec was found) — please test both URLs via the
// "Проверить" buttons in ExtraReality's own settings panel once these
// files are live, and send me the exact result so anything mismatched can
// be corrected against real signal instead of another guess.
//
// Expected incoming fields (best-effort, see file comment above):
//   name, email, phone, comment
//   datetime      "YYYY-MM-DD HH:MM:SS" — the booking's date+time combined
//                 into one field (unlike Mir Kvestov, which sends date and
//                 time separately)
//   players_num   integer — how many people, unlike Mir Kvestov this one
//                 IS commonly sent, so it's stored directly
//   price         the booking's cost
//   uid           ExtraReality's own reservation id (kept for reference —
//                 see externalRef below)
//   source        expected to be "extrareality"
//   signature     see the note on verification below
//   our_time_id   optional, echoed back from schedule.js — not relied on,
//                 date+time from `datetime` is enough to find the slot
//
// SIGNATURE VERIFICATION — DELIBERATELY NOT ENFORCED YET. ExtraReality's
// settings screen asks for a "секрет или md5-ключ", and the general
// pattern this kind of aggregator uses is signature = md5(datetime +
// secret) — but with no verified official spec in hand, getting this exact
// formula wrong would mean EVERY real booking silently gets rejected the
// moment an EXTRAREALITY_SECRET env var is set, which is a much worse
// outcome than having no signature check at all for now. So: leave
// ExtraReality's own "секрет" field blank for the moment, don't set an
// EXTRAREALITY_SECRET env var here, and this endpoint will accept bookings
// exactly like Mir Kvestov's does when its own secret isn't configured.
// Once a real test booking (via their "Проверить" button, or an actual
// booking through their platform) confirms the exact signature formula,
// this is a small, safe addition to make — same shape as
// api/mirkvestov/order.js's verifySignature().
//
// Required response shape (assumed to match Mir Kvestov's own — every
// aggregator seen so far uses this exact convention):
//   {"success": true}
//   {"success": false, "message": "..."}
//   {"success": false, "message": "Указанное время занято"}  <- for an
//     already-taken slot; ExtraReality's docs weren't confirmed to require
//     this EXACT wording (unlike Mir Kvestov's, which does), but using the
//     same phrasing everywhere is simple and shouldn't hurt.
//
// Reuses the same `bookings:<date>` Redis hash reservation mechanism as
// every other channel (site form, admin, Mir Kvestov) — see
// api/book.js / api/mirkvestov/order.js's file comments — so a slot can
// never be double-booked across channels, and shows up identically in the
// admin/staff panels, tagged channel: 'ExtraReality'.

import { kv } from '../_kv.js';
import { scheduleReminder } from '../_reminders.js';
import { scheduleGameCloseout } from '../_closeout.js';
import { sendBookingConfirmationSms } from '../_sms.js';

const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // same retention as every other booking

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

// "YYYY-MM-DD HH:MM:SS" (or "YYYY-MM-DDTHH:MM:SS") -> { dateISO, time } —
// time trimmed to "HH:MM" to match this site's own SLOTS format.
function splitDateTime(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return { dateISO: '', time: '' };
  return { dateISO: m[1], time: m[2] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(200).json({ success: false, message: 'Method not allowed' });
  }

  const body = parseBody(req);

  const cleanName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const cleanPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
  const cleanEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 100) : '';
  const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  const { dateISO: cleanDateISO, time: cleanTime } = splitDateTime(body.datetime);
  const cleanPrice = body.price != null ? String(body.price).slice(0, 20) : '';
  const cleanPlayers = body.players_num != null ? String(body.players_num).slice(0, 40) : '';
  const cleanUid = body.uid != null ? String(body.uid).slice(0, 100) : '';

  if (!cleanName || !cleanPhone || !cleanDateISO || !cleanTime) {
    return res.status(200).json({ success: false, message: 'Не хватает обязательных полей (имя, телефон, дата и время).' });
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
    players: cleanPlayers,
    price: cleanPrice,
    payCash: '',
    payCard: '',
    payErip: '',
    channel: 'ExtraReality',
    discountNote: '',
    workedActor: '',
    workedActress: '',
    handledByAdmin: '',
    comment: commentParts.join(' · '),
    animator: false,
    dateISO: cleanDateISO,
    dateLabel: '',
    time: cleanTime,
    externalRef: cleanUid ? `extrareality:${cleanUid}` : '',
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
    cleanPlayers ? `👥 Игроков: ${escapeMd(cleanPlayers)}` : null,
    cleanDateISO ? `📅 Дата: ${escapeMd(cleanDateISO)}` : null,
    cleanTime ? `🕒 Время: ${escapeMd(cleanTime)}` : null,
    cleanPrice ? `💰 Цена: ${escapeMd(cleanPrice)} Br` : null,
    cleanComment ? `💬 Комментарий: ${escapeMd(cleanComment)}` : null,
  ].filter(Boolean).join('\n');
  const text = `🩺 *Новая бронь — ExtraReality*\n\n${fields}`;

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
