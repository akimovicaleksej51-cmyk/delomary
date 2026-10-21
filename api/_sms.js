// SMS-квитанции клиенту через RocketSMS (rocketsms.by).
//
// 20.10.2026 (обновление 122): переведено на актуальное API RocketSMS
// v1.5.0 (адреса https://api.rocketsms.by/simple/...; старый /json/send из
// первой версии в новой документации больше не описан), альфа-имя по
// умолчанию — LOONY.BY (одобрено), квитанции снова включены. Добавлены:
// квитанция для броней комнаты отдыха с сайта, проверка баланса/альфа-имени
// и тестовая SMS для админки (действия smsInfo / smsTest в
// api/admin/bookings.js).
//
// Это квитанция «заявка принята», а не «бронь подтверждена»: администратор
// всё так же перезванивает клиенту, поэтому в тексте «Скоро позвоним».
//
// Переменные окружения (Vercel → Project → Settings → Environment Variables):
//   ROCKETSMS_LOGIN    — логин личного кабинета cab.rocketsms.by (обычно УНП)
//   ROCKETSMS_PASSWORD — пароль от кабинета В ОТКРЫТОМ ВИДЕ (md5 считается
//                        здесь же, перед каждым запросом)
//   ROCKETSMS_SENDER   — необязательно: другое альфа-имя вместо LOONY.BY
//
// Если логина/пароля нет — SMS просто не уходят (пишется в лог), брони
// работают как обычно. Любая ошибка RocketSMS никогда не ломает бронь.

import crypto from 'crypto';
import { kv, isKvConfigured } from './_kv.js';

export const ROCKETSMS_BASE = 'https://api.rocketsms.by/simple';
export const DEFAULT_SENDER = 'LOONY.BY';
export const SMS_PHONE = '+375291761984';
export const QUEST_TITLE = 'Дело Мэри. Скажи им, что я здесь';
const TIMEOUT_MS = 8000;

// Выключатель всех SMS-квитанций одним флагом (тестовая SMS из админки
// работает независимо от него).
export const SMS_RECEIPTS_ENABLED = true;

// Любой ввод телефона → "375XXXXXXXXX" (без "+", скобок, пробелов).
export function normalizePhoneForRocketSms(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('375')) return digits;
  if (digits.startsWith('80')) return '375' + digits.slice(2);
  if (digits.startsWith('0')) return '375' + digits.slice(1);
  if (digits.length === 9) return '375' + digits;
  return digits;
}

export function isValidByPhone(phone) {
  return /^375\d{9}$/.test(phone);
}

export function smsSender() {
  return (process.env.ROCKETSMS_SENDER || '').trim() || DEFAULT_SENDER;
}

export function isSmsConfigured() {
  return !!(process.env.ROCKETSMS_LOGIN && process.env.ROCKETSMS_PASSWORD);
}

// Сколько платных частей займёт текст. Кириллица → UCS-2: 70 символов в
// одной SMS, 67 в каждой части длинной. Латиница (GSM-7): 160 / 153.
export function smsParts(text) {
  const s = String(text || '');
  const unicode = /[^\x00-\x7F]/.test(s);
  const len = [...s].length;
  const [one, many] = unicode ? [70, 67] : [160, 153];
  if (len === 0) return 0;
  return len <= one ? 1 : Math.ceil(len / many);
}

function authParams() {
  const login = process.env.ROCKETSMS_LOGIN;
  const password = process.env.ROCKETSMS_PASSWORD;
  if (!login || !password) return null;
  return { username: login, password: crypto.createHash('md5').update(password).digest('hex') };
}

// Один запрос к RocketSMS. Параметры идут строкой запроса (для POST — в теле
// как form-urlencoded), как требует документация. Возвращает
// { ok, data } или { ok:false, error }.
async function rocketCall(path, params = {}, method = 'POST') {
  const auth = authParams();
  if (!auth) return { ok: false, error: 'NOT_CONFIGURED' };
  const qs = new URLSearchParams({ ...auth, ...params });
  const url = `${ROCKETSMS_BASE}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = method === 'GET'
      ? await fetch(`${url}?${qs.toString()}`, { signal: controller.signal })
      : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs.toString(),
        signal: controller.signal,
      });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* иногда отвечает текстом */ }
    if (!data) return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
    if (data && !Array.isArray(data) && data.error) return { ok: false, error: String(data.error), data };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'TIMEOUT' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Отправка одной SMS. { ok, id, status, cost } или { ok:false, error }.
export async function sendSms(rawPhone, text) {
  const phone = normalizePhoneForRocketSms(rawPhone);
  if (!isValidByPhone(phone)) return { ok: false, error: 'BAD_PHONE' };
  const out = await rocketCall('send', { phone, text, sender: smsSender() });
  if (!out.ok) return out;
  const d = out.data || {};
  if (d.status === 'FAILED') return { ok: false, error: 'FAILED', id: d.id };
  return { ok: true, id: d.id, status: d.status, cost: d.cost || null };
}

const pad = (n) => String(n).padStart(2, '0');

// "31.10"; для ночных сеансов (до 06:00) — "ночь 30/31.10", чтобы клиент
// не перепутал дату.
export function smsDateLabel(dateISO, time = '') {
  const [y, m, d] = String(dateISO || '').split('-').map(Number);
  if (!y || !m || !d) return String(dateISO || '');
  const hh = Number(String(time).split(':')[0]);
  if (time && hh >= 0 && hh < 6) {
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    const sameMonth = prev.getUTCMonth() === m - 1;
    return sameMonth
      ? `ночь ${prev.getUTCDate()}/${d}.${pad(m)}`
      : `ночь ${prev.getUTCDate()}.${pad(prev.getUTCMonth() + 1)}/${d}.${pad(m)}`;
  }
  return `${pad(d)}.${pad(m)}`;
}

// 21.10.2026: текст владельца — один и тот же для заявки с сайта, с
// агрегаторов и для брони из админки. Выходит 3 SMS (кириллица, 67 знаков
// в части длинного сообщения).
export const QUEST_ADDRESS = 'Адрес ул. Октябрьская 16/23.';
export function questReceiptText(record) {
  const when = smsDateLabel(record.dateISO, record.time);
  const details = [];
  if (record.players) details.push(String(record.players));
  if (record.price) details.push(`${record.price} Br`);
  return `Квест «${QUEST_TITLE}»: бронирование на ${when} в ${record.time} принято`
    + (details.length ? ` (${details.join(', ')})` : '')
    + `. ${SMS_PHONE}\n${QUEST_ADDRESS}`;
}

function sessionsWord(n) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'сеанс';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'сеанса';
  return 'сеансов';
}

export function roomReceiptText(record) {
  const when = smsDateLabel(record.dateISO);
  const n = Number(record.sessions || record.hours) || 0;
  const details = [];
  if (n) details.push(`${n} ${sessionsWord(n)}`);
  if (record.price) details.push(`${record.price} Br`);
  return `Loony Room: заявка на ${when}, ${record.startTime}–${record.endTime} принята`
    + (details.length ? ` (${details.join(', ')})` : '')
    + `. Скоро позвоним для подтверждения. ${SMS_PHONE}`;
}

// 20.10.2026: журнал последних SMS (KV-список smslog, 50 записей) — чтобы
// в админке было видно, ушла ли квитанция и что ответил RocketSMS, без
// логов Vercel. Никогда не ломает отправку/бронь.
export const SMS_LOG_KEY = 'smslog';
const SMS_LOG_MAX = 50;

export async function logSms(entry) {
  try {
    if (!isKvConfigured()) return;
    await kv('lpush', SMS_LOG_KEY, JSON.stringify({ at: new Date().toISOString(), ...entry }));
    await kv('ltrim', SMS_LOG_KEY, 0, SMS_LOG_MAX - 1);
  } catch (err) {
    console.error('RocketSMS: не удалось записать журнал SMS:', err);
  }
}

// Статус одной SMS у RocketSMS: QUEUED / SENT / DELIVERED / FAILED.
export async function getSmsStatus(id) {
  const out = await rocketCall('status', { id: String(id) }, 'GET');
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, status: out.data && out.data.status };
}

// Журнал для админки; у последних 15 записей с id — живой статус доставки.
export async function getSmsLog() {
  let items = [];
  try {
    const raw = isKvConfigured() ? await kv('lrange', SMS_LOG_KEY, 0, SMS_LOG_MAX - 1) : [];
    items = (Array.isArray(raw) ? raw : []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch (err) {
    console.error('RocketSMS: не удалось прочитать журнал SMS:', err);
  }
  if (isSmsConfigured()) {
    const withId = items.filter((e) => e.id).slice(0, 15);
    const statuses = await Promise.all(withId.map((e) => getSmsStatus(e.id)));
    withId.forEach((e, i) => { if (statuses[i].ok && statuses[i].status) e.delivery = statuses[i].status; });
  }
  return items;
}

function logDetails(kind, record) {
  return {
    kind,
    channel: record.channel || '',
    phone: normalizePhoneForRocketSms(record.phone),
    dateISO: record.dateISO || '',
    time: record.time || record.startTime || '',
  };
}

async function sendReceipt(kind, record, text) {
  const base = logDetails(kind, record);
  if (!SMS_RECEIPTS_ENABLED) {
    console.error(`RocketSMS: квитанции выключены (SMS_RECEIPTS_ENABLED) — ${kind} без SMS.`);
    await logSms({ ...base, ok: false, error: 'DISABLED' });
    return { ok: false, error: 'DISABLED' };
  }
  if (!isSmsConfigured()) {
    console.error('ROCKETSMS_LOGIN/ROCKETSMS_PASSWORD не заданы в Vercel — SMS-квитанция не отправлена (бронь это не затрагивает).');
    await logSms({ ...base, ok: false, error: 'NOT_CONFIGURED' });
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  let out;
  try {
    out = await sendSms(record.phone, text);
    if (!out.ok) console.error(`RocketSMS: квитанция (${kind}) не отправлена:`, out.error, record.phone);
  } catch (err) {
    console.error(`RocketSMS: ошибка при отправке квитанции (${kind}):`, err);
    out = { ok: false, error: 'EXCEPTION' };
  }
  await logSms({ ...base, ok: !!out.ok, id: out.id || null, status: out.status || '', error: out.error || '', parts: smsParts(text) });
  return out;
}

// 20.10.2026: брони, которые администратор добавил сам (по телефону, из
// Instagram…). С клиентом уже договорились, поэтому текст — «бронь
// подтверждена», а не «заявка принята, скоро позвоним».
export function questAdminText(record) {
  return questReceiptText(record);
}

export function roomAdminText(record) {
  const when = smsDateLabel(record.dateISO);
  const n = Number(record.sessions || record.hours) || 0;
  const details = [];
  if (n) details.push(`${n} ${sessionsWord(n)}`);
  if (record.price !== undefined && record.price !== '' && Number(record.price) > 0) details.push(`${record.price} Br`);
  return `Loony Room: бронь на ${when}, ${record.startTime}–${record.endTime} подтверждена`
    + (details.length ? ` (${details.join(', ')})` : '')
    + `. Ждём вас! ${SMS_PHONE}`;
}

export async function sendAdminQuestSms(record) {
  return sendReceipt('квест', { ...record, channel: record.channel || 'Админка' }, questReceiptText(record));
}

export async function sendAdminRoomSms(record) {
  return sendReceipt('комната', { ...record, channel: `Админка${record.channel ? ' (' + record.channel + ')' : ''}` }, roomAdminText(record));
}

// Квест: вызывается из api/book.js (сайт), api/mirkvestov.js и
// api/extrareality.js (брони с агрегаторов).
export async function sendBookingConfirmationSms(record) {
  return sendReceipt('квест', record, questReceiptText(record));
}

// Комната отдыха: вызывается из api/lead.js после успешной заявки с сайта.
export async function sendRoomConfirmationSms(record) {
  return sendReceipt('комната', record, roomReceiptText(record));
}

// Для админки: подключено ли, баланс, статус альфа-имени.
export async function getSmsInfo() {
  const sender = smsSender();
  const info = {
    configured: isSmsConfigured(),
    enabled: SMS_RECEIPTS_ENABLED,
    sender,
    balance: null,
    credits: null,
    senderStatus: null, // { found, checked, registered, verified }
    error: '',
    samples: {
      quest: questReceiptText({ dateISO: '2026-10-31', time: '19:00', players: '3–4 человека', price: '140' }),
      room: roomReceiptText({ dateISO: '2026-10-31', startTime: '18:40', endTime: '20:40', sessions: 2, price: '180' }),
      roomAdmin: roomAdminText({ dateISO: '2026-10-31', startTime: '18:40', endTime: '20:40', sessions: 2, price: '180' }),
    },
  };
  info.sampleParts = Object.fromEntries(Object.entries(info.samples).map(([k, v]) => [k, smsParts(v)]));
  if (!info.configured) return info;
  const [bal, snd] = await Promise.all([rocketCall('balance', {}, 'GET'), rocketCall('senders', {}, 'GET')]);
  if (bal.ok) {
    info.balance = bal.data.balance ?? null;
    info.credits = bal.data.credits ?? null;
  } else {
    info.error = bal.error;
  }
  if (snd.ok && Array.isArray(snd.data)) {
    const row = snd.data.find((s) => String(s.sender || '').toUpperCase() === sender.toUpperCase());
    info.senderStatus = row
      ? { found: true, checked: !!row.checked, registered: !!row.registered, verified: !!row.verified }
      : { found: false, checked: false, registered: false, verified: false };
  } else if (!info.error) {
    info.error = snd.error;
  }
  return info;
}

export const SMS_TEST_TEXT = 'LOONY.BY: тестовая SMS из админки. Квитанции клиентам работают.';
