// Serverless function (Vercel Node.js runtime), invoked once a day by
// Vercel Cron (see vercel.json) — NOT meant to be called manually.
//
// QStash's free tier can only schedule a message up to 7 days ahead
// (Upstash-Not-Before). Most bookings get their reminder scheduled
// immediately (see scheduleReminder() in api/_reminders.js, called from
// api/book.js and api/admin/bookings.js) because most bookings are made
// less than a week before the date. For the rare booking made further out
// than that, this daily sweep is the safety net: it looks at every
// upcoming customer booking without a scheduled reminder yet and, once its
// reminder time has come within the 7-day window, schedules it for real.
//
// This same sweep also does the equivalent job for the per-game "sverka"
// (closeout) feature (see api/_closeout.js) — a booking made more than 7
// days before its own game time hits the exact same QStash ceiling. The
// Vercel Hobby plan only allows a limited number of cron jobs, so both
// sweeps share this one daily run rather than needing a second cron entry
// in vercel.json.
//
// It ALSO runs sweepMissedCloseouts() over the last few days — a genuine
// safety net, not just a QStash-ceiling workaround: if a booking's own
// 80-minutes-after-start closeout job never got scheduled at all (e.g. it
// was created, then edited/moved in a way that raced the scheduling call),
// nothing else would ever notice and the actor's sverka would just never
// show up. This catches that the next time the sweep runs, and the admin
// panel also has a "Сверка сейчас" button (api/admin/shifts.js, action
// 'runCloseoutNow') for triggering it immediately instead of waiting.
//
// Auth: Vercel automatically sends "Authorization: Bearer <CRON_SECRET>"
// on cron-triggered requests when a CRON_SECRET env var is set — this
// checks that header so the endpoint can't be triggered by anyone else.
// (If CRON_SECRET isn't set, the check is skipped — same fail-open
// philosophy as the rest of this project, but you should set it.)

import { kv, kvPipeline, pairsToObject } from '../_kv.js';
import { scheduleReminder } from '../_reminders.js';
import { scheduleGameCloseout, sweepMissedCloseouts } from '../_closeout.js';
import { businessToday } from '../_time.js';

const SWEEP_DAYS_AHEAD = 9; // a little past the 7-day QStash ceiling, for margin
const MISSED_CLOSEOUT_DAYS_BACK = 3; // catches a booking whose closeout job never got scheduled a few days back

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = req.headers.authorization;
    if (provided !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const today = businessToday();
  const dates = [];
  for (let i = 0; i < SWEEP_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  const results = await kvPipeline(dates.map((iso) => ['HGETALL', `bookings:${iso}`]));

  let scheduled = 0;
  let checked = 0;
  let closeoutsScheduled = 0;

  await Promise.all((results || []).map(async (entry, i) => {
    const obj = pairsToObject(entry && entry.result);
    const dateISO = dates[i];
    await Promise.all(Object.entries(obj).map(async ([time, raw]) => {
      let record;
      try { record = JSON.parse(raw); } catch { return; }
      if (record.type !== 'customer') return;
      if (record.status === 'cancelled' || record.status === 'rescheduled') return;
      const fullRecord = { ...record, dateISO: record.dateISO || dateISO, time: record.time || time };

      // Skip only once EVERY performer covering this booking already has a
      // precisely scheduled reminder — scheduleReminder() itself is safe
      // to call again otherwise (it won't duplicate an already-scheduled
      // one), so a booking with, say, a registered actor but a not-yet-
      // registered actress keeps getting retried until both are set.
      const reminderDone = Array.isArray(record.reminders) && record.reminders.length && record.reminders.every((r) => r.status === 'scheduled');
      // Same idea for this booking's own per-game sverka — one entry per
      // performer covering it, each independently scheduled 80 minutes
      // after ITS start time (see api/_closeout.js).
      const closeoutDone = Array.isArray(record.closeouts) && record.closeouts.length && record.closeouts.every((c) => c.status === 'scheduled');
      if (reminderDone && closeoutDone) return;
      checked++;

      const [reminderPatch, closeoutPatch] = await Promise.all([
        reminderDone ? {} : scheduleReminder(fullRecord),
        closeoutDone ? {} : scheduleGameCloseout(fullRecord),
      ]);
      if (reminderPatch.reminders && reminderPatch.reminders.some((r) => r.status === 'scheduled')) scheduled++;
      if (closeoutPatch.closeouts && closeoutPatch.closeouts.some((c) => c.status === 'scheduled')) closeoutsScheduled++;
      const patch = { ...reminderPatch, ...closeoutPatch };
      if (Object.keys(patch).length) {
        await kv('hset', `bookings:${dateISO}`, time, JSON.stringify({ ...record, ...patch }));
      }
    }));
  }));

  // Safety net: a game whose start time has already passed (today or the
  // last few days) can end up with a booking that never got its sverka
  // scheduled at all (e.g. an edit/reschedule race, or the actor wasn't
  // registered yet at scheduling time and later registered). Catch those
  // here so the actor's sverka doesn't just silently never arrive; see
  // sweepMissedCloseouts() in api/_closeout.js for the exact (conservative)
  // matching rule.
  const pastDates = [];
  for (let i = 0; i < MISSED_CLOSEOUT_DAYS_BACK; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    pastDates.push(isoDate(d));
  }
  const missedCloseouts = await sweepMissedCloseouts(pastDates);

  return res.status(200).json({ ok: true, checked, scheduled, closeoutsScheduled, missedCloseouts });
}
