// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 — merges THREE previously-separate files into one, to
// stay within Vercel's Hobby-plan limit of 12 Serverless Functions per
// deployment. The site was already sitting at exactly 12 functions before
// the Мир Квестов / ExtraReality integrations added 4 more (see
// api/mirkvestov.js, api/extrareality.js, each themselves already merged
// from 2 files down to 1 for the same reason) — this merge frees up 2 more
// slots by folding these three internal-only jobs into one.
//
// All three were already "nobody outside our own code ever calls this
// directly" endpoints — no external service (Telegram, Mir Kvestov,
// ExtraReality) has this URL registered anywhere; only Vercel's own Cron
// scheduler (via vercel.json) and our own QStash publish calls (in
// api/_reminders.js / api/_closeout.js) ever hit them — so merging them
// costs nothing beyond a small `?job=` dispatch at the top, and there is
// zero risk of breaking an externally-registered webhook URL (contrast
// with api/telegram-webhook.js, which IS registered with Telegram's own
// servers via setWebhook and was deliberately left untouched here).
//
//   ?job=sweep     — was api/cron/reminders-sweep.js. Invoked once a day by
//                    Vercel Cron (see vercel.json's "crons" entry, now
//                    pointing at /api/internal-jobs?job=sweep). Not meant
//                    to be called manually.
//   ?job=reminder  — was api/telegram-reminder.js. The URL QStash calls at
//                    exactly the scheduled moment (1.5h before a booking) —
//                    see scheduleReminder() in api/_reminders.js, whose
//                    `destination` now points at
//                    /api/internal-jobs?job=reminder.
//   ?job=closeout  — was api/telegram-closeout.js. The URL QStash calls
//                    exactly CLOSEOUT_LEAD_MINUTES after one specific game
//                    started — see scheduleGameCloseout() in
//                    api/_closeout.js, whose `destination` now points at
//                    /api/internal-jobs?job=closeout.
//
// Each job's own logic below is otherwise UNCHANGED from its original file
// — same auth checks, same behavior, same env vars. If you're looking for
// "what does the daily sweep actually do" or "why does closeout.js await
// before responding", the original files' comments (still present below,
// per job) have the full story.

import { kv, kvPipeline, pairsToObject } from './_kv.js';
import { scheduleReminder } from './_reminders.js';
import { scheduleGameCloseout, sweepMissedCloseouts, runCloseoutForBooking } from './_closeout.js';
import { businessToday } from './_time.js';

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============================================================
// job=sweep — was api/cron/reminders-sweep.js
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
// days before its own game time hits the exact same QStash ceiling.
//
// It ALSO runs sweepMissedCloseouts() over the last few days — a genuine
// safety net, not just a QStash-ceiling workaround: if a booking's own
// 60-minutes-after-start closeout job never got scheduled at all, this
// catches it the next time the sweep runs (the admin panel also has a
// "Сверка сейчас" button for triggering it immediately instead of
// waiting — api/admin/shifts.js, action 'runCloseoutNow').
//
// Auth: Vercel automatically sends "Authorization: Bearer <CRON_SECRET>" on
// cron-triggered requests when a CRON_SECRET env var is set.
const SWEEP_DAYS_AHEAD = 9;
const MISSED_CLOSEOUT_DAYS_BACK = 3;

async function handleSweep(req, res) {
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

      const reminderDone = Array.isArray(record.reminders) && record.reminders.length && record.reminders.every((r) => r.status === 'scheduled');
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

  const pastDates = [];
  for (let i = 0; i < MISSED_CLOSEOUT_DAYS_BACK; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    pastDates.push(isoDate(d));
  }
  const missedCloseouts = await sweepMissedCloseouts(pastDates);

  return res.status(200).json({ ok: true, checked, scheduled, closeoutsScheduled, missedCloseouts });
}

// ============================================================
// job=reminder — was api/telegram-reminder.js
//
// Sends one Telegram message to the actor's private chat, 1.5h before
// their game. Auth: QStash forwards whatever custom header we asked it to
// when we scheduled the message ("Upstash-Forward-X-Reminder-Secret"), so
// it arrives here as a plain header, checked against REMINDER_WEBHOOK_SECRET.
const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}, ${WEEKDAY_NAMES[date.getDay()]}`;
}

async function handleReminder(req, res) {
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

  const { chatId, dateISO, time, players, animator } = body;
  if (!chatId || !time) {
    return res.status(400).json({ error: 'Missing chatId/time' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('internal-jobs (reminder): missing TELEGRAM_BOT_TOKEN');
    return res.status(500).json({ error: 'Bot not configured' });
  }

  const dateLabel = dateISO ? formatDateLabel(dateISO) : '';
  const lines = [
    '⏰ Напоминание: через 1.5 часа у вас игра.',
    dateLabel ? `📅 ${dateLabel}, ${time}` : `🕒 Время: ${time}`,
    players ? `👥 Игроков: ${players}` : null,
    animator ? '🎭 Заказан аниматор (+30 Br)' : null,
  ].filter(Boolean);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
    });
    const tgData = await tgRes.json().catch(() => ({}));
    if (!tgData.ok) {
      console.error('internal-jobs (reminder): Telegram API error:', tgData);
      return res.status(502).json({ error: 'Telegram send failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('internal-jobs (reminder): failed to reach Telegram API:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// job=closeout — was api/telegram-closeout.js
//
// QStash calls this exactly CLOSEOUT_LEAD_MINUTES after ONE SPECIFIC GAME
// started — one job per booking per performer. The actual "message this
// performer about this one game, stamp closeoutStatus" logic lives in
// runCloseoutForBooking() (api/_closeout.js) — shared with the admin's
// manual "Сверка сейчас" button and the daily missed-closeout safety net
// (job=sweep, above), so all three behave identically.
//
// IMPORTANT — this used to be the one place in this project with the same
// "ack fast, THEN await the real work" bug fixed in api/telegram-webhook.js:
// on Vercel's Node runtime the whole execution environment can freeze the
// instant a response is sent, so the work after it may never actually
// finish. Fixed the same way: do the work first, respond exactly once at
// the end, from a `finally` block. Keep that ordering if you ever touch
// this again.
async function handleCloseout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.REMINDER_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-reminder-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};
    const { dateISO, time, actorUsername } = body;

    if (!dateISO || !time || !actorUsername) return;

    const result = await runCloseoutForBooking(dateISO, time, actorUsername);
    if (!result.ok) {
      console.log(`internal-jobs (closeout): ${dateISO} ${time} @${actorUsername} — ${result.reason}: ${result.message}`);
    }
  } catch (err) {
    console.error('internal-jobs (closeout): runCloseoutForBooking threw:', err);
  } finally {
    res.status(200).json({ ok: true });
  }
}

// ============================================================
export default async function handler(req, res) {
  const job = req.query && req.query.job;
  if (job === 'reminder') return handleReminder(req, res);
  if (job === 'closeout') return handleCloseout(req, res);
  return handleSweep(req, res); // job=sweep, or no job param at all
}
