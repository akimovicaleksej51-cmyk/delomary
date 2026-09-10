// Serverless function (Vercel Node.js runtime).
// Admin-only day-by-day financial report — the equivalent of the owner's
// old spreadsheet's per-day rows, computed from the same booking records
// "Касса" already reads (see ../_finance.js), plus totals broken down by
// booking source ("Источник брони") and by who actually worked each game.
// Same auth pattern as the other admin/* endpoints: every request needs
// the X-Admin-Password header, rate-limited per IP.
//
// GET ?to=<ISO date>&days=<n>
//   Returns { from, to, days: [{dateISO, bookings, cash, card, erip,
//   expenses, payroll, netChange}, ...], channels: {name: {count, total}},
//   actors: {name: gamesCount} } for `days` days ending at `to` (default:
//   today, 30 days back).

import { kv, kvPipeline, pairsToObject } from '../_kv.js';
import { toAmount } from '../_finance.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 92;

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && provided === adminPassword;
}

function isValidDateISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const ip = getClientIp(req);
  const rate = await checkRateLimit(ip);
  if (rate.limited) {
    return res.status(429).json({
      error: `Слишком много попыток входа. Попробуйте снова через ${retryAfterMinutesLabel(rate.retryAfterSeconds)}`,
    });
  }
  if (!checkAuth(req)) {
    await recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Неверный пароль.' });
  }
  await clearAttempts(ip);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let days = parseInt((req.query && req.query.days) || String(DEFAULT_DAYS), 10);
  if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
  days = Math.min(days, MAX_DAYS);

  const toISO = isValidDateISO(req.query && req.query.to) ? req.query.to : isoDate(new Date());
  const end = parseISO(toISO);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(isoDate(d));
  }

  const [bookingResults, historyResults, cashoutResults] = await Promise.all([
    kvPipeline(dates.map((iso) => ['HGETALL', `bookings:${iso}`])),
    kvPipeline(dates.map((iso) => ['HGETALL', `history:${iso}`])),
    kvPipeline(dates.map((iso) => ['GET', `cashouts:${iso}`])),
  ]);

  const byDay = {};
  dates.forEach((iso) => {
    byDay[iso] = { dateISO: iso, bookings: 0, cash: 0, card: 0, erip: 0, expenses: 0, payroll: 0 };
  });

  const channelTotals = {};
  const actorTotals = {};

  function ingestRecord(record, dateISO) {
    if (!record || record.type !== 'customer') return;
    const day = byDay[dateISO];
    if (day) {
      day.bookings += 1;
      day.cash += toAmount(record.payCash);
      day.card += toAmount(record.payCard);
      day.erip += toAmount(record.payErip);
    }

    const channel = record.channel || 'Не указан';
    if (!channelTotals[channel]) channelTotals[channel] = { count: 0, total: 0 };
    channelTotals[channel].count += 1;
    channelTotals[channel].total += toAmount(record.price);

    [record.workedActor, record.workedActress].filter(Boolean).forEach((name) => {
      if (!actorTotals[name]) actorTotals[name] = 0;
      actorTotals[name] += 1;
    });
  }

  (bookingResults || []).forEach((entry, i) => {
    const obj = pairsToObject(entry && entry.result);
    Object.values(obj).forEach((raw) => {
      try { ingestRecord(JSON.parse(raw), dates[i]); } catch { /* skip malformed */ }
    });
  });
  (historyResults || []).forEach((entry, i) => {
    const obj = pairsToObject(entry && entry.result);
    Object.values(obj).forEach((raw) => {
      try { ingestRecord(JSON.parse(raw), dates[i]); } catch { /* skip malformed */ }
    });
  });
  (cashoutResults || []).forEach((entry, i) => {
    const raw = entry && entry.result;
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((c) => {
          const day = byDay[dates[i]];
          if (!day) return;
          if (c.kind === 'payroll') day.payroll += toAmount(c.amount);
          else day.expenses += toAmount(c.amount);
        });
      }
    } catch {
      // skip malformed entry
    }
  });

  const daysOut = dates.map((iso) => {
    const d = byDay[iso];
    return { ...d, netChange: d.cash - d.expenses - d.payroll };
  });

  return res.status(200).json({
    from: dates[0],
    to: dates[dates.length - 1],
    days: daysOut,
    channels: channelTotals,
    actors: actorTotals,
  });
}
