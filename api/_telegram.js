// Shared helpers for the OWNER-facing Telegram notifications sent whenever
// a booking is created, cancelled, rescheduled, or otherwise changed
// (api/book.js, api/mirkvestov.js, api/extrareality.js,
// api/admin/bookings.js). Added 23.09.2026 at the owner's request:
//   - date and time are shown FIRST, in bold, so they're the very first
//     thing visible in the notification preview, before opening it
//   - no emoji anywhere in these messages
//   - a date is always written day, then month, then year — e.g.
//     "23 сентября 2026" — never the raw ISO string's year-month-day order
//     (Мир Квестов's and ExtraReality's messages used to show the bare
//     dateISO, e.g. "2026-09-28")
//   - a booking made for TODAY gets an extra CAPS line saying roughly how
//     much time is left before the game starts
//
// Every one of these messages used to be sent as plain text (no
// parse_mode) — see each call site's own 22.09.2026 comment for why: the
// old code used parse_mode:'Markdown' (the legacy mode) together with
// MarkdownV2-style backslash-escaping, which don't match each other at
// all, so a customer's name/comment with a hyphen or parenthesis produced
// literal stray backslashes in real notifications. Bold text needs SOME
// parse_mode again, so this switches to Telegram's HTML mode instead of
// going back to Markdown — HTML only ever needs THREE characters escaped
// (& < >), vs. MarkdownV2's ~20, so the same class of bug is far less
// likely to resurface. escapeTgHtml() below must be applied to every piece
// of free text from a customer (name, phone, comment, tariff, etc.) before
// it goes into the message; the literal <b>/</b> tags this file adds
// itself are written directly, never escaped.
import { businessDateTime, todayISO } from './_time.js';

export function escapeTgHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MONTH_NAMES_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Always day -> month (by name) -> year, e.g. "23 сентября 2026" — never
// the raw "YYYY-MM-DD" order some of these messages showed before.
export function formatDateRu(dateISO) {
  const parts = String(dateISO).split('-').map(Number);
  const y = parts[0]; const m = parts[1]; const d = parts[2];
  if (!y || !m || !d) return String(dateISO);
  return `${d} ${MONTH_NAMES_RU[m - 1] || ''} ${y}`.trim();
}

// A booking made for TODAY gets a CAPS urgency note; any other day gets
// none (''). The three buckets are deliberately rough — the owner asked
// for a quick sense of urgency at a glance, not an exact countdown:
//   ~60-75 min left   -> "МЕНЬШЕ ЧАСА"  (the earliest a booking can ever
//                        come in at all — see CLOSE_SLOT_MINUTES_BEFORE in
//                        api/_time.js, which refuses anything closer)
//   ~75-105 min left  -> "ПОЛТОРА ЧАСА"
//   105+ min left      -> "ОСТАЛОСЬ НЕСКОЛЬКО ЧАСОВ"
export function sameDayUrgencyNote(dateISO, timeStr, now = new Date()) {
  if (dateISO !== todayISO()) return '';
  const parts = String(timeStr).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return '';
  const minutesLeft = (businessDateTime(dateISO, hh, mm).getTime() - now.getTime()) / 60000;
  if (minutesLeft <= 75) return 'ДО ИГРЫ МЕНЬШЕ ЧАСА';
  if (minutesLeft <= 105) return 'ДО ИГРЫ ПОЛТОРА ЧАСА';
  return 'ДО ИГРЫ ОСТАЛОСЬ НЕСКОЛЬКО ЧАСОВ';
}

// Builds the "Дата: <b>...</b>" / "Время: <b>...</b>" / (urgency note)
// block shared by every one of these notifications, so the ordering and
// bolding stay identical everywhere instead of being retyped per call
// site. Returns an array of lines (some possibly empty-string spacers) —
// join with the rest of the message's own fields.
export function dateTimeBlock(dateISO, timeStr, now = new Date()) {
  const note = sameDayUrgencyNote(dateISO, timeStr, now);
  return [
    `Дата: <b>${escapeTgHtml(formatDateRu(dateISO))}</b>`,
    `Время: <b>${escapeTgHtml(timeStr)}</b>`,
    note || null,
    '',
  ];
}
