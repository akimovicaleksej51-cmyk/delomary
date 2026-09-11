// Serverless function (Vercel Node.js runtime).
// QStash calls this at the exact end of a shift slot (see
// scheduleCloseout() in api/_closeout.js). It sends the actor one message
// per booking that fell inside their shift, each with "✅ Верно" / "✏️
// Исправить" buttons, so they can confirm or correct the player count and
// price — the actual back-and-forth once a button is tapped is handled in
// api/telegram-webhook.js, which also asks how much cash was collected
// (feeding straight into "Касса" — see api/_finance.js).
//
// Authentication: same shared-secret pattern as api/telegram-reminder.js —
// QStash forwards the X-Reminder-Secret header we asked it to when
// scheduling, checked against REMINDER_WEBHOOK_SECRET.
//
// Required env vars: TELEGRAM_BOT_TOKEN, REMINDER_WEBHOOK_SECRET — both
// already set up for the reminder feature, nothing new to configure.

import { kv } from './_kv.js';
import { getShiftsForDate, getActorsMap, resolveActorUsernamesForSlot } from './_reminders.js';
import { clearCloseoutRecord } from './_closeout.js';

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

// Returns the parsed Telegram API response, or { ok:false } if the request
// itself couldn't even be made (network error, no bot token) — either way
// the caller can check `.ok` to know whether the message actually went out.
// This used to just log-and-swallow every failure, which meant an actor who
// blocked the bot (or whose chat id had gone stale) silently never got their
// end-of-shift sverka with NOTHING recorded anywhere to explain why — see
// the closeoutStatus 'send-failed' handling below, which exists specifically
// so that failure becomes visible in the admin panel instead of invisible.
async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error(`telegram-closeout: ${method} returned not-ok:`, data);
    return data;
  } catch (err) {
    console.error(`telegram-closeout: ${method} failed:`, err);
    return { ok: false };
  }
}

// Stamps every booking in `bookings` with the same closeoutStatus — used
// for the two failure modes that affect the whole shift at once (actor
// never registered with the bot / the chat is unreachable), so the admin
// panel has something concrete to show instead of just... nothing.
async function markAllBookings(hashKey, bookings, status) {
  await Promise.all(bookings.map(async (b) => {
    const current = await kv('hget', hashKey, b.time);
    if (!current) return;
    try {
      const currentRecord = JSON.parse(current);
      await kv('hset', hashKey, b.time, JSON.stringify({ ...currentRecord, closeoutStatus: status }));
    } catch {
      // skip malformed entry
    }
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.REMINDER_WEBHOOK_SECRET;
  const providedSecret = req.headers['x-reminder-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { dateISO, slot } = body;

  // Always ack quickly — this is a background job, nobody's waiting on it.
  res.status(200).json({ ok: true });

  await clearCloseoutRecord(dateISO, slot);
  if (!dateISO || !slot) return;

  const shiftsMap = await getShiftsForDate(dateISO);
  const slotData = shiftsMap[slot];
  if (!slotData || !slotData.actorUsername) return; // slot was cleared/changed since scheduling

  const hashKey = `bookings:${dateISO}`;
  const bookingsRaw = await kv('hgetall', hashKey);
  const bookings = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer') continue;
      const resolvedTime = record.time || time;
      // Re-checks against the CURRENT shift schedule (not just this slot's
      // own start/end) so a booking is correctly attributed to every
      // performer actually covering it — an actor AND an actress are
      // routinely on shift for the very same booking, and each needs their
      // own closeout, so this checks membership, not equality against a
      // single resolved performer.
      // eslint-disable-next-line no-await-in-loop
      const resolvedActors = await resolveActorUsernamesForSlot(dateISO, resolvedTime);
      if (resolvedActors.includes(slotData.actorUsername)) bookings.push({ ...record, time: resolvedTime });
    }
  }
  if (!bookings.length) return; // nobody booked during this shift — nothing to check

  bookings.sort((a, b) => a.time.localeCompare(b.time));

  // From here on, every early-return that skips actually sending a message
  // ALSO stamps closeoutStatus on the affected bookings — this used to just
  // silently do nothing, which is indistinguishable (from the admin panel)
  // from "nothing needed sending". Now a failure is always visible on the
  // booking itself: "актёр ещё не подключил бота" or "не удалось отправить".
  const actors = await getActorsMap();
  const actor = actors[slotData.actorUsername];
  if (!actor || !actor.chatId) {
    await markAllBookings(hashKey, bookings, 'actor-not-registered');
    return;
  }

  const dateLabel = formatDateLabel(dateISO);
  const introResult = await tg('sendMessage', {
    chat_id: actor.chatId,
    text: `🎬 Смена ${dateLabel} завершена — сверьте, пожалуйста, ${bookings.length === 1 ? 'игру' : 'игры'}:`,
  });
  if (!introResult || !introResult.ok) {
    // Chat unreachable (actor blocked the bot, deleted their account, etc.)
    // — every per-booking message below would fail the same way, so don't
    // bother trying; just record the failure so it's visible.
    await markAllBookings(hashKey, bookings, 'send-failed');
    return;
  }

  for (const b of bookings) {
    const lines = [
      `🎮 ${b.time} · ${b.name || 'без имени'}`,
      b.players ? `👥 ${b.players}` : null,
      b.price ? `💰 ${b.price} Br` : null,
    ].filter(Boolean);

    // eslint-disable-next-line no-await-in-loop
    const sendResult = await tg('sendMessage', {
      chat_id: actor.chatId,
      text: lines.join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Верно', callback_data: `co|ok|${dateISO}|${b.time}` },
          { text: '✏️ Исправить', callback_data: `co|edit|${dateISO}|${b.time}` },
        ]],
      },
    });

    // eslint-disable-next-line no-await-in-loop
    const current = await kv('hget', hashKey, b.time);
    if (current) {
      try {
        const currentRecord = JSON.parse(current);
        if (!currentRecord.closeoutStatus || currentRecord.closeoutStatus === 'send-failed') {
          const nextStatus = (sendResult && sendResult.ok) ? 'awaiting' : 'send-failed';
          // eslint-disable-next-line no-await-in-loop
          await kv('hset', hashKey, b.time, JSON.stringify({ ...currentRecord, closeoutStatus: nextStatus }));
        }
      } catch {
        // skip malformed entry
      }
    }
  }
}
