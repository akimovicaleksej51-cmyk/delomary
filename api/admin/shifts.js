// Serverless function (Vercel Node.js runtime).
// Admin-only endpoint for the weekly actor-shift schedule that drives
// Telegram reminders (see api/_reminders.js for the full data model and
// api/telegram-webhook.js for how an actor's username becomes messageable).
// Same auth pattern as api/admin/bookings.js: every request needs the
// X-Admin-Password header, rate-limited per IP.
//
// Every day has exactly 4 fixed slots (SHIFT_SLOTS in api/_reminders.js):
// two for an actor, two for an actress. The admin panel always shows all
// 4 rows for every visible day — there's no open-ended "add a shift" list,
// just filling in (or clearing) one of the 4 slots.
//
// GET  ?from=<ISO date>&days=<n>
//   Returns { shifts: { '<ISO date>': { 'actor-1': {start,end,actorUsername}, ... } },
//             actors: { '<username>': { displayName, registered: bool } } }
//   for `days` consecutive dates starting at `from` (default 14, max 31).
//   A day with nothing filled in simply has {} — missing slots aren't sent.
//   `actors` only exposes displayName/registered — never the chat id.
//
// POST body.action:
//   { action:'setSlot', dateISO, slot, start, end, actorUsername }
//       Fills in one of the 4 slots for that date (slot must be one of
//       SHIFT_SLOTS). Send start/end/actorUsername all empty to CLEAR that
//       slot instead (removes it from that date's schedule).

import { getShiftsForDate, saveShiftsForDate, getActorsMap, SHIFT_SLOTS } from '../_reminders.js';
import { scheduleCloseout, cancelCloseout } from '../_closeout.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && provided === adminPassword;
}

function isValidDateISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    const fromISO = isValidDateISO(req.query && req.query.from) ? req.query.from : isoDate(new Date());
    let days = parseInt((req.query && req.query.days) || '14', 10);
    if (!Number.isFinite(days) || days < 1) days = 14;
    days = Math.min(days, 31);

    const [y, m, d] = fromISO.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    const dates = [];
    for (let i = 0; i < days; i++) {
      const dd = new Date(start);
      dd.setDate(start.getDate() + i);
      dates.push(isoDate(dd));
    }

    const shiftsByDate = {};
    await Promise.all(dates.map(async (iso) => {
      shiftsByDate[iso] = await getShiftsForDate(iso);
    }));

    const actorsRaw = await getActorsMap();
    const actors = {};
    Object.entries(actorsRaw).forEach(([username, info]) => {
      actors[username] = { displayName: info.displayName || '', registered: Boolean(info.chatId) };
    });

    return res.status(200).json({ shifts: shiftsByDate, actors });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    if (body.action === 'setSlot') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const slot = typeof body.slot === 'string' ? body.slot : '';
      if (!cleanDateISO || !SHIFT_SLOTS.includes(slot)) {
        return res.status(400).json({ error: 'Некорректная дата или смена.' });
      }

      const cleanStart = isValidHHMM(body.start) ? body.start : '';
      const cleanEnd = isValidHHMM(body.end) ? body.end : '';
      const cleanActor = typeof body.actorUsername === 'string'
        ? body.actorUsername.trim().replace(/^@/, '').toLowerCase().slice(0, 40)
        : '';

      const shiftsMap = await getShiftsForDate(cleanDateISO);

      // Whatever this slot used to be, any end-of-shift check-in scheduled
      // for it is now stale — cancel it before deciding whether to
      // schedule a fresh one below.
      await cancelCloseout(cleanDateISO, slot);

      // All three fields blank → clear this slot instead of setting it.
      if (!cleanStart && !cleanEnd && !cleanActor) {
        delete shiftsMap[slot];
        await saveShiftsForDate(cleanDateISO, shiftsMap);
        return res.status(200).json({ ok: true, shifts: shiftsMap });
      }

      if (!cleanStart || !cleanEnd || !cleanActor) {
        return res.status(400).json({ error: 'Заполните время начала, конца и username — или очистите все три поля, чтобы убрать смену.' });
      }
      if (cleanEnd <= cleanStart) {
        return res.status(400).json({ error: 'Время окончания должно быть позже начала.' });
      }

      shiftsMap[slot] = { start: cleanStart, end: cleanEnd, actorUsername: cleanActor };
      await saveShiftsForDate(cleanDateISO, shiftsMap);
      // Best-effort: schedules the actor's end-of-shift check-in message —
      // see api/_closeout.js. Never blocks or fails saving the shift.
      await scheduleCloseout(cleanDateISO, slot, shiftsMap[slot]);

      return res.status(200).json({ ok: true, shifts: shiftsMap });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
