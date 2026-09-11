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
//                             'confirmed', 'edited', 'actor-not-registered'
//                             (shift has this performer assigned but they
//                             never sent /start to the bot, so there's no
//                             chat to deliver to), or 'send-failed' (a chat
//                             id exists but Telegram rejected the message —
//                             e.g. the actor blocked the bot). The last two
//                             exist so a delivery failure is always visible
//                             on the booking instead of just silently never
//                             showing up.
//   closeoutCashCollected — the cash amount the actor reported.
//   closeoutRepliedAt     — ISO timestamp of the actor's response.
//
// Reporting cash collected writes straight into the booking's `payCash`
// field — the same field the admin panel's edit form uses — so there's
// only ever one number Касса reads, no matter who last touched it.

import { kv } from './_kv.js';
import { businessDateTime } from './_time.js';
import { getShiftsForDate, getActorsMap, resolveActorUsernamesForSlot } from './_reminders.js';

const CLOSEOUT_TTL_SECONDS = 60 * 60 * 24 * 14;
const PENDING_REPLY_TTL_SECONDS = 60 * 60 * 6; // long enough for an actor to reply the same evening
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

// Returns the parsed Telegram API response, or { ok:false } if the request
// itself couldn't even be made (network error, no bot token).
async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error(`closeout: ${method} returned not-ok:`, data);
    return data;
  } catch (err) {
    console.error(`closeout: ${method} failed:`, err);
    return { ok: false };
  }
}

// Stamps every booking in `bookings` with the same closeoutStatus — used
// for failure modes that affect the whole shift at once (actor never
// registered with the bot / the chat is unreachable), so the admin panel
// has something concrete to show instead of just... nothing.
async function markAllBookings(hashKey, bookings, status) {
  await Promise.all(bookings.map(async (b) => {
    const current = await kv('hget', hashKey, b.time);
    if (!current) return;
    try {
      const currentRecord = JSON.parse(current);
      await kv('hset', hashKey, b.time, JSON.stringify({ ...currentRecord, closeoutStatus: status }));
    } catch {
      // skip malformed entry
    }
  }));
}

// Every CUSTOMER booking covered by (dateISO, slot)'s actor, resolved
// against the CURRENT shift schedule (not just this slot's own start/end),
// so a booking is attributed to every performer actually covering it.
async function collectShiftBookings(dateISO, slotData) {
  const hashKey = `bookings:${dateISO}`;
  const bookingsRaw = await kv('hgetall', hashKey);
  const bookings = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer') continue;
      const resolvedTime = record.time || time;
      // eslint-disable-next-line no-await-in-loop
      const resolvedActors = await resolveActorUsernamesForSlot(dateISO, resolvedTime);
      if (resolvedActors.includes(slotData.actorUsername)) bookings.push({ ...record, time: resolvedTime });
    }
  }
  bookings.sort((a, b) => a.time.localeCompare(b.time));
  return { hashKey, bookings };
}

// slotData.end is Minsk wall-clock time — businessDateTime() (see
// api/_time.js) converts it to the correct absolute instant instead of
// letting the server's own (UTC) clock reinterpret those numbers as UTC,
// which used to schedule the closeout message 3 hours later than the
// shift actually ended.
function parseShiftDateTime(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return businessDateTime(dateISO, hh, mm);
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

// The actual "send the end-of-shift sverka" logic — shared by three
// callers: api/telegram-closeout.js (the QStash job firing at the exact
// shift end), api/admin/shifts.js's "runCloseoutNow" action (the admin's
// manual "Сверка сейчас" button — for whenever the automatic one didn't go
// out: bookings only entered into the system AFTER the shift already
// ended and the automatic job found nothing then, a wrong shift end time,
// a QStash/Telegram hiccup, etc.), and the daily safety-net sweep in
// api/cron/reminders-sweep.js (catches exactly that "found nothing at the
// time, bookings appeared later" case automatically, without anyone
// needing to notice and click the manual button).
//
// Always returns a small result object describing what happened instead of
// just silently returning — every caller can show or log something
// concrete rather than the old "nothing happened, no trace anywhere".
export async function runCloseoutForSlot(dateISO, slot) {
  await clearCloseoutRecord(dateISO, slot);

  const shiftsMap = await getShiftsForDate(dateISO);
  const slotData = shiftsMap[slot];
  if (!slotData || !slotData.actorUsername) {
    return { ok: false, reason: 'no-shift', message: 'На эту смену никто не назначен.' };
  }

  const { hashKey, bookings } = await collectShiftBookings(dateISO, slotData);
  if (!bookings.length) {
    return { ok: false, reason: 'no-bookings', message: 'На это время не нашлось броней для этой смены.', actorUsername: slotData.actorUsername };
  }

  // Only (re)send for bookings that actually still need it — a booking
  // already 'awaiting' a reply or already 'confirmed'/'edited' by the
  // actor is left alone, so re-running this (the manual button, or the
  // safety-net sweep picking up a newly-added booking in an otherwise
  // already-sent shift) never spams the actor with duplicates of messages
  // they've already got or already answered.
  const toSend = bookings.filter((b) => !b.closeoutStatus || b.closeoutStatus === 'send-failed' || b.closeoutStatus === 'actor-not-registered');
  if (!toSend.length) {
    return {
      ok: true,
      reason: 'already-sent',
      message: 'Все брони по этой смене уже отправлены на сверку или уже сверены.',
      bookingsCount: bookings.length,
      actorUsername: slotData.actorUsername,
    };
  }

  const actors = await getActorsMap();
  const actor = actors[slotData.actorUsername];
  if (!actor || !actor.chatId) {
    await markAllBookings(hashKey, toSend, 'actor-not-registered');
    return {
      ok: false,
      reason: 'actor-not-registered',
      message: `Актёр @${slotData.actorUsername} ещё не подключил бота (не отправил /start) — доставить некуда.`,
      bookingsCount: bookings.length,
      actorUsername: slotData.actorUsername,
    };
  }

  const dateLabel = formatDateLabel(dateISO);
  const introResult = await tg('sendMessage', {
    chat_id: actor.chatId,
    text: `🎬 Смена ${dateLabel} завершена — сверьте, пожалуйста, ${toSend.length === 1 ? 'игру' : 'игры'}:`,
  });
  if (!introResult || !introResult.ok) {
    await markAllBookings(hashKey, toSend, 'send-failed');
    return {
      ok: false,
      reason: 'send-failed',
      message: `Не удалось отправить сообщение в Telegram актёру @${slotData.actorUsername} (возможно, заблокировал бота).`,
      bookingsCount: bookings.length,
      actorUsername: slotData.actorUsername,
    };
  }

  let sentCount = 0;
  for (const b of toSend) {
    const lines = [
      `🎮 ${b.time} · ${b.name || 'без имени'}`,
      b.players ? `👥 ${b.players}` : null,
      b.price ? `💰 ${b.price} Br` : null,
    ].filter(Boolean);

    // eslint-disable-next-line no-await-in-loop
    const sendResult = await tg('sendMessage', {
      chat_id: actor.chatId,
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Верно', callback_data: `co|ok|${dateISO}|${b.time}` },
          { text: '✏️ Исправить', callback_data: `co|edit|${dateISO}|${b.time}` },
        ]],
      },
    });
    if (sendResult && sendResult.ok) sentCount++;

    // eslint-disable-next-line no-await-in-loop
    const current = await kv('hget', hashKey, b.time);
    if (current) {
      try {
        const currentRecord = JSON.parse(current);
        // A manual re-run should be able to retry a booking that's already
        // 'awaiting'/'send-failed' too — but never clobber a reply the
        // actor already gave.
        if (currentRecord.closeoutStatus !== 'confirmed' && currentRecord.closeoutStatus !== 'edited') {
          const nextStatus = (sendResult && sendResult.ok) ? 'awaiting' : 'send-failed';
          // eslint-disable-next-line no-await-in-loop
          await kv('hset', hashKey, b.time, JSON.stringify({ ...currentRecord, closeoutStatus: nextStatus }));
        }
      } catch {
        // skip malformed entry
      }
    }
  }

  return {
    ok: true,
    reason: 'sent',
    message: `Отправлено актёру @${slotData.actorUsername}: ${sentCount} из ${toSend.length} (всего в смене брони: ${bookings.length}).`,
    bookingsCount: bookings.length,
    sentCount,
    actorUsername: slotData.actorUsername,
  };
}

// Safety net for the daily sweep (api/cron/reminders-sweep.js): finds any
// shift slot whose end time has already passed (checked over the last
// couple of days, not just today, to survive a slow cron run or a shift
// crossing midnight) that has at least one covered booking with NO
// closeoutStatus at all — meaning the automatic QStash job either never
// fired, or fired and found nothing (e.g. the bookings were only entered
// into the system afterwards) — and runs the closeout for it. Never
// touches a slot whose bookings already have SOME status (even
// 'send-failed'/'actor-not-registered') — those are already visible in the
// admin panel and worth a human decision, not an automatic retry loop.
export async function sweepMissedCloseouts(dateISOList) {
  let attempted = 0;
  const results = [];
  await Promise.all(dateISOList.map(async (dateISO) => {
    const shiftsMap = await getShiftsForDate(dateISO);
    await Promise.all(Object.keys(shiftsMap).map(async (slot) => {
      const slotData = shiftsMap[slot];
      if (!slotData || !slotData.actorUsername || !slotData.end) return;
      const fireAt = parseShiftDateTime(dateISO, slotData.end);
      if (!fireAt || fireAt.getTime() > Date.now()) return; // shift hasn't ended yet

      const { bookings } = await collectShiftBookings(dateISO, slotData);
      if (!bookings.length) return;
      const missing = bookings.some((b) => !b.closeoutStatus);
      if (!missing) return;

      attempted++;
      // eslint-disable-next-line no-await-in-loop
      const result = await runCloseoutForSlot(dateISO, slot);
      results.push({ dateISO, slot, ...result });
    }));
  }));
  return { attempted, results };
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
