// Serverless function (Vercel Node.js runtime).
// Returns which time slots are already booked, for every date in the
// site's booking window, so the front-end can grey them out for every
// visitor — not just the one who booked them.
//
// This is public and unauthenticated, so it only ever reads the booked
// TIMES (the hash field names, via HKEYS) — never the customer details
// stored as the hash values. Those are only readable through the
// password-protected api/admin/bookings.js endpoint.
//
// Backed by Vercel KV (a Redis database you connect from the Vercel
// dashboard: Storage tab → Create Database → KV). Once connected, Vercel
// automatically adds the required environment variables to this project:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// If those variables are not set yet, this endpoint simply reports "no
// bookings" for everyone — nothing on the site breaks, slots just aren't
// blocked until the database is connected.

import { kvPipeline } from './_kv.js';
import { businessToday } from './_time.js';

const BOOKING_DAYS_AHEAD = 65; // small buffer beyond the site's 60-day window

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
  for (let i = 0; i < BOOKING_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  const commands = dates.map((iso) => ['HKEYS', `bookings:${iso}`]);
  const results = await kvPipeline(commands);

  if (!results) {
    // Database not connected (or the request failed) — report no bookings
    // rather than failing the whole site.
    return res.status(200).json({});
  }

  const out = {};
  results.forEach((entry, i) => {
    const times = entry && entry.result;
    if (Array.isArray(times) && times.length) {
      out[dates[i]] = times;
    }
  });

  return res.status(200).json(out);
}
