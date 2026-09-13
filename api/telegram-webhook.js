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
//   2. Runs the "shift closeout" conversation: once api/telegram-closeout.js
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
import { getPendingActorReply, setPendingActorReply, clearPendingActorReply } from './_closeout.js';
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
function extractIntegers(text) {
  const matches = String(text).match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

// A single amount, comma or dot as the decimal separator: "150", "150,50".
function extractAmount(text) {
  const m = String(text).match(/\d+([.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
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

const PAYMENT_PROMPT = 'Как оплатили эту игру? Напишите одним сообщением, например:\n' +
  '• 140 — если полностью наличными\n' +
  '• карта 140 — если полностью картой\n' +
  '• ерип 140 — если полностью через ЕРИП\n' +
  '• нал 100 карта 40 — если оплата разделена';

// A game has ONE payment, not one per performer — but a booking covered
// by both an actor and an actress gets THIS SAME confirm/edit flow
// independently for each of them (each has their own chat, their own
// buttons). So right after either of them confirms/edits, this decides
// whether to actually ask the payment question: if the OTHER performer
// already reported it (record.paymentReportedBy is set), there's nothing
// left to ask — just say so and finish; otherwise ask, and remember which
// performer is now answering (pending.actorUsername) so the reply handler
// can stamp who reported it.
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
  const actorUsername = await resolveActorUsernameByChatId(chatId);
  await setPendingActorReply(chatId, { dateISO, time, stage: 'payment', actorUsername });
  const res = await tg(token, 'sendMessage', { chat_id: chatId, text: PAYMENT_PROMPT });
  if (!res || res.ok === false) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: `⚠️ (диагностика) не удалось отправить вопрос про оплату: ${(res && res.description) || 'нет ответа от Telegram (таймаут?)'}` }).catch(() => {});
  }
}

// A button tap on one of the "✅ Верно" / "✏️ Исправить" messages
// api/telegram-closeout.js sends. Wrapped in try/catch so that ANY
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
  const parts = data.split('|'); // ['co', 'ok'|'edit', dateISO, time]

  if (parts[0] !== 'co' || parts.length < 4 || !chatId) {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }
  const [, action, dateISO, time] = parts;

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
      await setPendingActorReply(chatId, { dateISO, time, stage: 'players_price' });
      const sendResult = await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Укажите верное количество игроков и цену через запятую. Например: 4, 200',
      });
      if (!sendResult || sendResult.ok === false) {
        await reportDiagnostic('не удалось отправить следующий вопрос (sendMessage)', (sendResult && sendResult.description) || 'нет ответа от Telegram (таймаут?)');
      }
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
    const worked = await resolveWorkedField(dateISO, time, chatId);
    const updated = {
      ...record,
      players: playersLabel(playersNum),
      price: String(priceNum),
      closeoutStatus: 'edited',
      closeoutEditedFrom: { players: record.players || '', price: record.price || '' },
      closeoutRepliedAt: new Date().toISOString(),
      ...(worked ? { [worked.field]: worked.name } : {}),
    };
    await kv('hset', hashKey, time, JSON.stringify(updated));
    await tg(token, 'sendMessage', { chat_id: chatId, text: `Обновлено: ${playersLabel(playersNum)}, ${priceNum} Br.` });
    await askAboutPaymentOrSkip(token, chatId, dateISO, time, updated);
    return;
  }

  if (stage === 'payment') {
    // A booking covered by BOTH an actor and an actress asks each of them
    // this same question independently (each gets their own confirm/edit
    // flow — see the data-model comment in api/_closeout.js). But there is
    // only ONE payment for the whole game, not one per performer, so if
    // the OTHER performer already answered this in the meantime (a race:
    // both are mid-reply at once), re-check the record fresh right before
    // writing and skip overwriting their numbers with this reply.
    const freshRaw = await kv('hget', hashKey, time);
    let freshRecord = record;
    if (freshRaw) {
      try { freshRecord = JSON.parse(freshRaw) || record; } catch { freshRecord = record; }
    }
    if (freshRecord.paymentReportedBy) {
      await clearPendingActorReply(chatId);
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: `Оплата по этой игре уже была записана (принял(а) @${freshRecord.paymentReportedBy}). Спасибо, сверка завершена!`,
      });
      return;
    }

    const parsed = parsePayment(text);
    if (!parsed) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не получилось распознать. Напишите сумму и, если нужно, способ оплаты — например: 140, или карта 140, или нал 100 карта 40.',
      });
      return;
    }
    const updated = {
      ...freshRecord,
      payCash: String(parsed.cash),
      payCard: String(parsed.card),
      payErip: String(parsed.erip),
      closeoutCashCollected: String(parsed.cash),
      closeoutRepliedAt: new Date().toISOString(),
      paymentReportedBy: pending.actorUsername || null,
    };
    await kv('hset', hashKey, time, JSON.stringify(updated));
    await clearPendingActorReply(chatId);
    const parts = [
      parsed.cash ? `нал ${parsed.cash} Br` : null,
      parsed.card ? `карта ${parsed.card} Br` : null,
      parsed.erip ? `ЕРИП ${parsed.erip} Br` : null,
    ].filter(Boolean).join(', ');
    await tg(token, 'sendMessage', { chat_id: chatId, text: `Записал: ${parts}. Спасибо! Сверка по этой игре завершена.` });
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
