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
import crypto from 'crypto';

const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 15 * 60;

// 23.09.2026: double-checked this against Vercel's own docs before touching
// it — on Vercel (without an Enterprise "Trusted Proxy" set up, which this
// project doesn't use), Vercel's edge overwrites x-forwarded-for itself and
// explicitly does NOT forward whatever a client sent in that header, "to
// prevent IP spoofing". So reading the first entry here is reading Vercel's
// own value, not anything an attacker controls — this is safe as-is; a
// generic "trust the LAST entry instead" fix (the usual advice for a
// self-hosted reverse proxy) would be wrong here and could even break this
// on Vercel, since there is normally only ever a single IP in the header,
// no chain.
export function getClientIp(req) {
  const fwd = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

// Generic, purpose-built limiter for public endpoints that aren't "guess a
// password" attempts (api/book.js, so far) — a separate key prefix and much
// more generous thresholds than the login lockout above, tuned to allow a
// real customer bouncing between a few slots after a 409 while still
// capping a scripted flood. Counts EVERY call (not just failures, unlike
// the login limiter above, where only wrong passwords count) since there's
// no notion of a "failed attempt" on a booking submission. Fails open (same
// policy as the rest of this file) if KV isn't connected.
export async function checkAndBumpRateLimit(prefix, ip, maxAttempts, windowSeconds) {
  const key = `${prefix}:${ip}`;
  const count = await kv('incr', key);
  if (count === null) return { limited: false }; // KV down — fail open
  if (count === 1) await kv('expire', key, windowSeconds);
  if (count > maxAttempts) {
    const ttl = await kv('ttl', key);
    const retryAfterSeconds = ttl && ttl > 0 ? ttl : windowSeconds;
    return { limited: true, retryAfterSeconds };
  }
  return { limited: false };
}

// Constant-time password comparison, shared by every admin endpoint's
// checkAuth(). A plain `a === b` short-circuits on the first differing
// byte, which is a real (if impractical here, given the lockout above)
// timing side-channel for the one password gating all customer/financial
// data. crypto.timingSafeEqual() itself requires equal-length buffers, so
// both sides are hashed to a fixed length first — comparing the hashes is
// exactly as safe as comparing the originals, since a match here can only
// mean the inputs matched.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
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
