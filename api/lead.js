// Serverless function (Vercel Node.js runtime).
// Receives an email left in the "Loony Room" pre-order teaser and forwards
// it to a Telegram chat — a SEPARATE bot/chat from the booking one in
// api/book.js, on purpose, so room pre-orders don't mix with quest bookings.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   LOONY_BOT_TOKEN  — token from @BotFather for the Loony Room bot
//   LOONY_CHAT_ID    — the destination chat id (message the bot once, then
//                       open https://api.telegram.org/bot<TOKEN>/getUpdates
//                       and look for "chat":{"id":...} — negative number
//                       for a group/supergroup)

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

  const { email, website } = body;

  // Honeypot: real visitors never fill a field hidden with CSS.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  const cleanEmail = typeof email === 'string' ? email.trim().slice(0, 200) : '';
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(cleanEmail)) {
    return res.status(400).json({ error: 'Укажите корректный email.' });
  }

  const token = process.env.LOONY_BOT_TOKEN;
  const chatId = process.env.LOONY_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing LOONY_BOT_TOKEN or LOONY_CHAT_ID env vars');
    return res.status(500).json({
      error: 'Форма временно не работает. Попробуйте ещё раз чуть позже.',
    });
  }

  const escapeMd = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  const text = `🏠 *Loony Room — заявка на предзаказ*\n\n📧 Email: ${escapeMd(cleanEmail)}`;

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
        error: 'Не удалось отправить. Попробуйте ещё раз чуть позже.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз чуть позже.',
    });
  }
}
