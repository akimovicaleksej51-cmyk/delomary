// Shared "what can we book, and for how much" constants — mirrors the
// client-side logic in index.html's booking widget (the `slots`,
// `weekdayTiers`/`weekendTiers` and late-slot-surcharge constants there).
// Added 22.09.2026 for the Мир Квестов / ExtraReality aggregator
// integrations (see api/mirkvestov/*.js), which need to compute the SAME
// prices and open time slots server-side, without duplicating index.html's
// numbers in two places that could quietly drift apart.
//
// If you ever change a price or a time slot on the site (index.html), change
// it here too — this file is deliberately kept in the same shape as
// index.html's own constants so the two are easy to compare side by side.
//
// Not a route — Vercel ignores files starting with "_".

export const SLOTS = ['11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00', '21:30', '23:00'];
export const LATE_SLOT_INDEX = 8; // '23:00' — the late-night surcharge slot
export const LATE_SURCHARGE = 20; // Br, added on top of the normal tier price for the 23:00 slot only

export const weekdayTiers = [
  { max: 2, price: 140, people: '1–2 человека' },
  { max: 4, price: 160, people: '3–4 человека' },
  { max: 5, price: 190, people: '5 человек' },
  { max: 6, price: 220, people: '6 человек' },
];
export const weekendTiers = [
  { max: 2, price: 160, people: '1–2 человека' },
  { max: 4, price: 180, people: '3–4 человека' },
  { max: 5, price: 210, people: '5 человек' },
  { max: 6, price: 240, people: '6 человек' },
];

export function tiersFor(weekend) {
  return weekend ? weekendTiers : weekdayTiers;
}

// The optional "Аниматор к празднику" add-on on the site's own booking
// widget (index.html's own ANIMATOR_SURCHARGE constant — kept duplicated
// there on purpose, same as SLOTS/the tiers above, since index.html is
// static markup and can't import this file). Added 23.09.2026 so
// api/book.js can verify a submitted price server-side instead of trusting
// it outright — see api/book.js's own comment for why.
export const ANIMATOR_SURCHARGE = 30;

// Saturday/Sunday, same rule as index.html's isWeekend(d).
export function isWeekendISO(dateISO) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const day = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
  return day === 0 || day === 6;
}

// The price a brand-new visitor is quoted before saying how many people are
// coming — i.e. the cheapest tier for that day, plus the fixed late-slot
// surcharge if it applies to this exact time. This is deliberately the
// "starting from" price (not a per-team-size breakdown) — see
// api/mirkvestov.js's file comment for why.
export function startingPriceFor(dateISO, time) {
  const tiers = tiersFor(isWeekendISO(dateISO));
  const base = tiers[0].price;
  return base + (time === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0);
}
