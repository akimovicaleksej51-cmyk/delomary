// Shared "what day/time is it for the business" helpers.
//
// Vercel's serverless functions run with the process clock in UTC
// (regardless of the function's configured region), but this business —
// and everyone using the admin panel — is in Minsk (UTC+3, no DST since
// 2011). Any server-side code that did `new Date()` and then read
// getFullYear()/getMonth()/getDate() (or used it as a fallback "today")
// was silently computing UTC's calendar day, not Minsk's.
//
// Those two disagree for a very real 3-hour window EVERY NIGHT — from
// 00:00 to 03:00 Minsk time, the server's UTC clock still shows the
// PREVIOUS day. That window is exactly when an evening quest-room
// business is doing its end-of-day cash reconciliation, shift closeout,
// etc. — so this class of bug hits at the worst possible time. Any code
// that needs "today" (or "now") from the business's point of view must go
// through these helpers instead of doing its own `new Date()` + local
// getters.
//
// Not a route — Vercel ignores files starting with "_".

export const BUSINESS_TZ = 'Europe/Minsk';
const BUSINESS_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // Europe/Minsk has been a fixed UTC+3 since 2011, no DST

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}); // en-CA formats as YYYY-MM-DD

// Today's date (YYYY-MM-DD) as it is RIGHT NOW in Minsk — not on the
// server's own (UTC) clock.
export function todayISO() {
  return dateFmt.format(new Date());
}

// A Date object anchored at the start of "today" (Minsk), safe to hand to
// the existing `d.setDate(d.getDate() + n)` / `isoDate(d)` style arithmetic
// used throughout the codebase — that arithmetic only cares that the
// object's y/m/d getters round-trip correctly, which this preserves.
export function businessToday() {
  const [y, m, d] = todayISO().split('-').map(Number);
  return new Date(y, m - 1, d);
}

// The real current instant, but usable for correctly comparing against a
// booking's stored `dateISO` + `time` (which are Minsk wall-clock values).
// Building `new Date(y, m-1, d, hh, mm)` directly from those components
// would silently reinterpret them as UTC on the server — off by 3 hours.
// Building the UTC timestamp from the raw numbers and then correcting by
// the fixed Minsk offset gives the right absolute instant either way.
export function businessDateTime(dateISO, hh, mm) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0) - BUSINESS_UTC_OFFSET_MS);
}
