// Serverless function (Vercel Node.js runtime).
// QStash calls this at the exact end of a shift slot (see
// scheduleCloseout() in api/_closeout.js). The actual "find this shift's
// bookings, message the actor, stamp closeoutStatus" logic lives in
// runCloseoutForSlot() (api/_closeout.js) — shared with the admin's manual
// "Сверка сейчас" button (api/admin/shifts.js, action 'runCloseoutNow')
// and the daily missed-closeout safety net (api/cron/reminders-sweep.js),
// so all three behave identically and a fix only has to happen once.
//
// Authentication: same shared-secret pattern as api/telegram-reminder.js —
// QStash forwards the X-Reminder-Secret header we asked it to when
// scheduling, checked against REMINDER_WEBHOOK_SECRET.
//
// Required env vars: TELEGRAM_BOT_TOKEN, REMINDER_WEBHOOK_SECRET — both
// already set up for the reminder feature, nothing new to configure.

import { runCloseoutForSlot } from './_closeout.js';

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
  const { dateISO, slot } = body;

  // Always ack quickly — this is a background job, nobody's waiting on it.
  res.status(200).json({ ok: true });

  if (!dateISO || !slot) return;

  try {
    const result = await runCloseoutForSlot(dateISO, slot);
    if (!result.ok) {
      // 'no-bookings' just means nobody was booked in this shift at the
      // moment it ended (or, historically, the bookings got entered into
      // the system afterwards — that case is now caught the next day by
      // the safety-net sweep instead of vanishing without a trace).
      console.log(`telegram-closeout: ${dateISO} ${slot} — ${result.reason}: ${result.message}`);
    }
  } catch (err) {
    console.error('telegram-closeout: runCloseoutForSlot threw:', err);
  }
}
