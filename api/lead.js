// Serverless function (Vercel Node.js runtime).
// Receives an email left in the "Loony Room" pre-order teaser and does two
// separate things with it:
//
//   1. Notifies the owner in Telegram — a SEPARATE bot/chat from the
//      booking one in api/book.js, on purpose, so room pre-orders don't
//      mix with quest bookings.
//   2. Sends a confirmation letter straight to the visitor's own email,
//      via Elastic Email, so they immediately see "we got it".
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   LOONY_BOT_TOKEN        — token from @BotFather for the Loony Room bot
//   LOONY_CHAT_ID          — the destination chat id (message the bot
//                             once, then open
//                             https://api.telegram.org/bot<TOKEN>/getUpdates
//                             and look for "chat":{"id":...} — negative
//                             number for a group/supergroup)
//   ELASTICEMAIL_API_KEY   — API key from elasticemail.com (Settings →
//                             API → create an API key)
//   ELASTICEMAIL_FROM      — the email address you verified in Elastic
//                             Email (Settings → Domains → Verify email —
//                             no domain or phone number needed, just a
//                             confirmation link sent to that inbox).
//                             Emails will be sent "from" this address.
//
// NOTE ON THE LETTER TEXT: the subject/greeting/body below are a
// placeholder draft, written so the feature works end-to-end. Edit
// EMAIL_SUBJECT and the buildEmailHtml()/buildEmailText() functions below
// to change the wording — nothing else needs to change.

const EMAIL_SUBJECT = 'Вы в списке — Loony Room скоро откроется';

function buildEmailText() {
  return [
    'Здравствуйте.',
    '',
    'Спасибо, что оставили свой адрес — вы в числе первых, кто узнает об',
    'открытии новой комнаты Loony Room от квеста «Дело Мэри. Скажи им, что',
    'я здесь».',
    '',
    'Как только будут готовы дата запуска, цена и расписание — мы напишем',
    'вам сюда же, на этот адрес, и вы сможете забронировать место раньше',
    'остальных.',
    '',
    'До встречи по ту сторону двери.',
    '',
    '— Loony Games',
  ].join('\n');
}

function buildEmailHtml() {
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.6;">
    <p>Здравствуйте.</p>
    <p>
      Спасибо, что оставили свой адрес — вы в числе первых, кто узнает об
      открытии новой комнаты <strong>Loony Room</strong> от квеста
      «Дело Мэри. Скажи им, что я здесь».
    </p>
    <p>
      Как только будут готовы дата запуска, цена и расписание — мы напишем
      вам сюда же, на этот адрес, и вы сможете забронировать место раньше
      остальных.
    </p>
    <p>До встречи по ту сторону двери.</p>
    <p style="margin-top: 32px; color: #6b6b6b;">— Loony Games</p>
  </div>
  `.trim();
}

async function sendConfirmationEmail(toEmail) {
  const apiKey = process.env.ELASTICEMAIL_API_KEY;
  const fromEmail = process.env.ELASTICEMAIL_FROM;

  if (!apiKey || !fromEmail) {
    console.error('Missing ELASTICEMAIL_API_KEY or ELASTICEMAIL_FROM env vars — skipping confirmation email');
    return;
  }

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      from: fromEmail,
      fromName: 'Loony Games',
      to: toEmail,
      subject: EMAIL_SUBJECT,
      bodyHtml: buildEmailHtml(),
      bodyText: buildEmailText(),
      isTransactional: 'true',
    });

    const res = await fetch('https://api.elasticemail.com/v2/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();

    if (!data.success) {
      console.error('Elastic Email API error:', data.error || data);
    }
  } catch (err) {
    console.error('Failed to reach Elastic Email API:', err);
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

    // Send the confirmation letter to the visitor. This is best-effort: if
    // it fails, we log it but still tell the visitor their request was
    // received (the owner already got the Telegram notification above).
    await sendConfirmationEmail(cleanEmail);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз чуть позже.',
    });
  }
}
