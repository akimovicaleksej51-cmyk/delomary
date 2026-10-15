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

// ---- 12.10.2026: отдельная сетка на ВЫХОДНЫЕ (сб, вс) начиная с 31.10.2026 ----
// Будни (и выходные до 31.10) — как раньше, SLOTS выше.
export const WEEKEND_SLOTS = ['09:40', '11:00', '12:20', '13:40', '15:00', '16:20', '17:40', '19:00', '20:20', '21:40', '23:00'];
export const WEEKEND_GRID_FROM = '2026-10-31';
// Доплаты на выходной сетке: 21:40 — +10 Br, 23:00 — +15 Br сверх прежней
// доплаты за поздний сеанс (20 Br), итого +35 Br.
export const WEEKEND_SURCHARGES = { '21:40': 10, '23:00': LATE_SURCHARGE + 15 };
// 12.10.2026: доплаты в БУДНИ (будняя сетка): 21:30 — +10 Br, 23:00 — +15 Br сверх
// прежних +20, итого +35. Выходные со старой сеткой (до 31.10) — как было: 23:00 +20.
export const WEEKDAY_SURCHARGES = { '21:30': 10, '23:00': LATE_SURCHARGE + 15 };
// Будние дни, когда действуют цены выходного дня (сетка при этом будняя).
export const WEEKEND_PRICE_RANGES = [['2026-11-02', '2026-11-06']];

// ---- 15.10.2026: НОЧНЫЕ сеансы 31 октября и 1 ноября ----
// Идут в начале самого дня, перед утренними сеансами: 31.10 00:20, 01:40,
// 03:00, 04:20, потом 09:40 … То же 1 ноября.
export const NIGHT_SLOTS = {
  '2026-10-31': ['00:20', '01:40', '03:00', '04:20'], // 31 октября, перед утренними сеансами
  '2026-11-01': ['00:20', '01:40', '03:00', '04:20'], // 1 ноября, перед утренними сеансами
};
// Цена ночного сеанса: тариф выходного дня + доплата как у 23:00 на выходных (+35) + 15.
export const NIGHT_SURCHARGE = 35 + 15;
export function nightSlotsFor(dateISO) { return NIGHT_SLOTS[String(dateISO)] || []; }
export function isNightSlot(dateISO, time) { return nightSlotsFor(dateISO).includes(time); }

export function isoPlusDays(dateISO, n) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
// Сеансы дня так, как их видят агрегаторы: ночные (если есть) + дневные, все в этом же дне.
export function displayEntriesFor(dateISO) {
  return slotsFor(dateISO).map((time) => ({ time, realDate: dateISO }));
}
// (дата, время) из брони агрегатора → дата сеанса (у нас всегда та же самая).
export function resolveAggregatorSlot(dateISO, time) {
  return { dateISO, time };
}

// Дневная сетка дня (без ночных сеансов).
export function baseSlotsFor(dateISO) {
  return isWeekendISO(dateISO) && String(dateISO) >= WEEKEND_GRID_FROM ? WEEKEND_SLOTS : SLOTS;
}
// Все сеансы дня (ночные + дневные), по времени.
export function slotsFor(dateISO) {
  const night = nightSlotsFor(dateISO);
  return night.length ? [...night, ...baseSlotsFor(dateISO)] : baseSlotsFor(dateISO);
}
// Цены выходного дня в этот день? (сб/вс или особые даты выше)
export function isWeekendPriceDay(dateISO) {
  const d = String(dateISO);
  return isWeekendISO(d) || WEEKEND_PRICE_RANGES.some(([a, b]) => d >= a && d <= b);
}
export function tiersForDate(dateISO) {
  return tiersFor(isWeekendPriceDay(dateISO));
}
// 15.10.2026: по ПЯТНИЦАМ с 18:30 (18:30, 20:00, 21:30, 23:00) — тарифы выходного дня.
export const FRIDAY_WEEKEND_PRICE_FROM = '18:30';
export function isFridayEvening(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay() === 5 && String(time) >= FRIDAY_WEEKEND_PRICE_FROM;
}
// Тарифы для конкретного сеанса: ночные и пятничные вечерние — по тарифу выходного дня.
export function isWeekendPriceSlot(dateISO, time) {
  return isNightSlot(dateISO, time) || isFridayEvening(dateISO, time) || isWeekendPriceDay(dateISO);
}
export function tiersForSlot(dateISO, time) {
  return tiersFor(isWeekendPriceSlot(dateISO, time));
}
// Доплата за конкретный сеанс в этот день (к цене тарифа).
export function slotSurcharge(dateISO, time) {
  if (isNightSlot(dateISO, time)) return NIGHT_SURCHARGE;
  if (baseSlotsFor(dateISO) === WEEKEND_SLOTS) return WEEKEND_SURCHARGES[time] || 0;
  if (!isWeekendISO(dateISO)) return WEEKDAY_SURCHARGES[time] || 0;
  return time === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0;
}

// ---- переход: брони, сделанные по прежней сетке на дни, где сетка поменялась ----
// Такие брони остаются со своим временем и занимают комнату. Сеанс новой
// сетки ближе чем за 90 минут до/после такой брони считается занятым.
// Брони по сетке дня друг другу не мешают (как и раньше).
export const OLD_GRID_SESSION_MINUTES = 90;
export function timeToMinutes(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
export function slotsBlockedByOffGrid(dateISO, takenTimes) {
  const grid = slotsFor(dateISO);
  const off = (takenTimes || []).filter((t) => !grid.includes(t)).map(timeToMinutes).filter(Number.isFinite);
  if (!off.length) return [];
  return grid.filter((s) => off.some((m) => Math.abs(timeToMinutes(s) - m) < OLD_GRID_SESSION_MINUTES));
}
export function effectiveTakenTimes(dateISO, takenTimes) {
  const list = Array.isArray(takenTimes) ? takenTimes : [];
  return [...new Set([...list, ...slotsBlockedByOffGrid(dateISO, list)])];
}
// Пересекается ли сеанс `time` с бронью не по сетке этого дня?
export function overlapsExisting(dateISO, takenTimes, time) {
  const grid = slotsFor(dateISO);
  const t = timeToMinutes(time);
  if (!Number.isFinite(t)) return false;
  return (takenTimes || []).some((x) => x !== time
    && (!grid.includes(x) || !grid.includes(time))
    && Math.abs(timeToMinutes(x) - t) < OLD_GRID_SESSION_MINUTES);
}

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
  return tiersForSlot(dateISO, time)[0].price + slotSurcharge(dateISO, time);
}
