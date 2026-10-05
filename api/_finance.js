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

// Every date from sinceISO through toISO, BOTH inclusive — capped to the
// MAX_RANGE_DAYS closest to toISO (not the ones right after sinceISO).
//
// "Opening balance" here means the standard bookkeeping sense: the amount
// in the register at the START of sinceISO, before that day's own activity
// — so sinceISO's own bookings/cashouts still count on top of it. This
// matters for the common real workflow: someone opens Касса mid-day, counts
// the physical cash, and sets that as today's opening balance BEFORE
// logging anything else today — every booking or expense they then record
// today (and every day after) needs to add on top of that number, or the
// balance looks stuck at whatever it was for the rest of the day.
//
// The MAX_RANGE_DAYS cap also matters on its own: nobody is required to set
// an opening balance before using Касса at all, so sinceISO defaults to
// DEFAULT_SINCE (a fixed date years in the past). Counting forward from
// THAT date would spend the entire 400-day budget on ancient history and
// never reach "today" — every cashout and every booking's cash would
// silently never be counted, and the balance would look permanently stuck.
// Counting backward from toISO instead guarantees recent activity (today
// included) is always in range, at the cost of ignoring anything older
// than MAX_RANGE_DAYS when nobody has ever set a real opening balance —
// which is fine, since KV itself doesn't keep bookings/cashouts that old.
function datesFromAnchor(sinceISO, toISO) {
  const start = parseISO(sinceISO);
  const end = parseISO(toISO);
  const totalDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (totalDays <= 0) return [];
  const daysToInclude = Math.min(totalDays, MAX_RANGE_DAYS);
  const dates = [];
  for (let i = daysToInclude - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(isoDate(d));
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
//
// 23.09.2026: a RESCHEDULED booking is different from a cancelled one, and
// is deliberately excluded here — when a booking moves to a new date/time
// (api/admin/bookings.js's 'reschedule' action), the vacated slot's old
// record is kept in history:<fromDate> as a status:'rescheduled' snapshot
// purely so the move stays visible there, but it's still the exact same
// payment as the live record now sitting at the new date/time — counting
// both was double-counting every single payment on every reschedule (a
// 200 Br cash booking moved from Tuesday to Thursday made Касса show 400
// Br for one game, permanently, since nothing ever reconciled it). This
// filter fixes it retroactively too, since the total is computed fresh
// from these records every time rather than stored pre-summed anywhere.
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
        if (record.type === 'customer' && record.status !== 'rescheduled') total += toAmount(record.payCash);
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
  const dates = datesFromAnchor(opening.sinceDateISO, toISO);

  const [cashIn, cashOut] = await Promise.all([
    sumCashInForDates(dates),
    sumCashOutForDates(dates),
  ]);

  const balance = opening.balance + cashIn - cashOut;

  // 05.10.2026: "на начало смены" / "на конец смены" (owner's request). A
  // shift here = one business day. Start of shift = what was in the drawer
  // when today began = end of the previous shift, already net of any
  // инкассация/расход dated on an earlier day. End of shift = the running
  // balance right now, including everything recorded for today so far.
  // Only meaningful once toISO is inside the tracked range; if the anchor
  // ("точка отсчёта") was set for today itself, start of shift is just the
  // anchor amount.
  const [shiftIn, shiftOut, shiftCounts] = dates.includes(toISO)
    ? await Promise.all([sumCashInForDates([toISO]), sumCashOutForDates([toISO]), getCashCounts(toISO)])
    : [0, 0, await getCashCounts(toISO)];
  const shiftStart = balance - shiftIn + shiftOut;

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
    shift: {
      dateISO: toISO,
      start: shiftStart,
      cashIn: shiftIn,
      cashOut: shiftOut,
      end: balance,
      counts: shiftCounts,
    },
  };
}

// ============================================================================
// 05.10.2026: "куда делись 180 Br" — shift start/end, cash counts, and a
// day-by-day ledger (owner's request).
//
// Data model additions:
//   cashcount:<ISO date>    STRING, JSON array of physical cash counts done
//                            that day: [{ id, amount, expected, at, note }]
//                            `expected` is what Касса computed at the moment
//                            of counting, so the difference stays exactly
//                            what the person saw, even if records are edited
//                            later.
//   cashRegisterOpeningLog  STRING, JSON array (newest last, capped) of every
//                            "точка отсчёта" change: { at, sinceDateISO,
//                            balance, computedBefore } — `computedBefore` is
//                            what the register said the drawer held at the
//                            start of that day just BEFORE it was overwritten.
//                            Re-setting the anchor used to leave no trace at
//                            all, which is exactly the kind of thing that makes
//                            a shortfall impossible to find afterwards.
// ============================================================================

const CASHCOUNT_TTL_SECONDS = 60 * 60 * 24 * 400;
const OPENING_LOG_KEY = 'cashRegisterOpeningLog';
const OPENING_LOG_MAX = 100;
const LEDGER_MAX_DAYS = 62;

export async function getCashCounts(dateISO) {
  const raw = await kv('get', `cashcount:${dateISO}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveCashCounts(dateISO, list) {
  const key = `cashcount:${dateISO}`;
  if (!list.length) {
    await kv('del', key);
    return;
  }
  await kv('set', key, JSON.stringify(list));
  await kv('expire', key, CASHCOUNT_TTL_SECONDS);
}

export async function getOpeningLog() {
  const raw = await kv('get', OPENING_LOG_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function appendOpeningLog(entry) {
  const list = await getOpeningLog();
  list.push(entry);
  await kv('set', OPENING_LOG_KEY, JSON.stringify(list.slice(-OPENING_LOG_MAX)));
}

function prevISO(iso) {
  const d = parseISO(iso);
  d.setDate(d.getDate() - 1);
  return isoDate(d);
}

// What the register says was in the drawer at the START of dateISO, under the
// CURRENT anchor — or null if that day is before the tracked range.
export async function balanceAtStartOf(dateISO) {
  const opening = await getOpeningBalance();
  if (dateISO < opening.sinceDateISO) return null;
  if (dateISO === opening.sinceDateISO) return opening.balance;
  const state = await computeCashRegister(prevISO(dateISO));
  return state.balance;
}

function cashInEntry(record, timeKey, where) {
  const amount = toAmount(record.payCash);
  if (!amount) return null; // negative = a refund typed in as minus — still counted, like the register does
  if (record.type !== 'customer' || record.status === 'rescheduled') return null;
  const cancelled = record.status === 'cancelled';
  return {
    time: record.time || String(timeKey).split('@')[0],
    name: record.name || '',
    phone: record.phone || '',
    amount,
    price: toAmount(record.price),
    payCard: toAmount(record.payCard),
    payErip: toAmount(record.payErip),
    channel: record.channel || '',
    status: cancelled ? 'cancelled' : 'active',
    where,
    key: String(timeKey), // hash field — lets Бухгалтерия fix a cancelled booking's cash
    // A cancelled booking still counts in Касса on purpose (cash already
    // taken isn't un-collected by a cancel) — but if the money was handed
    // back, or the same client was simply re-booked as a NEW booking with
    // the cash entered again, the register now expects money that isn't in
    // the drawer. The single most likely cause of an unexplained shortfall,
    // so it's flagged loudly in the ledger.
    warning: cancelled ? 'cancelled-with-cash' : '',
  };
}

// Day-by-day ledger for [fromISO, toISO] (clamped to today and to
// LEDGER_MAX_DAYS), using EXACTLY the same rules as computeCashRegister so the
// last day's closing always equals the Касса balance.
export async function buildCashLedger(fromISO, toISO, todayISOValue) {
  const lastISO = toISO > todayISOValue ? todayISOValue : toISO;
  if (fromISO > lastISO) return { days: [], anchor: await getOpeningBalance(), openingLog: await getOpeningLog() };

  const range = [];
  {
    const end = parseISO(lastISO);
    const start = parseISO(fromISO);
    const total = Math.round((end - start) / 86400000) + 1;
    const n = Math.min(total, LEDGER_MAX_DAYS);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      range.push(isoDate(d));
    }
  }

  const [opening, openingLog] = await Promise.all([getOpeningBalance(), getOpeningLog()]);
  // The set of days the register actually sums over, computed exactly like
  // computeCashRegister(today) does.
  const regDates = datesFromAnchor(opening.sinceDateISO, todayISOValue);
  const regStart = regDates.length ? regDates[0] : todayISOValue;
  const tracked = (iso) => iso >= regStart && iso <= todayISOValue;

  // Balance at the start of the first tracked day in range.
  const firstTracked = range.find(tracked);
  let running = null;
  if (firstTracked) {
    const before = regDates.filter((iso) => iso < firstTracked);
    const [inBefore, outBefore] = await Promise.all([sumCashInForDates(before), sumCashOutForDates(before)]);
    running = opening.balance + inBefore - outBefore;
  }

  const [bookingRes, historyRes, cashoutRes, countRes] = await Promise.all([
    kvPipeline(range.map((iso) => ['HGETALL', `bookings:${iso}`])),
    kvPipeline(range.map((iso) => ['HGETALL', `history:${iso}`])),
    kvPipeline(range.map((iso) => ['GET', `cashouts:${iso}`])),
    kvPipeline(range.map((iso) => ['GET', `cashcount:${iso}`])),
  ]);

  const days = range.map((iso, i) => {
    const ins = [];
    [[bookingRes, 'bookings'], [historyRes, 'history']].forEach(([resArr, where]) => {
      const obj = pairsToObject(resArr && resArr[i] && resArr[i].result);
      Object.entries(obj).forEach(([key, raw]) => {
        try {
          const e = cashInEntry(JSON.parse(raw), key, where);
          if (e) ins.push(e);
        } catch { /* skip malformed */ }
      });
    });
    ins.sort((a, b) => String(a.time).localeCompare(String(b.time)));

    let outs = [];
    try {
      const raw = cashoutRes && cashoutRes[i] && cashoutRes[i].result;
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        outs = arr.map((c) => ({
          id: c.id, kind: c.kind === 'payroll' ? 'payroll' : 'expense', label: c.label || '',
          amount: toAmount(c.amount), createdAt: c.createdAt || '',
        }));
      }
    } catch { /* skip */ }
    outs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    let counts = [];
    try {
      const raw = countRes && countRes[i] && countRes[i].result;
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) counts = arr;
    } catch { /* skip */ }

    const cashIn = ins.reduce((sum, e) => sum + e.amount, 0);
    const cashOut = outs.reduce((sum, e) => sum + e.amount, 0);
    const isTracked = tracked(iso);
    const anchorEvents = openingLog.filter((l) => l.sinceDateISO === iso);
    let openingBal = null;
    let closingBal = null;
    if (isTracked && running != null) {
      openingBal = running;
      closingBal = running + cashIn - cashOut;
      running = closingBal;
    }
    return {
      dateISO: iso,
      tracked: isTracked,
      isAnchorDay: iso === opening.sinceDateISO,
      opening: openingBal,
      closing: closingBal,
      cashIn,
      cashOut,
      ins,
      outs,
      counts,
      anchorEvents,
      warnings: ins.filter((e) => e.warning).length,
    };
  });

  return { days, anchor: opening, regStart, openingLog };
}
