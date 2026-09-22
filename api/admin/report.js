// Serverless function (Vercel Node.js runtime).
// Admin-only day-by-day financial report — the equivalent of the owner's
// old spreadsheet's per-day rows, computed from the same booking records
// "Касса" already reads (see ../_finance.js), plus totals broken down by
// booking source ("Источник брони") and by who actually worked each game.
// Same auth pattern as the other admin/* endpoints: every request needs
// the X-Admin-Password header, rate-limited per IP.
//
// GET ?to=<ISO date>&days=<n>&detailed=<0|1>
//   Returns { from, to, days: [{dateISO, bookings, cash, card, erip,
//   expenses, payroll, netChange}, ...], channels: {name: {count, total}},
//   actors: {name: gamesCount} } for `days` days ending at `to` (default:
//   today, 30 days back). The admin panel's "Финансы" tab drives this with
//   one calendar month at a time (from=1st, to=last day) so the counts
//   naturally reset at the start of every new month — this endpoint itself
//   is range-agnostic, the month semantics live entirely in the caller.
//
//   With detailed=1, the response ALSO includes `bookings: [...]` — every
//   raw booking/technical record in the range (both `type:'customer'` and
//   `type:'technical'`, active/cancelled/rescheduled alike), each with its
//   dateISO/time attached. This is what powers "скачать таблицу за период"
//   in the admin panel: the client-side booking list only ever caches
//   ~2 months of history, so a real period export has to come from the
//   server instead.

import { kv, kvPipeline, pairsToObject } from '../_kv.js';
import { toAmount } from '../_finance.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';
import { todayISO } from '../_time.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 92;

// 22.09.2026: two bugs found together via a real "Источники броней" screenshot
// (Сайт 12, Мир Квестов 0, ExtraReality 1, Всего 14 — 12+0+1 ≠ 14, and a real
// Мир Квестов booking that definitely existed wasn't showing under its tile
// at all):
//
//  1. CASE MISMATCH — api/mirkvestov.js tags real bookings with
//     channel:'Мир Квестов' (capital К), but admin.html's own tracked-source
//     list and its manual "Источник брони" dropdown both used 'Мир квестов'
//     (lowercase к). Grouping below was a plain object-key match on the raw
//     channel string, so a real Мир Квестов booking silently landed in its
//     OWN 'Мир Квестов' bucket, which the tracker never looked up — it stayed
//     invisible in its own tile while still being counted in "Всего" (which
//     sums every bucket regardless of name), which is exactly why the total
//     didn't match the sum of the three visible tiles.
//  2. Bookings the owner transferred BY HAND from Мир Квестов/ExtraReality
//     before either real API integration existed have no `channel` set at
//     all (defaulting to 'Sайт') — but the owner always wrote the real
//     source into the booking's `comment` instead. Sniffed for below so
//     those historical bookings finally count under the right tile too,
//     instead of silently padding "Сайт".
//
// This normalizes BOTH the real API's capitalization and any hand-typed
// variant to one canonical spelling, and only falls back to sniffing the
// comment when no explicit non-default channel was set — an explicitly
// chosen channel (Instagram, Телефон, Пинкертон, Сливки, Бартер, ...) is
// never second-guessed by a comment.
function canonicalChannel(record) {
  const raw = typeof record.channel === 'string' ? record.channel.trim() : '';
  const lower = raw.toLowerCase();

  if (lower === 'мир квестов') return 'Мир Квестов';
  if (lower === 'extrareality') return 'ExtraReality';
  if (raw && lower !== 'сайт') return raw; // some other explicitly-chosen source — keep as typed

  const comment = typeof record.comment === 'string' ? record.comment.toLowerCase() : '';
  if (/экстра|extra\s*reality/.test(comment)) return 'ExtraReality';
  if (/мир\s*квест/.test(comment)) return 'Мир Квестов';

  return raw || 'Сайт';
}

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

  const toISO = isValidDateISO(req.query && req.query.to) ? req.query.to : todayISO();
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
  const wantDetailed = String((req.query && req.query.detailed) || '') === '1';
  const detailedRows = [];
  // 22.09.2026: the owner counted the admin panel's own booking list by hand
  // (20 rows for September) and compared it to "Источники броней" (14) —
  // they didn't match, but this time NOT because of a bug: GET on this same
  // file's neighbor, api/admin/bookings.js, explicitly returns "every
  // booking AND history entry (customer OR technical)" (see its own header
  // comment), while "Источники броней" only ever counted type:'customer'
  // records on purpose — a technical/blocked slot has no real "source" to
  // attribute (it's not a customer booking from any channel). The 6-booking
  // gap was very likely exactly that many technical/blocked-day entries.
  // Surfaced explicitly here (instead of just silently excluding them) so
  // admin.html can show it next to "Всего" and the numbers always visibly
  // add up to what the booking list shows, instead of one looking "wrong".
  let technicalCount = 0;

  function ingestRecord(record, dateISO) {
    if (!record) return;
    // 22.09.2026: computed up front (not just inside the customer-only branch
    // below) so it can also ride along on detailed rows as `channelCanonical`
    // — the owner wants to click a source tile ("Сайт" / "Мир Квестов" /
    // ExtraReality / "Всего" / "Технич.") on admin.html's main screen and see
    // that exact month's bookings, by date and time, without leaving the
    // site. The client can't recompute canonicalChannel() itself (it doesn't
    // have record.comment sniffing logic, and shouldn't have to duplicate
    // it), so the server does it once here and hands back the already-
    // normalized value alongside each raw row.
    const channelCanonical = record.type === 'customer' ? canonicalChannel(record) : null;
    if (wantDetailed) detailedRows.push({ ...record, dateISO, time: record.time || '', channelCanonical });
    if (record.type === 'technical') { technicalCount += 1; return; }
    if (record.type !== 'customer') return;
    const day = byDay[dateISO];
    if (day) {
      day.bookings += 1;
      day.cash += toAmount(record.payCash);
      day.card += toAmount(record.payCard);
      day.erip += toAmount(record.payErip);
    }

    // Бронь без явно указанного источника — это бронь, созданная прямо в
    // админке (или отредактированная так, что поле осталось пустым), ИЛИ
    // историческая бронь с сайта-агрегатора, перенесённая вручную ДО того,
    // как заработало настоящее API — см. canonicalChannel() выше для того,
    // как и то, и другое, и разный регистр "Мир Квестов"/"Мир квестов"
    // сводятся к одному счётчику.
    const channel = channelCanonical;
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
    technicalCount,
    ...(wantDetailed ? { bookings: detailedRows } : {}),
  });
}
