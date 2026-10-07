// 07.10.2026: имена сотрудников по их Telegram-нику.
// В основе по-прежнему ник (username без "@") — по нему работают смены,
// напоминания и сверки. Имя — только «подпись» к нику, чтобы в панелях
// было видно «Миша», а не «shiz1k_121».
//
// Имена по умолчанию заданы ниже (список от владельца, 07.10.2026). Их можно
// поменять или добавить новых людей прямо в админке: «Смены и напоминания» →
// «Имена сотрудников» — такие правки хранятся в KV-хеше actorNames и имеют
// приоритет над списком ниже.
import { kv } from './_kv.js';

export const DEFAULT_ACTOR_NAMES = {
  shiz1k_121: 'Миша',
  anton8087: 'Антон',
  ariebishe: 'Арина',
  korr_ii: 'Аня',
  lila_nabo: 'Люся',
  loeoox: 'Леша',
  loonychief: 'Наташа',
  magvvoi: 'Маша',
};

const NAMES_KEY = 'actorNames';

export function cleanUsername(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase().slice(0, 40);
}

// username → имя (KV поверх списка по умолчанию)
export async function getActorNames() {
  const out = { ...DEFAULT_ACTOR_NAMES };
  const raw = await kv('hgetall', NAMES_KEY);
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length - 1; i += 2) {
      const u = cleanUsername(raw[i]);
      const name = String(raw[i + 1] || '').trim();
      if (u && name) out[u] = name;
    }
  }
  return out;
}

export async function setActorName(username, name) {
  const u = cleanUsername(username);
  if (!u) return false;
  const clean = String(name || '').trim().slice(0, 40);
  if (clean) await kv('hset', NAMES_KEY, u, clean);
  else await kv('hdel', NAMES_KEY, u);
  return true;
}

// Старые подписи → новое имя. Раньше игры и выплаты записывались под именем
// из профиля Telegram (first_name) или под самим ником. Чтобы история не
// «рассыпалась» на два человека, такие старые подписи считаются тем же
// человеком, что и новое имя. Неоднозначные (одно старое имя у двух разных
// людей) пропускаются.
export async function getNameAliases(names) {
  const map = names || await getActorNames();
  const raw = await kv('hgetall', 'actors');
  const aliases = {};
  const conflict = new Set();
  const add = (from, to) => {
    if (!from || !to || from === to) return;
    if (aliases[from] && aliases[from] !== to) conflict.add(from);
    aliases[from] = to;
  };
  Object.entries(map).forEach(([u, name]) => add(u, name));
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length - 1; i += 2) {
      const u = raw[i];
      let info = null;
      try { info = JSON.parse(raw[i + 1]); } catch { info = null; }
      if (map[u] && info && info.displayName) add(String(info.displayName).trim(), map[u]);
    }
  }
  conflict.forEach((k) => delete aliases[k]);
  return aliases;
}
