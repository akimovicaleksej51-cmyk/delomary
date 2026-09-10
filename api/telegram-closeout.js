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
import { getShiftsForDate, getActorsMap, resolveActorUsernameForSlot } from './_reminders.js';
import { clearCloseoutRecord } from './_closeout.js';

const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function formatDateLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({}));
  } catch (err) {
    console.error(`telegram-closeout: ${method} failed:`, err);
    return null;
  }
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

  const actors = await getActorsMap();
  const actor = actors[slotData.actorUsername];
  if (!actor || !actor.chatId) return; // never connected the bot — nothing we can send

  const bookingsRaw = await kv('hgetall', `bookings:${dateISO}`);
  const bookings = [];
  if (Array.isArray(bookingsRaw)) {
    for (let i = 0; i < bookingsRaw.length - 1; i += 2) {
      const time = bookingsRaw[i];
      let record;
      try { record = JSON.parse(bookingsRaw[i + 1]); } catch { continue; }
      if (record.type !== 'customer') continue;
      const resolvedTime = record.time || time;
      // Re-checks against the CURRENT shift schedule (not just this slot's
      // own start/end) so a booking never gets double-attributed if two
      // slots happen to overlap — same tie-break rule reminders use.
      // eslint-disable-next-line no-await-in-loop
      const resolved = await resolveActorUsernameForSlot(dateISO, resolvedTime);
      if (resolved === slotData.actorUsername) bookings.push({ ...record, time: resolvedTime });
    }
  }
  if (!bookings.length) return; // nobody booked during this shift — nothing to check

  bookings.sort((a, b) => a.time.localeCompare(b.time));

  const dateLabel = formatDateLabel(dateISO);
  await tg('sendMessage', {
    chat_id: actor.chatId,
    text: `🎬 Смена ${dateLabel} завершена — сверьте, пожалуйста, ${bookings.length === 1 ? 'игру' : 'игры'}:`,
  });

  const hashKey = `bookings:${dateISO}`;
  for (const b of bookings) {
    const lines = [
      `🎮 ${b.time} · ${b.name || 'без имени'}`,
      b.players ? `👥 ${b.players}` : null,
      b.price ? `💰 ${b.price} Br` : null,
    ].filter(Boolean);

    // eslint-disable-next-line no-await-in-loop
    await tg('sendMessage', {
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
        if (!currentRecord.closeoutStatus) {
          // eslint-disable-next-line no-await-in-loop
          await kv('hset', hashKey, b.time, JSON.stringify({ ...currentRecord, closeoutStatus: 'awaiting' }));
        }
      } catch {
        // skip malformed entry
      }
    }
  }
}
