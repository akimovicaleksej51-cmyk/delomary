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
//       slot instead (removes it from that date's schedule). Also
//       BACKFILLS: any booking already on this date that falls inside the
//       new slot's time range, and doesn't yet have a reminder/sverka
//       scheduled for this performer, gets one scheduled right now — see
//       backfillScheduling() below. This matters a lot in practice: if a
//       booking gets entered (from the site or the admin panel) BEFORE the
//       shift for that time is assigned, scheduleReminder()/
//       scheduleGameCloseout() find no performer yet and schedule nothing
//       — and without this backfill, that booking's sverka would only ever
//       get caught by the once-a-day cron sweep (api/cron/reminders-sweep.js),
//       which could be many hours after the game already happened. Setting
//       the shift (even just re-saving the same slot) now immediately
//       fixes that instead of waiting on the sweep.
//   { action:'runCloseoutNow', dateISO, slot }
//       Manually sends the sverka right now for every booking in that
//       (date, slot) shift that hasn't been sent one yet — regardless of
//       whether each booking's own 80-minutes-after-start automatic QStash
//       job has already fired. See runCloseoutForSlot() in
//       api/_closeout.js (each shift's actual per-booking sverka timing is
//       now set independently by scheduleGameCloseout() when the booking
//       is created — this button doesn't change that schedule, it's purely
//       "send anything still pending, right now"). Only (re)sends for
//       bookings that don't already have a reply/awaiting status, so it's
//       always safe to click again.

import { kv } from '../_kv.js';
import { getShiftsForDate, saveShiftsForDate, getActorsMap, SHIFT_SLOTS, scheduleReminder } from '../_reminders.js';
import { runCloseoutForSlot, scheduleGameCloseout } from '../_closeout.js';
import { getClientIp, checkRateLimit, recordFailedAttempt, clearAttempts, retryAfterMinutesLabel } from '../_ratelimit.js';
import { todayISO } from '../_time.js';

// Whenever a shift slot is (re)saved, catch up any booking on that date
// that falls inside the slot's [start, end) range but is still missing a
// reminder or sverka job for the performer now assigned there — see the
// long comment above action 'setSlot'. Safe to call unconditionally and
// repeatedly: scheduleReminder()/scheduleGameCloseout() never duplicate a
// performer who already has one successfully scheduled.
async function backfillScheduling(dateISO, slotData) {
  if (!slotData || !slotData.start || !slotData.end) return;
  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hgetall', hashKey);
  if (!Array.isArray(raw) || !raw.length) return;

  await Promise.all(Array.from({ length: Math.floor(raw.length / 2) }, (_, i) => i).map(async (i) => {
    const time = raw[i * 2];
    let record;
    try { record = JSON.parse(raw[i * 2 + 1]); } catch { return; }
    if (!record || record.type !== 'customer') return;
    if (record.status === 'cancelled' || record.status === 'rescheduled') return;
    const resolvedTime = record.time || time;
    if (!(slotData.start <= resolvedTime && resolvedTime < slotData.end)) return;

    const fullRecord = { ...record, dateISO: record.dateISO || dateISO, time: resolvedTime };
    const [reminderPatch, closeoutPatch] = await Promise.all([
      scheduleReminder(fullRecord),
      scheduleGameCloseout(fullRecord),
    ]);
    const patch = { ...reminderPatch, ...closeoutPatch };
    if (Object.keys(patch).length) {
      await kv('hset', hashKey, time, JSON.stringify({ ...record, ...patch }));
    }
  }));
}

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
    const fromISO = isValidDateISO(req.query && req.query.from) ? req.query.from : todayISO();
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
      // Note: sverka (closeout) scheduling is no longer tied to shift
      // start/end times at all — each individual booking schedules its own
      // sverka 80 minutes after ITS game starts (scheduleGameCloseout() in
      // api/_closeout.js, called from api/book.js and
      // api/admin/bookings.js). Saving a shift here only affects who gets
      // reminders/sverka messages for bookings in this time window, not
      // when those messages fire — EXCEPT for bookings that already exist
      // on this date and missed their scheduling because no shift covered
      // them yet at the time they were made. backfillScheduling() catches
      // those up immediately instead of leaving them for tomorrow's cron.
      await backfillScheduling(cleanDateISO, shiftsMap[slot]);

      return res.status(200).json({ ok: true, shifts: shiftsMap });
    }

    if (body.action === 'runCloseoutNow') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const slot = typeof body.slot === 'string' ? body.slot : '';
      if (!cleanDateISO || !SHIFT_SLOTS.includes(slot)) {
        return res.status(400).json({ error: 'Некорректная дата или смена.' });
      }
      try {
        const result = await runCloseoutForSlot(cleanDateISO, slot);
        return res.status(200).json(result);
      } catch (err) {
        console.error('runCloseoutNow failed:', err);
        return res.status(500).json({ ok: false, error: 'Не удалось выполнить сверку — ошибка сервера.' });
      }
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
