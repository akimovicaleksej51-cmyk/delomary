// Shared helpers for the "actor reminder" feature: a weekly shift schedule
// maps time-ranges on each date to a specific actor (by Telegram username),
// and every CUSTOMER booking that falls inside a shift gets a private
// Telegram reminder to that actor 1.5 hours before the game.
//
// Not a route — Vercel ignores files starting with "_" — just imported by
// api/book.js, api/admin/bookings.js, api/admin/shifts.js,
// api/telegram-webhook.js and api/cron/reminders-sweep.js.
//
// ── Data model ──────────────────────────────────────────────────────────
//   shifts:<ISO date>   STRING, JSON array of shifts for that date:
//                        [{ id, start:'10:00', end:'16:00',
//                           actorUsername:'ivan_actor' }, ...]
//                        (start/end are "HH:MM" 24h, end exclusive.)
//   actors              HASH, one field per Telegram username (lowercase,
//                        no "@"), value JSON: { chatId, displayName,
//                        registeredAt }. Filled in automatically the
//                        moment that actor sends /start to the bot — see
//                        api/telegram-webhook.js. Without a chatId here,
//                        an actor can be scheduled in a shift but no
//                        reminder can actually be delivered to them yet.
//
// A scheduled reminder's own bookkeeping lives directly on the booking
// record (the same JSON stored in bookings:<date> / history:<date>):
//   reminderMsgId     — QStash message id, present once a precise reminder
//                        is scheduled (lets us cancel/replace it later).
//   reminderFireAt    — ISO timestamp the reminder is set to fire at.
//   reminderActor     — Telegram username of the actor it was scheduled for.
//   reminderPending   — true when the booking is more than 7 days out (the
//                        QStash free-tier delay ceiling), so the daily
//                        sweep (api/cron/reminders-sweep.js) still needs to
//                        schedule it once it comes within range.
//
// Everything here fails open: a missing QSTASH_TOKEN, missing shift, or
// unregistered actor just means no reminder gets scheduled — it never
// blocks or breaks the booking itself, same philosophy as the existing
// Telegram-notify code in api/book.js / api/admin/bookings.js.

import { kv } from './_kv.js';

const SHIFTS_TTL_SECONDS = 60 * 60 * 24 * 120; // shifts are set weeks ahead; keep a wide margin
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60; // free-tier ceiling on Upstash-Not-Before
const REMINDER_LEAD_MINUTES = 90;

function parseBookingDateTime(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export async function getShiftsForDate(dateISO) {
  const raw = await kv('get', `shifts:${dateISO}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function saveShiftsForDate(dateISO, shifts) {
  const key = `shifts:${dateISO}`;
  if (!shifts.length) {
    await kv('del', key);
    return;
  }
  await kv('set', key, JSON.stringify(shifts));
  await kv('expire', key, SHIFTS_TTL_SECONDS);
}

export async function getActorsMap() {
  const raw = await kv('hgetall', 'actors');
  const out = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length - 1; i += 2) {
      try { out[raw[i]] = JSON.parse(raw[i + 1]); } catch { /* skip */ }
    }
  }
  return out;
}

// Which actor (if any) covers a given time on a given date, per that date's
// shift schedule. Time-range comparison works fine on zero-padded "HH:MM"
// strings lexicographically. `end` is exclusive.
export async function resolveActorUsernameForSlot(dateISO, time) {
  const shifts = await getShiftsForDate(dateISO);
  const shift = shifts.find((s) => s.start <= time && time < s.end);
  return shift ? shift.actorUsername : null;
}

// Schedules (or re-schedules) the 1.5h-before reminder for a customer
// booking. Returns a patch object to merge into the booking record —
// callers are responsible for persisting it back to KV. Safe to call for
// every customer booking unconditionally: it silently does nothing if
// there's no shift covering the slot, no registered actor, QStash isn't
// configured, or the reminder time has already passed.
export async function scheduleReminder(record) {
  if (!record || record.type !== 'customer' || !record.dateISO || !record.time) return {};

  const qstashToken = process.env.QSTASH_TOKEN;
  const siteUrl = process.env.SITE_URL;
  const webhookSecret = process.env.REMINDER_WEBHOOK_SECRET;
  if (!qstashToken || !siteUrl || !webhookSecret) return {};

  const bookingAt = parseBookingDateTime(record.dateISO, record.time);
  if (!bookingAt) return {};

  const fireAt = new Date(bookingAt.getTime() - REMINDER_LEAD_MINUTES * 60 * 1000);
  const now = Date.now();
  if (fireAt.getTime() <= now) return {}; // already too late — nothing to schedule

  const actorUsername = await resolveActorUsernameForSlot(record.dateISO, record.time);
  if (!actorUsername) return {};

  const actors = await getActorsMap();
  const actor = actors[actorUsername];
  if (!actor || !actor.chatId) {
    // Shift has an actor assigned, but that actor hasn't messaged the bot
    // yet (so we have no chat id to send to). Record this so the admin
    // panel can flag it instead of silently doing nothing.
    return { reminderActor: actorUsername, reminderStatus: 'actor-not-registered' };
  }

  const delaySeconds = Math.floor((fireAt.getTime() - now) / 1000);
  if (delaySeconds > QSTASH_MAX_DELAY_SECONDS) {
    // Further out than QStash's free-tier delay ceiling — the daily sweep
    // (api/cron/reminders-sweep.js) will schedule it once it's in range.
    return { reminderActor: actorUsername, reminderFireAt: fireAt.toISOString(), reminderPending: true };
  }

  const notBefore = Math.floor(fireAt.getTime() / 1000);
  const destination = `${siteUrl.replace(/\/$/, '')}/api/telegram-reminder`;

  try {
    const qsRes = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Not-Before': String(notBefore),
        'Upstash-Forward-X-Reminder-Secret': webhookSecret,
      },
      body: JSON.stringify({
        chatId: actor.chatId,
        dateISO: record.dateISO,
        time: record.time,
        players: record.players || '',
      }),
    });
    const qsData = await qsRes.json().catch(() => ({}));
    if (!qsRes.ok || !qsData.messageId) {
      console.error('QStash publish failed:', qsData);
      return { reminderActor: actorUsername, reminderFireAt: fireAt.toISOString(), reminderPending: true };
    }
    return {
      reminderMsgId: qsData.messageId,
      reminderFireAt: fireAt.toISOString(),
      reminderActor: actorUsername,
      reminderStatus: 'scheduled',
    };
  } catch (err) {
    console.error('Failed to reach QStash:', err);
    return { reminderActor: actorUsername, reminderFireAt: fireAt.toISOString(), reminderPending: true };
  }
}

// Cancels a previously-scheduled reminder (booking cancelled, rescheduled,
// or edited in a way that invalidates it). Safe to call even if the record
// never had a reminder scheduled.
export async function cancelReminder(record) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !record || !record.reminderMsgId) return;

  try {
    await fetch(`https://qstash.upstash.io/v2/messages/${record.reminderMsgId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${qstashToken}` },
    });
  } catch (err) {
    console.error('Failed to cancel QStash message:', err);
  }
}

// Strips the reminder bookkeeping fields off a record — used when moving a
// booking (reschedule) so the fresh scheduleReminder() call starts clean
// rather than inheriting stale scheduling info from the old slot.
export function stripReminderFields(record) {
  const { reminderMsgId, reminderFireAt, reminderActor, reminderStatus, reminderPending, ...rest } = record;
  return rest;
}
