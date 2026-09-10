// Serverless function (Vercel Node.js runtime).
// Receives a booking request from the site's form, reserves the slot (so it
// shows as taken for every other visitor), and forwards it as a Telegram
// message to the quest owner. It does NOT reply to the customer —
// confirmation is done by the owner manually, by phone.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN  — token from @BotFather
//   TELEGRAM_CHAT_ID    — the owner's chat id (message your bot once, then
//                          open https://api.telegram.org/bot<TOKEN>/getUpdates
//                          and look for "chat":{"id":...})
//
// Optional (needed for slot availability to work — see api/slots.js):
//   KV_REST_API_URL, KV_REST_API_TOKEN — added automatically once you
//   connect a Vercel KV database (Storage tab → Create Database → KV) to
//   this project. Without them, bookings still work, they just aren't
//   checked against each other.

const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // auto-clean ~90 days after the date

async function kv(...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // not connected — fail open, don't block bookings

  const path = args.map((a) => encodeURIComponent(a)).join('/');
  try {
    const res = await fetch(`${url}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error('KV request failed:', err);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { name, phone, players, date, dateISO, time, price, website, comment } = body;

  // Honeypot: real visitors never fill a field hidden with CSS. If it's
  // filled, silently pretend success so bots don't learn anything.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';
  const cleanDateISO = typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : '';
  const cleanTime = typeof time === 'string' ? time.trim().slice(0, 20) : '';

  if (!cleanName || !cleanPhone) {
    return res.status(400).json({ error: 'Укажите имя и телефон.' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(500).json({
      error: 'Форма временно не работает. Пожалуйста, позвоните нам напрямую.',
    });
  }

  // Reserve the slot atomically: SADD returns 1 only if this (date, time)
  // pair was not already in the set, so two simultaneous requests can never
  // both "win" the same slot.
  const slotKey = cleanDateISO && cleanTime ? `booked:${cleanDateISO}` : null;
  let reserved = false;
  if (slotKey) {
    const added = await kv('sadd', slotKey, cleanTime);
    if (added === 0) {
      return res.status(409).json({
        conflict: true,
        error: 'Это время только что заняли — пожалуйста, выберите другое.',
      });
    }
    if (added === 1) reserved = true; // null means KV isn't connected — proceed unchecked
  }

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    `📞 Телефон: ${escapeMd(cleanPhone)}`,
    players ? `👥 Игроков: ${escapeMd(String(players).slice(0, 10))}` : null,
    date ? `📅 Дата: ${escapeMd(String(date).slice(0, 60))}` : null,
    cleanTime ? `🕒 Время: ${escapeMd(cleanTime)}` : null,
    price ? `💰 Цена: ${escapeMd(String(price).slice(0, 20))} ₽` : null,
    cleanComment ? `💬 Комментарий: ${escapeMd(cleanComment)}` : null,
  ].filter(Boolean).join('\n');

  const text = `🩺 *Новая заявка — Дело Мэри*\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      if (reserved) await kv('srem', slotKey, cleanTime); // release — the owner never got notified
      return res.status(502).json({
        error: 'Не удалось отправить заявку. Попробуйте позвонить нам.',
      });
    }

    if (reserved) await kv('expire', slotKey, SLOT_TTL_SECONDS);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    if (reserved) await kv('srem', slotKey, cleanTime); // release — the owner never got notified
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз позже.',
    });
  }
}
