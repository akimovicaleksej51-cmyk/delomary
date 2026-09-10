// Serverless function (Vercel Node.js runtime).
// This is the URL QStash calls at exactly the scheduled moment (1.5h before
// a booking) — see scheduleReminder() in api/_reminders.js for how the
// call gets scheduled. It just sends one Telegram message to the actor's
// private chat.
//
// Authentication: QStash forwards whatever custom header we asked it to
// when we scheduled the message ("Upstash-Forward-X-Reminder-Secret"), so
// it arrives here as a plain header. We just check it matches
// REMINDER_WEBHOOK_SECRET — anyone without that secret gets 401. (We don't
// verify QStash's own request signature here to avoid pulling in a JWT
// library — this project intentionally has zero npm dependencies — but the
// shared-secret header is only ever known to this project's own code, so
// it's not guessable.)
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN       — same bot as everywhere else in this project.
//   REMINDER_WEBHOOK_SECRET  — same secret used when scheduling in
//                               api/_reminders.js.

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}, ${WEEKDAY_NAMES[date.getDay()]}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.REMINDER_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-reminder-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { chatId, dateISO, time, players } = body;
  if (!chatId || !time) {
    return res.status(400).json({ error: 'Missing chatId/time' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('telegram-reminder: missing TELEGRAM_BOT_TOKEN');
    return res.status(500).json({ error: 'Bot not configured' });
  }

  const dateLabel = dateISO ? formatDateLabel(dateISO) : '';
  const lines = [
    '⏰ Напоминание: через 1.5 часа у вас игра.',
    dateLabel ? `📅 ${dateLabel}, ${time}` : `🕒 Время: ${time}`,
    players ? `👥 Игроков: ${players}` : null,
  ].filter(Boolean);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
    });
    const tgData = await tgRes.json().catch(() => ({}));
    if (!tgData.ok) {
      console.error('telegram-reminder: Telegram API error:', tgData);
      return res.status(502).json({ error: 'Telegram send failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-reminder: failed to reach Telegram API:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
