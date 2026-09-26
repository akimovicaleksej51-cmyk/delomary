// Serverless function (Vercel Node.js runtime).
// Receives Telegram "updates" for the SAME bot that already sends booking
// notifications (TELEGRAM_BOT_TOKEN). It does two things:
//
//   1. Catches an actor's one-time /start so their Telegram *username*
//      turns into a chat id we can actually message (Telegram can only
//      message a private chat once that person has messaged the bot at
//      least once — there is no way to send by @username alone). Records
//      { username → chat id } in the "actors" hash — see api/_reminders.js.
//
//   2. Runs the "shift closeout" conversation: once api/internal-jobs.js (?job=closeout)
//      sends an actor their end-of-shift check-in, this is what handles
//      the "✅ Верно" / "✏️ Исправить" button taps (Telegram calls these
//      "callback queries") and the free-text replies that follow —
//      correcting a booking's player count/price, and how the game was
//      paid for (cash / card / ERIP / a split of these — see
//      parsePayment() below, feeds straight into "Касса" — see
//      api/_finance.js). See api/_closeout.js for the full data model.
//
// If a button tap ever just shows Telegram's loading spinner and nothing
// happens, there are two independent things that can cause it, and both are
// guarded against now:
//
//   1. Telegram isn't delivering "callback_query" updates to this endpoint
//      at all (so nothing here even runs) — check
//        https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
//      in a browser. "url" must be exactly <SITE_URL>/api/telegram-webhook,
//      and "last_error_message" (if present) tells you what's failing. If
//      it's blank/wrong, redo the setWebhook step below.
//
//   2. This code DID run, but got stuck on a network call that never
//      resolved (a hung fetch to Upstash or to Telegram itself — this is
//      not hypothetical, it's the confirmed cause of a real stuck-spinner
//      report). A hang is neither a resolve nor a reject, so a plain
//      try/catch never sees it. Fixed on three layers: every kv() call has
//      its own timeout (api/_kv.js), every outbound Telegram call here has
//      its own timeout, and handleCallbackQuery() below additionally runs a
//      watchdog timer that answers the callback query on its own if
//      everything else somehow still hasn't after a few seconds. Net
//      result: a tap can end in an error alert, but it can never again spin
//      forever.
//
// One-time setup (do this once, after deploying this file and setting the
// env vars below):
//   Open in a browser (replace the two placeholders):
//     https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<SITE_URL>/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
//   A reply with "ok":true means Telegram will now forward messages here.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN      — same token api/book.js already uses.
//   TELEGRAM_WEBHOOK_SECRET — a secret string you make up yourself; must
//                              match the secret_token given to setWebhook
//                              above. Telegram echoes it back on every
//                              request as a header, which is how this
//                              endpoint knows a request really came from
//                              Telegram and not somebody guessing the URL.

import { kv } from './_kv.js';
import { getPendingActorReply, setPendingActorReply, clearPendingActorReply, BOT_CLOSEOUT_ENABLED } from './_closeout.js';
import { getShiftsForDate, getActorsMap, SHIFT_SLOTS } from './_reminders.js';

// Which booking field ("Кто отыграл") a confirming actor's reply should
// fill in, and what name to put there — resolved from the CURRENT shift
// schedule by matching this chat id back to the username covering that
// booking's slot at that date/time. Previously this field only ever got
// filled in by the admin typing it in by hand after the fact; now a "✅
// Верно"/edited confirmation in Telegram fills it in immediately, so the
// per-actor "games played this month" stat in Финансы updates itself
// without anyone needing to remember to go do it manually. Returns null if
// no shift slot for that date/time matches this chat (e.g. the shift was
// since cleared/reassigned) — callers just skip setting the field then.
async function resolveWorkedField(dateISO, time, chatId) {
  const [shiftsMap, actorsMap] = await Promise.all([getShiftsForDate(dateISO), getActorsMap()]);
  for (const slotId of SHIFT_SLOTS) {
    const s = shiftsMap[slotId];
    if (!s || !s.actorUsername || !(s.start <= time && time < s.end)) continue;
    const info = actorsMap[s.actorUsername];
    if (!info || info.chatId !== chatId) continue;
    const field = slotId.startsWith('actress') ? 'workedActress' : 'workedActor';
    return { field, name: info.displayName || s.actorUsername, actorUsername: s.actorUsername };
  }
  return null;
}

// Which registered performer this Telegram chat belongs to — a plain
// reverse lookup on the `actors` hash, independent of today's shift
// schedule (unlike resolveWorkedField, which only matches a chat to a
// SLOT that's currently assigned). Used to remember which performer
// reported a game's payment, so a second performer confirming the same
// booking doesn't blindly overwrite the first one's numbers — see
// askAboutPaymentOrSkip() below.
async function resolveActorUsernameByChatId(chatId) {
  const actorsMap = await getActorsMap();
  for (const [username, info] of Object.entries(actorsMap)) {
    if (info && info.chatId === chatId) return username;
  }
  return null;
}

// A fetch() that hangs forever (no response, no error — a stuck connection)
// is not hypothetical, and it's the actual cause found for the "tap Верно,
// spinner just spins forever" bug: this file's very first step on a button
// tap is a kv()-backed getPendingActorReply() call (see handleCallbackQueryInner
// below); if that underlying fetch never settles, the whole handler hangs
// before it ever reaches answerCallbackQuery — and a hang is neither a
// resolve nor a reject, so the try/catch around handleCallbackQuery never
// runs either. Eventually the serverless function is killed by its own
// platform timeout with zero chance to ever answer Telegram, leaving the
// tapped button stuck on "Загрузка..." forever, exactly as reported. Capping
// every outbound Telegram call here at a few seconds means the worst case
// becomes "fails fast, we log it and move on" instead of "hangs forever."
// (Overridable via env var for tests; production never sets this, so it's
// always 8000ms there.)
const TG_TIMEOUT_MS = Number(process.env.TG_TIMEOUT_MS) || 8000;

async function tg(token, method, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    console.error(`telegram-webhook: ${method} failed:`, err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Russian pluralization for "N человек/человека" — matches the style
// already used in the tier labels shown at booking time.
function playersLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word = 'человек';
  if (mod10 === 1 && mod100 !== 11) word = 'человек';
  else if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) word = 'человека';
  return `${n} ${word}`;
}

// "4, 200" / "4 200" / "игроков 4, цена 200" → [4, 200] — pulls out every
// integer in the text and takes the first two (players, then price).
// Kept only for the LEGACY 'players_price' free-text stage — any
// conversation already mid-reply the moment this update goes out still
// needs to finish the way it started, see the 'players_price' branch below.
function extractIntegers(text) {
  const matches = String(text).match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

// ── Button-based player-count / price / discount редизайн ────────────────
// Replaces the old "reply with free text: 4, 200" flow for the "✏️
// Исправить" path. Two reasons: (1) the site owner asked for buttons
// instead of typing, and (2) typing invited exactly the kind of mistake
// that made every sverka in one report show the same price regardless of
// the actual booking — a stray or misread digit in free text silently
// became the new price with no cross-check. Buttons remove that class of
// mistake entirely for the standard cases, while still allowing a typed
// custom price or a discount note for the exceptional ones.
//
// All the state this multi-step conversation needs (which booking, which
// player count was already picked) travels INSIDE each button's own
// callback_data instead of a server-side session — simpler and more
// robust than a KV-backed pending state for the button-only steps (no TTL
// to race against, nothing to leave dangling if the actor never finishes).
// A KV-backed pendingActorReply is still used, exactly as before, for the
// two steps that need the actor to actually type something (a custom
// price, a discount, or a custom player count).

// The exact set of prices this business uses across every combination of
// day type (будни/выходной), team size tier, and the +20 Br late-session
// (23:00) surcharge — see tiersFor()/lateSurcharge in index.html. Shown as
// one flat list of buttons so correcting a sverka is always "tap the right
// number", never "remember which of four tiers plus a surcharge applies".
const PRICE_OPTIONS = [140, 160, 180, 190, 200, 210, 220, 230, 240, 260];
const PLAYER_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPlayersKeyboard(dateISO, time) {
  const rows = chunk(PLAYER_OPTIONS, 4).map((row) =>
    row.map((n) => ({ text: String(n), callback_data: `co|pl|${dateISO}|${time}|${n}` }))
  );
  rows.push([{ text: '✏️ Другое количество', callback_data: `co|plcustom|${dateISO}|${time}` }]);
  return { inline_keyboard: rows };
}

function buildPriceKeyboard(dateISO, time, playersNum) {
  const rows = chunk(PRICE_OPTIONS, 5).map((row) =>
    row.map((p) => ({ text: String(p), callback_data: `co|pr|${dateISO}|${time}|${playersNum}|${p}` }))
  );
  rows.push([
    { text: '✏️ Своя цена', callback_data: `co|prcustom|${dateISO}|${time}|${playersNum}` },
    { text: '🏷 Скидка', callback_data: `co|discount|${dateISO}|${time}|${playersNum}` },
  ]);
  return { inline_keyboard: rows };
}

// Applies the final players+price(+discount note) choice to a booking,
// saves it, and continues into the existing payment question — the single
// landing point for every path through the new button flow (a plain price
// button, a custom typed price, or a discount reply).
async function finalizeEdit(token, chatId, dateISO, time, record, playersNum, priceValue, discountNote) {
  const hashKey = `bookings:${dateISO}`;
  const worked = await resolveWorkedField(dateISO, time, chatId);
  const updated = {
    ...record,
    players: playersLabel(playersNum),
    price: String(priceValue),
    ...(discountNote != null ? { discountNote } : {}),
    closeoutStatus: 'edited',
    closeoutEditedFrom: { players: record.players || '', price: record.price || '' },
    closeoutRepliedAt: new Date().toISOString(),
    ...(worked ? { [worked.field]: worked.name } : {}),
  };
  await kv('hset', hashKey, time, JSON.stringify(updated));
  const summaryParts = [`${playersLabel(playersNum)}`, `${priceValue} Br`];
  if (discountNote) summaryParts.push(`скидка: ${discountNote}`);
  await tg(token, 'sendMessage', { chat_id: chatId, text: `Обновлено: ${summaryParts.join(', ')}.` });
  await askAboutPaymentOrSkip(token, chatId, dateISO, time, updated);
}

// A single amount, comma or dot as the decimal separator: "150", "150,50".
function extractAmount(text) {
  const m = String(text).match(/\d+([.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// "150, постоянный клиент" → { price: 150, note: 'постоянный клиент' } — the
// reply to the "🏷 Скидка" button: a price, then everything after it (minus
// a leading separator) is kept verbatim as the discount reason. Returns
// null only if no number at all was found.
function parseDiscountReply(text) {
  const s = String(text);
  const m = s.match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const price = parseFloat(m[0].replace(',', '.'));
  if (!Number.isFinite(price)) return null;
  const note = s.slice(m.index + m[0].length).replace(/^[\s,;:\-]+/, '').trim();
  return { price, note };
}

// How a game was paid for — cash, card, ERIP, or any split between them,
// e.g. "140" / "нал 140" / "карта 140" / "ерип 140" / "нал 100 карта 40".
// Looks for a number following each payment-method word (any Cyrillic
// ending is accepted — "нал", "наличные", "наличкой", "картой", "безнал",
// "ерипом" all match) and sums however many of the three are present. A
// bare number with none of those words is treated as fully cash — that
// covers the overwhelmingly common case (a walk-in paying cash) without
// making the actor type "нал" every single time. Returns null if nothing
// usable was found at all.
export function parsePayment(text) {
  const t = String(text).toLowerCase();
  const cashMatch = t.match(/нал\w*[^\d]*(\d+(?:[.,]\d+)?)/);
  const cardMatch = t.match(/(?:карт\w*|безнал\w*)[^\d]*(\d+(?:[.,]\d+)?)/);
  const eripMatch = t.match(/(?:ерип\w*|erip)[^\d]*(\d+(?:[.,]\d+)?)/);

  if (!cashMatch && !cardMatch && !eripMatch) {
    // No payment-method word at all — if the whole message is just a
    // number, treat it as fully cash (matches the old, pre-split prompt).
    const bare = extractAmount(t);
    if (bare == null) return null;
    return { cash: bare, card: 0, erip: 0 };
  }

  const toNum = (m) => (m ? parseFloat(m[1].replace(',', '.')) : 0);
  const cash = toNum(cashMatch);
  const card = toNum(cardMatch);
  const erip = toNum(eripMatch);
  if (!Number.isFinite(cash) || !Number.isFinite(card) || !Number.isFinite(erip)) return null;
  if (cash === 0 && card === 0 && erip === 0) return null;
  return { cash, card, erip };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // THE ACTUAL ROOT CAUSE of the "button spins, then just clears with
  // nothing happening" reports (found by reading production logs): this
  // handler used to send its 200 OK response FIRST, then keep working
  // ("ack fast, Telegram retries aggressively otherwise" — a reasonable
  // instinct, but wrong for this platform). On Vercel's Node.js runtime
  // (built on AWS Lambda), a function's whole execution environment —
  // including the event loop, pending timers, and in-flight fetch() calls —
  // can be FROZEN the instant the HTTP response is considered complete, and
  // only thaws again on some LATER invocation reusing the same warm
  // container. Production logs confirmed this exactly: a burst of
  // *different* outbound calls (KV requests AND Telegram API calls like
  // answerCallbackQuery/editMessageReplyMarkup) all aborting within the
  // same millisecond of each other — consistent with a batch of timers that
  // had been frozen together suddenly all firing at once when something
  // finally thawed the container, not with each of them independently
  // timing out for its own reason.
  //
  // Every OTHER route in this project (api/slots, api/admin/shifts, …)
  // never showed this problem, because they all do the work FIRST and only
  // send their response at the end — the normal, safe pattern. This handler
  // now does the same: the response is sent exactly once, from the `finally`
  // block below, only after all the real work has actually finished. Telegram
  // tolerates a webhook response taking a few seconds; it does not tolerate
  // a response that arrives instantly but represents work that then stalls
  // indefinitely on a frozen container, which is what was actually
  // happening before.
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    if (body.callback_query) {
      await handleCallbackQuery(token, body.callback_query);
      return;
    }

    const message = body.message || body.edited_message;
    if (!message || !message.chat || !message.text) return;

    const chatId = message.chat.id;
    const text = String(message.text).trim();

    // A closeout conversation in progress takes priority over everything
    // else (except an actual command) — this is how "✏️ Исправить" or the
    // cash-collected question gets its answer.
    if (!text.startsWith('/')) {
      const pending = await getPendingActorReply(chatId);
      if (pending) {
        await handleActorReply(token, chatId, pending, text);
        return;
      }
    }

    if (!text.startsWith('/start')) return;

    const username = message.from && message.from.username ? String(message.from.username).toLowerCase() : '';
    const displayName = (message.from && (message.from.first_name || message.from.username)) || '';

    if (!username) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Чтобы получать напоминания о бронях, сначала задайте себе username в Telegram: Настройки → Имя пользователя. Потом снова напишите /start этому боту.',
      });
      return;
    }

    await kv('hset', 'actors', username, JSON.stringify({
      chatId,
      displayName,
      registeredAt: new Date().toISOString(),
    }));

    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `Готово, ${displayName || 'привет'}! Теперь вам будут приходить напоминания о бронях за 1.5 часа до игры, а в конце смены — сообщения для сверки игр (@${username}).`,
    });
  } catch (err) {
    console.error('telegram-webhook: top-level handler threw:', err);
  } finally {
    res.status(200).json({ ok: true });
  }
}

// Payment buttons — one method covers the FULL price in one tap (no typing,
// and the amount shown is always the booking's real price, never a fixed
// "140" example), plus a "Свой вариант" fallback for a split or partial
// payment (the one case buttons genuinely can't cover, since the split
// could be anything). `price` is a number; when a booking somehow has no
// price at all, callers fall back to a custom-only keyboard instead (see
// askAboutPaymentOrSkip below).
function buildPaymentKeyboard(dateISO, time, price) {
  return {
    inline_keyboard: [
      [{ text: `💵 Нал ${price} Br`, callback_data: `co|pay|${dateISO}|${time}|cash|${price}` }],
      [{ text: `💳 Карта ${price} Br`, callback_data: `co|pay|${dateISO}|${time}|card|${price}` }],
      [{ text: `📱 ЕРИП ${price} Br`, callback_data: `co|pay|${dateISO}|${time}|erip|${price}` }],
      [{ text: '🔀 Оплата частями / разделена', callback_data: `co|paycustom|${dateISO}|${time}|${price}` }],
    ],
  };
}

// A game has ONE payment, not one per performer — but a booking covered
// by both an actor and an actress gets THIS SAME confirm/edit flow
// independently for each of them (each has their own chat, their own
// buttons). So right after either of them confirms/edits, this decides
// whether to actually ask the payment question: if the OTHER performer
// already reported it (record.paymentReportedBy is set), there's nothing
// left to ask — just say so and finish; otherwise ask via buttons, each
// pre-filled with the booking's REAL price (fixes a report where the
// example in this question always showed "140" regardless of the actual
// amount — that was only ever illustrative text in the old free-text
// prompt, never a stored value, but it read as if the price itself was
// wrong). Whoever answers is resolved fresh at the moment they tap a
// button (or, for a split payment, when they finish typing it) rather than
// stored ahead of time, since a plain button tap needs no pending state at
// all — see the 'pay' callback branch below.
async function askAboutPaymentOrSkip(token, chatId, dateISO, time, record) {
  if (record.paymentReportedBy) {
    await clearPendingActorReply(chatId);
    const res = await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `Оплата по этой игре уже была записана (принял(а) @${record.paymentReportedBy}). Спасибо, сверка завершена!`,
    });
    if (!res || res.ok === false) {
      await tg(token, 'sendMessage', { chat_id: chatId, text: `⚠️ (диагностика) не удалось отправить сообщение "оплата уже записана": ${(res && res.description) || 'нет ответа от Telegram (таймаут?)'}` }).catch(() => {});
    }
    return;
  }
  const price = Number(record.price) || 0;
  const reply_markup = price
    ? buildPaymentKeyboard(dateISO, time, price)
    : { inline_keyboard: [[{ text: '🔀 Указать сумму', callback_data: `co|paycustom|${dateISO}|${time}|0` }]] };
  const res = await tg(token, 'sendMessage', {
    chat_id: chatId,
    text: price ? `Как оплатили эту игру (${price} Br)?` : 'У этой игры не указана цена — как оплатили и сколько?',
    reply_markup,
  });
  if (!res || res.ok === false) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: `⚠️ (диагностика) не удалось отправить вопрос про оплату: ${(res && res.description) || 'нет ответа от Telegram (таймаут?)'}` }).catch(() => {});
  }
}

// Shared landing point for every way a payment can end up recorded — a
// direct нал/карта/ЕРИП button tap (the full price, one method) or a typed
// split/partial reply after "🔀 Оплата частями". Re-fetches the booking
// fresh right before writing (not the possibly-stale `record` the caller
// already had) because a booking covered by both an actor and an actress
// runs this same question independently in each chat — if the OTHER
// performer reported the payment in the meantime, this must defer to them
// instead of overwriting their numbers.
async function applyPayment(token, chatId, dateISO, time, actorUsername, amounts) {
  const hashKey = `bookings:${dateISO}`;
  const freshRaw = await kv('hget', hashKey, time);
  if (!freshRaw) {
    await clearPendingActorReply(chatId);
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'Эта бронь уже не активна — сверка отменена.' });
    return;
  }
  let freshRecord;
  try { freshRecord = JSON.parse(freshRaw); } catch { freshRecord = null; }
  if (!freshRecord) {
    await clearPendingActorReply(chatId);
    return;
  }
  if (freshRecord.paymentReportedBy) {
    await clearPendingActorReply(chatId);
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `Оплата по этой игре уже была записана (принял(а) @${freshRecord.paymentReportedBy}). Спасибо, сверка завершена!`,
    });
    return;
  }
  const updated = {
    ...freshRecord,
    payCash: String(amounts.cash),
    payCard: String(amounts.card),
    payErip: String(amounts.erip),
    closeoutCashCollected: String(amounts.cash),
    closeoutRepliedAt: new Date().toISOString(),
    paymentReportedBy: actorUsername || null,
  };
  await kv('hset', hashKey, time, JSON.stringify(updated));
  await clearPendingActorReply(chatId);
  const parts = [
    amounts.cash ? `нал ${amounts.cash} Br` : null,
    amounts.card ? `карта ${amounts.card} Br` : null,
    amounts.erip ? `ЕРИП ${amounts.erip} Br` : null,
  ].filter(Boolean).join(', ');
  await tg(token, 'sendMessage', { chat_id: chatId, text: `Записал: ${parts}. Спасибо! Сверка по этой игре завершена.` });
}

// A button tap on one of the "✅ Верно" / "✏️ Исправить" messages
// api/internal-jobs.js (?job=closeout) sends. Wrapped in try/catch so that ANY
// unexpected error (a bug, a KV hiccup, whatever) still answers the
// callback query — otherwise the tap just shows Telegram's loading
// spinner forever with no visible error anywhere, which is exactly the
// silent-hang symptom this is here to prevent.
//
// On top of that: a WATCHDOG. try/catch only helps once something actually
// throws — a genuine network *hang* (fetch that never resolves and never
// rejects) throws nothing, so try/catch alone can still leave the button
// stuck forever if a hang happens somewhere this function doesn't expect.
// The per-call timeouts added to kv()/tg() close the known gaps, but this
// watchdog is the actual guarantee: no matter what hangs and where, this
// callback query gets answered — with a "server is slow, try again" alert —
// within WATCHDOG_MS no matter what.
// (Overridable via env var for tests; production never sets this, so it's
// always 9000ms there.)
const WATCHDOG_MS = Number(process.env.CALLBACK_WATCHDOG_MS) || 9000;

async function handleCallbackQuery(token, cq) {
  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    tg(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Сервер долго отвечает. Кнопки на старом сообщении могли не сработать — подождите немного и попробуйте ещё раз.',
      show_alert: true,
    }).catch(() => {});
  }, WATCHDOG_MS);

  try {
    await handleCallbackQueryInner(token, cq);
    settled = true;
  } catch (err) {
    console.error('telegram-webhook: handleCallbackQuery threw:', err);
    if (!settled) {
      settled = true;
      try {
        await tg(token, 'answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'Что-то пошло не так, попробуйте ещё раз.',
          show_alert: true,
        });
      } catch {
        // even the error-recovery answerCallbackQuery failed — nothing more
        // to do from here, but at least it's logged above.
      }
    }
  } finally {
    clearTimeout(watchdog);
  }
}

async function handleCallbackQueryInner(token, cq) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  // ['co', action, dateISO, time, ...rest] — rest carries whatever the
  // button-based players/price/discount flow below needs to pass along
  // (the chosen player count, then the chosen price) entirely inside the
  // callback_data itself, so no extra actions grow the base 4-part shape.
  const parts = data.split('|');

  if (parts[0] !== 'co' || parts.length < 4 || !chatId) {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }
  const [, action, dateISO, time, ...rest] = parts;

  // Only one closeout conversation at a time per actor — tapping a button
  // on a DIFFERENT booking while one is still mid-reply would otherwise
  // silently clobber the in-progress one.
  const pending = await getPendingActorReply(chatId);
  if (pending && (pending.dateISO !== dateISO || pending.time !== time)) {
    await tg(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Сначала ответьте на предыдущий вопрос в чате.',
      show_alert: true,
    });
    return;
  }

  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hget', hashKey, time);
  if (!raw) {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Эта бронь уже не активна.', show_alert: true });
    if (messageId) {
      await tg(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    }
    return;
  }
  let record;
  try { record = JSON.parse(raw); } catch { record = null; }
  if (!record) {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }

  // 26.09.2026: bot-driven sverka is disabled in production (see
  // BOT_CLOSEOUT_ENABLED in api/_closeout.js) — closeout now happens through
  // staff.html's own "Провести сверку" button instead. Telegram never
  // expires an inline keyboard on its own, so without this check a tap on an
  // OLD "🎬 Сверка игры" message (from before the switch) would still walk
  // through the full players/price/payment flow below and silently
  // overwrite the booking's real data, bypassing the manualCloseout audit
  // trail entirely. Answer the tap so the button stops spinning, explain
  // where sverka lives now, and remove the stale buttons so this can't be
  // tapped again.
  if (!BOT_CLOSEOUT_ENABLED) {
    await tg(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: 'Сверка через бота больше не используется — отметьте игру в панели сотрудника, кнопка «Провести сверку».',
      show_alert: true,
    });
    if (messageId) {
      await tg(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
    return;
  }

  await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });

  // TEMPORARY DIAGNOSTIC, added while tracking down a report that the button
  // stops loading (so the callback WAS answered — the part above this line
  // works) but nothing visibly happens afterward: no confirmation text, no
  // follow-up payment question. Everything below this point used to fail
  // silently — a thrown error had nowhere to go (nobody was watching the
  // server logs), and a Telegram API call rejecting a request (e.g.
  // editMessageText on a message it won't edit) was only ever logged with
  // console.error, invisible to anyone without Vercel log access. Now: any
  // thrown error, or any Telegram API call that comes back not-ok, gets
  // reported as a plain follow-up message in the SAME chat — so whatever is
  // actually going wrong is visible immediately, no server logs needed. Once
  // the real cause is found this can be trimmed back down.
  async function reportDiagnostic(label, detail) {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ (диагностика) ${label}: ${detail}`,
    }).catch(() => {});
  }

  try {
    if (action === 'ok') {
      // Fills in "Кто отыграл" automatically from whoever just confirmed —
      // see resolveWorkedField() — so the per-actor games-this-month stat in
      // Финансы updates itself instead of waiting on the admin to type it in
      // by hand later.
      const worked = await resolveWorkedField(dateISO, time, chatId);
      const updated = {
        ...record,
        closeoutStatus: 'confirmed',
        closeoutRepliedAt: new Date().toISOString(),
        ...(worked ? { [worked.field]: worked.name } : {}),
      };
      await kv('hset', hashKey, time, JSON.stringify(updated));
      if (messageId) {
        const summary = [time, record.name, record.players, record.price ? `${record.price} Br` : null].filter(Boolean).join(' · ');
        const editResult = await tg(token, 'editMessageText', {
          chat_id: chatId, message_id: messageId,
          text: `✅ Подтверждено: ${summary}`,
          reply_markup: { inline_keyboard: [] },
        });
        if (!editResult || editResult.ok === false) {
          await reportDiagnostic('не удалось отредактировать сообщение (editMessageText)', (editResult && editResult.description) || 'нет ответа от Telegram (таймаут?)');
        }
      }
      await askAboutPaymentOrSkip(token, chatId, dateISO, time, updated);
      return;
    }

    if (action === 'edit') {
      // Clear any stale pending text-reply left over from an earlier,
      // unfinished conversation on this SAME booking (e.g. the actor
      // tapped "Исправить", then never finished before tapping it again) —
      // otherwise a leftover 'custom_price'/'discount' stage could
      // misinterpret the actor's next ordinary message.
      await clearPendingActorReply(chatId);
      if (messageId) {
        const editResult = await tg(token, 'editMessageText', {
          chat_id: chatId, message_id: messageId,
          text: `✏️ Исправляется: ${time} · ${record.name || ''}`,
          reply_markup: { inline_keyboard: [] },
        });
        if (!editResult || editResult.ok === false) {
          await reportDiagnostic('не удалось отредактировать сообщение (editMessageText)', (editResult && editResult.description) || 'нет ответа от Telegram (таймаут?)');
        }
      }
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Сколько игроков было на самом деле?',
        reply_markup: buildPlayersKeyboard(dateISO, time),
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить кнопки количества игроков (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }

    // Player count picked via a button — ask for the price next. The
    // chosen count travels forward inside the price buttons' own
    // callback_data (co|pr|date|time|players|amount), so nothing needs to
    // be stored server-side between this step and the next.
    if (action === 'pl') {
      const playersNum = Number(rest[0]);
      if (!Number.isFinite(playersNum) || playersNum <= 0) return;
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: `Игроков: ${playersLabel(playersNum)}. Теперь выберите цену:`,
        reply_markup: buildPriceKeyboard(dateISO, time, playersNum),
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить кнопки цены (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }

    // "✏️ Другое количество" — the 8 buttons don't cover it, fall back to
    // typing the exact number.
    if (action === 'plcustom') {
      await setPendingActorReply(chatId, { dateISO, time, stage: 'custom_players' });
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Напишите точное количество игроков числом. Например: 9',
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить вопрос про количество игроков (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }

    // A standard price button tapped — players + price are both known now,
    // save and move on to the payment question exactly as before.
    if (action === 'pr') {
      const playersNum = Number(rest[0]);
      const priceValue = Number(rest[1]);
      if (!Number.isFinite(playersNum) || !Number.isFinite(priceValue)) return;
      await finalizeEdit(token, chatId, dateISO, time, record, playersNum, priceValue, null);
      return;
    }

    // "✏️ Своя цена" — none of the standard buttons match, type the exact
    // amount instead.
    if (action === 'prcustom') {
      const playersNum = Number(rest[0]);
      await setPendingActorReply(chatId, { dateISO, time, stage: 'custom_price', players: playersNum });
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Напишите цену числом. Например: 205',
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить вопрос про цену (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }

    // "🏷 Скидка" — a discounted final price plus an optional reason, both
    // in one typed reply (kept as free text since a discount's reason is
    // inherently open-ended — "постоянный клиент", "промокод", etc. — not
    // something a fixed set of buttons could cover).
    if (action === 'discount') {
      const playersNum = Number(rest[0]);
      await setPendingActorReply(chatId, { dateISO, time, stage: 'discount', players: playersNum });
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Укажите итоговую цену со скидкой и, если нужно, причину — например: 150, постоянный клиент',
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить вопрос про скидку (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }

    // A "💵 Нал" / "💳 Карта" / "📱 ЕРИП" button — the game's FULL price was
    // paid through exactly this one method, no typing needed at all.
    if (action === 'pay') {
      const method = rest[0]; // 'cash' | 'card' | 'erip'
      const amount = Number(rest[1]) || 0;
      const actorUsername = await resolveActorUsernameByChatId(chatId);
      await applyPayment(token, chatId, dateISO, time, actorUsername, {
        cash: method === 'cash' ? amount : 0,
        card: method === 'card' ? amount : 0,
        erip: method === 'erip' ? amount : 0,
      });
      return;
    }

    // "🔀 Оплата частями / разделена" — the one case buttons can't cover
    // (the split could be any combination), so fall back to a typed reply.
    // The example in the prompt uses the booking's REAL price split roughly
    // in half, never a fixed placeholder amount.
    if (action === 'paycustom') {
      const price = Number(rest[0]) || 0;
      const actorUsername = await resolveActorUsernameByChatId(chatId);
      await setPendingActorReply(chatId, { dateISO, time, stage: 'payment', actorUsername });
      const half1 = price ? Math.ceil(price / 2) : 100;
      const half2 = price ? price - half1 : 40;
      const totalNote = price ? ` (в сумме должно получиться ${price} Br)` : '';
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: `Как разделили оплату? Напишите одним сообщением — например: нал ${half1} карта ${half2}${totalNote}. Можно сочетать нал/карта/ерип в любом порядке.`,
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить вопрос про разделённую оплату (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
      return;
    }
  } catch (err) {
    console.error('telegram-webhook: handleCallbackQueryInner (post-answer) threw:', err);
    await reportDiagnostic('внутренняя ошибка после нажатия кнопки', err && err.message ? err.message : String(err));
  }
}

// A free-text reply while a closeout conversation is in progress. Wrapped
// in try/catch (like handleCallbackQuery above) so a bug here leaves a
// clear log line instead of the actor's message just vanishing with no
// reply and no trace.
async function handleActorReply(token, chatId, pending, text) {
  try {
    await handleActorReplyInner(token, chatId, pending, text);
  } catch (err) {
    console.error('telegram-webhook: handleActorReply threw:', err);
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'Что-то пошло не так, попробуйте отправить сообщение ещё раз.' }).catch(() => {});
  }
}

async function handleActorReplyInner(token, chatId, pending, text) {
  const { dateISO, time, stage } = pending;
  const hashKey = `bookings:${dateISO}`;
  const raw = await kv('hget', hashKey, time);
  if (!raw) {
    await clearPendingActorReply(chatId);
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'Эта бронь уже не активна — сверка отменена.' });
    return;
  }
  let record;
  try { record = JSON.parse(raw); } catch { record = null; }
  if (!record) {
    await clearPendingActorReply(chatId);
    return;
  }

  // Same 26.09.2026 guard as handleCallbackQueryInner() above — a reply left
  // pending from before bot-sverka was disabled must not still finalize an
  // edit through the old flow.
  if (!BOT_CLOSEOUT_ENABLED) {
    await clearPendingActorReply(chatId);
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Сверка через бота больше не используется — отметьте игру в панели сотрудника, кнопка «Провести сверку».',
    });
    return;
  }

  // Legacy stage — the free-text "4, 200" flow this replaced with buttons
  // (see buildPlayersKeyboard/buildPriceKeyboard above). Kept only so an
  // actor already mid-reply the moment this update goes out (tapped
  // "Исправить" under the OLD code, hasn't replied yet) still gets a
  // working conversation instead of a reply that lands nowhere. Every NEW
  // "Исправить" tap now goes through the button flow instead.
  if (stage === 'players_price') {
    const nums = extractIntegers(text);
    if (nums.length < 2 || nums[0] <= 0 || nums[1] <= 0) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать. Напишите два числа через запятую: сначала игроков, потом цену. Например: 4, 200',
      });
      return;
    }
    const [playersNum, priceNum] = nums;
    await finalizeEdit(token, chatId, dateISO, time, record, playersNum, priceNum, null);
    return;
  }

  // "✏️ Другое количество" reply — a typed player count, then straight on
  // to the same price-buttons step a normal button tap would reach.
  if (stage === 'custom_players') {
    const nums = extractIntegers(text);
    const playersNum = nums[0];
    if (!playersNum || playersNum <= 0) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать. Напишите количество игроков числом, например: 9',
      });
      return;
    }
    await clearPendingActorReply(chatId);
    const sendResult = await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `Игроков: ${playersLabel(playersNum)}. Теперь выберите цену:`,
      reply_markup: buildPriceKeyboard(dateISO, time, playersNum),
    });
    if (!sendResult || sendResult.ok === false) {
      await tg(token, 'sendMessage', { chat_id: chatId, text: `⚠️ (диагностика) не удалось отправить кнопки цены: ${(sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)'}` }).catch(() => {});
    }
    return;
  }

  // "✏️ Своя цена" reply — a typed exact price; the player count picked
  // earlier travelled here via pending.players (set when the button was
  // tapped — see the 'prcustom' callback branch above).
  if (stage === 'custom_price') {
    const priceNum = extractAmount(text);
    if (priceNum == null || priceNum <= 0) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать цену. Напишите число, например: 205',
      });
      return;
    }
    await clearPendingActorReply(chatId);
    await finalizeEdit(token, chatId, dateISO, time, record, pending.players, priceNum, null);
    return;
  }

  // "🏷 Скидка" reply — a discounted final price plus an optional reason
  // in one message; the player count again travelled via pending.players.
  if (stage === 'discount') {
    const parsed = parseDiscountReply(text);
    if (!parsed || parsed.price <= 0) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать. Напишите итоговую цену и, если нужно, причину — например: 150, постоянный клиент',
      });
      return;
    }
    await clearPendingActorReply(chatId);
    await finalizeEdit(token, chatId, dateISO, time, record, pending.players, parsed.price, parsed.note || 'без указания причины');
    return;
  }

  // Reached only via "🔀 Оплата частями / разделена" now (see the
  // 'paycustom' callback branch above) — a single-method full payment is
  // handled directly by the payment buttons and never reaches free text at
  // all. The "already reported by someone else" race is checked inside
  // applyPayment() itself (it re-fetches the booking fresh right before
  // writing), so it's covered even though it isn't re-checked here first.
  if (stage === 'payment') {
    const parsed = parsePayment(text);
    if (!parsed) {
      const price = Number(record.price) || 0;
      const half1 = price ? Math.ceil(price / 2) : 100;
      const half2 = price ? price - half1 : 40;
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: `Не получилось распознать. Напишите сумму и способ оплаты — например: нал ${half1} карта ${half2}${price ? ` (в сумме ${price} Br)` : ''}.`,
      });
      return;
    }
    await applyPayment(token, chatId, dateISO, time, pending.actorUsername, parsed);
    return;
  }

  // Legacy stage from a conversation started before this update (an
  // in-flight one from before this deploy) — kept so nobody mid-reply
  // gets stuck. New conversations always use 'payment' above, which
  // supports a cash/card/ERIP split instead of assuming cash-only.
  if (stage === 'cash') {
    const amount = extractAmount(text);
    if (amount == null || amount < 0) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать сумму. Напишите просто число, например: 150 (или 0, если не наличными).',
      });
      return;
    }
    const updated = {
      ...record,
      payCash: String(amount),
      closeoutCashCollected: String(amount),
      closeoutRepliedAt: new Date().toISOString(),
    };
    await kv('hset', hashKey, time, JSON.stringify(updated));
    await clearPendingActorReply(chatId);
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'Спасибо! Сверка по этой игре завершена.' });
  }
}
