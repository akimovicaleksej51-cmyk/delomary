// Serverless function (Vercel Node.js runtime).
// Checks the admin password. Used only so admin.html can show a clear
// "wrong password" message before letting anyone into the panel — the real
// protection is that every other admin endpoint (api/admin/bookings.js)
// re-checks the same password on every single request via the
// X-Admin-Password header, so this login step can't be bypassed by
// skipping straight to the panel.
//
// Required environment variable (set in Vercel → Project → Settings →
// Environment Variables):
//   ADMIN_PASSWORD — whatever password you want to protect /admin.html with.
//
// Brute-force protection: failed attempts are counted per IP in KV (see
// ../_ratelimit.js) and shared with api/admin/bookings.js, since that's the
// endpoint that actually enforces the password on every request — an
// attacker guessing passwords straight against it, without ever touching
// this login screen, is throttled the same way.

import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';

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

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error('Missing ADMIN_PASSWORD env var');
    return res.status(500).json({
      error: 'Админка ещё не настроена — задайте ADMIN_PASSWORD в настройках Vercel.',
    });
  }

  const ip = getClientIp(req);
  const rate = await checkRateLimit(ip);
  if (rate.limited) {
    return res.status(429).json({
      error: `Слишком много попыток входа. Попробуйте снова через ${retryAfterMinutesLabel(rate.retryAfterSeconds)}`,
    });
  }

  if (typeof body.password !== 'string' || body.password !== adminPassword) {
    await recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Неверный пароль.' });
  }

  await clearAttempts(ip);
  return res.status(200).json({ ok: true });
}
