// Shared brute-force guard for the admin password.
//
// The login screen (api/admin/login.js) is really just a UX nicety — the
// actual protection is that api/admin/bookings.js re-checks the same
// password on every single request via the X-Admin-Password header. That
// means rate-limiting only the login screen would leave the real endpoint
// wide open to being hit directly with a guessed header, bypassing the
// login screen entirely. So both files import this and share one counter
// per client IP.
//
// Fails open (never blocks anyone) if KV isn't connected, same as the rest
// of the app — a missing database degrades to "no rate limiting", not to a
// broken admin panel.

import { kv } from './_kv.js';

const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 15 * 60;

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// { limited: true, retryAfterSeconds } if this IP is currently locked out,
// otherwise { limited: false }.
export async function checkRateLimit(ip) {
  const key = `loginattempts:${ip}`;
  const attempts = await kv('get', key);
  const count = attempts ? parseInt(attempts, 10) || 0 : 0;
  if (count < MAX_ATTEMPTS) return { limited: false };

  const ttl = await kv('ttl', key);
  const retryAfterSeconds = ttl && ttl > 0 ? ttl : LOCKOUT_SECONDS;
  return { limited: true, retryAfterSeconds };
}

export async function recordFailedAttempt(ip) {
  const key = `loginattempts:${ip}`;
  const count = await kv('incr', key);
  if (count === 1) await kv('expire', key, LOCKOUT_SECONDS);
}

export async function clearAttempts(ip) {
  await kv('del', `loginattempts:${ip}`);
}

export function retryAfterMinutesLabel(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${minutes} мин.`;
}
