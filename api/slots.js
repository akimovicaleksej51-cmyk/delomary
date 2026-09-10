// Serverless function (Vercel Node.js runtime).
// Returns which time slots are already booked, for every date in the
// site's booking window, so the front-end can grey them out for every
// visitor — not just the one who booked them.
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

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    // Database not connected yet — report no bookings rather than failing.
    return res.status(200).json({});
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < BOOKING_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  try {
    const commands = dates.map((iso) => ['SMEMBERS', `booked:${iso}`]);
    const pipeRes = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    if (!pipeRes.ok) {
      console.error('KV pipeline request failed:', pipeRes.status);
      return res.status(200).json({});
    }

    const results = await pipeRes.json();
    const out = {};
    results.forEach((entry, i) => {
      const members = entry && entry.result;
      if (Array.isArray(members) && members.length) {
        out[dates[i]] = members;
      }
    });

    return res.status(200).json(out);
  } catch (err) {
    console.error('Failed to read booked slots from KV:', err);
    return res.status(200).json({});
  }
}
