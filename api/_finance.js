// Shared helpers for the "Касса" (cash register) feature: a manually-set
// opening balance plus every day's cash movements since combine into a
// running balance the admin panel can show at a glance — replacing the
// running-total column the owner used to keep by hand in a spreadsheet.
//
// Not a route — Vercel ignores files starting with "_" — imported by
// api/admin/finance.js and api/admin/bookings.js.
//
// ── Data model ──────────────────────────────────────────────────────────
//   cashouts:<ISO date>   STRING, JSON array of cash-outflow entries for
//                          that date — a general expense, or a salary/
//                          collection ("инкассация") payout, both of which
//                          remove physical cash from the register:
//                          [{ id, kind:'expense'|'payroll', label, amount,
//                             createdAt }]
//                          `amount` is always a positive number — `kind`
//                          just says whether it was an expense or a payout;
//                          the register only cares that cash left.
//   cashRegisterOpening    STRING, JSON anchor point the running balance is
//                          computed forward from:
//                          { balance, sinceDateISO }
//                          Everything from the day AFTER sinceDateISO
//                          onward is added/subtracted automatically by
//                          computeCashRegister(); re-setting this (the
//                          admin panel's "точка отсчёта") both corrects the
//                          balance and bounds how far back a computation
//                          ever has to scan.
//
// Cash IN is read directly off booking records — every CUSTOMER booking's
// `payCash` field (set from the admin panel's booking-detail edit form, see
// api/admin/bookings.js) — never a separate ledger entry, so there's only
// one place cash-from-a-booking is ever recorded. Card/ERIP payments never
// touch this register at all: only physical cash affects the count in the
// drawer.

import { kv, kvPipeline, pairsToObject } from './_kv.js';

const OPENING_KEY = 'cashRegisterOpening';
const CASHOUTS_TTL_SECONDS = 60 * 60 * 24 * 400; // cashouts matter long-term for the register's history
const MAX_RANGE_DAYS = 400; // sanity cap so a very old opening date can't trigger a huge scan
const RECENT_WINDOW_DAYS = 30; // how far back the "recent entries" list in the admin UI looks
const DEFAULT_SINCE = '2020-01-01';

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y || 2020, (m || 1) - 1, d || 1);
}

// Every date strictly AFTER sinceISO, up to and including toISO.
function datesBetweenExclusiveStart(sinceISO, toISO) {
  const start = parseISO(sinceISO);
  const end = parseISO(toISO);
  const dates = [];
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() + 1);
  let guard = 0;
  while (cursor <= end && guard < MAX_RANGE_DAYS) {
    dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return dates;
}

// Parses a loosely-typed money value ("160", "160 Br", "160,50") into a
// plain number, defaulting to 0 for anything unparseable.
export function toAmount(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export async function getOpeningBalance() {
  const raw = await kv('get', OPENING_KEY);
  if (!raw) return { balance: 0, sinceDateISO: DEFAULT_SINCE };
  try {
    const obj = JSON.parse(raw);
    return {
      balance: toAmount(obj.balance),
      sinceDateISO: typeof obj.sinceDateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.sinceDateISO)
        ? obj.sinceDateISO
        : DEFAULT_SINCE,
    };
  } catch {
    return { balance: 0, sinceDateISO: DEFAULT_SINCE };
  }
}

export async function setOpeningBalance(balance, sinceDateISO) {
  await kv('set', OPENING_KEY, JSON.stringify({ balance: toAmount(balance), sinceDateISO }));
}

export async function getCashoutsForDate(dateISO) {
  const raw = await kv('get', `cashouts:${dateISO}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveCashoutsForDate(dateISO, list) {
  const key = `cashouts:${dateISO}`;
  if (!list.length) {
    await kv('del', key);
    return;
  }
  await kv('set', key, JSON.stringify(list));
  await kv('expire', key, CASHOUTS_TTL_SECONDS);
}

// Sums every customer booking's payCash across bookings:<date> AND
// history:<date> for the given dates in one pipelined round-trip. A
// booking that was later cancelled still counts here by default — if cash
// genuinely got refunded, the admin can just clear that booking's payCash
// by editing it.
async function sumCashInForDates(dates) {
  if (!dates.length) return 0;
  const results = await kvPipeline([
    ...dates.map((iso) => ['HGETALL', `bookings:${iso}`]),
    ...dates.map((iso) => ['HGETALL', `history:${iso}`]),
  ]);
  if (!results) return 0;
  let total = 0;
  results.forEach((entry) => {
    const obj = pairsToObject(entry && entry.result);
    Object.values(obj).forEach((raw) => {
      try {
        const record = JSON.parse(raw);
        if (record.type === 'customer') total += toAmount(record.payCash);
      } catch {
        // skip malformed entry
      }
    });
  });
  return total;
}

async function sumCashOutForDates(dates) {
  if (!dates.length) return 0;
  const results = await kvPipeline(dates.map((iso) => ['GET', `cashouts:${iso}`]));
  if (!results) return 0;
  let total = 0;
  results.forEach((entry) => {
    const raw = entry && entry.result;
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach((c) => { total += toAmount(c.amount); });
    } catch {
      // skip malformed entry
    }
  });
  return total;
}

// The full computed state of the register as of `toISO` (usually today):
// the manually-set opening balance, plus every cash movement since, plus a
// short recent-entries list for the admin panel.
export async function computeCashRegister(toISO) {
  const opening = await getOpeningBalance();
  const dates = datesBetweenExclusiveStart(opening.sinceDateISO, toISO);

  const [cashIn, cashOut] = await Promise.all([
    sumCashInForDates(dates),
    sumCashOutForDates(dates),
  ]);

  const balance = opening.balance + cashIn - cashOut;

  // Recent cashouts for the admin list — a separate, shorter window so the
  // panel doesn't have to render months of history every time it opens.
  const today = parseISO(toISO);
  const recentDates = [];
  for (let i = 0; i < RECENT_WINDOW_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    recentDates.push(isoDate(d));
  }
  const recentResults = await kvPipeline(recentDates.map((iso) => ['GET', `cashouts:${iso}`]));
  const recentCashouts = [];
  (recentResults || []).forEach((entry, i) => {
    const raw = entry && entry.result;
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((c) => recentCashouts.push({ ...c, dateISO: recentDates[i] }));
      }
    } catch {
      // skip malformed entry
    }
  });
  recentCashouts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return {
    balance,
    sinceDateISO: opening.sinceDateISO,
    openingBalance: opening.balance,
    asOfISO: toISO,
    cashIn,
    cashOut,
    recentCashouts: recentCashouts.slice(0, 50),
  };
}
