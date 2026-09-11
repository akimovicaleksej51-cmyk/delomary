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
//   shifts:<ISO date>   STRING, JSON object with up to 4 fixed slots per
//                        day — SHIFT_SLOTS below ('actor-1','actor-2',
//                        'actress-1','actress-2') — a slot missing from the
//                        object just means it's empty that day:
//                        { 'actor-1': { start:'10:00', end:'16:00',
//                                       actorUsername:'ivan_actor' }, ... }
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
//   reminders   ARRAY, one entry per performer covering that time slot —
//                a booking can need BOTH an actor and an actress on shift
//                at once, and each gets their own independent reminder:
//                [{ actorUsername, msgId, fireAt, status }]
//                status is 'scheduled' (msgId present — a precise QStash
//                job is set), 'pending' (booking is more than 7 days out,
//                the QStash free-tier delay ceiling — the daily sweep in
//                api/cron/reminders-sweep.js will schedule it for real once
//                it's in range), or 'actor-not-registered' (assigned to
//                the shift but never sent /start to the bot, so there's no
//                chat id to deliver to yet).
//
// Everything here fails open: a missing QSTASH_TOKEN, missing shift, or
// unregistered actor just means no reminder gets scheduled — it never
// blocks or breaks the booking itself, same philosophy as the existing
// Telegram-notify code in api/book.js / api/admin/bookings.js.

import { kv } from './_kv.js';
import { businessDateTime } from './_time.js';

const SHIFTS_TTL_SECONDS = 60 * 60 * 24 * 120; // shifts are set weeks ahead; keep a wide margin
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60; // free-tier ceiling on Upstash-Not-Before
const REMINDER_LEAD_MINUTES = 90;

// Fixed slots per day: 2 for an actor, 2 for an actress. Deliberately not
// an open-ended list — the admin panel always shows exactly these 4 rows
// per day, so a slot's id doubles as its own storage key (no separate
// "add a new shift" flow needed).
export const SHIFT_SLOTS = ['actor-1', 'actor-2', 'actress-1', 'actress-2'];

// record.time is Minsk wall-clock time — businessDateTime() (see
// api/_time.js) converts it to the correct absolute instant instead of
// letting the server's own (UTC) clock reinterpret those numbers as UTC,
// which used to schedule every reminder 90 minutes AFTER the booking had
// already started instead of 90 minutes before it.
function parseBookingDateTime(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return businessDateTime(dateISO, hh, mm);
}

// Returns { 'actor-1': {start,end,actorUsername}, ... } — only the slots
// that are actually filled in for that date; an empty/missing day is {}.
export async function getShiftsForDate(dateISO) {
  const raw = await kv('get', `shifts:${dateISO}`);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export async function saveShiftsForDate(dateISO, shiftsMap) {
  const key = `shifts:${dateISO}`;
  if (!Object.keys(shiftsMap).length) {
    await kv('del', key);
    return;
  }
  await kv('set', key, JSON.stringify(shiftsMap));
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

// EVERY performer covering a given time on a given date, per that date's 4
// fixed shift slots — an actor slot and an actress slot routinely cover
// the same booking at once (this is a two-character show), and both need
// their own reminder/closeout, not just whichever slot happens to be
// checked first. Time-range comparison works fine on zero-padded "HH:MM"
// strings lexicographically. `end` is exclusive. Returns distinct
// usernames in a fixed order (actor-1, actor-2, actress-1, actress-2) — if
// two slots of the SAME category somehow overlap, the first one wins for
// that category, but an actor and an actress covering the same time both
// come back.
export async function resolveActorUsernamesForSlot(dateISO, time) {
  const shiftsMap = await getShiftsForDate(dateISO);
  const seen = new Set();
  const usernames = [];
  for (const slotId of SHIFT_SLOTS) {
    const s = shiftsMap[slotId];
    if (s && s.start <= time && time < s.end && s.actorUsername && !seen.has(s.actorUsername)) {
      seen.add(s.actorUsername);
      usernames.push(s.actorUsername);
    }
  }
  return usernames;
}

// Schedules one job per performer covering a customer booking's slot — an
// actor AND an actress are routinely on shift for the very same booking
// (this is a two-character show), and each needs their own independent
// 1.5h-before reminder, not just whichever one resolveActorUsernamesForSlot
// happened to list first. Returns a patch object ({ reminders: [...] }) to
// merge into the booking record — callers are responsible for persisting
// it back to KV. Safe to call for every customer booking unconditionally,
// and safe to call repeatedly (the daily sweep does): a performer who
// already has a successfully scheduled reminder is left untouched rather
// than re-scheduled/duplicated.
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

  const actorUsernames = await resolveActorUsernamesForSlot(record.dateISO, record.time);
  if (!actorUsernames.length) return {};

  const actors = await getActorsMap();
  const existingByActor = {};
  (Array.isArray(record.reminders) ? record.reminders : []).forEach((r) => {
    if (r && r.actorUsername) existingByActor[r.actorUsername] = r;
  });

  const delaySeconds = Math.floor((fireAt.getTime() - now) / 1000);
  const destination = `${siteUrl.replace(/\/$/, '')}/api/telegram-reminder`;

  const reminders = await Promise.all(actorUsernames.map(async (actorUsername) => {
    const already = existingByActor[actorUsername];
    if (already && already.status === 'scheduled' && already.msgId) return already; // don't duplicate

    const actor = actors[actorUsername];
    if (!actor || !actor.chatId) {
      // Shift has this performer assigned, but they haven't messaged the
      // bot yet (so there's no chat id to send to). Record this so the
      // admin panel can flag it instead of silently doing nothing.
      return { actorUsername, status: 'actor-not-registered' };
    }

    if (delaySeconds > QSTASH_MAX_DELAY_SECONDS) {
      // Further out than QStash's free-tier delay ceiling — the daily
      // sweep (api/cron/reminders-sweep.js) will schedule it once in range.
      return { actorUsername, fireAt: fireAt.toISOString(), status: 'pending' };
    }

    const notBefore = Math.floor(fireAt.getTime() / 1000);
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
        return { actorUsername, fireAt: fireAt.toISOString(), status: 'pending' };
      }
      return { actorUsername, msgId: qsData.messageId, fireAt: fireAt.toISOString(), status: 'scheduled' };
    } catch (err) {
      console.error('Failed to reach QStash:', err);
      return { actorUsername, fireAt: fireAt.toISOString(), status: 'pending' };
    }
  }));

  return { reminders };
}

// Cancels every previously-scheduled reminder for a booking (cancelled,
// rescheduled, or edited in a way that invalidates them). Safe to call
// even if the record never had any reminders scheduled.
export async function cancelReminder(record) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !record || !Array.isArray(record.reminders) || !record.reminders.length) return;

  await Promise.all(record.reminders.map(async (r) => {
    if (!r || !r.msgId) return;
    try {
      await fetch(`https://qstash.upstash.io/v2/messages/${r.msgId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${qstashToken}` },
      });
    } catch (err) {
      console.error('Failed to cancel QStash message:', err);
    }
  }));
}

// Strips the reminder bookkeeping off a record — used when moving a
// booking (reschedule) so the fresh scheduleReminder() call starts clean
// rather than inheriting stale scheduling info from the old slot.
export function stripReminderFields(record) {
  const { reminders, ...rest } = record;
  return rest;
}
