// Serverless function (Vercel Node.js runtime).
// QStash calls this exactly 80 minutes after ONE SPECIFIC GAME started
// (see scheduleGameCloseout() in api/_closeout.js) — one job per booking
// per performer, not once per whole shift. The actual "message this
// performer about this one game, stamp closeoutStatus" logic lives in
// runCloseoutForBooking() (api/_closeout.js) — shared with the admin's
// manual "Сверка сейчас" button (api/admin/shifts.js, action
// 'runCloseoutNow', via runCloseoutForSlot() which loops per-booking) and
// the daily missed-closeout safety net (api/cron/reminders-sweep.js), so
// all three behave identically and a fix only has to happen once.
//
// Authentication: same shared-secret pattern as api/telegram-reminder.js —
// QStash forwards the X-Reminder-Secret header we asked it to when
// scheduling, checked against REMINDER_WEBHOOK_SECRET.
//
// Required env vars: TELEGRAM_BOT_TOKEN, REMINDER_WEBHOOK_SECRET — both
// already set up for the reminder feature, nothing new to configure.

import { runCloseoutForBooking } from './_closeout.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.REMINDER_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-reminder-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { dateISO, time, actorUsername } = body;

  // Always ack quickly — this is a background job, nobody's waiting on it.
  res.status(200).json({ ok: true });

  if (!dateISO || !time || !actorUsername) return;

  try {
    const result = await runCloseoutForBooking(dateISO, time, actorUsername);
    if (!result.ok) {
      // e.g. the booking got cancelled/rescheduled after this job was
      // scheduled, or the actor blocked the bot in the meantime — never
      // silent, always logged, and the daily safety-net sweep in
      // api/cron/reminders-sweep.js will retry anything genuinely missed.
      console.log(`telegram-closeout: ${dateISO} ${time} @${actorUsername} — ${result.reason}: ${result.message}`);
    }
  } catch (err) {
    console.error('telegram-closeout: runCloseoutForBooking threw:', err);
  }
}
