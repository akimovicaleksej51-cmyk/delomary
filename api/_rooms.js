// Loony Room — hourly room rental (added 03.10.2026, owner's request).
//
// Everything about room bookings lives here: the hourly grid, prices, the
// optional hosted game, storage, availability, and the Telegram message.
// Not a route — Vercel ignores files starting with "_". It's reached through
// two EXISTING functions instead of a new one, because the project is
// already at the Vercel Hobby-plan limit of 12 serverless functions:
//   - api/lead.js        — public side: availability (GET) + new booking (POST)
//   - api/admin/bookings.js — admin side: list + cancel
//
// Storage is deliberately SEPARATE from the quest's own `bookings:<date>`
// hashes — the quest's admin list, Касса/Финансы, reports, reminders, the
// aggregators' schedules and api/slots.js all read `bookings:*`, and a room
// rental must never show up as a quest game in any of them. Room bookings go
// into `roombookings:<date>`: one hash field per occupied HOUR ("14:00"),
// whose value is the whole booking's JSON (same record repeated on every
// hour it covers, tied together by `bookingId`). Reserving hour-by-hour with
// HSETNX keeps two overlapping requests from both winning, exactly like the
// quest's per-slot HSETNX in api/book.js.
//
// If a price or the hours ever change, change ROOM_* below AND the matching
// constants at the top of loonyroom.html's script (static page, can't import
// this file) — same convention as api/_pricing.js vs index.html.

import { kv, kvPipeline, isKvConfigured } from './_kv.js';
import { isSlotClosingSoon, businessToday } from './_time.js';
import { isWeekendISO } from './_pricing.js';
import { escapeTgHtml, formatDateRu, urgencyLead } from './_telegram.js';

// 10:00 … 22:00 — 13 one-hour slots; the 22:00 slot runs until 23:00.
export const ROOM_SLOTS = Array.from({ length: 13 }, (_, i) => `${String(10 + i).padStart(2, '0')}:00`);
export const ROOM_RATE_WEEKDAY = 70; // Br per hour, Mon–Fri
export const ROOM_RATE_WEEKEND = 90; // Br per hour, Sat–Sun (same weekend rule as the quest)
export const ROOM_DAYS_AHEAD = 60;   // how far ahead the online calendar goes
export const ROOM_NAME = 'Loony Room';

// Optional add-on: a hosted party game. Its price isn't set yet, so it's
// never added to the total — the admin confirms it by phone.
export const HOST_GAMES = {
  mafia: 'Мафия с ведущим',
  bunker: 'Бункер с ведущим',
};

const ROOM_TTL_SECONDS = 60 * 60 * 24 * 90;

export function roomRateFor(dateISO) {
  return isWeekendISO(dateISO) ? ROOM_RATE_WEEKEND : ROOM_RATE_WEEKDAY;
}

export function roomKey(dateISO) {
  return `roombookings:${dateISO}`;
}

// "14:00" + 3 hours -> "17:00"
export function endTimeFor(startTime, hours) {
  const h = Number(String(startTime).slice(0, 2)) + Number(hours);
  return `${String(h).padStart(2, '0')}:00`;
}

function isRealCalendarDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function windowDates(fromOffset, count) {
  const today = businessToday();
  const out = [];
  for (let i = fromOffset; i < fromOffset + count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push(isoDate(d));
  }
  return out;
}

function lastBookableISO() {
  return windowDates(ROOM_DAYS_AHEAD - 1, 1)[0];
}

// ---------- public: availability ----------

// { 'YYYY-MM-DD': ['14:00', '15:00', …taken hours] } for today .. +ROOM_DAYS_AHEAD.
// Only ever exposes WHICH hours are taken (HKEYS), never who booked them —
// same privacy rule as api/slots.js for the quest.
export async function getRoomAvailability() {
  const dates = windowDates(0, ROOM_DAYS_AHEAD);
  const results = await kvPipeline(dates.map((iso) => ['HKEYS', roomKey(iso)]));
  const taken = {};
  (results || []).forEach((entry, i) => {
    const list = entry && Array.isArray(entry.result) ? entry.result : [];
    if (list.length) taken[dates[i]] = list.filter((t) => ROOM_SLOTS.includes(t)).sort();
  });
  return { taken, slots: ROOM_SLOTS, firstDateISO: dates[0], lastDateISO: dates[dates.length - 1] };
}

// ---------- public: validation + booking ----------

function clean(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

function cleanAttribution(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const pick = (k, max) => (typeof a[k] === 'string' ? a[k].trim().slice(0, max) : '');
  return {
    utmSource: pick('utm_source', 100),
    utmMedium: pick('utm_medium', 100),
    utmCampaign: pick('utm_campaign', 150),
    gclid: pick('gclid', 150),
    fbclid: pick('fbclid', 150),
  };
}

function attributionLabel(a) {
  const parts = [a.utmSource, a.utmMedium, a.utmCampaign].filter(Boolean);
  if (parts.length) return parts.join(' / ');
  if (a.gclid) return 'клик по рекламе Google (gclid)';
  if (a.fbclid) return 'клик по рекламе Meta (fbclid)';
  return '';
}

function hoursLabel(n) {
  return `${n} ч`;
}

// Returns { ok:true, record } or { ok:false, status, error, conflict? }.
// Pure validation — touches nothing.
export function validateRoomRequest(body) {
  const name = clean(body.name, 100);
  const phone = clean(body.phone, 40);
  const comment = clean(body.comment, 500);
  const dateISO = typeof body.dateISO === 'string' ? body.dateISO : '';
  const startTime = typeof body.startTime === 'string' ? body.startTime.trim() : '';
  const hours = Number(body.hours);
  const hostGame = typeof body.hostGame === 'string' && HOST_GAMES[body.hostGame] ? body.hostGame : '';

  if (!name || !phone) return { ok: false, status: 400, error: 'Укажите имя и телефон.' };
  if ((phone.match(/\d/g) || []).length < 9) return { ok: false, status: 400, error: 'Проверьте номер телефона.' };
  if (!isRealCalendarDate(dateISO)) return { ok: false, status: 400, error: 'Некорректная дата.' };
  if (dateISO > lastBookableISO()) return { ok: false, status: 400, error: 'На эту дату онлайн-бронь ещё не открыта — позвоните нам: +375 (29) 176-19-84.' };

  const startIdx = ROOM_SLOTS.indexOf(startTime);
  if (startIdx === -1) return { ok: false, status: 400, error: 'Некорректное время.' };
  if (!Number.isInteger(hours) || hours < 1 || startIdx + hours > ROOM_SLOTS.length) {
    return { ok: false, status: 400, error: 'Некорректная продолжительность.' };
  }
  const times = ROOM_SLOTS.slice(startIdx, startIdx + hours);

  // Same hour-before cutoff as the quest (api/_time.js) — checking the
  // FIRST hour is enough, every later one starts even later.
  if (isSlotClosingSoon(dateISO, times[0])) {
    return {
      ok: false, status: 409, conflict: true,
      error: 'Онлайн-бронь этого времени уже закрыта — до начала меньше часа. Позвоните нам: +375 (29) 176-19-84.',
    };
  }

  const rate = roomRateFor(dateISO);
  const attribution = cleanAttribution(body.attribution);
  const record = {
    type: 'room',
    room: ROOM_NAME,
    bookingId: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    phone,
    comment,
    dateISO,
    startTime: times[0],
    endTime: endTimeFor(times[0], hours),
    hours,
    times,
    rate,
    price: rate * hours, // the room only — a hosted game is priced separately by phone
    hostGame,
    hostGameLabel: hostGame ? HOST_GAMES[hostGame] : '',
    channel: 'Сайт',
    attribution,
    createdAt: new Date().toISOString(),
  };
  return { ok: true, record };
}

// Reserves every hour of the booking atomically-enough: HSETNX hour by hour,
// and if ANY hour turns out to be taken (or KV hiccups), releases the ones
// this request already grabbed. Returns { ok:true } / { ok:false, status, error, conflict? }.
export async function reserveRoomHours(record) {
  const key = roomKey(record.dateISO);
  const value = JSON.stringify(record);
  const grabbed = [];
  for (const t of record.times) {
    // eslint-disable-next-line no-await-in-loop
    const added = await kv('hsetnx', key, t, value);
    if (added === 1) { grabbed.push(t); continue; }
    if (grabbed.length) await kv('hdel', key, ...grabbed);
    if (added === 0) {
      return { ok: false, status: 409, conflict: true, error: `Время ${t} уже занято — выберите другие часы.` };
    }
    if (isKvConfigured()) {
      return { ok: false, status: 503, error: 'Временные неполадки с сервером. Попробуйте ещё раз через минуту.' };
    }
    return { ok: true, unreserved: true }; // KV not connected at all — same fallback as api/book.js
  }
  await kv('expire', key, ROOM_TTL_SECONDS);
  return { ok: true };
}

export async function releaseRoomHours(record) {
  if (record && record.times && record.times.length) {
    await kv('hdel', roomKey(record.dateISO), ...record.times);
  }
}

export function roomBookingTelegramText(record) {
  const fields = [
    `Дата: <b>${escapeTgHtml(formatDateRu(record.dateISO))}</b>`,
    `Время: <b>${escapeTgHtml(record.startTime)}–${escapeTgHtml(record.endTime)}</b> (${hoursLabel(record.hours)})`,
    `Имя: ${escapeTgHtml(record.name)}`,
    `Телефон: ${escapeTgHtml(record.phone)}`,
    record.hostGameLabel ? `Доп. опция: ${escapeTgHtml(record.hostGameLabel)} (цену уточнить)` : null,
    `Цена: ${record.price} Br (${hoursLabel(record.hours)} × ${record.rate} Br)`,
    record.comment ? `Комментарий: ${escapeTgHtml(record.comment)}` : null,
    attributionLabel(record.attribution || {}) ? `Источник: ${escapeTgHtml(attributionLabel(record.attribution))}` : null,
  ].filter((l) => l !== null).join('\n');
  // Same-day urgency lead first, exactly like a new quest booking.
  return `${urgencyLead(record.dateISO, record.startTime)}${'Новая бронь — Loony Room'.toUpperCase()}\n\n${fields}`;
}

export async function sendRoomTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error('Loony Room: Telegram API error:', data);
    return { ok: !!data.ok };
  } catch (err) {
    console.error('Loony Room: failed to reach Telegram API:', err);
    return { ok: false };
  }
}

// ---------- admin: list + cancel ----------

// Every room booking from a week ago to ROOM_DAYS_AHEAD out, one entry per
// booking (not per hour), sorted by date then start time.
export async function listRoomBookings() {
  // 09.10.2026: месяц назад (было неделя) — чтобы можно было провести сверку
  // по прошедшим броням комнаты
  const dates = windowDates(-31, 31 + ROOM_DAYS_AHEAD);
  const results = await kvPipeline(dates.map((iso) => ['HGETALL', roomKey(iso)]));
  const byId = new Map();
  (results || []).forEach((entry) => {
    const raw = entry && Array.isArray(entry.result) ? entry.result : [];
    for (let i = 0; i < raw.length - 1; i += 2) {
      try {
        const rec = JSON.parse(raw[i + 1]);
        if (rec && rec.bookingId && !byId.has(rec.bookingId)) byId.set(rec.bookingId, rec);
      } catch { /* skip malformed */ }
    }
  });
  return [...byId.values()].sort((a, b) =>
    (a.dateISO + a.startTime).localeCompare(b.dateISO + b.startTime));
}

// Frees every hour that belongs to `bookingId` on that date (only fields
// whose stored record really carries that id — never a different booking's
// hour). Returns the cancelled record, or null if nothing matched.
export async function cancelRoomBooking(dateISO, bookingId) {
  if (!isRealCalendarDate(dateISO) || typeof bookingId !== 'string' || !bookingId) return null;
  const key = roomKey(dateISO);
  const raw = await kv('hgetall', key);
  if (!Array.isArray(raw)) return null;
  const fields = [];
  let record = null;
  for (let i = 0; i < raw.length - 1; i += 2) {
    try {
      const rec = JSON.parse(raw[i + 1]);
      if (rec && rec.bookingId === bookingId) { fields.push(raw[i]); record = record || rec; }
    } catch { /* skip */ }
  }
  if (!fields.length) return null;
  await kv('hdel', key, ...fields);
  return record;
}

export function roomCancelTelegramText(record) {
  const fields = [
    `Дата: <b>${escapeTgHtml(formatDateRu(record.dateISO))}</b>`,
    `Время: <b>${escapeTgHtml(record.startTime)}–${escapeTgHtml(record.endTime)}</b>`,
    record.name ? `Имя: ${escapeTgHtml(record.name)}` : null,
    record.phone ? `Телефон: ${escapeTgHtml(record.phone)}` : null,
  ].filter((l) => l !== null).join('\n');
  return `${'Бронь Loony Room отменена'.toUpperCase()}\n\n${fields}`;
}


// ---------- 09.10.2026: сверка по комнате + деньги комнаты в Кассе/Бухгалтерии ----------
//
// Сверка хранится прямо в записи брони (она лежит копией на каждом часе —
// поэтому переписываются все часы этой брони сразу):
//   closeout: { done:true, played, at, responsible, note, priceBefore? }
//   price, payCash, payCard, payErip — как у брони квеста.
// played:false («не состоялась») — денег нет, способы оплаты очищаются.

// Уникальные брони комнаты из ответа HGETALL (по bookingId).
export function uniqueRoomRecords(hgetallResult) {
  const raw = Array.isArray(hgetallResult) ? hgetallResult : [];
  const byId = new Map();
  for (let i = 0; i < raw.length - 1; i += 2) {
    try {
      const rec = JSON.parse(raw[i + 1]);
      if (rec && rec.bookingId && !byId.has(rec.bookingId)) byId.set(rec.bookingId, rec);
    } catch { /* skip */ }
  }
  return [...byId.values()];
}

// Деньги, которые реально пришли за комнату (0, если игра «не состоялась»).
export function roomPaid(rec) {
  const n = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(x) ? x : 0; };
  if (!rec || (rec.closeout && rec.closeout.played === false)) return { cash: 0, card: 0, erip: 0 };
  return { cash: n(rec.payCash), card: n(rec.payCard), erip: n(rec.payErip) };
}

async function rewriteRoomBooking(dateISO, bookingId, mutate) {
  if (!isRealCalendarDate(dateISO) || typeof bookingId !== 'string' || !bookingId) return null;
  const key = roomKey(dateISO);
  const raw = await kv('hgetall', key);
  if (!Array.isArray(raw)) return null;
  const fields = [];
  let record = null;
  for (let i = 0; i < raw.length - 1; i += 2) {
    try {
      const rec = JSON.parse(raw[i + 1]);
      if (rec && rec.bookingId === bookingId) { fields.push(raw[i]); record = record || rec; }
    } catch { /* skip */ }
  }
  if (!record) return null;
  const updated = mutate({ ...record });
  const args = [];
  fields.forEach((f) => { args.push(f, JSON.stringify(updated)); });
  await kv('hset', key, ...args);
  return updated;
}

export async function setRoomCloseout(dateISO, bookingId, { played, price, payCash, payCard, payErip, responsible, note } = {}) {
  const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
  return rewriteRoomBooking(dateISO, bookingId, (rec) => {
    const wasPlayed = played !== false;
    const prev = rec.closeout && rec.closeout.done ? rec.closeout : null;
    const closeout = {
      done: true,
      played: wasPlayed,
      at: new Date().toISOString(),
      responsible: clean(responsible, 60) || (prev ? prev.responsible : '') || '',
      note: clean(note, 300),
    };
    if (prev && Object.prototype.hasOwnProperty.call(prev, 'priceBefore')) closeout.priceBefore = prev.priceBefore;
    const nextPrice = wasPlayed && price != null && String(price).trim() !== '' ? clean(price, 12) : String(rec.price);
    if (!closeout.priceBefore && nextPrice !== String(rec.price)) closeout.priceBefore = rec.price;
    rec.closeout = closeout;
    if (wasPlayed) {
      rec.price = nextPrice;
      rec.payCash = clean(payCash, 12);
      rec.payCard = clean(payCard, 12);
      rec.payErip = clean(payErip, 12);
    } else {
      rec.payCash = ''; rec.payCard = ''; rec.payErip = '';
    }
    return rec;
  });
}

export async function cancelRoomCloseout(dateISO, bookingId) {
  return rewriteRoomBooking(dateISO, bookingId, (rec) => {
    if (rec.closeout && Object.prototype.hasOwnProperty.call(rec.closeout, 'priceBefore')) rec.price = rec.closeout.priceBefore;
    delete rec.closeout;
    rec.payCash = ''; rec.payCard = ''; rec.payErip = '';
    return rec;
  });
}
