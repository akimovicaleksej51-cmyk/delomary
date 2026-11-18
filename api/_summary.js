// 18.11.2026: вечерняя сводка за день в Telegram — Наташе (@loonychief) лично
// от бота. Не роут (файл начинается с "_"): вызывается из
//   - api/internal-jobs.js ?job=summary — Vercel Cron раз в сутки (vercel.json),
//     срабатывает между 00:00 и 00:59 по Минску (точность крона на тарифе
//     Hobby — в пределах часа) и присылает итоги ТОЛЬКО ЧТО закончившегося дня;
//   - api/admin/finance.js action:'sendSummary' — кнопка в «Кассе», чтобы
//     прислать сводку прямо сейчас (за текущий день).
//
// «День» — как у безнала в Кассе: с 01:00 до 01:00 по Минску, поэтому
// поздние игры (23:00) попадают в свой день.
//
// Кому слать — SUMMARY_RECIPIENTS (ники Telegram без @). Сообщение уходит
// в личку тому, кто хоть раз написал боту /start (тогда его chat id лежит
// в KV-хеше `actors`, как у актёров для напоминаний).

import { kv, kvCachedRead, pairsToObject } from './_kv.js';
import { toAmount, computeCashRegister, getCashoutsForDate, nonCashBusinessDate } from './_finance.js';
import { uniqueRoomRecords, roomPaid } from './_rooms.js';
import { getActorsMap } from './_reminders.js';
import { escapeTgHtml } from './_telegram.js';

export const SUMMARY_RECIPIENTS = ['loonychief']; // Наташа

const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function dayTitle(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WD[w]}, ${d} ${MONTHS[m - 1]}`;
}
function money(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Br`;
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return `${n} ${one}`;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

// Собирает цифры дня. Деньги — только то, что реально записано в брони
// (нал / безнал / ЕРИП из сверки или редактирования), как в Кассе.
export async function buildDailySummary(dateISO) {
  const res = await kvCachedRead([
    ['HGETALL', `bookings:${dateISO}`],
    ['HGETALL', `history:${dateISO}`],
    ['HGETALL', `roombookings:${dateISO}`],
  ]);
  if (!res) return { ok: false, error: 'База данных не отвечает' };

  const s = {
    dateISO,
    cash: 0, card: 0, erip: 0,
    quest: { games: 0, notPlayed: 0, paid: 0 },
    room: { bookings: 0, sessions: 0, notPlayed: 0, paid: 0 },
    unsettled: [],
    expenses: 0, payroll: 0,
    balance: null,
  };

  // Квест: активные брони дня + оплаты по отменённым (деньги могли взять)
  const live = pairsToObject(res[0] && res[0].result);
  Object.entries(live).forEach(([time, raw]) => {
    let r; try { r = JSON.parse(raw); } catch { return; }
    if (!r || r.type !== 'customer' || r.status === 'rescheduled') return;
    const cash = toAmount(r.payCash), card = toAmount(r.payCard), erip = toAmount(r.payErip);
    s.cash += cash; s.card += card; s.erip += erip;
    if (r.status === 'cancelled') return;
    s.quest.games += 1;
    s.quest.paid += cash + card + erip;
    const mc = r.manualCloseout;
    if (mc && mc.done && mc.played === false) s.quest.notPlayed += 1;
    if (!(mc && mc.done)) s.unsettled.push({ kind: 'квест', time: r.time || time, name: r.name || '' });
  });
  Object.values(pairsToObject(res[1] && res[1].result)).forEach((raw) => {
    let r; try { r = JSON.parse(raw); } catch { return; }
    if (!r || r.type !== 'customer' || r.status === 'rescheduled') return;
    s.cash += toAmount(r.payCash); s.card += toAmount(r.payCard); s.erip += toAmount(r.payErip);
  });

  // Комната отдыха (технические брони не считаем)
  uniqueRoomRecords(res[2] && res[2].result).forEach((rec) => {
    if (!rec || rec.technical) return;
    const p = roomPaid(rec);
    s.cash += p.cash; s.card += p.card; s.erip += p.erip;
    s.room.bookings += 1;
    s.room.sessions += Number(rec.sessions || rec.hours) || 0;
    s.room.paid += p.cash + p.card + p.erip;
    if (rec.closeout && rec.closeout.done && rec.closeout.played === false) s.room.notPlayed += 1;
    if (!(rec.closeout && rec.closeout.done)) s.unsettled.push({ kind: 'комната', time: rec.startTime || '', name: rec.name || '' });
  });

  // Расходы и ЗП из кассы за этот день
  const cashouts = await getCashoutsForDate(dateISO);
  cashouts.forEach((c) => {
    const a = toAmount(c.amount);
    if (c.kind === 'payroll') s.payroll += a; else s.expenses += a;
  });

  try {
    const reg = await computeCashRegister(dateISO);
    if (reg && Number.isFinite(Number(reg.balance))) s.balance = Number(reg.balance);
  } catch { /* без остатка кассы — не страшно */ }

  s.unsettled.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { ok: true, summary: s };
}

export function dailySummaryText(s) {
  const total = s.cash + s.card + s.erip;
  const lines = [];
  lines.push(`<b>СВОДКА ЗА ДЕНЬ · ${escapeTgHtml(dayTitle(s.dateISO))}</b>`);
  lines.push('');
  lines.push(`<b>Выручка: ${money(total)}</b>`);
  lines.push(`Наличные: ${money(s.cash)}`);
  lines.push(`Безнал: ${money(s.card)}`);
  if (s.erip) lines.push(`ЕРИП: ${money(s.erip)}`);
  lines.push('');
  lines.push(`Квест: ${plural(s.quest.games, 'игра', 'игры', 'игр')}${s.quest.games ? ` — ${money(s.quest.paid)}` : ''}${s.quest.notPlayed ? ` (не состоялось: ${s.quest.notPlayed})` : ''}`);
  lines.push(`Комната: ${s.room.bookings ? `${plural(s.room.bookings, 'бронь', 'брони', 'броней')}, ${plural(s.room.sessions, 'сеанс', 'сеанса', 'сеансов')} — ${money(s.room.paid)}` : 'броней не было'}${s.room.notPlayed ? ` (не состоялось: ${s.room.notPlayed})` : ''}`);
  if (s.expenses || s.payroll || s.balance !== null) {
    lines.push('');
    if (s.expenses) lines.push(`Расходы из кассы: ${money(s.expenses)}`);
    if (s.payroll) lines.push(`ЗП из кассы: ${money(s.payroll)}`);
    if (s.balance !== null) lines.push(`В кассе: <b>${money(s.balance)}</b>`);
  }
  lines.push('');
  if (s.unsettled.length) {
    lines.push(`⚠️ <b>Без сверки: ${s.unsettled.length}</b>`);
    s.unsettled.slice(0, 15).forEach((u) => {
      lines.push(`• ${escapeTgHtml(u.time)} ${u.kind}${u.name ? ` — ${escapeTgHtml(u.name)}` : ''}`);
    });
    if (s.unsettled.length > 15) lines.push(`… и ещё ${s.unsettled.length - 15}`);
    lines.push('<i>Деньги по броням без сверки в выручку не попали.</i>');
  } else if (s.quest.games || s.room.bookings) {
    lines.push('Все сверки проведены.');
  }
  return lines.join('\n');
}

async function sendTo(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN не задан' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) console.error('Сводка: Telegram API error:', data);
    return { ok: !!data.ok, error: data.ok ? '' : (data.description || 'Telegram не принял сообщение') };
  } catch (err) {
    console.error('Сводка: Telegram недоступен:', err);
    return { ok: false, error: 'Telegram недоступен' };
  }
}

// Отправляет сводку за dateISO всем из SUMMARY_RECIPIENTS.
// { onceKey: true } — не больше одного раза за день (для крона: повторный
// вызов в тот же день ничего не шлёт).
// Возвращает { ok, sent:[ник], missing:[ник без /start], errors:[…] }.
export async function sendDailySummary(dateISO, { once = false } = {}) {
  if (once) {
    const first = await kv('set', `summarysent:${dateISO}`, '1', 'NX', 'EX', 60 * 60 * 72);
    if (first !== 'OK') return { ok: true, skipped: true, sent: [], missing: [], errors: [] };
  }
  const built = await buildDailySummary(dateISO);
  if (!built.ok) {
    if (once) await kv('del', `summarysent:${dateISO}`);
    return { ok: false, error: built.error, sent: [], missing: [], errors: [built.error] };
  }
  const text = dailySummaryText(built.summary);
  const actors = await getActorsMap();
  const sent = [], missing = [], errors = [];
  for (const u of SUMMARY_RECIPIENTS) {
    const a = actors[u];
    if (!a || !a.chatId) { missing.push(u); continue; }
    // eslint-disable-next-line no-await-in-loop
    const r = await sendTo(a.chatId, text);
    if (r.ok) sent.push(u); else errors.push(`${u}: ${r.error}`);
  }
  if (once && !sent.length) await kv('del', `summarysent:${dateISO}`); // не дошло — пусть можно будет повторить
  return { ok: sent.length > 0, sent, missing, errors, summary: built.summary };
}

// День, итоги которого присылать сейчас: тот же «день с 01:00», что у безнала.
// В 00:30 это ещё вчерашний день — то есть только что закончившийся.
export function summaryDateNow(now = new Date()) {
  return nonCashBusinessDate(now);
}
