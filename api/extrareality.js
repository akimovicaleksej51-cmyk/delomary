// Serverless function (Vercel Node.js runtime).
// Added 22.09.2026 for the ExtraReality aggregator integration. Combines
// what would otherwise be two separate files (a GET "schedule" endpoint and
// a POST "booking" endpoint) into one, since Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions total — see api/internal-jobs.js's
// header comment for the full picture.
//
// Give ExtraReality these URLs in their settings panel:
//   Расписание (GET):        https://loonygames.by/api/extrareality
//   Бронь (POST):             https://loonygames.by/api/extrareality
//   Отмена брони (POST):      https://loonygames.by/api/extrareality?action=cancel
// (Расписание and Бронь share one URL — GET vs POST tells them apart. The
// cancel endpoint needs its own URL since it's also a POST to the same
// file — the "?action=cancel" query string is how the single serverless
// function tells a cancellation apart from a new booking, without using up
// a second function slot — see the Vercel Hobby 12-function-limit note
// above.)
//
// 22.09.2026 update: found ExtraReality's real, official API docs
// (https://github.com/riente/extrareality-api/blob/master/docs/APIv2.md),
// which confirms the general shape guessed below was correct, and gives
// two concrete new facts used in this update:
//   - the schedule should cover "примерно на месяц вперёд" (about a month
//     ahead) — extended further still, to 1.5 months, per the owner's
//     request (see DAYS_AHEAD below).
//   - the signature formula for the WHOLE API is md5($datetime . $secret)
//     — this is now used below for the cancellation endpoint (see
//     verifyExtraRealitySignature()). The booking endpoint's own signature
//     is still deliberately not enforced (see the POST section further
//     down) since no real booking has confirmed it end-to-end yet.
//
// ===========================================================================
// GET — response shape (one entry per bookable time slot, for the next
// ~1.5 months):
//   date          "YYYY-MM-DD"
//   time          "HH:MM" (24-hour)
//   is_free       false if taken (booked/blocked) or already in the past
//   price         integer, Br — the cheapest tier's "starting from" price
//   extraPrices   {"1–2 человека": 140, "3–4 человека": 160, ...} — the
//                 full weekday/weekend per-team-size breakdown, since
//                 ExtraReality's own schedule response appears to carry
//                 this directly (unlike Mir Kvestov's separate, unclear
//                 "tariffs" callback), so it's safe to include here.
//   our_time_id   optional custom field, echoed back per convention — not
//                 relied on by the POST handler below.
//
// ===========================================================================
// POST — incoming fields (best-effort, see note above):
//   name, email, phone, comment
//   datetime      "YYYY-MM-DD HH:MM:SS" — date+time combined into one
//                 field (unlike Mir Kvestov, which sends them separately)
//   players_num   integer — unlike Mir Kvestov this one IS commonly sent,
//                 so it's stored directly on the booking
//   price         the booking's cost
//   uid           ExtraReality's own reservation id (kept as externalRef)
//   source        expected to be "extrareality"
//   signature     see the note on verification below
//   our_time_id   optional, echoed back from the GET side — not relied on
//
// SIGNATURE VERIFICATION — DELIBERATELY NOT ENFORCED YET. With no verified
// official spec in hand, getting the exact formula wrong would mean EVERY
// real booking silently gets rejected the moment an EXTRAREALITY_SECRET env
// var is set — a much worse outcome than no signature check at all for
// now. Leave ExtraReality's own "секрет" field blank for the moment; this
// endpoint accepts bookings exactly like Mir Kvestov's does when its own
// secret isn't configured. Once a real test booking confirms the exact
// signature formula, adding it here is a small, safe addition (same shape
// as api/mirkvestov.js's verifySignature()).
//
// Required response shape (assumed to match Mir Kvestov's own convention):
//   {"success": true}
//   {"success": false, "message": "..."}
//   {"success": false, "message": "Указанное время занято"}  <- for an
//     already-taken slot (exact wording not confirmed required for
//     ExtraReality, but reusing it everywhere is simple and shouldn't hurt).
//
// Reuses the same `bookings:<date>` Redis hash reservation mechanism as
// every other channel, tagged channel: 'ExtraReality'.
//
// ===========================================================================
// POST ?action=cancel — "Отмена брони", added 22.09.2026 per the official
// docs (see link above). ExtraReality calls this when a customer (or their
// own staff) cancels a booking made through them.
//
// Incoming fields, per their spec:
//   datetime    "YYYY-MM-DD HH:MM:SS" of the game being cancelled
//   phone       customer phone (not otherwise used here — datetime+uid is
//               enough to identify the slot, phone is just extra context)
//   quest_id    ExtraReality's quest id (not otherwise used here — this
//               site only has the one quest/room)
//   uid         ExtraReality's own booking id — the SAME value they sent
//               with the original booking (stored as this site's
//               externalRef, "extrareality:<uid>"), used below as a safety
//               check so this endpoint can only ever cancel a booking that
//               actually came from ExtraReality with a matching id, never
//               some other channel's booking that happens to sit in the
//               same slot.
//   signature   md5(datetime + EXTRAREALITY_SECRET) — verified below, but
//               (like Mir Kvestov's own signature) ONLY once
//               EXTRAREALITY_SECRET is actually set as an env var; while
//               ExtraReality's "секрет" field in their panel is left blank
//               (as instructed when the booking endpoint was first set up),
//               this check is skipped entirely and cancellation works
//               either way.
//
// Uses the exact same cancel mechanics as the admin panel's own "Отменить"
// button (api/admin/bookings.js, action:'cancel'): HDEL the slot, cancel any
// scheduled reminder/closeout jobs, move the record into the `history:<date>`
// hash tagged status:'cancelled', and notify the owner's Telegram — so an
// ExtraReality cancellation looks and behaves identically to a manual one.
//
// ===========================================================================
// GET ?action=reviews — "Получение отзывов" / "Получение рейтинга", also
// added 22.09.2026. Unlike every other action in this file, THIS ONE calls
// OUT to ExtraReality (they don't call us) — it's how the site's own
// "Отзывы" section (index.html, #reviews) always shows fresh reviews
// instead of three hand-picked quotes that go stale.
//
// Per their docs:
//   GET https://extrareality.by/api2/reviews?quest_id=<id>  → array of
//     {id, datetime, name, text, rating}
//   GET https://extrareality.by/api2/rating?quest_id=<id>&json=1  →
//     {questId, rating}
// and explicitly: "рекомендуется отправлять его не чаще раза в 30 минут" —
// so this endpoint never calls ExtraReality on every single page view.
// Instead it caches the result in Redis and only re-fetches once the cache
// is older than REVIEWS_MIN_REFRESH_SECONDS (30 minutes, matching their
// own guidance exactly) — the first visitor after that window pays for a
// live fetch, everyone else in between gets the cached copy. If the live
// fetch ever fails, the last good cached copy is served instead of
// breaking the section.
//
// Needs an EXTRAREALITY_QUEST_ID env var (the numeric quest id ExtraReality
// assigned this room — NOT the "секрет"/md5 key, and not the URL slug
// "delo-meri-skazhi-im-chto-ya-zdes"). Until that env var is set, this
// action just returns an empty review list — index.html's own script
// already keeps its 3 static fallback reviews on screen when that happens,
// so nothing breaks; it starts pulling live reviews the moment the quest id
// is added on Vercel, no further code changes needed.

import crypto from 'crypto';
import { kv, kvPipeline } from './_kv.js';
import { businessToday, isSlotClosingSoon } from './_time.js';
import { SLOTS, tiersFor, isWeekendISO, startingPriceFor, LATE_SLOT_INDEX, LATE_SURCHARGE } from './_pricing.js';
import { scheduleReminder, cancelReminder } from './_reminders.js';
import { scheduleGameCloseout, cancelGameCloseout } from './_closeout.js';
import { sendBookingConfirmationSms } from './_sms.js';
import { escapeTgHtml, dateTimeBlock, formatDateRu } from './_telegram.js';

const DAYS_AHEAD = 45; // was 14 (2 weeks) — extended to ~1.5 months, 22.09.2026
const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 95; // matches api/admin/bookings.js

const REVIEWS_CACHE_KEY = 'extrareality:reviewsCache';
const REVIEWS_MIN_REFRESH_SECONDS = 30 * 60; // ExtraReality's own guidance: "не чаще раза в 30 минут"
const REVIEWS_CACHE_TTL_SECONDS = 60 * 60 * 24 * 2; // safety-net Redis expiry only — the 30-min check above is what actually paces the refresh

// 23.09.2026: the local escapeMd() that used to live here (see git history/
// old comments if curious — it was a plain-text passthrough, kept around
// after an earlier Markdown-escaping bug) is gone: every Telegram message
// in this file now goes through escapeTgHtml() from api/_telegram.js
// instead, since these messages are HTML parse_mode now (bold date/time —
// see that file's own comment for the full history).

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extraPricesFor(dateISO, time) {
  const tiers = tiersFor(isWeekendISO(dateISO));
  const lateBonus = time === SLOTS[LATE_SLOT_INDEX] ? LATE_SURCHARGE : 0;
  const out = {};
  tiers.forEach((tier) => { out[tier.people] = tier.price + lateBonus; });
  return out;
}

async function handleSchedule(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const today = businessToday();
  const dates = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }

  const results = await kvPipeline(dates.map((iso) => ['HKEYS', `bookings:${iso}`]));
  const takenByDate = {};
  if (results) {
    results.forEach((entry, i) => {
      const times = entry && entry.result;
      takenByDate[dates[i]] = Array.isArray(times) ? times : [];
    });
  }

  const now = new Date();
  const out = [];
  for (const dateISO of dates) {
    const taken = takenByDate[dateISO] || [];
    for (const time of SLOTS) {
      // Was just "already started" — now matches the site's own hour-before
      // cutoff (see isSlotClosingSoon in api/_time.js), so a slot ExtraReality
      // couldn't book on our own site anyway isn't shown as free here either.
      const closingSoon = isSlotClosingSoon(dateISO, time, now);
      out.push({
        date: dateISO,
        time,
        is_free: !closingSoon && !taken.includes(time),
        price: startingPriceFor(dateISO, time),
        extraPrices: extraPricesFor(dateISO, time),
        our_time_id: `${dateISO}_${time}`,
      });
    }
  }

  return res.status(200).json(out);
}

function parseBody(req) {
  let body = req.body;
  if (body == null) return {};
  if (typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  try {
    return Object.fromEntries(new URLSearchParams(trimmed));
  } catch {
    return {};
  }
}

function splitDateTime(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!m) return { dateISO: '', time: '' };
  return { dateISO: m[1], time: m[2] };
}

async function handleBook(req, res) {
  const body = parseBody(req);

  const cleanName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const cleanPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
  const cleanEmail = typeof body.email === 'string' ? body.email.trim().slice(0, 100) : '';
  const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  const { dateISO: cleanDateISO, time: cleanTime } = splitDateTime(body.datetime);
  const cleanPrice = body.price != null ? String(body.price).slice(0, 20) : '';
  const cleanPlayers = body.players_num != null ? String(body.players_num).slice(0, 40) : '';
  const cleanUid = body.uid != null ? String(body.uid).slice(0, 100) : '';

  if (!cleanName || !cleanPhone || !cleanDateISO || !cleanTime) {
    return res.status(200).json({ success: false, message: 'Не хватает обязательных полей (имя, телефон, дата и время).' });
  }

  // Matches the site's own hour-before cutoff (see api/_time.js) — closes
  // this even if ExtraReality's cached schedule still thinks the slot is
  // free (e.g. they last fetched GET a while ago and the hour boundary has
  // since passed).
  if (isSlotClosingSoon(cleanDateISO, cleanTime)) {
    return res.status(200).json({ success: false, message: 'Указанное время больше недоступно для онлайн-бронирования (до сеанса меньше часа).' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return res.status(200).json({ success: false, message: 'Бронирование временно недоступно, попробуйте позже.' });
  }

  const commentParts = [cleanComment, cleanEmail ? `Email: ${cleanEmail}` : ''].filter(Boolean);

  const record = {
    type: 'customer',
    name: cleanName,
    phone: cleanPhone,
    players: cleanPlayers,
    price: cleanPrice,
    payCash: '',
    payCard: '',
    payErip: '',
    channel: 'ExtraReality',
    discountNote: '',
    workedActor: '',
    workedActress: '',
    handledByAdmin: '',
    comment: commentParts.join(' · '),
    animator: false,
    dateISO: cleanDateISO,
    dateLabel: '',
    time: cleanTime,
    externalRef: cleanUid ? `extrareality:${cleanUid}` : '',
    createdAt: new Date().toISOString(),
  };

  const hashKey = `bookings:${cleanDateISO}`;
  const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
  if (added === 0) {
    return res.status(200).json({ success: false, message: 'Указанное время занято' });
  }
  const reserved = added === 1;

  // 23.09.2026: date+time first and bold, no emoji, always day/month/year
  // (this used to show the bare ISO date, "2026-09-28") — see
  // api/_telegram.js for the shared formatting and why HTML parse_mode.
  const fields = [
    ...dateTimeBlock(cleanDateISO, cleanTime),
    `Имя: ${escapeTgHtml(cleanName)}`,
    `Телефон: ${escapeTgHtml(cleanPhone)}`,
    cleanPlayers ? `Игроков: ${escapeTgHtml(cleanPlayers)}` : null,
    cleanPrice ? `Цена: ${escapeTgHtml(cleanPrice)} Br` : null,
    cleanComment ? `Комментарий: ${escapeTgHtml(cleanComment)}` : null,
  ].filter((line) => line !== null).join('\n');
  // 23.09.2026: title line always CAPS (owner's request).
  const text = `${'Новая бронь — ExtraReality'.toUpperCase()}\n\n${fields}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      if (reserved) await kv('hdel', hashKey, cleanTime);
      return res.status(200).json({ success: false, message: 'Внутренняя ошибка, попробуйте ещё раз.' });
    }

    if (reserved) {
      await kv('expire', hashKey, SLOT_TTL_SECONDS);
      const [reminderPatch, closeoutPatch] = await Promise.all([
        scheduleReminder(record),
        scheduleGameCloseout(record),
      ]);
      const patch = { ...reminderPatch, ...closeoutPatch };
      if (Object.keys(patch).length) {
        await kv('hset', hashKey, cleanTime, JSON.stringify({ ...record, ...patch }));
      }
    }

    await sendBookingConfirmationSms(record);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Failed to reach Telegram API:', err);
    if (reserved) await kv('hdel', hashKey, cleanTime);
    return res.status(200).json({ success: false, message: 'Внутренняя ошибка, попробуйте ещё раз.' });
  }
}

function verifyExtraRealitySignature(rawDatetime, providedSignature) {
  const secret = process.env.EXTRAREALITY_SECRET;
  if (!secret) return true; // "секрет" field left blank in ExtraReality's panel — skip check, exactly like before
  const provided = typeof providedSignature === 'string' ? providedSignature.trim().toLowerCase() : '';
  if (!provided) return false; // a secret IS configured — a request with no signature at all can't be trusted
  const expected = crypto.createHash('md5').update(`${rawDatetime}${secret}`, 'utf8').digest('hex');
  return provided === expected;
}

async function handleCancel(req, res) {
  const body = parseBody(req);

  const rawDatetime = typeof body.datetime === 'string' ? body.datetime.trim() : '';
  const cleanUid = body.uid != null ? String(body.uid).trim().slice(0, 100) : '';
  const providedSignature = typeof body.signature === 'string' ? body.signature.trim() : '';

  const { dateISO: cleanDateISO, time: cleanTime } = splitDateTime(rawDatetime);
  if (!cleanDateISO || !cleanTime) {
    return res.status(200).json({ success: false, message: 'Не удалось распознать дату и время брони (datetime).' });
  }

  if (!verifyExtraRealitySignature(rawDatetime, providedSignature)) {
    console.error(
      'ExtraReality cancel: signature check failed — cancellation refused. ' +
      `datetime=${rawDatetime} uid=${cleanUid}`
    );
    return res.status(200).json({ success: false, message: 'Ошибка проверки подписи.' });
  }

  const hashKey = `bookings:${cleanDateISO}`;
  const existingRaw = await kv('hget', hashKey, cleanTime);
  if (!existingRaw) {
    // Nothing there any more (already cancelled/moved on our side) — the
    // slot ExtraReality wants cancelled is already free, so this counts as
    // success rather than an error.
    return res.status(200).json({ success: true });
  }

  let existing;
  try { existing = JSON.parse(existingRaw); } catch { existing = null; }

  // Safety check: only cancel a booking that's actually tagged as coming
  // from ExtraReality, and — when both sides have a uid to compare — only
  // if it's the SAME booking. This stops a cancel request from deleting an
  // unrelated booking (a different channel, or a newer booking) that
  // happens to now occupy the same date/time slot.
  const expectedRef = cleanUid ? `extrareality:${cleanUid}` : '';
  const refMismatch = expectedRef && existing && existing.externalRef && existing.externalRef !== expectedRef;
  if (!existing || existing.channel !== 'ExtraReality' || refMismatch) {
    console.error(
      'ExtraReality cancel: slot does not match an ExtraReality booking with this uid — ignoring. ' +
      `dateISO=${cleanDateISO} time=${cleanTime} uid=${cleanUid} ` +
      `existingChannel=${existing && existing.channel} existingRef=${existing && existing.externalRef}`
    );
    return res.status(200).json({ success: false, message: 'Бронь с таким uid не найдена.' });
  }

  await kv('hdel', hashKey, cleanTime);
  await Promise.all([cancelReminder(existing), cancelGameCloseout(existing)]);

  const cancelledAt = new Date().toISOString();
  const cancelled = { ...existing, status: 'cancelled', cancelledAt, cancelledVia: 'ExtraReality' };
  const historyKey = `history:${cleanDateISO}`;
  const historyField = `${cleanTime}@${Date.now()}`;
  await kv('hset', historyKey, historyField, JSON.stringify(cancelled));
  await kv('expire', historyKey, HISTORY_TTL_SECONDS);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    // 23.09.2026: same date/time-first, bold, no-emoji, day/month/year
    // formatting as the booking notification above — see api/_telegram.js.
    // No same-day urgency note here (that's specific to a NEW booking).
    const fields = [
      `Дата: <b>${escapeTgHtml(formatDateRu(cleanDateISO))}</b>`,
      `Время: <b>${escapeTgHtml(cleanTime)}</b>`,
      existing.name ? `Имя: ${escapeTgHtml(existing.name)}` : null,
      existing.phone ? `Телефон: ${escapeTgHtml(existing.phone)}` : null,
    ].filter((line) => line !== null).join('\n');
    // 23.09.2026: title line always CAPS (owner's request).
    const text = `${'Бронь отменена — ExtraReality'.toUpperCase()}\n\n${fields}`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
    } catch (err) {
      console.error('Failed to notify Telegram about ExtraReality cancellation:', err);
      // Not fatal — the cancellation itself already succeeded above.
    }
  }

  return res.status(200).json({ success: true });
}

async function fetchExtraRealityReviewsLive(questId) {
  const [reviewsRes, ratingRes] = await Promise.all([
    fetch(`https://extrareality.by/api2/reviews?quest_id=${encodeURIComponent(questId)}&quantity=6`),
    fetch(`https://extrareality.by/api2/rating?quest_id=${encodeURIComponent(questId)}&json=1`),
  ]);

  // Reviews are the whole point of this call — if that request itself
  // failed, treat the whole fetch as failed so the caller falls back to
  // the last good cache instead of overwriting it with an empty list. The
  // rating number is a nice-to-have alongside it: if just THAT one fails,
  // still return the reviews, only with rating:null.
  if (!reviewsRes.ok) {
    throw new Error(`ExtraReality reviews endpoint returned HTTP ${reviewsRes.status}`);
  }
  const reviewsJson = await reviewsRes.json();
  const ratingJson = ratingRes.ok ? await ratingRes.json() : null;

  const reviews = Array.isArray(reviewsJson)
    ? reviewsJson
      .filter((r) => r && typeof r.text === 'string' && r.text.trim())
      .map((r) => ({
        id: r.id != null ? r.id : null,
        datetime: typeof r.datetime === 'string' ? r.datetime : '',
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 100) : 'Гость',
        text: String(r.text).trim().slice(0, 600),
        rating: r.rating != null && !Number.isNaN(Number(r.rating)) ? Number(r.rating) : null,
      }))
    : [];

  const rating = ratingJson && ratingJson.rating != null && !Number.isNaN(Number(ratingJson.rating))
    ? Number(ratingJson.rating)
    : null;

  return { reviews, rating, fetchedAt: new Date().toISOString() };
}

async function handleReviews(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let cached = null;
  try {
    const raw = await kv('get', REVIEWS_CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read ExtraReality reviews cache:', err);
  }

  const cacheAgeSeconds = cached && cached.fetchedAt
    ? (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000
    : Infinity;
  const isFresh = cacheAgeSeconds < REVIEWS_MIN_REFRESH_SECONDS;

  const questId = process.env.EXTRAREALITY_QUEST_ID;
  if (!questId) {
    // Not configured yet — serve whatever's cached (normally nothing) so
    // index.html's own script just keeps its static fallback reviews.
    return res.status(200).json({
      success: true,
      reviews: (cached && cached.reviews) || [],
      rating: (cached && cached.rating) || null,
      fetchedAt: (cached && cached.fetchedAt) || null,
    });
  }

  if (isFresh) {
    return res.status(200).json({ success: true, ...cached, cacheHit: true });
  }

  try {
    const fresh = await fetchExtraRealityReviewsLive(questId);
    await kv('set', REVIEWS_CACHE_KEY, JSON.stringify(fresh));
    await kv('expire', REVIEWS_CACHE_KEY, REVIEWS_CACHE_TTL_SECONDS);
    return res.status(200).json({ success: true, ...fresh, cacheHit: false });
  } catch (err) {
    console.error('Failed to fetch fresh ExtraReality reviews — falling back to cache:', err);
    return res.status(200).json({
      success: true,
      reviews: (cached && cached.reviews) || [],
      rating: (cached && cached.rating) || null,
      fetchedAt: (cached && cached.fetchedAt) || null,
      cacheHit: !!cached,
    });
  }
}

export default async function handler(req, res) {
  // CORS — added 22.09.2026. ExtraReality's own "Проверить" button next to
  // the "Расписание"/"Бронь" fields in their settings panel appears to call
  // this URL directly from JavaScript running IN THEIR OWN dashboard page
  // (extrareality.by), not from their server: opening the exact same URL
  // by typing it into a browser's address bar worked fine (a plain 200
  // with valid JSON — that kind of top-level navigation is never subject
  // to CORS), but their "Проверить" button showed a generic "Unsuccessful
  // response from server." That's the classic signature of the browser
  // itself blocking a cross-origin fetch() before it ever reaches our
  // code, because we never sent an Access-Control-Allow-Origin header.
  // Mir Kvestov's own test tool was unaffected by this — CORS only ever
  // applies to requests made by a browser's JavaScript, and their test
  // (per their working 200 response) runs server-side.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    // Preflight — a browser sends this by itself before some cross-origin
    // requests; answering it (the CORS headers above already apply to
    // this response too) is what lets the browser then send the real
    // GET/POST through.
    return res.status(204).end();
  }
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET') {
    if (action === 'reviews') return handleReviews(req, res);
    return handleSchedule(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'cancel') return handleCancel(req, res);
    return handleBook(req, res);
  }
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(200).json({ success: false, message: 'Method not allowed' });
}
