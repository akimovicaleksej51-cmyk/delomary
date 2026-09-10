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
} from '../_finance.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';

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

  if (req.method === 'GET') {
    const toISO = isValidDateISO(req.query && req.query.to) ? req.query.to : isoDate(new Date());
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
      list.push({ id: genId(), kind, label, amount, createdAt: new Date().toISOString() });
      await saveCashoutsForDate(cleanDateISO, list);
      const state = await computeCashRegister(isoDate(new Date()));
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
      const state = await computeCashRegister(isoDate(new Date()));
      return res.status(200).json({ ok: true, ...state });
    }

    if (body.action === 'setOpening') {
      const cleanDateISO = isValidDateISO(body.sinceDateISO) ? body.sinceDateISO : '';
      if (!cleanDateISO) {
        return res.status(400).json({ error: 'Укажите дату для точки отсчёта.' });
      }
      await setOpeningBalance(body.balance, cleanDateISO);
      const state = await computeCashRegister(isoDate(new Date()));
      return res.status(200).json({ ok: true, ...state });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
