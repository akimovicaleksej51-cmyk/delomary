// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the ExtraReality aggregator integration. Combines
// what would otherwise be two separate files (a GET "schedule" endpoint and
// a POST "booking" endpoint) into one, since Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions total — see api/internal-jobs.js's
// header comment for the full picture.
//
// Give ExtraReality exactly this URL for BOTH the "Расписание" and "Бронь"
// fields in their settings panel — same URL, GET vs POST tells them apart:
//   https://loonygames.by/api/extrareality
//
// IMPORTANT CONTEXT — please read before relying on this: I could not find
// an official, verified ExtraReality API document. What this file
// implements is a best-effort match of: (1) the fields visible on your own
// settings screenshot (site domain, a quest, a "секрет или md5-ключ", a
// schedule URL, a booking URL — each with its own "Проверить" test
// button), and (2) the general shape of "GET schedule + POST booking" that
// essentially every quest-room aggregator (including Mir Kvestov) uses. It
// has NOT been tested against ExtraReality's real servers. Please click the
// "Проверить" button next to each URL in ExtraReality's panel once this
// file is live, and send whatever response/error it shows — real signal
// beats guessing twice.
//
// ===========================================================================
// GET — response shape (one entry per bookable time slot, for the next
// ~2 weeks):
//   date          "YYYY-MM-DD"
//   time          "HH:MM" (24-hour)
//   is_free       false if taken (booked/blocked) or already in the past
//   price         integer, Br — the cheapest tier's "starting from" price
//   extraPrices   {"1–2 человека": 140, "3–4 человека": 160, ...} — the
//                 full weekday/weekend per-team-size breakdown, since
//                 ExtraReality's own schedule response appears to carry
//                 this directly (unlike Mir Kvestov's separate, unclear
//                 "tariffs" callback), so it's safe to include here.
//   our_time_id   optional custom field, echoed back per convention — not
//                 relied on by the POST handler below.
//
// ===========================================================================
// POST — incoming fields (best-effort, see note above):
//   name, email, phone, comment
//   datetime      "YYYY-MM-DD HH:MM:SS" — date+time combined into one
//                 field (unlike Mir Kvestov, which sends them separately)
//   players_num   integer — unlike Mir Kvestov this one IS commonly sent,
//                 so it's stored directly on the booking
//   price         the booking's cost
//   uid           ExtraReality's own reservation id (kept as externalRef)
//   source        expected to be "extrareality"
//   signature     see the note on verification below
//   our_time_id   optional, echoed back from the GET side — not relied on
//
// SIGNATURE VERIFICATION — DELIBERATELY NOT ENFORCED YET. With no verified
// official spec in hand, getting the exact formula wrong would mean EVERY
// real booking silently gets rejected the moment an EXTRAREALITY_SECRET env
// var is set — a much worse outcome than no signature check at all for
// now. Leave ExtraReality's own "секрет" field blank for the moment; this
// endpoint accepts bookings exactly like Mir Kvestov's does when its own
// secret isn't configured. Once a real test booking confirms the exact
// signature formula, adding it here is a small, safe addition (same shape
// as api/mirkvestov.js's verifySignature()).
//
// Required response shape (assumed to match Mir Kvestov's own convention):
//   {"success": true}
//   {"success": false, "message": "..."}
//   {"success": false, "message": "Указанное время занято"}  <- for an
//     already-taken slot (exact wording not confirmed required for
//     ExtraReality, but reusing it everywhere is simple and shouldn't hurt).
//
// Reuses the same `bookings:<date>` Redis hash reservation mechanism as
// every other channel, tagged channel: 'ExtraReality'.

import { kv, kvPipeline } from './_kv.js';
import { businessToday, businessDateTime } from './_time.js';
import { SLOTS, tiersFor, isWeekendISO, startingPriceFor, LATE_SLOT_INDEX, LATE_SURCHARGE } from './_pricing.js';
import { scheduleReminder } from './_reminders.js';
import { scheduleGameCloseout } from './_closeout.js';
import { sendBookingConfirmationSms } from './_sms.js';

const DAYS_AHEAD = 14;
const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90;

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extraPricesFor(dateISO, time) {
  const tiers = tiersFor(isWeekendISO(dateISO));
  const lateBonus = time === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0;
  const out = {};
  tiers.forEach((tier) => { out[tier.people] = tier.price + lateBonus; });
  return out;
}

async function handleSchedule(req, res) {
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
        extraPrices: extraPricesFor(dateISO, time),
        our_time_id: `${dateISO}_${time}`,
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

function splitDateTime(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return { dateISO: '', time: '' };
  return { dateISO: m[1], time: m[2] };
}

async function handleBook(req, res) {
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

export default async function handler(req, res) {
  // CORS — added 22.09.2026. ExtraReality's own "Проверить" button next to
  // the "Расписание"/"Бронь" fields in their settings panel appears to call
  // this URL directly from JavaScript running IN THEIR OWN dashboard page
  // (extrareality.by), not from their server: opening the exact same URL
  // by typing it into a browser's address bar worked fine (a plain 200
  // with valid JSON — that kind of top-level navigation is never subject
  // to CORS), but their "Проверить" button showed a generic "Unsuccessful
  // response from server." That's the classic signature of the browser
  // itself blocking a cross-origin fetch() before it ever reaches our
  // code, because we never sent an Access-Control-Allow-Origin header.
  // Mir Kvestov's own test tool was unaffected by this — CORS only ever
  // applies to requests made by a browser's JavaScript, and their test
  // (per their working 200 response) runs server-side.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    // Preflight — a browser sends this by itself before some cross-origin
    // requests; answering it (the CORS headers above already apply to
    // this response too) is what lets the browser then send the real
    // GET/POST through.
    return res.status(204).end();
  }
  if (req.method === 'GET') return handleSchedule(req, res);
  if (req.method === 'POST') return handleBook(req, res);
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(200).json({ success: false, message: 'Method not allowed' });
}
