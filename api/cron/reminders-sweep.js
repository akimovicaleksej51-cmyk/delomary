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
// This same sweep also does the equivalent job for the "shift closeout"
// feature (see api/_closeout.js) — a shift schedule set more than 7 days
// ahead hits the exact same QStash ceiling. The Vercel Hobby plan only
// allows a limited number of cron jobs, so both sweeps share this one
// daily run rather than needing a second cron entry in vercel.json.
//
// Auth: Vercel automatically sends "Authorization: Bearer <CRON_SECRET>"
// on cron-triggered requests when a CRON_SECRET env var is set — this
// checks that header so the endpoint can't be triggered by anyone else.
// (If CRON_SECRET isn't set, the check is skipped — same fail-open
// philosophy as the rest of this project, but you should set it.)

import { kv, kvPipeline, pairsToObject } from '../_kv.js';
import { scheduleReminder, getShiftsForDate, SHIFT_SLOTS } from '../_reminders.js';
import { getCloseoutRecord, scheduleCloseout } from '../_closeout.js';

const SWEEP_DAYS_AHEAD = 9; // a little past the 7-day QStash ceiling, for margin

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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < SWEEP_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  const results = await kvPipeline(dates.map((iso) => ['HGETALL', `bookings:${iso}`]));

  let scheduled = 0;
  let checked = 0;

  await Promise.all((results || []).map(async (entry, i) => {
    const obj = pairsToObject(entry && entry.result);
    const dateISO = dates[i];
    await Promise.all(Object.entries(obj).map(async ([time, raw]) => {
      let record;
      try { record = JSON.parse(raw); } catch { return; }
      if (record.type !== 'customer') return;
      if (record.reminderMsgId) return; // already precisely scheduled — nothing to do
      checked++;

      const patch = await scheduleReminder({ ...record, dateISO: record.dateISO || dateISO, time: record.time || time });
      if (patch.reminderMsgId) {
        scheduled++;
        await kv('hset', `bookings:${dateISO}`, time, JSON.stringify({ ...record, ...patch }));
      }
    }));
  }));

  // Same idea, for shift closeouts stuck in 'pending' (see api/_closeout.js).
  let closeoutsScheduled = 0;
  await Promise.all(dates.map(async (dateISO) => {
    await Promise.all(SHIFT_SLOTS.map(async (slot) => {
      const rec = await getCloseoutRecord(dateISO, slot);
      if (!rec || rec.status !== 'pending') return;
      const shiftsMap = await getShiftsForDate(dateISO);
      const slotData = shiftsMap[slot];
      if (!slotData) return;
      await scheduleCloseout(dateISO, slot, slotData);
      closeoutsScheduled++;
    }));
  }));

  return res.status(200).json({ ok: true, checked, scheduled, closeoutsScheduled });
}
