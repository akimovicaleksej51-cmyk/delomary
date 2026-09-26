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

import { getClientIp, checkAndBumpRateLimit } from './_ratelimit.js';

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

  // 26.09.2026: this form has a Telegram notification AND sends a real
  // email to whatever address is submitted (see sendConfirmationEmail
  // below) with no rate limiting at all — unlike api/book.js, someone could
  // flood arbitrary email addresses with unsolicited "you're on the list"
  // letters (harassment, plus it costs a real Elastic Email API call each
  // time) or spam the owner's Telegram. Same threshold as api/book.js's own
  // limiter (20 per 10 min per IP) since this, like that one, is a normal
  // site visitor's own browser submitting the form — one IP is one person.
  const clientIp = getClientIp(req);
  const leadRate = await checkAndBumpRateLimit('leadattempts', clientIp, 20, 10 * 60);
  if (leadRate.limited) {
    return res.status(429).json({ error: 'Слишком много попыток подряд. Попробуйте через несколько минут.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { email, website, attribution } = body;

  // Honeypot: real visitors never fill a field hidden with CSS.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  // 26.09.2026: same ad-attribution capture as api/book.js — see that
  // file's comment and index.html's getAdAttribution(). Only used for the
  // optional Telegram line below; nothing here is required or validated.
  const rawAttribution = attribution && typeof attribution === 'object' ? attribution : {};
  const cleanAttribution = {
    utmSource: typeof rawAttribution.utm_source === 'string' ? rawAttribution.utm_source.trim().slice(0, 100) : '',
    utmMedium: typeof rawAttribution.utm_medium === 'string' ? rawAttribution.utm_medium.trim().slice(0, 100) : '',
    utmCampaign: typeof rawAttribution.utm_campaign === 'string' ? rawAttribution.utm_campaign.trim().slice(0, 150) : '',
    gclid: typeof rawAttribution.gclid === 'string' ? rawAttribution.gclid.trim().slice(0, 150) : '',
    fbclid: typeof rawAttribution.fbclid === 'string' ? rawAttribution.fbclid.trim().slice(0, 150) : '',
  };
  function attributionLabel(a) {
    const parts = [a.utmSource, a.utmMedium, a.utmCampaign].filter(Boolean);
    if (parts.length) return parts.join(' / ');
    if (a.gclid) return 'клик по рекламе Google (gclid)';
    if (a.fbclid) return 'клик по рекламе Meta (fbclid)';
    return '';
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

  // 22.09.2026: sent as plain text now (no parse_mode) — see the
  // escapeMd() comment in api/book.js for why the old backslash-escaping
  // (written for MarkdownV2, but sent with the legacy 'Markdown' mode)
  // showed up as literal backslashes in real notifications. An email
  // address commonly contains "." and sometimes "-", both MarkdownV2-
  // reserved, so this one was affected too.
  const escapeMd = (s) => String(s);
  const sourceLabel = attributionLabel(cleanAttribution);
  const text = `🏠 Loony Room — заявка на предзаказ\n\n📧 Email: ${escapeMd(cleanEmail)}`
    + (sourceLabel ? `\n📣 Источник: ${escapeMd(sourceLabel)}` : '');

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
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
