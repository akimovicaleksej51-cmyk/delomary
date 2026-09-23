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
// NOTE ON PRICING — the schedule (GET, no params) above still sends only the
// CHEAPEST tier's price ("от X Br"), same as always.
//
// 23.09.2026: per-team-size tariffs ARE now implemented — see handleTariffs
// below — because the owner noticed another quest on Mir Kvestov shows a
// "Тариф" dropdown with a price per group size on its booking form, while
// ours only showed one flat price. That dropdown is Mir Kvestov's optional
// "Получение тарифов" feature (section 3 of their API doc, shared with us as
// a Google Doc): a SECOND kind of GET call to the same URL, this one WITH
// `date` and `time` query params, expecting back an object mapping a
// display label to its price, e.g. {"1–2 человека: 140 Br": 140, "3–4
// человека: 160 Br": 160, ...} — built here from the exact same
// api/_pricing.js tiers the site's own booking widget uses, so it can never
// drift from the real price. The label the customer picks comes back
// verbatim in the `tariff` field of the booking POST (handleOrder below) —
// captured only for visibility (comment + Telegram alert); the `price`
// field they send alongside it is Mir Kvestov's own copy of that tariff's
// price, so no computation depends on parsing the label back into a number.
//
// MANUAL STEP (not something this code can do on its own): Mir Kvestov's
// doc says a quest must separately tell their manager which URL to call for
// this — it isn't auto-detected from the schedule URL already on file. Since
// our own handler already tells the two kinds of GET call apart by whether
// `date`/`time` are present, there's no need to register a second URL:
// just let Mir Kvestov's support/manager know the SAME URL already on file
// (https://loonygames.by/api/mirkvestov) should also be used for
// "Получение тарифов".
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
// against md5(first_name+family_name+phone+email+MIRKVESTOV_SECRET).
//
// 22.09.2026 update: Mir Kvestov's real production system started sending
// bookings whose md5 does NOT match this formula (their real booking got
// rejected with "Ошибка проверки подписи." and never reached us — reported
// by their support team via email). Since the signature check is optional
// per their own spec, and losing a real customer booking is far worse than
// accepting one we can't cryptographically verify, a mismatch NO LONGER
// blocks the booking — it's logged (see verifySignature's caller below) so
// the mismatch can be diagnosed from Vercel's function logs, but the
// booking still goes through. Once the real formula (or a corrected
// MIRKVESTOV_SECRET value) is confirmed with their support, this can be
// tightened back to a hard rejection if desired.
//
// Reuses the exact same reservation mechanism as the site's own
// api/book.js (HSETNX on the `bookings:<date>` Redis hash) so a Mir
// Kvestov booking can never double-book a slot the website (or any other
// channel) already holds, and shows up identically in the admin/staff
// panels — tagged channel: 'Мир Квестов'.

import crypto from 'crypto';
import { kv, kvPipeline } from './_kv.js';
import { businessToday, isSlotClosingSoon } from './_time.js';
import { SLOTS, LATE_SLOT_INDEX, LATE_SURCHARGE, startingPriceFor, tiersFor, isWeekendISO } from './_pricing.js';
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
      // 22.09.2026: was just "already started" — now matches the site's own
      // hour-before cutoff (see isSlotClosingSoon in api/_time.js). The
      // owner caught ExtraReality still offering a slot 4 minutes before it
      // started; Mir Kvestov had the exact same gap here.
      const closingSoon = isSlotClosingSoon(dateISO, time, now);
      out.push({
        date: dateISO,
        time,
        is_free: !closingSoon && !taken.includes(time),
        price: startingPriceFor(dateISO, time),
        our_slot_id: `${dateISO}_${time}`,
      });
    }
  }

  return res.status(200).json(out);
}

// "Получение тарифов" — see the big comment near the top of this file. Only
// reached when the GET request carries `date` and `time` (the plain
// schedule call above never does), so this needs no query param of its own
// to be told apart from handleTimetable.
async function handleTariffs(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const dateISO = typeof q.date === 'string' ? q.date.trim() : '';
  const time = typeof q.time === 'string' ? q.time.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || !/^\d{2}:\d{2}$/.test(time)) {
    // Malformed request — no sane tariff list to answer with. Their own doc
    // doesn't define an error shape for this call, so an empty object (no
    // tariffs) is the safest fallback rather than a 4xx that might make
    // their side treat the whole integration as broken.
    return res.status(200).json({});
  }

  const tiers = tiersFor(isWeekendISO(dateISO));
  const surcharge = time === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0;
  const out = {};
  tiers.forEach((tier) => {
    const price = tier.price + surcharge;
    out[`${tier.people}: ${price} Br`] = price;
  });

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
  if (provided !== expected) {
    // Logged (never the secret itself) so a real mismatch can be diagnosed
    // from Vercel's function logs — see the big comment above this
    // function for why this no longer blocks the booking.
    console.error(
      'Mir Kvestov md5 signature mismatch — booking will still be accepted. ' +
      `provided=${provided} expectedByOurFormula=${expected} ` +
      `fields(first_name,family_name,phone,email)=${JSON.stringify([body.first_name, body.family_name, body.phone, body.email])}`
    );
    return false;
  }
  return true;
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
  // 23.09.2026: the label the customer picked from the "Получение тарифов"
  // dropdown (see handleTariffs above) — e.g. "3–4 человека: 160 Br" —
  // echoed back verbatim per Mir Kvestov's spec. Purely informational: it's
  // just the same tier the `price` field above already reflects, spelled
  // out for a human reading the comment/Telegram alert instead of a bare
  // number with no team size attached.
  const cleanTariff = typeof body.tariff === 'string' ? body.tariff.trim().slice(0, 100) : '';

  const cleanName = [cleanFirst, cleanLast].filter(Boolean).join(' ').trim();

  if (!cleanName || !cleanPhone || !cleanDateISO || !cleanTime) {
    return res.status(200).json({ success: false, message: 'Не хватает обязательных полей (имя, телефон, дата, время).' });
  }

  // 22.09.2026: matches the site's own hour-before cutoff (see
  // api/_time.js) — closes this even if Mir Kvestov's cached timetable
  // still thinks the slot is free.
  if (isSlotClosingSoon(cleanDateISO, cleanTime)) {
    return res.status(200).json({ success: false, message: 'Указанное время больше недоступно для онлайн-бронирования (до сеанса меньше часа).' });
  }

  // A signature mismatch is logged inside verifySignature() but, as of
  // 22.09.2026, no longer rejects the booking — see the big comment above
  // verifySignature() for why. `signatureMismatch` just flags the record
  // for the owner (in the Telegram notification below) so it isn't a
  // silent discrepancy.
  const signatureMismatch = !verifySignature(body);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(200).json({ success: false, message: 'Бронирование временно недоступно, попробуйте позже.' });
  }

  const commentParts = [cleanComment, cleanTariff ? `Тариф: ${cleanTariff}` : '', cleanEmail ? `Email: ${cleanEmail}` : ''].filter(Boolean);

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

  // 22.09.2026: no longer backslash-escaped, and the message below is sent
  // as PLAIN TEXT (no parse_mode) — see the comment on escapeMd() in
  // api/extrareality.js for why the old escaping showed up as literal
  // backslashes in real notifications (e.g. "2026\-09\-28", "\(md5\)").
  const escapeMd = (s) => String(s);
  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    `📞 Телефон: ${cleanPhone}`,
    cleanDateISO ? `📅 Дата: ${escapeMd(cleanDateISO)}` : null,
    cleanTime ? `🕒 Время: ${escapeMd(cleanTime)}` : null,
    cleanPrice ? `💰 Цена: ${escapeMd(cleanPrice)} Br` : null,
    cleanTariff ? `👥 Тариф: ${escapeMd(cleanTariff)}` : null,
    cleanComment ? `💬 Комментарий: ${escapeMd(cleanComment)}` : null,
    signatureMismatch ? `⚠️ Подпись (md5) не совпала — booking принят, но проверьте логи` : null,
  ].filter(Boolean).join('\n');
  const text = `🩺 Новая бронь — Мир Квестов\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }), // plain text — see the escapeMd() comment above
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
  // CORS — added 22.09.2026, mirroring the same fix on api/extrareality.js
  // after ExtraReality's own "Проверить" button turned out to be blocked
  // by the browser's own cross-origin rules (see that file's comment for
  // the full story). Mir Kvestov's own test tool wasn't affected by this —
  // its 200 response showed it runs server-side, where CORS doesn't
  // apply — but adding the same harmless headers here keeps both
  // integrations consistent in case a browser-based test ever gets added
  // on their side too.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    const q = req.query || {};
    const hasDateAndTime = typeof q.date === 'string' && typeof q.time === 'string';
    return hasDateAndTime ? handleTariffs(req, res) : handleTimetable(req, res);
  }
  if (req.method === 'POST') return handleOrder(req, res);
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(200).json({ success: false, message: 'Method not allowed' });
}
