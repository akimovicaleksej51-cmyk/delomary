// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the ExtraReality aggregator integration.
//
// ExtraReality's own partner setup page (the one you screenshotted —
// "Настройки бронирования по API") asks for two URLs on our site:
// "Расписание" (schedule) and "Бронь" (booking). This file is the first
// one. Give ExtraReality exactly this URL in the "Расписание" field:
//   https://loonygames.by/api/extrareality/schedule
//
// IMPORTANT CONTEXT — please read before relying on this: unlike Mir
// Kvestov (who sent an unambiguous first-party spec document), I could not
// find an official, verified ExtraReality API document. What this file
// implements is a best-effort match of: (1) the fields visible on your own
// settings screenshot (site domain, a quest, a "секрет или md5-ключ", a
// schedule URL, a booking URL — each with its own "Проверить" test button),
// and (2) the general shape of "GET schedule + POST booking, with is_free /
// price fields" that essentially every quest-room aggregator (including Mir
// Kvestov) uses. It has NOT been tested against ExtraReality's real
// servers. Please click the "Проверить" button next to each URL in
// ExtraReality's panel once these files are live, and send me whatever
// response or error it shows — that's real signal I can use to fix any
// field-name mismatch, which is much safer than guessing twice.
//
// Response shape (one entry per bookable time slot, for the next ~2 weeks —
// matching Mir Kvestov's own window since ExtraReality's docs weren't
// explicit about exactly how far ahead they expect):
//   date          "YYYY-MM-DD"
//   time          "HH:MM" (24-hour)
//   is_free       false if taken (booked/blocked) or already in the past
//   price         integer, Br — the cheapest tier's price for that day (see
//                 api/_pricing.js's file comment for why this is a
//                 "starting from" price rather than a per-team-size one)
//   extraPrices   {"1–2 человека": 140, "3–4 человека": 160, ...} — the
//                 full weekday/weekend per-team-size breakdown. Unlike Mir
//                 Kvestov (whose separate, optional "tariffs" endpoint has
//                 an unclear callback format), ExtraReality's own schedule
//                 response appears to carry this directly, so there's no
//                 separate round-trip to guess wrong — safe to include.
//   our_time_id   optional custom field, echoed back untouched during
//                 booking per every aggregator's convention seen so far —
//                 not actually relied on by api/extrareality/book.js
//                 (which re-derives the slot from the booking's own
//                 datetime), just a harmless debugging aid.

import { kvPipeline } from '../_kv.js';
import { businessToday, businessDateTime } from '../_time.js';
import { SLOTS, tiersFor, isWeekendISO, startingPriceFor, LATE_SLOT_INDEX, LATE_SURCHARGE } from '../_pricing.js';

const DAYS_AHEAD = 14;

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
