// Serverless function (Vercel Node.js runtime).
// Receives a booking request from the site's form and forwards it as a
// Telegram message to the quest owner. It does NOT store bookings anywhere
// and does NOT reply to the customer — confirmation is done by the owner
// manually, by phone.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN  — token from @BotFather
//   TELEGRAM_CHAT_ID    — the owner's chat id (message your bot once, then
//                          open https://api.telegram.org/bot<TOKEN>/getUpdates
//                          and look for "chat":{"id":...})

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

  const { name, phone, players, date, time, price, website, comment } = body;

  // Honeypot: real visitors never fill a field hidden with CSS. If it's
  // filled, silently pretend success so bots don't learn anything.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';

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

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    `📞 Телефон: ${escapeMd(cleanPhone)}`,
    players ? `👥 Игроков: ${escapeMd(String(players).slice(0, 10))}` : null,
    date ? `📅 Дата: ${escapeMd(String(date).slice(0, 60))}` : null,
    time ? `🕒 Время: ${escapeMd(String(time).slice(0, 40))}` : null,
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
      return res.status(502).json({
        error: 'Не удалось отправить заявку. Попробуйте позвонить нам.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз позже.',
    });
  }
}  if (!cleanName || !cleanPhone) {
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

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  const fields = [
    `👤 Имя: ${escapeMd(cleanName)}`,
    `📞 Телефон: ${escapeMd(cleanPhone)}`,
    players ? `👥 Игроков: ${escapeMd(String(players).slice(0, 10))}` : null,
    date ? `📅 Дата: ${escapeMd(String(date).slice(0, 60))}` : null,
    time ? `🕒 Время: ${escapeMd(String(time).slice(0, 40))}` : null,
    price ? `💰 Цена: ${escapeMd(String(price).slice(0, 20))} ₽` : null,
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
      return res.status(502).json({
        error: 'Не удалось отправить заявку. Попробуйте позвонить нам.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз позже.',
    });
  }
}
