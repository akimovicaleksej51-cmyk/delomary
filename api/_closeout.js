// Shared helpers for the actor "shift closeout" feature: once a shift ends,
// the actor gets a Telegram message listing that shift's bookings and can
// confirm each one, or correct the player count and price — then reports
// how much cash they collected, which feeds straight into the "Касса"
// running balance (see api/_finance.js).
//
// Not a route — Vercel ignores files starting with "_" — imported by
// api/admin/shifts.js (schedules/cancels the QStash job whenever a shift
// slot is set or cleared), api/telegram-closeout.js (the job QStash
// actually calls), api/telegram-webhook.js (tracks the actor's in-progress
// reply once they tap a button) and api/cron/reminders-sweep.js (safety
// net for shifts set more than 7 days ahead — same QStash free-tier
// ceiling as booking reminders).
//
// ── Data model ──────────────────────────────────────────────────────────
//   closeout:<ISO date>:<slot>   STRING, JSON bookkeeping for the ONE
//                                 scheduled/pending closeout job for that
//                                 shift slot (slot is one of SHIFT_SLOTS
//                                 in api/_reminders.js):
//                                 { qstashMsgId, fireAt, actorUsername,
//                                   status:'scheduled'|'pending' }
//                                 Deleted the moment the job actually fires
//                                 (api/telegram-closeout.js cleans up after
//                                 itself) — there's nothing left to track
//                                 once the messages are sent.
//   pendingActorReply:<chatId>   STRING, JSON conversation state, set
//                                 while an actor is mid-reply to a
//                                 closeout question (correcting a booking,
//                                 or reporting cash collected):
//                                 { dateISO, time, stage:'players_price'|
//                                   'cash' }
//                                 Short TTL — if the actor never replies,
//                                 it just expires and the bot goes back to
//                                 treating their messages as ordinary text.
//
// A closeout's own progress lives directly on the booking record (same
// JSON as bookings:<date> / history:<date>):
//   closeoutStatus        — 'awaiting' (message sent, no reply yet),
//                             'confirmed', or 'edited'.
//   closeoutCashCollected — the cash amount the actor reported.
//   closeoutRepliedAt     — ISO timestamp of the actor's response.
//
// Reporting cash collected writes straight into the booking's `payCash`
// field — the same field the admin panel's edit form uses — so there's
// only ever one number Касса reads, no matter who last touched it.

import { kv } from './_kv.js';

const CLOSEOUT_TTL_SECONDS = 60 * 60 * 24 * 14;
const PENDING_REPLY_TTL_SECONDS = 60 * 60 * 6; // long enough for an actor to reply the same evening
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

function parseShiftDateTime(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function closeoutKey(dateISO, slot) {
  return `closeout:${dateISO}:${slot}`;
}

export async function getCloseoutRecord(dateISO, slot) {
  const raw = await kv('get', closeoutKey(dateISO, slot));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Schedules the end-of-shift check-in for one (date, slot). Safe to call
// unconditionally whenever a slot is saved — silently does nothing if
// QStash isn't configured, the slot has no actor, or the shift's already over.
export async function scheduleCloseout(dateISO, slot, slotData) {
  if (!slotData || !slotData.end || !slotData.actorUsername) return;

  const qstashToken = process.env.QSTASH_TOKEN;
  const siteUrl = process.env.SITE_URL;
  const webhookSecret = process.env.REMINDER_WEBHOOK_SECRET;
  if (!qstashToken || !siteUrl || !webhookSecret) return;

  const fireAt = parseShiftDateTime(dateISO, slotData.end);
  if (!fireAt) return;
  const now = Date.now();
  if (fireAt.getTime() <= now) return; // shift's already over — nothing to schedule

  const key = closeoutKey(dateISO, slot);
  const delaySeconds = Math.floor((fireAt.getTime() - now) / 1000);

  if (delaySeconds > QSTASH_MAX_DELAY_SECONDS) {
    // Further out than QStash's free-tier delay ceiling — the daily sweep
    // (api/cron/reminders-sweep.js) schedules it for real once it's in range.
    await kv('set', key, JSON.stringify({ fireAt: fireAt.toISOString(), actorUsername: slotData.actorUsername, status: 'pending' }));
    await kv('expire', key, CLOSEOUT_TTL_SECONDS);
    return;
  }

  const notBefore = Math.floor(fireAt.getTime() / 1000);
  const destination = `${siteUrl.replace(/\/$/, '')}/api/telegram-closeout`;

  try {
    const qsRes = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Not-Before': String(notBefore),
        'Upstash-Forward-X-Reminder-Secret': webhookSecret,
      },
      body: JSON.stringify({ dateISO, slot }),
    });
    const qsData = await qsRes.json().catch(() => ({}));
    if (!qsRes.ok || !qsData.messageId) {
      console.error('QStash publish failed (closeout):', qsData);
      await kv('set', key, JSON.stringify({ fireAt: fireAt.toISOString(), actorUsername: slotData.actorUsername, status: 'pending' }));
      await kv('expire', key, CLOSEOUT_TTL_SECONDS);
      return;
    }
    await kv('set', key, JSON.stringify({
      qstashMsgId: qsData.messageId,
      fireAt: fireAt.toISOString(),
      actorUsername: slotData.actorUsername,
      status: 'scheduled',
    }));
    await kv('expire', key, CLOSEOUT_TTL_SECONDS);
  } catch (err) {
    console.error('Failed to reach QStash (closeout):', err);
  }
}

// Cancels a previously-scheduled closeout for a (date, slot) — called
// whenever that slot is edited or cleared, so a stale job never fires for
// a shift that no longer exists (or now belongs to someone else).
export async function cancelCloseout(dateISO, slot) {
  const record = await getCloseoutRecord(dateISO, slot);
  if (record && record.qstashMsgId) {
    const qstashToken = process.env.QSTASH_TOKEN;
    if (qstashToken) {
      try {
        await fetch(`https://qstash.upstash.io/v2/messages/${record.qstashMsgId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${qstashToken}` },
        });
      } catch (err) {
        console.error('Failed to cancel QStash closeout message:', err);
      }
    }
  }
  await kv('del', closeoutKey(dateISO, slot));
}

// Called by api/telegram-closeout.js once the job has actually fired —
// there's nothing left to track after that (unlike a booking reminder, a
// closeout job never needs to be looked up again by its own key).
export async function clearCloseoutRecord(dateISO, slot) {
  await kv('del', closeoutKey(dateISO, slot));
}

export async function getPendingActorReply(chatId) {
  const raw = await kv('get', `pendingActorReply:${chatId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function setPendingActorReply(chatId, state) {
  const key = `pendingActorReply:${chatId}`;
  await kv('set', key, JSON.stringify(state));
  await kv('expire', key, PENDING_REPLY_TTL_SECONDS);
}

export async function clearPendingActorReply(chatId) {
  await kv('del', `pendingActorReply:${chatId}`);
}
