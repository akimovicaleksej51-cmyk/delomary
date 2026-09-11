// Shared helpers for the actor "game closeout" (sverka) feature: a set
// time after EACH GAME ITSELF starts, every performer who covered that
// booking gets a private Telegram message with "✅ Верно" / "✏️
// Исправить" buttons, so they can confirm or correct the player count and
// price, then report how the game was paid for (cash / card / ERIP, or a
// split — see parsePayment() in api/telegram-webhook.js) — which feeds
// straight into "Касса" (see api/_finance.js) and, once confirmed, also
// fills in "Кто отыграл" (see resolveWorkedField() in
// api/telegram-webhook.js) for the per-actor games-this-month stat.
//
// This used to fire once at the END OF THE WHOLE SHIFT, batching every
// booking from that shift into one round of messages. Per the site
// owner's explicit request, it now works exactly like booking reminders
// (api/_reminders.js) — one independent job PER BOOKING PER PERFORMER,
// timed off that booking's own start time — so a sverka for an 11:00 game
// arrives at 12:20 regardless of when the shift as a whole ends, instead
// of everyone's sverka arriving in one batch at shift end.
//
// Not a route — Vercel ignores files starting with "_" — imported by
// api/book.js and api/admin/bookings.js (schedule/cancel a booking's
// closeout jobs alongside its reminder jobs, at the same call sites),
// api/telegram-closeout.js (the job QStash actually calls),
// api/telegram-webhook.js (tracks the actor's in-progress reply once they
// tap a button), api/admin/shifts.js (the admin's manual "Сверка сейчас"
// button — still organized per shift slot in the UI, but now implemented
// as "run the per-booking sender for every booking that slot covers") and
// api/cron/reminders-sweep.js (schedules any 'pending' closeout that was
// too far out to schedule immediately — same QStash 7-day ceiling as
// reminders — and the missed-closeout safety net below).
//
// ── Data model ──────────────────────────────────────────────────────────
// A booking's own closeout scheduling lives directly on its record (same
// JSON as bookings:<date> / history:<date>, same shape as the pre-existing
// `reminders` array in api/_reminders.js):
//   closeouts   ARRAY, one entry per performer covering that booking:
//                [{ actorUsername, msgId, fireAt, status }]
//                status is 'scheduled' (msgId present — a precise QStash
//                job is set), 'pending' (more than 7 days out — the daily
//                sweep in api/cron/reminders-sweep.js schedules it for
//                real once it's in range), or 'actor-not-registered'
//                (assigned to the shift but never sent /start to the bot).
//
//   pendingActorReply:<chatId>   STRING, JSON conversation state, set
//                                 while an actor is mid-reply to a
//                                 closeout question (correcting a booking,
//                                 or reporting how it was paid):
//                                 { dateISO, time, stage:'players_price'|
//                                   'payment'|'cash' }
//                                 ('cash' is a legacy stage kept for any
//                                 conversation already in flight from
//                                 before the cash/card/ERIP split existed
//                                 — see api/telegram-webhook.js.) Short
//                                 TTL — if the actor never replies, it
//                                 just expires.
//
// A closeout's own progress lives directly on the booking record:
//   closeoutStatus        — 'awaiting' (message sent, no reply yet),
//                             'confirmed', 'edited', 'actor-not-registered'
//                             (this performer never sent /start to the
//                             bot, so there's no chat to deliver to), or
//                             'send-failed' (a chat id exists but Telegram
//                             rejected the message — e.g. the actor
//                             blocked the bot). The last two exist so a
//                             delivery failure is always visible on the
//                             booking instead of just silently never
//                             showing up. NOTE: this is a single field
//                             shared by the booking, not one per performer
//                             — if both an actor and an actress cover the
//                             same booking, whichever of them last acted
//                             on it "wins" this field; each still gets
//                             their own independent message and buttons.
//   closeoutCashCollected — the cash amount the actor reported (kept for
//                             backward compatibility with the pre-split
//                             flow; payCash/payCard/payErip below are what
//                             Касса actually reads).
//   closeoutRepliedAt     — ISO timestamp of the actor's response.
//
// Reporting how a game was paid for writes straight into the booking's
// `payCash`/`payCard`/`payErip` fields — the same fields the admin panel's
// edit form uses — so there's only ever one set of numbers Касса reads,
// no matter who last touched them.

import { kv } from './_kv.js';
import { businessDateTime } from './_time.js';
import { getShiftsForDate, getActorsMap, resolveActorUsernamesForSlot } from './_reminders.js';

const CLOSEOUT_LEAD_MINUTES = 80; // 1 час 20 минут ПОСЛЕ начала игры
const PENDING_REPLY_TTL_SECONDS = 60 * 60 * 6; // long enough for an actor to reply the same evening
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

// record.time / a shift slot's start-end are Minsk wall-clock time —
// businessDateTime() (see api/_time.js) converts to the correct absolute
// instant instead of letting the server's own (UTC) clock reinterpret
// those numbers as UTC.
function parseWallClock(dateISO, time) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return businessDateTime(dateISO, hh, mm);
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

// Schedules one job per performer covering a customer booking's slot — an
// actor AND an actress are routinely on shift for the very same booking,
// and each gets their own independent sverka, 80 minutes after the game
// STARTS (not tied to when their shift ends). Returns a patch object
// ({ closeouts: [...] }) to merge into the booking record — callers are
// responsible for persisting it back to KV, exactly like scheduleReminder()
// in api/_reminders.js. Safe to call unconditionally for every customer
// booking, and safe to call repeatedly (the daily sweep does): a performer
// who already has a successfully scheduled closeout is left untouched.
export async function scheduleGameCloseout(record) {
  if (!record || record.type !== 'customer' || !record.dateISO || !record.time) return {};
  if (record.status === 'cancelled' || record.status === 'rescheduled') return {};

  const qstashToken = process.env.QSTASH_TOKEN;
  const siteUrl = process.env.SITE_URL;
  const webhookSecret = process.env.REMINDER_WEBHOOK_SECRET;
  if (!qstashToken || !siteUrl || !webhookSecret) return {};

  const startAt = parseWallClock(record.dateISO, record.time);
  if (!startAt) return {};

  const fireAt = new Date(startAt.getTime() + CLOSEOUT_LEAD_MINUTES * 60 * 1000);
  const now = Date.now();
  if (fireAt.getTime() <= now) return {}; // already too late — nothing to schedule

  const actorUsernames = await resolveActorUsernamesForSlot(record.dateISO, record.time);
  if (!actorUsernames.length) return {};

  const actors = await getActorsMap();
  const existingByActor = {};
  (Array.isArray(record.closeouts) ? record.closeouts : []).forEach((c) => {
    if (c && c.actorUsername) existingByActor[c.actorUsername] = c;
  });

  const delaySeconds = Math.floor((fireAt.getTime() - now) / 1000);
  const destination = `${siteUrl.replace(/\/$/, '')}/api/telegram-closeout`;

  const closeouts = await Promise.all(actorUsernames.map(async (actorUsername) => {
    const already = existingByActor[actorUsername];
    if (already && already.status === 'scheduled' && already.msgId) return already; // don't duplicate

    const actor = actors[actorUsername];
    if (!actor || !actor.chatId) {
      return { actorUsername, status: 'actor-not-registered' };
    }

    if (delaySeconds > QSTASH_MAX_DELAY_SECONDS) {
      // Further out than QStash's free-tier delay ceiling — the daily
      // sweep (api/cron/reminders-sweep.js) schedules it for real once
      // it's in range, same as booking reminders.
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
        body: JSON.stringify({ dateISO: record.dateISO, time: record.time, actorUsername }),
      });
      const qsData = await qsRes.json().catch(() => ({}));
      if (!qsRes.ok || !qsData.messageId) {
        console.error('QStash publish failed (closeout):', qsData);
        return { actorUsername, fireAt: fireAt.toISOString(), status: 'pending' };
      }
      return { actorUsername, msgId: qsData.messageId, fireAt: fireAt.toISOString(), status: 'scheduled' };
    } catch (err) {
      console.error('Failed to reach QStash (closeout):', err);
      return { actorUsername, fireAt: fireAt.toISOString(), status: 'pending' };
    }
  }));

  return { closeouts };
}

// Cancels every previously-scheduled closeout job for a booking (cancelled
// or moved to a different date/time) — mirrors cancelReminder() in
// api/_reminders.js. Safe to call even if the record never had any
// closeouts scheduled.
export async function cancelGameCloseout(record) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !record || !Array.isArray(record.closeouts) || !record.closeouts.length) return;

  await Promise.all(record.closeouts.map(async (c) => {
    if (!c || !c.msgId) return;
    try {
      await fetch(`https://qstash.upstash.io/v2/messages/${c.msgId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${qstashToken}` },
      });
    } catch (err) {
      console.error('Failed to cancel QStash closeout message:', err);
    }
  }));
}

// Strips the closeout bookkeeping off a record — used when moving a
// booking (reschedule) so the fresh scheduleGameCloseout() call starts
// clean rather than inheriting stale scheduling info from the old slot.
// Mirrors stripReminderFields() in api/_reminders.js.
export function stripCloseoutFields(record) {
  const { closeouts, ...rest } = record;
  return rest;
}

// The actual "send ONE performer their sverka for ONE booking" logic —
// the single-booking equivalent of what used to be a whole-shift batch.
// Shared by: api/telegram-closeout.js (the automatic QStash job, firing
// 80 minutes after that booking's start), api/admin/shifts.js's
// "Сверка сейчас" button (via runCloseoutForSlot below, for whenever the
// automatic one didn't go out or needs retrying), and the daily
// missed-closeout safety net (sweepMissedCloseouts below). Always returns
// a small result object describing what happened instead of silently
// returning — so a failure is never invisible.
export async function runCloseoutForBooking(dateISO, time, actorUsername) {
  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hget', hashKey, time);
  if (!raw) return { ok: false, reason: 'no-booking', message: 'Эта бронь больше не существует.' };
  let record;
  try { record = JSON.parse(raw); } catch { return { ok: false, reason: 'bad-record', message: 'Повреждённая запись брони.' }; }
  if (!record || record.type !== 'customer') return { ok: false, reason: 'not-customer', message: 'Это не клиентская бронь.' };
  if (record.status === 'cancelled' || record.status === 'rescheduled') {
    return { ok: false, reason: 'not-applicable', message: 'Бронь отменена или перенесена — сверка не нужна.' };
  }

  // `closeoutStatus` (awaiting/confirmed/edited/...) is a single field
  // SHARED across every performer covering this booking — see the data
  // model comment at the top of this file. That's fine for tracking a
  // REPLY (only one conversation happens at a time either way), but it
  // must NOT be used to decide whether THIS performer has already been
  // SENT their message — otherwise, on a booking covered by both an actor
  // and an actress, the moment the first one's send flips closeoutStatus
  // to 'awaiting', the second would look "already sent" and never get
  // their own message at all. So the send-gate below is tracked
  // per-performer, inside this booking's own `closeouts` array (the same
  // array scheduleGameCloseout() populated), using each entry's
  // `sentStatus` field — independent from the shared `closeoutStatus`.
  const closeouts = Array.isArray(record.closeouts) ? record.closeouts : [];
  const idx = closeouts.findIndex((c) => c && c.actorUsername === actorUsername);
  const existing = idx >= 0 ? closeouts[idx] : null;

  // Already sent to THIS performer (awaiting a reply) — don't re-send.
  // 'send-failed'/'actor-not-registered' ARE retried (that's the point of
  // the manual button and the safety net).
  if (existing && existing.sentStatus && existing.sentStatus !== 'send-failed' && existing.sentStatus !== 'actor-not-registered') {
    return { ok: true, reason: 'already-sent', message: 'По этой игре сверка уже отправлена или уже сверена.' };
  }

  function withCloseoutPatch(sentStatus) {
    const nextCloseouts = [...closeouts];
    if (idx >= 0) nextCloseouts[idx] = { ...existing, actorUsername, sentStatus };
    else nextCloseouts.push({ actorUsername, sentStatus });
    // closeoutStatus keeps its existing (reply-driven) value once one is
    // set — a second performer's send attempt shouldn't reset an already-
    // answered conversation back to 'awaiting'/'send-failed'.
    const closeoutStatus = (record.closeoutStatus && record.closeoutStatus !== 'send-failed' && record.closeoutStatus !== 'actor-not-registered')
      ? record.closeoutStatus
      : sentStatus;
    return { ...record, closeouts: nextCloseouts, closeoutStatus };
  }

  const actors = await getActorsMap();
  const actor = actors[actorUsername];
  if (!actor || !actor.chatId) {
    await kv('hset', hashKey, time, JSON.stringify(withCloseoutPatch('actor-not-registered')));
    return { ok: false, reason: 'actor-not-registered', message: `Актёр @${actorUsername} ещё не подключил бота (не отправил /start) — доставить некуда.` };
  }

  const dateLabel = formatDateLabel(dateISO);
  const lines = [
    `🎬 Сверка игры — ${dateLabel}, ${time}`,
    record.name ? `👤 ${record.name}` : null,
    record.players ? `👥 ${record.players}` : null,
    record.price ? `💰 ${record.price} Br` : null,
  ].filter(Boolean);

  const sendResult = await tg('sendMessage', {
    chat_id: actor.chatId,
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Верно', callback_data: `co|ok|${dateISO}|${time}` },
        { text: '✏️ Исправить', callback_data: `co|edit|${dateISO}|${time}` },
      ]],
    },
  });

  const nextSentStatus = (sendResult && sendResult.ok) ? 'awaiting' : 'send-failed';
  await kv('hset', hashKey, time, JSON.stringify(withCloseoutPatch(nextSentStatus)));

  if (!sendResult || !sendResult.ok) {
    return { ok: false, reason: 'send-failed', message: `Не удалось отправить сверку актёру @${actorUsername} (возможно, заблокировал бота).` };
  }
  return { ok: true, reason: 'sent', message: `Сверка по игре ${time} отправлена актёру @${actorUsername}.` };
}

// The admin's manual "Сверка сейчас" button is organized per shift slot
// (that's the unit the "Смены и напоминания" screen shows), so this stays
// the entry point for it — but now it just resolves every booking that
// slot's actor covers on that date and runs the single-booking sender
// (above) for each one that still needs it, aggregating the results. Also
// used by the safety-net sweep for shifts caught by the "found nothing at
// the time, bookings appeared later" pattern.
export async function runCloseoutForSlot(dateISO, slot) {
  const shiftsMap = await getShiftsForDate(dateISO);
  const slotData = shiftsMap[slot];
  if (!slotData || !slotData.actorUsername) {
    return { ok: false, reason: 'no-shift', message: 'На эту смену никто не назначен.' };
  }

  const hashKey = `bookings:${dateISO}`;
  const bookingsRaw = await kv('hgetall', hashKey);
  const bookingTimes = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer' || record.status === 'cancelled' || record.status === 'rescheduled') continue;
      const resolvedTime = record.time || time;
      // eslint-disable-next-line no-await-in-loop
      const resolvedActors = await resolveActorUsernamesForSlot(dateISO, resolvedTime);
      if (resolvedActors.includes(slotData.actorUsername)) bookingTimes.push(resolvedTime);
    }
  }
  bookingTimes.sort((a, b) => a.localeCompare(b));

  if (!bookingTimes.length) {
    return { ok: false, reason: 'no-bookings', message: 'На это время не нашлось броней для этой смены.', actorUsername: slotData.actorUsername };
  }

  let sentCount = 0;
  let alreadySentCount = 0;
  const perBooking = [];
  for (const time of bookingTimes) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runCloseoutForBooking(dateISO, time, slotData.actorUsername);
    perBooking.push({ time, ...result });
    if (result.ok && result.reason === 'sent') sentCount++;
    if (result.ok && result.reason === 'already-sent') alreadySentCount++;
  }

  if (sentCount === 0 && alreadySentCount === bookingTimes.length) {
    return {
      ok: true,
      reason: 'already-sent',
      message: 'Все брони по этой смене уже отправлены на сверку или уже сверены.',
      bookingsCount: bookingTimes.length,
      actorUsername: slotData.actorUsername,
    };
  }

  return {
    ok: sentCount > 0,
    reason: sentCount > 0 ? 'sent' : 'send-failed',
    message: `Отправлено актёру @${slotData.actorUsername}: ${sentCount} из ${bookingTimes.length} (остальные уже были отправлены раньше или не удалось доставить).`,
    bookingsCount: bookingTimes.length,
    sentCount,
    actorUsername: slotData.actorUsername,
    perBooking,
  };
}

// Safety net for the daily sweep (api/cron/reminders-sweep.js): finds any
// customer booking whose sverka time (start + 80 minutes) has already
// passed (checked over the last couple of days, not just today) but where
// at least one of its covering performers still has NO send attempt
// recorded at all for it — meaning the automatic QStash job for THAT
// performer either never got scheduled (e.g. the shift was only assigned
// to that booking after the booking was made, too close to the fire time
// for anything to catch it before the next sweep) or fired and something
// went wrong before ever stamping a result — and sends it. This check is
// per-performer (via each closeouts[] entry's `sentStatus`, same as
// runCloseoutForBooking's own gate) rather than the shared
// `closeoutStatus` field, precisely so a booking covered by BOTH an actor
// and an actress doesn't get treated as "fully handled" the moment just
// one of them has been messaged. A performer who already has SOME
// sentStatus (even 'send-failed'/'actor-not-registered') is left alone —
// those are already visible in the admin panel and worth a human decision
// (or a manual "Сверка сейчас" click), not an automatic retry loop.
export async function sweepMissedCloseouts(dateISOList) {
  let attempted = 0;
  const results = [];
  await Promise.all(dateISOList.map(async (dateISO) => {
    const hashKey = `bookings:${dateISO}`;
    const bookingsRaw = await kv('hgetall', hashKey);
    if (!Array.isArray(bookingsRaw)) return;

    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer' || record.status === 'cancelled' || record.status === 'rescheduled') continue;

      const resolvedTime = record.time || time;
      const startAt = parseWallClock(dateISO, resolvedTime);
      if (!startAt) continue;
      const fireAt = new Date(startAt.getTime() + CLOSEOUT_LEAD_MINUTES * 60 * 1000);
      if (fireAt.getTime() > Date.now()) continue; // not due yet

      // eslint-disable-next-line no-await-in-loop
      const actorUsernames = await resolveActorUsernamesForSlot(dateISO, resolvedTime);
      if (!actorUsernames.length) continue;

      const closeouts = Array.isArray(record.closeouts) ? record.closeouts : [];
      const missingActors = actorUsernames.filter((u) => !closeouts.some((c) => c && c.actorUsername === u && c.sentStatus));
      if (!missingActors.length) continue; // every covering performer already has SOME send attempt recorded

      attempted++;
      for (const actorUsername of missingActors) {
        // eslint-disable-next-line no-await-in-loop
        const result = await runCloseoutForBooking(dateISO, resolvedTime, actorUsername);
        results.push({ dateISO, time: resolvedTime, actorUsername, ...result });
      }
    }
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
