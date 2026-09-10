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
//      correcting a booking's player count/price, and reporting how much
//      cash was collected (which feeds straight into "Касса" — see
//      api/_finance.js). See api/_closeout.js for the full data model.
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

async function tg(token, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    console.error(`telegram-webhook: ${method} failed:`, err);
    return null;
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

  // Always ack quickly with 200 — Telegram retries aggressively otherwise.
  res.status(200).json({ ok: true });

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
}

// A button tap on one of the "✅ Верно" / "✏️ Исправить" messages
// api/telegram-closeout.js sends.
async function handleCallbackQuery(token, cq) {
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

  if (action === 'ok') {
    const updated = { ...record, closeoutStatus: 'confirmed', closeoutRepliedAt: new Date().toISOString() };
    await kv('hset', hashKey, time, JSON.stringify(updated));
    if (messageId) {
      const summary = [time, record.name, record.players, record.price ? `${record.price} Br` : null].filter(Boolean).join(' · ');
      await tg(token, 'editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: `✅ Подтверждено: ${summary}`,
        reply_markup: { inline_keyboard: [] },
      });
    }
    await setPendingActorReply(chatId, { dateISO, time, stage: 'cash' });
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Сколько наличных вы получили за эту игру? Напишите сумму в Br (0, если оплата не наличными).',
    });
    return;
  }

  if (action === 'edit') {
    if (messageId) {
      await tg(token, 'editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: `✏️ Исправляется: ${time} · ${record.name || ''}`,
        reply_markup: { inline_keyboard: [] },
      });
    }
    await setPendingActorReply(chatId, { dateISO, time, stage: 'players_price' });
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Укажите верное количество игроков и цену через запятую. Например: 4, 200',
    });
  }
}

// A free-text reply while a closeout conversation is in progress.
async function handleActorReply(token, chatId, pending, text) {
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
    const updated = {
      ...record,
      players: playersLabel(playersNum),
      price: String(priceNum),
      closeoutStatus: 'edited',
      closeoutEditedFrom: { players: record.players || '', price: record.price || '' },
      closeoutRepliedAt: new Date().toISOString(),
    };
    await kv('hset', hashKey, time, JSON.stringify(updated));
    await tg(token, 'sendMessage', { chat_id: chatId, text: `Обновлено: ${playersLabel(playersNum)}, ${priceNum} Br.` });
    await setPendingActorReply(chatId, { dateISO, time, stage: 'cash' });
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Сколько наличных вы получили за эту игру? Напишите сумму в Br (0, если оплата не наличными).',
    });
    return;
  }

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
