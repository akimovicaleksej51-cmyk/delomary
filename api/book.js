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
// Optional (needed for slot availability + the admin panel to work — see
// api/slots.js and api/admin/bookings.js):
//   KV_REST_API_URL, KV_REST_API_TOKEN — added automatically once you
//   connect a Vercel KV database (Storage tab → Create Database → KV) to
//   this project. Without them, bookings still work, they just aren't
//   checked against each other and won't show up in the admin panel.
//
// Optional (SMS receipt to the customer — see api/_sms.js for full details
// and the exact wording sent):
//   ROCKETSMS_LOGIN, ROCKETSMS_PASSWORD, ROCKETSMS_SENDER — added
//   18.09.2026. Without them, bookings still work exactly as before, the
//   customer just doesn't get an SMS receipt of their request.
//
// Bookings are stored in KV as a Redis HASH per date — key "bookings:<ISO
// date>", one field per booked time, whose value is a JSON string with the
// full booking details (name, phone, players, price, comment...). This lets
// the admin panel list/view/cancel/reschedule bookings, while the public
// api/slots.js endpoint only ever reads the field NAMES (the times), never
// these JSON values, so customer details are never exposed publicly.

import { kv, isKvConfigured } from './_kv.js';
import { scheduleReminder } from './_reminders.js';
import { scheduleGameCloseout } from './_closeout.js';
import { sendBookingConfirmationSms } from './_sms.js';
import { isSlotClosingSoon } from './_time.js';
import { SLOTS, LATE_SLOT_INDEX, LATE_SURCHARGE, ANIMATOR_SURCHARGE, tiersFor, isWeekendISO } from './_pricing.js';
import { getClientIp, checkAndBumpRateLimit } from './_ratelimit.js';
import { escapeTgHtml, dateTimeBlock } from './_telegram.js';

const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90; // auto-clean ~90 days after the date

// 23.09.2026: an actual calendar date, not just something shaped like one —
// cleanDateISO below only checked the YYYY-MM-DD shape with a regex, so
// "2026-02-30" (or any other date that doesn't really exist) passed as
// valid. That mattered because a date this check rejects, combined with a
// missing/invalid time, used to leave hashKey null further down — which
// skipped BOTH the "closing soon" rejection above it AND the slot-
// reservation step entirely, so the booking still succeeded and reached the
// owner's Telegram without ever occupying a real slot in bookings:<date>.
function isRealCalendarDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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

  const { name, phone, players, date, dateISO, time, price, website, comment, animator } = body;

  // Honeypot: real visitors never fill a field hidden with CSS. If it's
  // filled, silently pretend success so bots don't learn anything.
  if (website) {
    return res.status(200).json({ ok: true });
  }

  // 23.09.2026: this endpoint had no anti-flood protection of its own at
  // all (unlike the admin login, see api/_ratelimit.js) — only the
  // honeypot above, plus the per-(date,time) dedup further down, which does
  // nothing to stop a script hitting a DIFFERENT date/time on every
  // request. Each one reaches all the way to a live Telegram message (and,
  // if RocketSMS is configured, an SMS) before this point, so a flood here
  // has a real, visible cost, not just wasted CPU. Deliberately a separate,
  // much more generous counter from the login lockout's 8-per-15-minutes —
  // a real customer bouncing between a few slots after a couple of 409s
  // must never be blocked.
  const clientIp = getClientIp(req);
  const bookingRate = await checkAndBumpRateLimit('bookattempts', clientIp, 20, 10 * 60);
  if (bookingRate.limited) {
    return res.status(429).json({
      error: 'Слишком много заявок подряд с этого устройства. Попробуйте через несколько минут или позвоните нам: +375 (44) 780-30-00.',
    });
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 40) : '';
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';
  const cleanDateISO = typeof dateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : '';
  const cleanTime = typeof time === 'string' ? time.trim().slice(0, 20) : '';
  const cleanDateLabel = typeof date === 'string' ? date.trim().slice(0, 60) : '';
  const cleanPlayers = players != null ? String(players).slice(0, 40) : '';
  const cleanAnimator = animator === true || animator === 'true';

  if (!cleanName || !cleanPhone) {
    return res.status(400).json({ error: 'Укажите имя и телефон.' });
  }

  // 23.09.2026: dateISO/time used to only be checked for SHAPE (a
  // YYYY-MM-DD-looking string, and any string at all for time), never
  // against a real calendar date or the site's actual published slots. A
  // request with a blank/malformed date left `hashKey` (below) null, which
  // skipped BOTH the "closing soon" check right after this block AND the
  // slot-reservation step entirely — so the booking still went through and
  // reached the owner's Telegram, just without ever occupying a real slot
  // in bookings:<date>. That let anyone flood the owner with unlimited
  // "phantom" bookings that no amount of resubmitting would ever collide
  // with (nothing to collide against), on top of not being blocked by the
  // real per-slot dedup at all.
  if (!isRealCalendarDate(cleanDateISO)) {
    return res.status(400).json({ error: 'Некорректная дата.' });
  }
  if (!SLOTS.includes(cleanTime)) {
    return res.status(400).json({ error: 'Некорректное время сеанса.' });
  }

  // 22.09.2026: the front-end calendar (index.html) already greys out and
  // blocks a slot once there's under an hour left before it starts — but
  // that was ONLY a front-end check, so a direct POST here (or a visitor
  // whose page had been open a while, past the hour boundary) could still
  // slip through server-side. Mirrors the exact same rule now enforced on
  // the Mir Kvestov/ExtraReality booking endpoints — see api/_time.js.
  if (isSlotClosingSoon(cleanDateISO, cleanTime)) {
    return res.status(409).json({
      conflict: true,
      error: 'Онлайн-бронь этого времени уже закрыта — до сеанса меньше часа. Позвоните нам: +375 (44) 780-30-00.',
    });
  }

  // 23.09.2026: `price` used to be whatever the client sent, verbatim —
  // never checked against api/_pricing.js the way every other booking path
  // (Мир Квестов, ExtraReality, the admin panel) already is. A direct POST
  // here (bypassing the widget's own JS) could claim any price for any
  // team size/date/time; the owner would just see whatever number was sent
  // in the Telegram notification. `players` doubles as the tier-selector
  // here (it's the exact tier label the widget sends, e.g. "3–4 человека"
  // — see index.html), so an unrecognised value also means an unrecognised
  // team size, not just a cosmetic mismatch.
  const matchedTier = tiersFor(isWeekendISO(cleanDateISO)).find((t) => t.people === cleanPlayers);
  if (!matchedTier) {
    return res.status(400).json({ error: 'Некорректное количество игроков.' });
  }
  const expectedPrice = matchedTier.price
    + (cleanTime === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0)
    + (cleanAnimator ? ANIMATOR_SURCHARGE : 0);
  const submittedPrice = price != null ? String(price).slice(0, 20) : '';
  if (submittedPrice !== String(expectedPrice)) {
    console.error(`book.js: price mismatch for ${cleanDateISO} ${cleanTime} (${cleanPlayers}${cleanAnimator ? ' + аниматор' : ''}) — client sent "${submittedPrice}", expected ${expectedPrice}. Using the correct price.`);
  }
  const cleanPrice = String(expectedPrice);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(500).json({
      error: 'Форма временно не работает. Пожалуйста, позвоните нам напрямую.',
    });
  }

  // Reserve the slot atomically: HSETNX only sets the field if it doesn't
  // already exist in the hash, so two simultaneous requests can never both
  // "win" the same (date, time) pair. cleanDateISO/cleanTime are guaranteed
  // non-empty and valid by the checks above, so this key is always built.
  const hashKey = `bookings:${cleanDateISO}`;
  let reserved = false;

  const record = {
    type: 'customer',
    name: cleanName,
    phone: cleanPhone,
    players: cleanPlayers,
    price: cleanPrice,
    // Payment breakdown, discount notes, and who actually worked the
    // session aren't known yet at booking time — the admin fills these in
    // later via the admin panel's "Редактировать" (see the Касса feature
    // in api/admin/bookings.js / api/admin/finance.js). `channel` defaults
    // to 'Сайт' here since that's simply true for every booking that goes
    // through this endpoint.
    payCash: '',
    payCard: '',
    payErip: '',
    channel: 'Сайт',
    discountNote: '',
    workedActor: '',
    workedActress: '',
    handledByAdmin: '',
    comment: cleanComment,
    animator: cleanAnimator, // customer requested the "Аниматор" add-on (+30 Br) at booking time
    dateISO: cleanDateISO,
    dateLabel: cleanDateLabel,
    time: cleanTime,
    createdAt: new Date().toISOString(),
  };

  const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
  if (added === 0) {
    return res.status(409).json({
      conflict: true,
      error: 'Это время только что заняли — пожалуйста, выберите другое.',
    });
  }
  if (added === 1) {
    reserved = true;
  } else if (isKvConfigured()) {
    // 23.09.2026: `added` is also `null` when KV IS connected but this one
    // call failed/timed out (a real Redis hiccup — see api/_kv.js) — that
    // used to be treated exactly like "KV isn't connected at all" and the
    // booking proceeded anyway, unreserved. On a deployment where KV is
    // actually in use (this one), that's the dangerous case: if two
    // customers hit the same transient failure for the same slot, BOTH
    // requests would "succeed" with no 409 ever shown to either of them,
    // and the owner would get two separate Telegram messages for one real
    // slot. Failing the request instead means a customer sees a clear
    // "try again" instead of a phantom successful booking.
    console.error(`book.js: KV write failed for ${hashKey} ${cleanTime} while KV is configured — refusing to book unreserved.`);
    return res.status(503).json({
      error: 'Временные неполадки с сервером. Пожалуйста, попробуйте отправить заявку ещё раз через минуту.',
    });
  }
  // else: KV isn't connected at all in this deployment — proceed
  // unreserved, exactly as documented at the top of this file.

  // 23.09.2026: date+time now shown FIRST and in bold (owner's request —
  // wants them visible without opening the message), no emoji anywhere,
  // and the date is always day/month/year, never a raw ISO string. See
  // api/_telegram.js for the shared formatting this and the other two
  // booking sources (Мир Квестов, ExtraReality) all use, and why this is
  // HTML parse_mode rather than the old plain text or the even-older
  // Markdown (that history is also there).
  const fields = [
    ...dateTimeBlock(cleanDateISO, cleanTime),
    `Имя: ${escapeTgHtml(cleanName)}`,
    `Телефон: ${escapeTgHtml(cleanPhone)}`,
    cleanPlayers ? `Игроков: ${escapeTgHtml(cleanPlayers)}` : null,
    cleanPrice ? `Цена: ${escapeTgHtml(cleanPrice)} Br` : null,
    cleanAnimator ? `Аниматор: да (+30 Br)` : null,
    cleanComment ? `Комментарий: ${escapeTgHtml(cleanComment)}` : null,
  ].filter((line) => line !== null).join('\n');

  // 23.09.2026: title line always CAPS (owner's request).
  const text = `${'Новая заявка — Дело Мэри'.toUpperCase()}\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML', // only for the <b> tags dateTimeBlock() adds — see api/_telegram.js
      }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      if (reserved) await kv('hdel', hashKey, cleanTime); // release — the owner never got notified
      return res.status(502).json({
        error: 'Не удалось отправить заявку. Попробуйте позвонить нам.',
      });
    }

    if (reserved) {
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      // Best-effort: if a shift schedule assigns a performer to this slot,
      // this schedules their private 1.5h-before reminder AND their sverka
      // (game closeout) message, timed 60 minutes (1 hour) after THIS game's own
      // start time — see api/_reminders.js and api/_closeout.js. Neither
      // ever blocks or fails the booking itself.
      const [reminderPatch, closeoutPatch] = await Promise.all([
        scheduleReminder(record),
        scheduleGameCloseout(record),
      ]);
      const patch = { ...reminderPatch, ...closeoutPatch };
      if (Object.keys(patch).length) {
        await kv('hset', hashKey, cleanTime, JSON.stringify({ ...record, ...patch }));
      }
    }

    // Best-effort SMS receipt to the customer — runs whether or not KV/the
    // dedup check above is connected, since the booking request itself
    // already succeeded (the owner was already notified via Telegram at
    // this point). Never blocks or fails the booking; see api/_sms.js.
    await sendBookingConfirmationSms(record);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    if (reserved) await kv('hdel', hashKey, cleanTime); // release — the owner never got notified
    return res.status(500).json({
      error: 'Внутренняя ошибка. Попробуйте ещё раз позже.',
    });
  }
}
