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

// A booking made for TODAY gets a CAPS urgency note, wrapped in ‼️ on both
// ends (23.09.2026, owner's request — the one deliberate exception to
// "no emoji anywhere in these messages" above, specifically so this one
// line jumps out); any other day gets none (''). The three buckets are
// deliberately rough — the owner asked for a quick sense of urgency at a
// glance, not an exact countdown:
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
  let core;
  if (minutesLeft <= 75) core = 'ДО ИГРЫ МЕНЬШЕ ЧАСА';
  else if (minutesLeft <= 105) core = 'ДО ИГРЫ ПОЛТОРА ЧАСА';
  else core = 'ДО ИГРЫ ОСТАЛОСЬ НЕСКОЛЬКО ЧАСОВ';
  return `‼️‼️${core}‼️‼️`;
}

// Builds the "Дата: <b>...</b>" / "Время: <b>...</b>" block shared by every
// one of these notifications, so the ordering and bolding stay identical
// everywhere instead of being retyped per call site. Returns an array of
// lines to join with the rest of the message's own fields.
//
// 23.09.2026: no longer ends with a blank-line spacer (there used to be
// one here) — the owner asked for Время and the next field (usually Имя)
// to follow directly with no gap between them.
//
// 23.09.2026 (later same day): used to also append the same-day urgency
// note (sameDayUrgencyNote()) as a third line here. Moved out to its own
// call — the owner asked for that note to be the very FIRST thing in the
// whole message (ahead of the "НОВАЯ БРОНЬ..." title itself), so it's the
// first line Telegram shows in the push-notification preview, with Дата
// and Время following only once the message is opened. See
// urgencyLead() below and each call site's own use of it.
export function dateTimeBlock(dateISO, timeStr, now = new Date()) {
  return [
    `Дата: <b>${escapeTgHtml(formatDateRu(dateISO))}</b>`,
    `Время: <b>${escapeTgHtml(timeStr)}</b>`,
  ];
}

// Prefix to put at the very top of a message, above the title line: the
// same-day urgency note plus a blank-line separator, or '' when the
// booking isn't for today (sameDayUrgencyNote() already returns '' then).
// 23.09.2026: owner's request — this note used to sit between Дата and
// Время further down; now it leads the entire message instead.
export function urgencyLead(dateISO, timeStr, now = new Date()) {
  const note = sameDayUrgencyNote(dateISO, timeStr, now);
  return note ? `${note}\n\n` : '';
}
