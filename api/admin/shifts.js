// Serverless function (Vercel Node.js runtime).
// Admin-only endpoint for the weekly actor-shift schedule that drives
// Telegram reminders (see api/_reminders.js for the full data model and
// api/telegram-webhook.js for how an actor's username becomes messageable).
// Same auth pattern as api/admin/bookings.js: every request needs the
// X-Admin-Password header, rate-limited per IP.
//
// GET  ?from=<ISO date>&days=<n>
//   Returns { shifts: { '<ISO date>': [ {id,start,end,actorUsername}, ... ] },
//             actors: { '<username>': { displayName, registered: bool } } }
//   for `days` consecutive dates starting at `from` (default 14, max 31).
//   `actors` only exposes displayName/registered — never the chat id.
//
// POST body.action:
//   { action:'addShift', dateISO, start, end, actorUsername }
//       Appends a shift to that date (start/end "HH:MM", end after start).
//       No overlap check against other shifts on purpose — a real actor
//       could legitimately be listed for a stand-in slot; the admin is
//       trusted to enter it sensibly.
//   { action:'deleteShift', dateISO, shiftId }
//       Removes one shift from that date.

import { getShiftsForDate, saveShiftsForDate, getActorsMap } from '../_reminders.js';
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

    if (body.action === 'addShift') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanStart = isValidHHMM(body.start) ? body.start : '';
      const cleanEnd = isValidHHMM(body.end) ? body.end : '';
      const cleanActor = typeof body.actorUsername === 'string'
        ? body.actorUsername.trim().replace(/^@/, '').toLowerCase().slice(0, 40)
        : '';

      if (!cleanDateISO || !cleanStart || !cleanEnd || !cleanActor) {
        return res.status(400).json({ error: 'Заполните дату, время начала/конца и актёра.' });
      }
      if (cleanEnd <= cleanStart) {
        return res.status(400).json({ error: 'Время окончания должно быть позже начала.' });
      }

      const shifts = await getShiftsForDate(cleanDateISO);
      const shift = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        start: cleanStart,
        end: cleanEnd,
        actorUsername: cleanActor,
      };
      shifts.push(shift);
      shifts.sort((a, b) => a.start.localeCompare(b.start));
      await saveShiftsForDate(cleanDateISO, shifts);

      return res.status(200).json({ ok: true, shifts });
    }

    if (body.action === 'deleteShift') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const shiftId = typeof body.shiftId === 'string' ? body.shiftId : '';
      if (!cleanDateISO || !shiftId) {
        return res.status(400).json({ error: 'Укажите дату и смену.' });
      }

      const shifts = await getShiftsForDate(cleanDateISO);
      const next = shifts.filter((s) => s.id !== shiftId);
      await saveShiftsForDate(cleanDateISO, next);

      return res.status(200).json({ ok: true, shifts: next });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
