// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the Мир Квестов aggregator integration.
//
// This is the "Получение расписания" endpoint from Mir Kvestov's own API
// spec (https://mir-kvestov.ru/integration, shared with us as a Google Doc):
// their servers call this URL with a plain GET (no parameters) and expect a
// JSON array covering roughly the next two weeks, one entry per bookable
// time slot, so:
//   GET https://loonygames.by/api/mirkvestov/timetable
//
// Give Mir Kvestov exactly this URL in their partner setup form.
//
// Fields, per their spec:
//   date      "YYYY-MM-DD"
//   time      "HH:MM" (24-hour)
//   is_free   false if already booked/blocked OR if that time has already
//             passed today — true otherwise
//   price     integer, in Br — see the note below on why this is the
//             CHEAPEST tier's price, not a per-team-size breakdown
//   our_slot_id  optional custom field (allowed by their spec, "any
//             additional parameters you send us, we return during
//             booking") — not actually relied on by api/mirkvestov/order.js
//             (which re-derives everything from date+time+the DB), but kept
//             as a harmless, spec-legal extra in case it's ever useful for
//             cross-checking / debugging a specific booking later.
//
// Reuses the exact same source of truth as the site's own public
// api/slots.js: the `bookings:<date>` Redis hash. A slot's key existing
// there means SOMETHING holds it — a real customer booking (any channel)
// or an admin's "blockDay" technical closure — so `is_free` here always
// matches what a visitor on the site itself would see, automatically, with
// no separate "is this day closed" logic to keep in sync.
//
// NOTE ON PRICING — no per-team-size tariffs (Mir Kvestov's optional
// "Получение тарифов" feature) are implemented here on purpose. The site's
// real price depends on how many people are playing (140–240 Br depending
// on weekday/weekend and team size — see api/_pricing.js), but Mir
// Kvestov's own docs are explicit that sending the standard single price
// here is a complete, valid integration on its own ("использование
// тарифов не отменяет передачу стандартной цены"). We show the CHEAPEST
// tier ("от X Br"), and — exactly like every other booking channel this
// site already has (the site's own form, phone calls, walk-ins) — the
// admin panel's existing "Позвонить/подтвердить" workflow is where the
// exact price for that team's size gets confirmed with the customer by
// phone before the game. If you'd like exact per-team-size pricing shown
// on Mir Kvestov's own listing instead, that's Mir Kvestov's separate
// "get_price" endpoint — ask them for a live example via their test page
// so the "tariff" field's exact shape can be confirmed before building it.

import { kvPipeline } from '../_kv.js';
import { businessToday, businessDateTime } from '../_time.js';
import { SLOTS, startingPriceFor } from '../_pricing.js';

const DAYS_AHEAD = 14; // Mir Kvestov's spec: "расписание на 2 недели"

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
        our_slot_id: `${dateISO}_${time}`,
      });
    }
  }

  return res.status(200).json(out);
}
