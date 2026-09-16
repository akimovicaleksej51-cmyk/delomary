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
// arrives at 12:00 (exactly 1 hour later) regardless of when the shift as
// a whole ends, instead of everyone's sverka arriving in one batch at
// shift end.
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
//                                 { dateISO, time, stage, players? }
//                                 stage is one of:
//                                   'custom_players' — actor tapped "✏️
//                                     Другое количество" on the player-count
//                                     buttons, typing the exact number next.
//                                   'custom_price'   — tapped "✏️ Своя
//                                     цена" on the price buttons; `players`
//                                     carries the count picked just before.
//                                   'discount'       — tapped "🏷 Скидка";
//                                     same `players` carry-over as above.
//                                   'payment'        — the cash/card/ERIP
//                                     question after players+price are set.
//                                   'players_price'  — LEGACY free-text
//                                     "4, 200" stage from before the button
//                                     redesign; kept only so a conversation
//                                     already in flight the moment this
//                                     shipped still finishes correctly.
//                                   'cash'           — even older legacy
//                                     stage, from before the cash/card/ERIP
//                                     split existed.
//                                 See api/telegram-webhook.js for all of the
//                                 above. Short TTL — if the actor never
//                                 replies, it just expires.
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
import { getShiftsForDate, getActorsMap, resolveActorUsernamesForSlot, resolveActorUsernamesForSlotSync } from './_reminders.js';

// ── РУЧНАЯ СВЕРКА (16.09.2026) ───────────────────────────────────────────
// По просьбе владельца сверка через Telegram-бота (карточка "🎬 Сверка
// игры" с кнопками "✅ Верно"/"✏️ Исправить") полностью отключена. Актёры
// по-прежнему получают обычное напоминание за 1.5ч до игры — это отдельная,
// не связанная с закрытием игры система (api/_reminders.js), она не
// тронута. Вместо ответа актёра в боте сотрудник теперь сам отмечает
// результат игры в новой упрощённой панели (staff.html) — см.
// setManualCloseout()/cancelManualCloseout() ниже, и action:'manualCloseout'
// в api/admin/bookings.js.
//
// Один флаг гасит обе стороны бот-сверки разом, ничего не удаляя:
//   - scheduleGameCloseout() ниже возвращает {} сразу — новые сверки
//     больше не планируются ни для одной новой/перенесённой брони.
//   - runCloseoutForBooking() ниже отказывается ОТПРАВЛЯТЬ что-либо — это
//     же глушит "Сверка сейчас"/QStash-джобы, ранее поставленные до этого
//     изменения (runCloseoutForSlot и telegram-closeout.js оба идут через
//     эту функцию), не давая им внезапно ожить и написать актёру.
// cancelGameCloseout() (отмена уже запланированной джобы) НЕ гасится —
// это просто уборка, она безопасна и всё ещё нужна при отмене/переносе
// старых броней. Чтобы вернуть сверку через бота — поставьте true.
//
// Переопределяется переменной окружения ИСКЛЮЧИТЕЛЬНО для тестов (чтобы не
// выбрасывать регрессионные тесты старого бот-механизма — вдруг он ещё
// понадобится): в проде эта переменная нигде не задаётся, поэтому там
// сверка через бота всегда выключена.
const BOT_CLOSEOUT_ENABLED = process.env.BOT_CLOSEOUT_ENABLED_FOR_TESTS === '1';

const CLOSEOUT_LEAD_MINUTES = 60; // ровно 1 час ПОСЛЕ начала игры (бронь в 13:30 → сверка в 14:30)
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

// Same reasoning as KV_TIMEOUT_MS in api/_kv.js: a fetch() to Telegram that
// never settles must not be allowed to hang a caller forever. (Overridable
// via env var for tests; production never sets this, so it's always 8000ms.)
const TG_TIMEOUT_MS = Number(process.env.TG_TIMEOUT_MS) || 8000;

// Returns the parsed Telegram API response, or { ok:false } if the request
// itself couldn't even be made (network error, no bot token, or timeout).
async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error(`closeout: ${method} returned not-ok:`, data);
    return data;
  } catch (err) {
    console.error(`closeout: ${method} failed:`, err);
    return { ok: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Schedules one job per performer covering a customer booking's slot — an
// actor AND an actress are routinely on shift for the very same booking,
// and each gets their own independent sverka, exactly CLOSEOUT_LEAD_MINUTES
// (1 hour) after the game STARTS (not tied to when their shift ends). Returns a patch object
// ({ closeouts: [...] }) to merge into the booking record — callers are
// responsible for persisting it back to KV, exactly like scheduleReminder()
// in api/_reminders.js. Safe to call unconditionally for every customer
// booking, and safe to call repeatedly (the daily sweep does): a performer
// who already has a successfully scheduled closeout is left untouched.
export async function scheduleGameCloseout(record) {
  if (!BOT_CLOSEOUT_ENABLED) return {};
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

// ── РУЧНАЯ СВЕРКА ────────────────────────────────────────────────────────
// Заменяет бот-подтверждение (см. флаг BOT_CLOSEOUT_ENABLED выше): сотрудник
// в staff.html сам отмечает, состоялась ли игра, и правит цену/число
// игроков прямо там. `played:false` значит "игра не состоялась" — price/
// players в этом случае не трогаем (сверять нечего), просто фиксируем факт.
//
// Важно про priceBefore/playersBefore: они замораживаются ОДИН РАЗ, при
// самой первой успешной сверке этой брони, и дальше не переписываются —
// даже если сверку потом ещё раз открыть и поправить цену снова. Иначе
// вторая правка "съела" бы разницу первой, и стрелка "было → стало" в
// списке показывала бы уже не настоящую исходную цену, а то, что сверка
// сама же туда недавно записала.
export async function setManualCloseout(dateISO, time, { played, price, players, discountNote, payCash, payCard, payErip, confirmedBy } = {}) {
  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hget', hashKey, time);
  if (!raw) return { ok: false, reason: 'no-booking', message: 'Эта бронь больше не существует.' };
  let record;
  try { record = JSON.parse(raw); } catch { return { ok: false, reason: 'bad-record', message: 'Повреждённая запись брони.' }; }
  if (!record || record.type !== 'customer') {
    return { ok: false, reason: 'not-customer', message: 'Это не клиентская бронь.' };
  }
  if (record.status === 'cancelled' || record.status === 'rescheduled') {
    return { ok: false, reason: 'not-applicable', message: 'Бронь отменена или перенесена — сверка не нужна.' };
  }

  const wasPlayed = played !== false;
  const already = record.manualCloseout && record.manualCloseout.done ? record.manualCloseout : null;
  const nextPrice = wasPlayed && price !== '' && price != null ? String(price) : record.price;
  const nextPlayers = wasPlayed && players !== '' && players != null ? String(players) : record.players;
  // Скидка и способ оплаты (16.09.2026): в отличие от price/players выше,
  // эти поля НЕ получают before/after-стрелку в общем списке — сотрудник
  // просто перезаписывает их во время сверки, как в обычном редактировании
  // брони. '' — валидное значение (например, снять скидку или обнулить
  // неактуальный способ оплаты), поэтому здесь проверяем именно "!= null",
  // а не "не пусто".
  const nextDiscountNote = wasPlayed && discountNote != null ? String(discountNote) : record.discountNote;
  const nextPayCash = wasPlayed && payCash != null ? String(payCash) : record.payCash;
  const nextPayCard = wasPlayed && payCard != null ? String(payCard) : record.payCard;
  const nextPayErip = wasPlayed && payErip != null ? String(payErip) : record.payErip;

  const manualCloseout = {
    done: true,
    played: wasPlayed,
    confirmedAt: new Date().toISOString(),
    confirmedBy: confirmedBy || (already ? already.confirmedBy : '') || '',
  };
  if (already && Object.prototype.hasOwnProperty.call(already, 'priceBefore')) {
    manualCloseout.priceBefore = already.priceBefore;
  } else if (wasPlayed && nextPrice !== record.price) {
    manualCloseout.priceBefore = record.price;
  }
  if (already && Object.prototype.hasOwnProperty.call(already, 'playersBefore')) {
    manualCloseout.playersBefore = already.playersBefore;
  } else if (wasPlayed && nextPlayers !== record.players) {
    manualCloseout.playersBefore = record.players;
  }

  const updated = {
    ...record,
    price: nextPrice,
    players: nextPlayers,
    discountNote: nextDiscountNote,
    payCash: nextPayCash,
    payCard: nextPayCard,
    payErip: nextPayErip,
    manualCloseout,
  };
  await kv('hset', hashKey, time, JSON.stringify(updated));
  return { ok: true, reason: 'saved', message: 'Сверка сохранена.', booking: { ...updated, dateISO, time } };
}

// Undoes a manual sverka: restores whatever price/players were BEFORE it
// (if the sverka actually changed them — a booking whose sverka never
// touched price/players has nothing to restore) and drops the
// manualCloseout marker, so staff can redo it from scratch.
export async function cancelManualCloseout(dateISO, time) {
  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hget', hashKey, time);
  if (!raw) return { ok: false, reason: 'no-booking', message: 'Эта бронь больше не существует.' };
  let record;
  try { record = JSON.parse(raw); } catch { return { ok: false, reason: 'bad-record', message: 'Повреждённая запись брони.' }; }
  if (!record.manualCloseout || !record.manualCloseout.done) {
    return { ok: false, reason: 'nothing-to-cancel', message: 'По этой брони сверка ещё не проводилась.' };
  }

  const { manualCloseout, ...rest } = record;
  const restored = { ...rest };
  if (Object.prototype.hasOwnProperty.call(manualCloseout, 'priceBefore')) restored.price = manualCloseout.priceBefore;
  if (Object.prototype.hasOwnProperty.call(manualCloseout, 'playersBefore')) restored.players = manualCloseout.playersBefore;

  await kv('hset', hashKey, time, JSON.stringify(restored));
  return { ok: true, reason: 'cancelled', message: 'Сверка отменена — можно провести заново.' };
}

// The actual "send ONE performer their sverka for ONE booking" logic —
// the single-booking equivalent of what used to be a whole-shift batch.
// Shared by: api/telegram-closeout.js (the automatic QStash job, firing
// 60 minutes (1 hour) after that booking's start), api/admin/shifts.js's
// "Сверка сейчас" button (via runCloseoutForSlot below, for whenever the
// automatic one didn't go out or needs retrying), and the daily
// missed-closeout safety net (sweepMissedCloseouts below). Always returns
// a small result object describing what happened instead of silently
// returning — so a failure is never invisible.
export async function runCloseoutForBooking(dateISO, time, actorUsername, ctx = {}) {
  if (!BOT_CLOSEOUT_ENABLED) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'Сверка через Telegram-бота отключена — теперь она проводится вручную в новой панели администратора (staff.html).',
    };
  }
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

  // Already sent to THIS performer (awaiting a reply) — normally don't
  // re-send. 'send-failed'/'actor-not-registered' ARE always retried
  // (that's the point of the manual button and the safety net).
  //
  // ctx.force (set only by the admin's manual "Сверка сейчас" button — see
  // runCloseoutForSlot below) overrides the "awaiting" skip specifically:
  // Telegram's API can report a message as successfully sent (sentStatus
  // stays 'awaiting') while the performer swears it never arrived on their
  // end — a stale/changed chat, a muted conversation, or just Telegram
  // being Telegram. Without a way to force a fresh attempt, the button was
  // stuck always answering "already sent" and never actually retrying,
  // which is exactly what this fixes. It does NOT override a booking the
  // performer has actually ANSWERED (closeoutStatus 'confirmed'/'edited')
  // — resending to someone who already replied would just be confusing,
  // there's nothing left to ask them.
  const alreadyAnswered = record.closeoutStatus === 'confirmed' || record.closeoutStatus === 'edited';
  const isRetryableFailure = existing && (existing.sentStatus === 'send-failed' || existing.sentStatus === 'actor-not-registered');
  const shouldSkipSend = existing && existing.sentStatus && !isRetryableFailure && !(ctx.force && !alreadyAnswered);
  if (shouldSkipSend) {
    return alreadyAnswered
      ? { ok: true, reason: 'already-answered', message: 'По этой игре сверка уже получена и подтверждена актёром — переспрашивать нечего.' }
      : { ok: true, reason: 'already-sent', message: 'По этой игре сверка уже отправлена или уже сверена.' };
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

  // A caller that's doing this for many bookings at once (runCloseoutForSlot,
  // sweepMissedCloseouts below) already fetched the whole actors map once
  // and passes it in via ctx.actorsMap, instead of every single booking
  // re-fetching the ENTIRE actors hash from KV just to read one entry.
  const actors = ctx.actorsMap || await getActorsMap();
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

  // Fetch the bookings hash and the actors map ONCE, up front, in parallel —
  // not once per booking. This used to call resolveActorUsernamesForSlot()
  // (its own shifts:<date> KV read) AND getActorsMap() (a full actors hash
  // read) inside a sequential per-booking loop, so a shift with a full day
  // of bookings turned into dozens of back-to-back Upstash round-trips —
  // slow enough on a busy day to blow past the serverless function's time
  // limit, which is exactly what made this button just spin forever with
  // no response ever coming back to the admin panel.
  const hashKey = `bookings:${dateISO}`;
  const [bookingsRaw, actorsMap] = await Promise.all([
    kv('hgetall', hashKey),
    getActorsMap(),
  ]);
  const bookingTimes = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer' || record.status === 'cancelled' || record.status === 'rescheduled') continue;
      const resolvedTime = record.time || time;
      const resolvedActors = resolveActorUsernamesForSlotSync(shiftsMap, resolvedTime);
      if (resolvedActors.includes(slotData.actorUsername)) bookingTimes.push(resolvedTime);
    }
  }
  bookingTimes.sort((a, b) => a.localeCompare(b));

  if (!bookingTimes.length) {
    return { ok: false, reason: 'no-bookings', message: 'На это время не нашлось броней для этой смены.', actorUsername: slotData.actorUsername };
  }

  // Each booking here is a DIFFERENT record (a different field in the
  // bookings hash), so there's no shared record for two of these calls to
  // race on — that part would be just as safe done concurrently. (Two
  // performers on the SAME booking, e.g. an actor and an actress, is a
  // different story — see sweepMissedCloseouts below, which keeps THAT
  // part sequential.)
  //
  // But these ARE sent ONE AT A TIME, in ascending time order, on purpose —
  // this used to fire all of them at once with Promise.all, which sent the
  // requests correctly but let Telegram's own network timing decide which
  // one actually ARRIVED in the actor's chat first. The admin reported
  // exactly that: clicking "Сверка сейчас" for a shift with games at
  // 11:00/12:30/14:00/15:30/17:00 delivered them to the actor in a random
  // order (e.g. 11:00, 17:00, 14:00, ...) instead of matching the order the
  // games actually happen in, which is confusing to read through. Sending
  // them strictly in sequence (await, not Promise.all) makes delivery order
  // match dispatch order — Telegram processes one bot's consecutive
  // sendMessage calls to the same chat in the order they're received. The
  // shifts/bookings/actors maps are still all fetched ONCE up front (the
  // fix for the earlier "button just spins forever" bug — see
  // test_closeout_slot_performance.mjs), so this only serializes the
  // actual per-booking send (1 KV write + 1 Telegram call each) — for a
  // normal shift's handful of bookings that's a barely-noticeable delay,
  // not the old N+1-reads-per-booking blowup.
  //
  // force:true — this is the admin explicitly clicking "Сверка сейчас",
  // which now means it FOR REAL, right now: it resends even to a performer
  // who already has an 'awaiting' send recorded (Telegram said delivered,
  // but they say it never arrived) — see the comment on the skip check in
  // runCloseoutForBooking above. Only a booking the performer has actually
  // ANSWERED is left alone.
  const results = [];
  for (const time of bookingTimes) {
    results.push(await runCloseoutForBooking(dateISO, time, slotData.actorUsername, { actorsMap, force: true }));
  }

  let sentCount = 0;
  let alreadyAnsweredCount = 0;
  const perBooking = [];
  results.forEach((result, i) => {
    perBooking.push({ time: bookingTimes[i], ...result });
    if (result.ok && result.reason === 'sent') sentCount++;
    if (result.ok && result.reason === 'already-answered') alreadyAnsweredCount++;
  });

  if (sentCount === 0 && alreadyAnsweredCount === bookingTimes.length) {
    return {
      ok: true,
      reason: 'already-answered',
      message: 'По всем броням этой смены сверка уже получена и подтверждена — переспрашивать нечего.',
      bookingsCount: bookingTimes.length,
      actorUsername: slotData.actorUsername,
    };
  }

  return {
    ok: sentCount > 0,
    reason: sentCount > 0 ? 'sent' : 'send-failed',
    message: `Отправлено (или отправлено повторно) актёру @${slotData.actorUsername}: ${sentCount} из ${bookingTimes.length} (остальные уже подтверждены актёром, или не удалось доставить — актёр ещё не подключил бота).`,
    bookingsCount: bookingTimes.length,
    sentCount,
    actorUsername: slotData.actorUsername,
    perBooking,
  };
}

// The "Отменить сверку" counterpart of runCloseoutForSlot above, for the
// same (date, slot) unit the "Смены и напоминания" screen shows — the
// admin doesn't need to open every booking's own card one by one to redo a
// whole shift's sverka. For every booking this slot's actor covers on that
// date whose sverka is already COMPLETE (closeoutStatus 'confirmed' or
// 'edited'), clears that result — same fields api/admin/bookings.js's
// per-booking 'cancelCloseout' action clears (payment, who worked it, the
// per-performer send-tracking, the shared closeoutStatus) — leaving the
// booking as if sverka never happened for it. Bookings still only
// 'awaiting' a reply, or with no sverka yet at all, are left untouched
// (nothing to cancel there). Does NOT resend anything — use "Сверка
// сейчас" for that afterwards, same as the single-booking flow.
export async function cancelCloseoutForSlot(dateISO, slot) {
  const shiftsMap = await getShiftsForDate(dateISO);
  const slotData = shiftsMap[slot];
  if (!slotData || !slotData.actorUsername) {
    return { ok: false, reason: 'no-shift', message: 'На эту смену никто не назначен.' };
  }

  const hashKey = `bookings:${dateISO}`;
  const bookingsRaw = await kv('hgetall', hashKey);
  const candidates = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (!record || record.type !== 'customer') continue;
      if (record.status === 'cancelled' || record.status === 'rescheduled') continue;
      const resolvedTime = record.time || time;
      const resolvedActors = resolveActorUsernamesForSlotSync(shiftsMap, resolvedTime);
      if (!resolvedActors.includes(slotData.actorUsername)) continue;
      candidates.push({ time, record });
    }
  }

  if (!candidates.length) {
    return { ok: false, reason: 'no-bookings', message: 'На это время не нашлось броней для этой смены.', actorUsername: slotData.actorUsername };
  }

  const toCancel = candidates.filter(({ record }) => record.closeoutStatus === 'confirmed' || record.closeoutStatus === 'edited');
  if (!toCancel.length) {
    return {
      ok: true,
      reason: 'nothing-to-cancel',
      message: 'По броням этой смены ещё нет завершённой сверки — отменять нечего.',
      bookingsCount: candidates.length,
      actorUsername: slotData.actorUsername,
    };
  }

  await Promise.all(toCancel.map(({ time, record }) => {
    const {
      closeoutStatus, closeouts, payCash, payCard, payErip,
      closeoutCashCollected, closeoutRepliedAt, paymentReportedBy,
      workedActor, workedActress, discountNote,
      ...rest
    } = record;
    return kv('hset', hashKey, time, JSON.stringify(rest));
  }));

  return {
    ok: true,
    reason: 'cancelled',
    message: `Сверка отменена по ${toCancel.length} из ${candidates.length} броней этой смены (остальные ещё не были завершены). Нажмите «Сверка сейчас», чтобы отправить их актёру @${slotData.actorUsername} заново.`,
    bookingsCount: candidates.length,
    cancelledCount: toCancel.length,
    actorUsername: slotData.actorUsername,
  };
}

// Safety net for the daily sweep (api/cron/reminders-sweep.js): finds any
// customer booking whose sverka time (start + 60 minutes) has already
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
    // Same fix as runCloseoutForSlot() above: fetch this date's shifts and
    // the actors map ONCE (in parallel with the bookings hash) instead of
    // resolveActorUsernamesForSlot()/getActorsMap() re-fetching them from
    // KV on every single booking in the loop below.
    const hashKey = `bookings:${dateISO}`;
    const [bookingsRaw, shiftsMap, actorsMap] = await Promise.all([
      kv('hgetall', hashKey),
      getShiftsForDate(dateISO),
      getActorsMap(),
    ]);
    if (!Array.isArray(bookingsRaw)) return;

    // Different bookings (different hash fields) can safely be handled in
    // parallel; ONLY the actor/actress pair on the very same booking must
    // stay sequential, since both would otherwise read-modify-write the
    // same record's `closeouts` array at once and one write could clobber
    // the other (the same class of race fixed for payment reporting).
    await Promise.all(Array.from({ length: Math.floor(bookingsRaw.length / 2) }, (_, i) => i).map(async (i) => {
      const time = bookingsRaw[i * 2];
      let record;
      try { record = JSON.parse(bookingsRaw[i * 2 + 1]); } catch { return; }
      if (!record || record.type !== 'customer' || record.status === 'cancelled' || record.status === 'rescheduled') return;

      const resolvedTime = record.time || time;
      const startAt = parseWallClock(dateISO, resolvedTime);
      if (!startAt) return;
      const fireAt = new Date(startAt.getTime() + CLOSEOUT_LEAD_MINUTES * 60 * 1000);
      if (fireAt.getTime() > Date.now()) return; // not due yet

      const actorUsernames = resolveActorUsernamesForSlotSync(shiftsMap, resolvedTime);
      if (!actorUsernames.length) return;

      const closeouts = Array.isArray(record.closeouts) ? record.closeouts : [];
      const missingActors = actorUsernames.filter((u) => !closeouts.some((c) => c && c.actorUsername === u && c.sentStatus));
      if (!missingActors.length) return; // every covering performer already has SOME send attempt recorded

      attempted++;
      for (const actorUsername of missingActors) {
        // eslint-disable-next-line no-await-in-loop
        const result = await runCloseoutForBooking(dateISO, resolvedTime, actorUsername, { actorsMap });
        results.push({ dateISO, time: resolvedTime, actorUsername, ...result });
      }
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
