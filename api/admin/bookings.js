// Serverless function (Vercel Node.js runtime).
// Password-protected endpoint behind the admin panel (admin.html). Every
// request — GET or POST — must include the header:
//   X-Admin-Password: <the same value as the ADMIN_PASSWORD env var>
// Requests without a matching header get 401 and nothing else runs.
//
// GET  → returns every booking (customer or technical) in the booking
//         window, oldest first, full details included (name, phone,
//         players, price, comment...).
// POST → body.action selects what to do:
//   { action:'create', dateISO, time, comment }
//       Creates a "technical" booking (blocks the slot, no customer info).
//   { action:'cancel', dateISO, time }
//       Removes a booking, freeing the slot again.
//   { action:'edit', dateISO, time, name, phone, players, price, comment }
//       Updates a booking's details in place (same date/time).
//   { action:'reschedule', fromDateISO, fromTime, toDateISO, toTime }
//       Moves a booking to a different date/time (fails with 409 if the
//       new slot is already taken).
//
// Data model: each date has a Redis HASH at key "bookings:<ISO date>", one
// field per booked time, whose value is a JSON string with the full
// booking record. See api/book.js for how customer bookings are created,
// and api/slots.js for the public (PII-free) read side.

import { kv, kvPipeline, pairsToObject } from '../_kv.js';

const WINDOW_DAYS_BACK = 3; // small buffer so very recent bookings stay visible
const WINDOW_DAYS_AHEAD = 65;
const SLOT_TTL_SECONDS = 60 * 60 * 24 * 90;

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function windowDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = -WINDOW_DAYS_BACK; i < WINDOW_DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(isoDate(d));
  }
  return dates;
}

function checkAuth(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  return Boolean(adminPassword) && provided === adminPassword;
}

function isValidDateISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidTime(s) {
  return typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 20;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Неверный пароль.' });
  }

  if (req.method === 'GET') {
    const dates = windowDates();
    const commands = dates.map((iso) => ['HGETALL', `bookings:${iso}`]);
    const results = await kvPipeline(commands);

    if (!results) {
      return res.status(200).json({ bookings: [] });
    }

    const bookings = [];
    results.forEach((entry, i) => {
      const obj = pairsToObject(entry && entry.result);
      Object.entries(obj).forEach(([time, raw]) => {
        try {
          const record = JSON.parse(raw);
          bookings.push({
            ...record,
            dateISO: record.dateISO || dates[i],
            time: record.time || time,
          });
        } catch {
          // Skip a malformed entry instead of failing the whole list.
        }
      });
    });

    bookings.sort((a, b) => (a.dateISO + a.time).localeCompare(b.dateISO + b.time));

    return res.status(200).json({ bookings });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const { action } = body;

    if (action === 'create') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim().slice(0, 20) : '';
      const cleanComment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
      const isCustomer = body.type === 'customer';

      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время.' });
      }

      let record;
      if (isCustomer) {
        const cleanName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
        const cleanPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
        if (!cleanName || !cleanPhone) {
          return res.status(400).json({ error: 'Укажите имя и телефон клиента.' });
        }
        record = {
          type: 'customer',
          name: cleanName,
          phone: cleanPhone,
          players: body.players != null ? String(body.players).trim().slice(0, 10) : '',
          price: body.price != null ? String(body.price).trim().slice(0, 20) : '',
          comment: cleanComment,
          dateISO: cleanDateISO,
          dateLabel: '',
          time: cleanTime,
          createdAt: new Date().toISOString(),
          source: 'admin', // created manually from the admin panel, not the public booking form
        };
      } else {
        record = {
          type: 'technical',
          name: 'Техническая бронь',
          phone: '',
          players: '',
          price: '',
          comment: cleanComment,
          dateISO: cleanDateISO,
          dateLabel: '',
          time: cleanTime,
          createdAt: new Date().toISOString(),
        };
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const added = await kv('hsetnx', hashKey, cleanTime, JSON.stringify(record));
      if (added === 0) {
        return res.status(409).json({ error: 'Этот слот уже занят.' });
      }
      await kv('expire', hashKey, SLOT_TTL_SECONDS);

      return res.status(200).json({ ok: true, booking: record });
    }

    if (action === 'cancel') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }
      await kv('hdel', `bookings:${cleanDateISO}`, cleanTime);
      return res.status(200).json({ ok: true });
    }

    if (action === 'edit') {
      const cleanDateISO = isValidDateISO(body.dateISO) ? body.dateISO : '';
      const cleanTime = isValidTime(body.time) ? body.time.trim() : '';
      if (!cleanDateISO || !cleanTime) {
        return res.status(400).json({ error: 'Укажите дату и время брони.' });
      }

      const hashKey = `bookings:${cleanDateISO}`;
      const existingRaw = await kv('hget', hashKey, cleanTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена — возможно, её уже отменили.' });
      }

      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = {}; }

      const updated = {
        ...existing,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : existing.name,
        phone: typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : existing.phone,
        players: body.players != null ? String(body.players).trim().slice(0, 10) : existing.players,
        price: body.price != null ? String(body.price).trim().slice(0, 20) : existing.price,
        comment: typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : existing.comment,
      };

      await kv('hset', hashKey, cleanTime, JSON.stringify(updated));
      return res.status(200).json({ ok: true, booking: updated });
    }

    if (action === 'reschedule') {
      const fromDateISO = isValidDateISO(body.fromDateISO) ? body.fromDateISO : '';
      const fromTime = isValidTime(body.fromTime) ? body.fromTime.trim() : '';
      const toDateISO = isValidDateISO(body.toDateISO) ? body.toDateISO : '';
      const toTime = isValidTime(body.toTime) ? body.toTime.trim().slice(0, 20) : '';

      if (!fromDateISO || !fromTime || !toDateISO || !toTime) {
        return res.status(400).json({ error: 'Укажите текущие и новые дату и время.' });
      }
      if (fromDateISO === toDateISO && fromTime === toTime) {
        return res.status(400).json({ error: 'Новое время совпадает с текущим.' });
      }

      const fromKey = `bookings:${fromDateISO}`;
      const toKey = `bookings:${toDateISO}`;

      const existingRaw = await kv('hget', fromKey, fromTime);
      if (!existingRaw) {
        return res.status(404).json({ error: 'Бронь не найдена — возможно, её уже отменили.' });
      }

      let existing;
      try { existing = JSON.parse(existingRaw); } catch { existing = {}; }

      const updated = { ...existing, dateISO: toDateISO, time: toTime };

      const added = await kv('hsetnx', toKey, toTime, JSON.stringify(updated));
      if (added === 0) {
        return res.status(409).json({ error: 'Это время уже занято — выберите другое.' });
      }
      await kv('expire', toKey, SLOT_TTL_SECONDS);
      await kv('hdel', fromKey, fromTime);

      return res.status(200).json({ ok: true, booking: updated });
    }

    return res.status(400).json({ error: 'Неизвестное действие.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
