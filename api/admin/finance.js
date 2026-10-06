// Serverless function (Vercel Node.js runtime).
// Admin-only "Касса" (cash register) endpoint — a running cash balance
// computed from a manually-set opening anchor plus every booking's payCash
// field and every manually-logged cash outflow (expense or payroll/
// "инкассация" payout) since. Same auth pattern as the other admin/*
// endpoints: every request needs the X-Admin-Password header, rate-limited
// per IP (see ../_ratelimit.js).
//
// GET  ?to=<ISO date>
//   Returns the computed register state as of that date (default: today) —
//   see computeCashRegister() in ../_finance.js for the exact shape.
//
// POST body.action:
//   { action:'addCashout', dateISO, kind, label, amount }
//       Logs a cash outflow on that date. kind is 'expense' or 'payroll'.
//   { action:'deleteCashout', dateISO, id }
//       Removes one previously-logged cashout.
// 05.10.2026 additions (owner's request — "потерялись 180 Br"):
//   GET ?ledger=1&from=<ISO>&to=<ISO>
//       Day-by-day cash ledger for Бухгалтерия: start/end of every shift,
//       every booking's cash and every расход/ЗП/инкассация behind those
//       numbers, physical counts, "точка отсчёта" changes. See
//       buildCashLedger() in ../_finance.js.
//   { action:'addCashCount', amount, note }
//       Records a physical count of the drawer right now, together with what
//       Касса expected at that moment.
//   { action:'deleteCashCount', dateISO, id }
//
//   { action:'settleUnpaid', items:[{ actor, games:['YYYY-MM-DD|HH:MM'] }] }
//       06.10.2026: marks games as already paid out WITHOUT changing the
//       register (stored in payrollSettled, see ../_finance.js).
//   { action:'deleteSettled', id }
//
//   { action:'setOpening', balance, sinceDateISO }
//       Re-anchors the running balance: "as of this date, the register had
//       this much cash" — everything up to and including sinceDateISO is
//       no longer scanned, which also keeps computeCashRegister fast.
//
// Every POST action returns the freshly recomputed state (same shape as
// GET) so the admin panel never needs a second round-trip to refresh.

import {
  getCashoutsForDate,
  saveCashoutsForDate,
  setOpeningBalance,
  computeCashRegister,
  toAmount,
  getCashCounts,
  saveCashCounts,
  buildCashLedger,
  balanceAtStartOf,
  appendOpeningLog,
  getPaidGamesForActor,
  getSettledMarkers,
  saveSettledMarkers,
} from '../_finance.js';
import { formatDateRu } from '../_telegram.js';
import { kv } from '../_kv.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel, safeEqual } from '../_ratelimit.js';
import { todayISO } from '../_time.js';

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && typeof provided === 'string' && safeEqual(provided, adminPassword);
}

function isValidDateISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  if (req.method === 'GET' && req.query && String(req.query.ledger) === '1') {
    const today = todayISO();
    const toISO = isValidDateISO(req.query.to) ? req.query.to : today;
    const fromISO = isValidDateISO(req.query.from) ? req.query.from : toISO;
    if (fromISO > toISO) return res.status(400).json({ error: 'Некорректный период.' });
    const ledger = await buildCashLedger(fromISO, toISO, today);
    return res.status(200).json({ ok: true, today, ...ledger });
  }

  if (req.method === 'GET') {
    const toISO = isValidDateISO(req.query && req.query.to) ? req.query.to : todayISO();
    const state = await computeCashRegister(toISO);
    return res.status(200).json(state);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    if (body.action === 'addCashout') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const kind = body.kind === 'payroll' ? 'payroll' : 'expense';
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : '';
      const amount = toAmount(body.amount);
      if (!cleanDateISO || !label || !(amount > 0)) {
        return res.status(400).json({ error: 'Укажите дату, описание и сумму больше нуля.' });
      }
      const list = await getCashoutsForDate(cleanDateISO);
      const entry = { id: genId(), kind, label, amount, createdAt: new Date().toISOString() };
      // 06.10.2026: a ЗП payout can now be tied to a person and to the exact
      // games it pays for ("YYYY-MM-DD|HH:MM"), so Бухгалтерия can show for
      // every actor which days are already paid and which aren't.
      if (kind === 'payroll' && typeof body.actor === 'string' && body.actor.trim()) {
        entry.actor = body.actor.trim().slice(0, 60);
        entry.paidGames = [...new Set((Array.isArray(body.paidGames) ? body.paidGames : [])
          .filter((g) => typeof g === 'string' && /^\d{4}-\d{2}-\d{2}\|.{1,20}$/.test(g)))]
          .slice(0, 300);
        // 06.10.2026: the same game can't be paid twice (an actor marking it
        // themselves in staff.html AND a manager paying it in admin.html).
        if (entry.paidGames.length) {
          const already = await getPaidGamesForActor(entry.actor, todayISO());
          const dup = entry.paidGames.filter((k) => already.has(k));
          if (dup.length) {
            const days = [...new Set(dup.map((k) => k.split('|')[0]))].sort().map(formatDateRu);
            return res.status(409).json({ error: `Часть игр уже отмечена как выплаченная (${days.join(', ')}). Обновите список и отметьте заново.` });
          }
        }
        // 06.10.2026: an actor can record "забрал ЗП" themselves from
        // staff.html — the entry is marked as such and shows up in
        // admin.html's Бухгалтерия and Касса like any payout. (Update 91:
        // no Telegram message any more — owner's request.)
        if (body.selfReported === true) entry.selfReported = true;
      }
      list.push(entry);
      await saveCashoutsForDate(cleanDateISO, list);
      const state = await computeCashRegister(todayISO());
      return res.status(200).json({ ok: true, ...state });
    }

    if (body.action === 'deleteCashout') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const id = typeof body.id === 'string' ? body.id : '';
      if (!cleanDateISO || !id) {
        return res.status(400).json({ error: 'Некорректный запрос.' });
      }
      const list = await getCashoutsForDate(cleanDateISO);
      const next = list.filter((c) => c.id !== id);
      await saveCashoutsForDate(cleanDateISO, next);
      const state = await computeCashRegister(todayISO());
      return res.status(200).json({ ok: true, ...state });
    }

    // 06.10.2026 (update 91): "все деньги уже забирали" — mark games as paid
    // WITHOUT taking cash out of the register (it was handed out earlier and
    // is already part of the balance). Body: { items:[{ actor, games:[key] }] }.
    // Games that are already paid, or in the future, are skipped silently.
    if (body.action === 'settleUnpaid') {
      const today = todayISO();
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      const markers = await getSettledMarkers();
      const createdAt = new Date().toISOString();
      let games = 0;
      const people = [];
      for (const it of items) {
        const actor = it && typeof it.actor === 'string' ? it.actor.trim().slice(0, 60) : '';
        if (!actor) continue;
        const keys = [...new Set((Array.isArray(it.games) ? it.games : [])
          .filter((g) => typeof g === 'string' && /^\d{4}-\d{2}-\d{2}\|.{1,20}$/.test(g) && g.slice(0, 10) <= today))]
          .slice(0, 2000);
        if (!keys.length) continue;
        // eslint-disable-next-line no-await-in-loop
        const already = await getPaidGamesForActor(actor, today);
        markers.forEach((m) => { if (m.actor === actor) (m.paidGames || []).forEach((k) => already.add(k)); });
        const fresh = keys.filter((k) => !already.has(k)).sort();
        if (!fresh.length) continue;
        markers.push({ id: genId(), actor, paidGames: fresh, dateISO: today, createdAt, label: 'Отмечено как выплаченное ранее' });
        games += fresh.length;
        people.push(actor);
      }
      if (games) {
        try {
          await saveSettledMarkers(markers);
        } catch {
          return res.status(503).json({ error: 'Не удалось сохранить. Попробуйте ещё раз.' });
        }
      }
      return res.status(200).json({ ok: true, settledGames: games, people });
    }

    if (body.action === 'deleteSettled') {
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) return res.status(400).json({ error: 'Некорректный запрос.' });
      const markers = await getSettledMarkers();
      try {
        await saveSettledMarkers(markers.filter((m) => m.id !== id));
      } catch {
        return res.status(503).json({ error: 'Не удалось сохранить. Попробуйте ещё раз.' });
      }
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'addCashCount') {
      const raw = body.amount;
      const amount = toAmount(raw);
      if (raw == null || String(raw).trim() === '' || !/\d/.test(String(raw)) || amount < 0) {
        return res.status(400).json({ error: 'Укажите, сколько денег фактически в кассе.' });
      }
      const today = todayISO();
      const before = await computeCashRegister(today);
      const list = await getCashCounts(today);
      list.push({
        id: genId(),
        amount,
        expected: before.balance,
        at: new Date().toISOString(),
        note: typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '',
      });
      await saveCashCounts(today, list);
      const state = await computeCashRegister(today);
      return res.status(200).json({ ok: true, ...state });
    }

    if (body.action === 'deleteCashCount') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const id = typeof body.id === 'string' ? body.id : '';
      if (!cleanDateISO || !id) {
        return res.status(400).json({ error: 'Некорректный запрос.' });
      }
      const list = await getCashCounts(cleanDateISO);
      await saveCashCounts(cleanDateISO, list.filter((c) => c.id !== id));
      const state = await computeCashRegister(todayISO());
      return res.status(200).json({ ok: true, ...state });
    }

    // 05.10.2026: a CANCELLED booking keeps its payCash in history:<date>, and
    // Касса keeps counting it (on purpose — cancelling doesn't un-collect
    // cash). But if the money was actually handed back, or the client was
    // re-booked as a new booking with the cash entered again, there was no
    // way at all to correct it: the booking edit form only works on ACTIVE
    // bookings. So the register kept expecting money that isn't in the
    // drawer, forever. This removes the cash from that one cancelled record
    // (keeping the old amount on it for the record) — Бухгалтерия shows a
    // button for it next to every flagged entry.
    if (body.action === 'clearCancelledCash') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const key = typeof body.key === 'string' ? body.key.slice(0, 80) : '';
      if (!cleanDateISO || !key) return res.status(400).json({ error: 'Некорректный запрос.' });
      const hashKey = `history:${cleanDateISO}`;
      const raw = await kv('hget', hashKey, key);
      let record = null;
      try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
      if (!record || record.type !== 'customer' || record.status !== 'cancelled') {
        return res.status(404).json({ error: 'Отменённая бронь не найдена.' });
      }
      if (!toAmount(record.payCash)) {
        return res.status(200).json({ ok: true, alreadyClear: true });
      }
      const updated = {
        ...record,
        payCashRemoved: record.payCash,
        payCashRemovedAt: new Date().toISOString(),
        payCash: '',
      };
      await kv('hset', hashKey, key, JSON.stringify(updated));
      const state = await computeCashRegister(todayISO());
      return res.status(200).json({ ok: true, ...state });
    }

    if (body.action === 'setOpening') {
      const cleanDateISO = isValidDateISO(body.sinceDateISO) ? body.sinceDateISO : '';
      if (!cleanDateISO) {
        return res.status(400).json({ error: 'Укажите дату для точки отсчёта.' });
      }
      // 05.10.2026: remember what the register said right before the anchor
      // is overwritten, so Бухгалтерия can show "здесь точку отсчёта
      // переставили: по расчёту было X, поставили Y" instead of the old
      // history silently vanishing.
      let computedBefore = null;
      try { computedBefore = await balanceAtStartOf(cleanDateISO); } catch { computedBefore = null; }
      await setOpeningBalance(body.balance, cleanDateISO);
      await appendOpeningLog({
        at: new Date().toISOString(),
        sinceDateISO: cleanDateISO,
        balance: toAmount(body.balance),
        computedBefore,
      });
      const state = await computeCashRegister(todayISO());
      return res.status(200).json({ ok: true, ...state });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
