// Shared helper for talking to Vercel KV (an Upstash Redis database) via its
// REST API. This file is NOT a route — Vercel ignores files that start with
// an underscore when building serverless functions from the api/ folder —
// but it can still be imported by the other files in this folder.
//
// Commands are sent as a JSON array in the POST body (Upstash's "body"
// command form) rather than built into the URL path, so long values (like a
// booking comment) never risk hitting a URL length limit.

// How long we'll wait for a single Upstash request before giving up and
// treating it as failed. Without this, a `fetch()` that never settles (a
// hung TCP connection, Upstash having a bad moment — this does happen, not
// hypothetical) leaves the calling `await kv(...)` stuck forever, since a
// hang is neither a resolve nor a reject and the surrounding try/catch never
// fires. That is exactly how the Telegram "✅ Верно" button once got stuck
// on its loading spinner forever: the webhook's very first step is a
// getPendingActorReply() call (see api/telegram-webhook.js), which is a
// kv() call — if IT hangs, the code never even reaches the
// answerCallbackQuery() call that clears the spinner, and eventually the
// serverless function is killed by its own platform-level timeout with no
// chance to answer Telegram at all. Capping every KV call here means the
// worst case is "fails fast after 8s and we fail open," never "hangs
// forever" — the same fix already applied to the admin's own slow-KV-calls
// bug, just guarding the one call site that bug didn't reach.
// (Overridable via env var so tests can simulate a hang without a real
// multi-second wait — production never sets this, so it's always 8000ms there.)
import crypto from 'crypto';

const KV_TIMEOUT_MS = Number(process.env.KV_TIMEOUT_MS) || 8000;

async function fetchWithTimeout(url, options, timeoutMs = KV_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// 23.09.2026: lets a caller tell "KV was never set up on this deployment"
// (documented, intentional fail-open — see api/book.js's header comment)
// apart from "KV IS set up but this particular call just failed/timed out".
// kv()/kvPipeline() themselves can't tell those two apart (both return
// null), which used to mean a real Redis hiccup was silently treated the
// same as "no database at all" — including by the one write (reserving a
// slot) where that distinction matters most: see the 23.09.2026 comment in
// api/book.js.
export function isKvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// ── 30.10.2026: экономия запросов к базе ────────────────────────────────
// Upstash считает каждую команду (в pipeline — каждую отдельно), а у
// бесплатного тарифа месячный лимит. Расписание для сайта, Мира Квестов,
// ExtraReality и списки в админке читали по 45–250 команд за раз, и в конце
// октября лимит кончился — база перестала отвечать. Теперь:
//   • каждая запись данных (брони, смены, касса…) одной командой в том же
//     запросе увеличивает счётчик версии данных `datav`;
//   • kvCached() хранит готовый ответ в `cache:<имя>` вместе с версией: пока
//     данные не менялись — 2 команды вместо десятков.
// Счётчики защиты от спама (*attempts:*), сам кеш и журнал SMS версию не
// меняют — от них ответы не зависят.
export const DATA_VERSION_KEY = 'datav';
const WRITE_OPS = new Set(['SET', 'SETEX', 'SETNX', 'GETSET', 'GETDEL', 'MSET', 'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY',
  'DEL', 'UNLINK', 'RENAME', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LTRIM', 'LREM', 'LSET', 'SADD', 'SREM', 'ZADD', 'ZREM', 'INCR', 'INCRBY', 'DECR', 'DECRBY', 'APPEND']);
function bumpsVersion(cmd) {
  if (!Array.isArray(cmd) || !WRITE_OPS.has(String(cmd[0]).toUpperCase())) return false;
  const key = String(cmd[1] == null ? '' : cmd[1]);
  if (!key) return false;
  if (key === DATA_VERSION_KEY || key.startsWith('cache:') || key === 'smslog') return false;
  if (/^[a-z]*attempts:/i.test(key) || key.startsWith('pendingActorReply:')) return false;
  return true;
}

// Последняя ошибка базы (текст ответа Upstash) — чтобы админка показала
// причину вместо пустого списка. kvErrorCount растёт при каждой ошибке —
// kvCached() по нему понимает, что ответ собран с ошибками и кешировать нельзя.
let lastKvError = '';
let kvErrorCount = 0;
export function getLastKvError() { return lastKvError; }
function noteKvError(msg) {
  lastKvError = String(msg || 'ошибка базы').slice(0, 300);
  kvErrorCount += 1;
  console.error('KV error:', lastKvError);
}

async function rawPipeline(commands) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetchWithTimeout(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      noteKvError(`HTTP ${res.status} ${text}`);
      return null;
    }
    const out = await res.json();
    if (Array.isArray(out)) {
      const bad = out.find((r) => r && r.error);
      if (bad) noteKvError(bad.error);
    }
    return out;
  } catch (err) {
    noteKvError(err && err.name === 'AbortError' ? 'база не ответила вовремя' : (err && err.message) || err);
    return null;
  }
}

export async function kv(...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // not connected — callers should fail open

  // Запись данных — в том же запросе увеличиваем версию (см. выше).
  if (bumpsVersion(args)) {
    const out = await rawPipeline([args, ['INCR', DATA_VERSION_KEY]]);
    if (!Array.isArray(out) || !out[0] || out[0].error) return null;
    return out[0].result;
  }

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      noteKvError(`HTTP ${res.status} ${text}`);
      return null;
    }
    const data = await res.json();
    return data.result;
  } catch (err) {
    noteKvError(err && err.name === 'AbortError' ? 'база не ответила вовремя' : (err && err.message) || err);
    return null;
  }
}

// Runs several commands in one HTTP round-trip. `commands` is an array of
// arrays, e.g. [['HKEYS', 'bookings:2026-09-16'], ['HKEYS', 'bookings:2026-09-17']].
// Returns an array of { result } / { error }, one per command, in order —
// or null if KV isn't connected or the request failed outright.
export async function kvPipeline(commands) {
  if (!Array.isArray(commands) || !commands.length) return [];
  if (commands.some(bumpsVersion)) {
    const out = await rawPipeline([...commands, ['INCR', DATA_VERSION_KEY]]);
    return Array.isArray(out) ? out.slice(0, commands.length) : out;
  }
  return rawPipeline(commands);
}

// Готовый ответ из кеша, если данные с тех пор не менялись; иначе build()
// и сохранить. `name` должен включать всё, от чего зависит ответ (дата,
// параметры запроса, 10-минутный отрезок времени для «закрытия» слотов).
// Если при сборке были ошибки базы — ответ не кешируется.
const CACHE_MAX_BYTES = 900 * 1024;
export async function kvCached(name, ttlSeconds, build) {
  if (!isKvConfigured()) return build();
  const key = `cache:${name}`;
  const head = await rawPipeline([['GET', DATA_VERSION_KEY], ['GET', key]]);
  const ver = Array.isArray(head) && head[0] && !head[0].error ? String(head[0].result == null ? '0' : head[0].result) : null;
  if (ver !== null && head[1] && head[1].result) {
    try {
      const c = JSON.parse(head[1].result);
      if (c && c.v === ver) return c.d;
    } catch { /* битый кеш — пересоберём */ }
  }
  const errorsBefore = kvErrorCount;
  const data = await build();
  if (ver !== null && data !== undefined && data !== null && kvErrorCount === errorsBefore) {
    const json = JSON.stringify({ v: ver, d: data });
    if (json.length <= CACHE_MAX_BYTES) await rawPipeline([['SET', key, json, 'EX', String(ttlSeconds)]]);
  }
  return data;
}

// То же, что kvPipeline(), но для БОЛЬШИХ ЧТЕНИЙ (десятки HGETALL/HKEYS по
// датам): результат запоминается, пока данные не менялись. Возвращает тот же
// массив { result } / { error }, что kvPipeline, или null при ошибке базы.
// Только для команд чтения!
export async function kvCachedRead(commands, ttlSeconds = 6 * 3600) {
  if (!Array.isArray(commands) || !commands.length) return [];
  const name = 'r:' + crypto.createHash('sha1').update(JSON.stringify(commands)).digest('hex').slice(0, 24);
  const out = await kvCached(name, ttlSeconds, async () => {
    const res = await rawPipeline(commands);
    return Array.isArray(res) && !res.some((r) => r && r.error) ? res : null;
  });
  return Array.isArray(out) ? out : null;
}

// "YYYY-MM-DDTHH:M" по Минску — 10-минутный отрезок для ключей кеша, чтобы
// слоты, закрывающиеся за час до начала, обновлялись не позже чем через 10 минут.
export function minskTenMinuteBucket(now = new Date()) {
  const t = new Date(now.getTime() + 3 * 3600 * 1000).toISOString();
  return t.slice(0, 15);
}

// Upstash returns HGETALL as a flat array: ["field1","value1","field2","value2"].
// This turns that into a plain { field1: value1, field2: value2 } object.
// A missing/empty hash comes back as null or [], both handled here.
export function pairsToObject(pairs) {
  if (!Array.isArray(pairs)) return {};
  const out = {};
  for (let i = 0; i < pairs.length - 1; i += 2) {
    out[pairs[i]] = pairs[i + 1];
  }
  return out;
}
