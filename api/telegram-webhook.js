// Serverless function (Vercel Node.js runtime).
// Receives Telegram "updates" for the SAME bot that already sends booking
// notifications (TELEGRAM_BOT_TOKEN) — this is what lets an actor's
// Telegram *username* turn into a chat id we can actually message.
//
// Telegram can only message a private chat once that person has messaged
// the bot at least once — there is no way to send by @username alone. So
// every actor who should get shift reminders has to open the bot and send
// /start exactly once. This endpoint is what catches that /start and
// records { username → chat id } in KV, under the "actors" hash (see
// api/_reminders.js for the full data model).
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

async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('telegram-webhook: failed to reply:', err);
  }
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

  const message = body.message || body.edited_message;
  if (!message || !message.chat || !message.text) return;

  const text = String(message.text).trim();
  if (!text.startsWith('/start')) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = message.chat.id;
  const username = message.from && message.from.username ? String(message.from.username).toLowerCase() : '';
  const displayName = (message.from && (message.from.first_name || message.from.username)) || '';

  if (!username) {
    if (token) {
      await sendTelegram(
        token,
        chatId,
        'Чтобы получать напоминания о бронях, сначала задайте себе username в Telegram: Настройки → Имя пользователя. Потом снова напишите /start этому боту.'
      );
    }
    return;
  }

  await kv('hset', 'actors', username, JSON.stringify({
    chatId,
    displayName,
    registeredAt: new Date().toISOString(),
  }));

  if (token) {
    await sendTelegram(
      token,
      chatId,
      `Готово, ${displayName || 'привет'}! Теперь вам будут приходить напоминания о бронях за 1.5 часа до игры, когда вас поставят в график (@${username}).`
    );
  }
}
