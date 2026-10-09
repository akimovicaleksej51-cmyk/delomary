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
import { escapeTgHtml, formatDateRu, roomUrgencyLead } from './_telegram.js';

// 09.10.2026: сетка брони комнаты — СЕАНСЫ. Каждый сеанс — 1 час, после него
// 30 минут на уборку (гостям об этом не пишем), поэтому сеансы начинаются
// каждые 1,5 часа. Бронь — один или несколько сеансов подряд; если гости
// берут несколько, они не уходят между ними: 2 сеанса с 18:00 = 18:00–20:30,
// 3 сеанса = 18:00–22:00. Платят за сеансы: 2 сеанса = 2 × тариф за час.
// В записи брони `hours` = количество сеансов (оплачиваемых часов).
// Последний сеанс 22:30–23:30.
export const ROOM_STARTS = ['10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30', '21:00', '22:30'];
export const ROOM_SLOTS = ROOM_STARTS; // старое имя — для совместимости
export const ROOM_CLOSE = '23:30';
export const ROOM_CLEANUP_MINUTES = 30;
export const ROOM_SESSION_MINUTES = 60;
export const ROOM_STEP_MINUTES = ROOM_SESSION_MINUTES + ROOM_CLEANUP_MINUTES; // 90
export const ROOM_MAX_HOURS = ROOM_STARTS.length; // до 9 сеансов
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

// "18:00" + 3 hours -> "21:00"; "10:30" + 2 -> "12:30"
export function roomMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
export function roomTime(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
// Конец брони из N сеансов: начало последнего сеанса + 1 час.
// "18:00" + 1 -> "19:00", + 2 -> "20:30", + 3 -> "22:00".
export function endTimeFor(startTime, sessions) {
  return roomTime(roomMin(startTime) + Number(sessions) * ROOM_STEP_MINUTES - ROOM_CLEANUP_MINUTES);
}

// Занятые промежутки дня в минутах: [начало, конец + уборка] для каждой брони.
// Работает и для старых броней (с почасовыми полями) — берёт startTime/endTime.
export function roomBusyIntervals(records, exceptBookingId = '') {
  return (records || [])
    .filter((r) => r && r.bookingId !== exceptBookingId && Number.isFinite(roomMin(r.startTime)) && Number.isFinite(roomMin(r.endTime)))
    .map((r) => [roomMin(r.startTime), roomMin(r.endTime) + ROOM_CLEANUP_MINUTES])
    .sort((a, b) => a[0] - b[0]);
}
// Сколько сеансов подряд можно взять, начав в startTime (0 — нельзя начать).
// Бронь вместе с уборкой после неё не должна задевать другие брони.
export function roomMaxHours(busy, startTime) {
  const s = roomMin(startTime);
  if (!ROOM_STARTS.includes(startTime) || !Number.isFinite(s)) return 0;
  if ((busy || []).some(([bs, be]) => s >= bs && s < be)) return 0;
  let limit = roomMin(ROOM_CLOSE);          // конец брони — не позже закрытия
  (busy || []).forEach(([bs]) => { if (bs > s) limit = Math.min(limit, bs - ROOM_CLEANUP_MINUTES); });
  return Math.max(0, Math.floor((limit - s + ROOM_CLEANUP_MINUTES) / ROOM_STEP_MINUTES));
}
// Получасовые ячейки брони в Redis: от начала до конца + уборка. HSETNX по
// ячейкам не даёт двум одновременным броням занять одно и то же время.
export function roomCells(startTime, sessions) {
  const s = roomMin(startTime), e = s + Number(sessions) * ROOM_STEP_MINUTES;
  const out = [];
  for (let m = s; m < e; m += 30) out.push(roomTime(m));
  return out;
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

// { busy: { 'YYYY-MM-DD': [[startMin, endMin], …] } } for today .. +ROOM_DAYS_AHEAD.
// endMin уже включает 30 минут уборки. Отдаём только ЗАНЯТЫЕ ПРОМЕЖУТКИ,
// никогда — кто забронировал (то же правило приватности, что у api/slots.js).
export async function getRoomAvailability() {
  const dates = windowDates(0, ROOM_DAYS_AHEAD);
  const busyByDate = await roomBusyByDate(dates);
  const busy = {};
  dates.forEach((iso) => { if (busyByDate[iso].length) busy[iso] = busyByDate[iso]; });
  return {
    busy, starts: ROOM_STARTS, close: ROOM_CLOSE, cleanup: ROOM_CLEANUP_MINUTES,
    firstDateISO: dates[0], lastDateISO: dates[dates.length - 1],
  };
}

// Занятые промежутки по датам: { 'YYYY-MM-DD': [[s, e], …] }.
export async function roomBusyByDate(dates) {
  const results = await kvPipeline(dates.map((iso) => ['HGETALL', roomKey(iso)]));
  const out = {};
  dates.forEach((iso, i) => {
    const e = results && results[i];
    out[iso] = roomBusyIntervals(uniqueRoomRecords(e && e.result));
  });
  return out;
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

// Откуда пришла бронь комнаты (поле channel в записи брони):
//   'Сайт'          — форма на loonyroom.html
//   'Телефон', 'Instagram' — менеджер внёс вручную в админке
//   'Мир Квестов', 'ExtraReality' — агрегаторы (api/mirkvestov.js и
//                     api/extrareality.js с параметром ?room=1)
// 09.10.2026: в админке оставлены только «Телефон» и «Instagram».
export const ROOM_ADMIN_CHANNELS = ['Телефон', 'Instagram'];
export const ROOM_AGGREGATOR_CHANNELS = ['Мир Квестов', 'ExtraReality'];
export const ROOM_SOURCES = ['Сайт', ...ROOM_ADMIN_CHANNELS, ...ROOM_AGGREGATOR_CHANNELS];
// Источник брони для статистики. Старые брони, внесённые до 09.10.2026 с
// источником «Telegram» / «Пришли без брони» / «Другое», считаются «Другое».
export function roomSourceOf(rec) {
  const c = rec && rec.channel;
  if (!c) return 'Сайт';
  return ROOM_SOURCES.includes(c) ? c : 'Другое';
}

// Returns { ok:true, record } or { ok:false, status, error, conflict? }.
// Pure validation — touches nothing.
// 09.10.2026: { admin:true } — бронь, добавленная менеджером в админке:
// телефон необязателен, можно задним числом (до месяца назад — чтобы потом
// провести сверку) и без отсечки «за час до начала», цену можно поменять.
export function validateRoomRequest(body, { admin = false } = {}) {
  const name = clean(body.name, 100);
  const phone = clean(body.phone, 40);
  const comment = clean(body.comment, 500);
  const dateISO = typeof body.dateISO === 'string' ? body.dateISO : '';
  const startTime = typeof body.startTime === 'string' ? body.startTime.trim() : '';
  const hours = Number(body.hours);
  const hostGame = typeof body.hostGame === 'string' && HOST_GAMES[body.hostGame] ? body.hostGame : '';

  if (admin) {
    if (!name) return { ok: false, status: 400, error: 'Укажите имя гостя.' };
    if (phone && (phone.match(/\d/g) || []).length < 7) return { ok: false, status: 400, error: 'Проверьте номер телефона.' };
  } else {
    if (!name || !phone) return { ok: false, status: 400, error: 'Укажите имя и телефон.' };
    if ((phone.match(/\d/g) || []).length < 9) return { ok: false, status: 400, error: 'Проверьте номер телефона.' };
  }
  if (!isRealCalendarDate(dateISO)) return { ok: false, status: 400, error: 'Некорректная дата.' };
  if (dateISO > lastBookableISO()) {
    return { ok: false, status: 400, error: admin
      ? `Брони комнаты открыты на ${ROOM_DAYS_AHEAD} дней вперёд — эта дата пока дальше.`
      : 'На эту дату онлайн-бронь ещё не открыта — позвоните нам: +375 (29) 176-19-84.' };
  }
  if (admin && dateISO < windowDates(-31, 1)[0]) {
    return { ok: false, status: 400, error: 'Задним числом можно добавить бронь не раньше, чем месяц назад.' };
  }

  if (!ROOM_STARTS.includes(startTime)) return { ok: false, status: 400, error: 'Некорректное время.' };
  if (!Number.isInteger(hours) || hours < 1 || roomMin(endTimeFor(startTime, hours)) > roomMin(ROOM_CLOSE)) {
    return { ok: false, status: 400, error: 'Некорректная продолжительность.' };
  }
  const times = roomCells(startTime, hours);

  // Same hour-before cutoff as the quest (api/_time.js) — checking the
  // FIRST hour is enough, every later one starts even later.
  if (!admin && isSlotClosingSoon(dateISO, startTime)) {
    return {
      ok: false, status: 409, conflict: true,
      error: 'Онлайн-бронь этого времени уже закрыта — до начала меньше часа. Позвоните нам: +375 (29) 176-19-84.',
    };
  }

  const rate = roomRateFor(dateISO);
  const attribution = admin ? {} : cleanAttribution(body.attribution);
  // Admin may set its own price (discount, deal by phone); empty -> by the rate.
  let price = rate * hours;
  if (admin && body.price !== undefined && String(body.price).trim() !== '') {
    const p = Number(String(body.price).replace(',', '.').trim());
    if (!Number.isFinite(p) || p < 0 || p > 100000) return { ok: false, status: 400, error: 'Проверьте цену.' };
    price = Math.round(p * 100) / 100;
  }
  const channel = admin
    ? (ROOM_ADMIN_CHANNELS.includes(body.channel) ? body.channel : 'Телефон')
    : 'Сайт';
  const record = {
    type: 'room',
    room: ROOM_NAME,
    bookingId: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    phone,
    comment,
    dateISO,
    startTime,
    endTime: endTimeFor(startTime, hours),
    hours,      // количество сеансов (оплачиваемых часов)
    sessions: hours,
    times,
    rate,
    price, // the room only — a hosted game is priced separately by phone
    hostGame,
    hostGameLabel: hostGame ? HOST_GAMES[hostGame] : '',
    channel,
    attribution,
    createdAt: new Date().toISOString(),
  };
  if (admin) record.createdBy = 'admin';
  return { ok: true, record };
}

// Reserves every hour of the booking atomically-enough: HSETNX hour by hour,
// and if ANY hour turns out to be taken (or KV hiccups), releases the ones
// this request already grabbed. Returns { ok:true } / { ok:false, status, error, conflict? }.
export async function reserveRoomHours(record) {
  const key = roomKey(record.dateISO);
  const value = JSON.stringify(record);
  // 09.10.2026: сначала — пересечение с уже существующими бронями (с учётом
  // 30 минут уборки), в том числе старыми почасовыми, у которых другие ячейки.
  const existing = await kv('hgetall', key);
  if (Array.isArray(existing) && existing.length) {
    const busy = roomBusyIntervals(uniqueRoomRecords(existing), record.bookingId);
    if (roomMaxHours(busy, record.startTime) < Number(record.hours)) {
      return { ok: false, status: 409, conflict: true, error: 'Это время уже занято — выберите другое.' };
    }
  }
  const grabbed = [];
  for (const t of record.times) {
    // eslint-disable-next-line no-await-in-loop
    const added = await kv('hsetnx', key, t, value);
    if (added === 1) { grabbed.push(t); continue; }
    if (grabbed.length) await kv('hdel', key, ...grabbed);
    if (added === 0) {
      return { ok: false, status: 409, conflict: true, error: 'Это время уже занято — выберите другое.' };
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
    Number(record.price) === record.rate * record.hours
      ? `Цена: ${record.price} Br (${hoursLabel(record.hours)} × ${record.rate} Br)`
      : `Цена: ${record.price} Br (договорная; по тарифу было бы ${record.rate * record.hours} Br)`,
    record.createdBy === 'admin' || ROOM_AGGREGATOR_CHANNELS.includes(record.channel) ? `Откуда: ${escapeTgHtml(record.channel || '')}` : null,
    record.email ? `Email: ${escapeTgHtml(record.email)}` : null,
    record.comment ? `Комментарий: ${escapeTgHtml(record.comment)}` : null,
    attributionLabel(record.attribution || {}) ? `Источник: ${escapeTgHtml(attributionLabel(record.attribution))}` : null,
  ].filter((l) => l !== null).join('\n');
  // Same-day urgency lead first, exactly like a new quest booking.
  const title = record.createdBy === 'admin' ? 'Новая бронь — Loony Room (добавлена в админке)'
    : ROOM_AGGREGATOR_CHANNELS.includes(record.channel) ? `Новая бронь — Loony Room · ${record.channel}`
      : 'Новая бронь — Loony Room';
  return `${roomUrgencyLead(record.dateISO, record.startTime)}${title.toUpperCase()}\n\n${fields}`;
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

export function roomCancelTelegramText(record, via = '') {
  const fields = [
    `Дата: <b>${escapeTgHtml(formatDateRu(record.dateISO))}</b>`,
    `Время: <b>${escapeTgHtml(record.startTime)}–${escapeTgHtml(record.endTime)}</b>`,
    record.name ? `Имя: ${escapeTgHtml(record.name)}` : null,
    record.phone ? `Телефон: ${escapeTgHtml(record.phone)}` : null,
    via ? `Отменено через: ${escapeTgHtml(via)}` : null,
  ].filter((l) => l !== null).join('\n');
  return `${'Бронь Loony Room отменена'.toUpperCase()}\n\n${fields}`;
}

// ---------- 09.10.2026: агрегаторы (Мир Квестов, ExtraReality) ----------
//
// Почва для синхронизации брони комнаты с агрегаторами. Включается, когда
// агрегатору дают отдельный адрес для комнаты (с ?room=1) — см. шапки
// api/mirkvestov.js и api/extrareality.js. Пока этот адрес никому не дан,
// код просто не вызывается.
//
// Агрегаторы мыслят «сеансами»: время начала + цена. У комнаты почасовая
// аренда, поэтому:
//   - расписание: каждое время сетки (10:30 … 22:30), is_free = можно начать хотя бы на 1 час;
//     price = цена за 1 час; дополнительно — варианты «1 час / 2 часа / …»
//     до следующей занятой брони или закрытия (тарифы у Мира Квестов,
//     extraPrices у ExtraReality);
//   - бронь: сколько часов, берём из выбранного тарифа («3 часа: 210 Br»),
//     поля hours/duration, если агрегатор их пришлёт, или из цены (цена /
//     тариф за час); иначе 1 час.

function hoursWordRu(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} час`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} часа`;
  return `${n} часов`;
}

// Варианты для одного времени начала: [{ hours, label, price }], label —
// «1 час · до 19:00», «2 часа · до 20:30» (агрегатор вернёт его в тарифе).
export function roomPackagesFor(dateISO, startTime, busy) {
  const rate = roomRateFor(dateISO);
  const max = roomMaxHours(busy, startTime);
  return Array.from({ length: max }, (_, i) => ({ hours: i + 1, label: `${hoursWordRu(i + 1)} · до ${endTimeFor(startTime, i + 1)}`, price: rate * (i + 1) }));
}

// Расписание для агрегатора: одна запись на каждое время начала из сетки.
export async function roomAggregatorSchedule(daysAhead, now = new Date()) {
  const dates = windowDates(0, Math.min(daysAhead, ROOM_DAYS_AHEAD));
  const busyByDate = await roomBusyByDate(dates);
  const out = [];
  for (const dateISO of dates) {
    const t = busyByDate[dateISO] || [];
    for (const time of ROOM_STARTS) {
      const free = roomMaxHours(t, time) > 0 && !isSlotClosingSoon(dateISO, time, now);
      out.push({
        date: dateISO,
        time,
        is_free: free,
        price: roomRateFor(dateISO),
        packages: free ? roomPackagesFor(dateISO, time, t) : [],
      });
    }
  }
  return out;
}

// Сколько часов хочет гость, по тому, что прислал агрегатор.
export function aggregatorHours({ hours, duration, tariff, price }, dateISO) {
  const asInt = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
  const h = asInt(hours);
  if (Number.isInteger(h) && h >= 1 && h <= ROOM_MAX_HOURS) return h;
  const d = asInt(duration);
  if (Number.isFinite(d) && d > 0) {
    // минуты (18:00–20:30 = 150 мин = 2 сеанса) или число часов/сеансов
    const fromDur = d > ROOM_MAX_HOURS ? Math.round((d + ROOM_CLEANUP_MINUTES) / ROOM_STEP_MINUTES) : Math.round(d);
    if (fromDur >= 1 && fromDur <= ROOM_MAX_HOURS) return fromDur;
  }
  const m = typeof tariff === 'string' ? tariff.match(/(\d+)\s*ч/i) : null;
  if (m) { const n = Number(m[1]); if (n >= 1 && n <= ROOM_MAX_HOURS) return n; }
  const p = asInt(price);
  const rate = roomRateFor(dateISO);
  if (Number.isFinite(p) && p >= rate) { const n = Math.round(p / rate); if (n >= 1 && n <= ROOM_MAX_HOURS) return n; }
  return 1;
}

// Новая бронь комнаты от агрегатора. Проверки — те же, что у сайта
// (validateRoomRequest), плюс защита от повтора: если агрегатор прислал
// ту же бронь второй раз (тот же externalRef), отвечаем «ок» и не дублируем.
// Возвращает { ok:true, record, duplicate? } или { ok:false, message }.
export async function createAggregatorRoomBooking({ channel, name, phone, email, comment, dateISO, startTime, hours, price, externalRef }) {
  if (!ROOM_AGGREGATOR_CHANNELS.includes(channel)) return { ok: false, message: 'Неизвестный источник.' };
  if (externalRef && isRealCalendarDate(dateISO)) {
    const same = uniqueRoomRecords(await kv('hgetall', roomKey(dateISO))).find((r) => r.externalRef === externalRef);
    if (same) return { ok: true, record: same, duplicate: true };
  }
  const checked = validateRoomRequest({ name, phone, comment, dateISO, startTime, hours });
  if (!checked.ok) return { ok: false, message: checked.error };
  const record = checked.record;
  record.channel = channel;
  record.attribution = {};
  if (email) record.email = String(email).trim().slice(0, 100);
  if (externalRef) record.externalRef = externalRef;
  const p = Number(String(price == null ? '' : price).replace(',', '.'));
  if (Number.isFinite(p) && p > 0 && p <= 100000) record.price = Math.round(p * 100) / 100;
  const reserved = await reserveRoomHours(record);
  if (!reserved.ok) return { ok: false, message: reserved.conflict ? 'Указанное время занято' : (reserved.error || 'Внутренняя ошибка, попробуйте ещё раз.') };
  if (reserved.unreserved) return { ok: false, message: 'Бронирование временно недоступно, попробуйте позже.' };
  // Telegram — это то, как владелец узнаёт о брони; не дошло — откатываем, как у сайта.
  const sent = await sendRoomTelegram(roomBookingTelegramText(record));
  if (!sent.ok) {
    await releaseRoomHours(record);
    return { ok: false, message: 'Внутренняя ошибка, попробуйте ещё раз.' };
  }
  return { ok: true, record };
}

// Отмена брони комнаты по номеру брони агрегатора. Возвращает отменённую
// запись или null (не нашли — значит уже отменена или это чужая бронь).
export async function cancelRoomByExternalRef(dateISO, externalRef) {
  if (!isRealCalendarDate(dateISO) || !externalRef) return null;
  const rec = uniqueRoomRecords(await kv('hgetall', roomKey(dateISO))).find((r) => r.externalRef === externalRef);
  if (!rec) return null;
  return cancelRoomBooking(dateISO, rec.bookingId);
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
