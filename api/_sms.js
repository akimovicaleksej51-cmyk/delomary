// Sends the customer a short SMS receipt right after they submit a booking
// request on the public site, via RocketSMS (rocketsms.by) — a Belarusian
// SMS gateway. Added 18.09.2026 at the owner's request, modeled on the
// existing Telegram integration in api/book.js: best-effort only, never
// blocks or fails the booking itself.
//
// IMPORTANT — this is a "заявка принята" receipt, not a final confirmed
// booking: the admin still calls the customer to confirm the exact time and
// price (same process as before this feature — see the "fine" text on the
// site and the Telegram message this mirrors), so the wording below says
// "заявка принята" / "скоро позвоним", not "бронь подтверждена". If the
// business process ever changes so the site itself is the final word on a
// booking, this text should change to match.
//
// Required environment variables (Vercel → Project → Settings →
// Environment Variables):
//   ROCKETSMS_LOGIN    — логин личного кабинета rocketsms.by (обычно УНП)
//   ROCKETSMS_PASSWORD — ПАРОЛЬ ОТ ЛИЧНОГО КАБИНЕТА В ОТКРЫТОМ ВИДЕ. Ничего
//                        самому хэшировать не нужно — RocketSMS требует
//                        md5-хэш пароля в запросе, и этот файл сам считает
//                        его через Node.js crypto прямо перед отправкой.
// Optional:
//   ROCKETSMS_SENDER   — альфа-имя отправителя (до 11 латинских символов
//                        без пробелов), которое клиент увидит вместо
//                        номера. Пока имя проходит проверку в RocketSMS,
//                        просто не задавайте эту переменную — сообщения
//                        будут уходить с номера/имени по умолчанию для
//                        вашего аккаунта. Как только альфа-имя одобрят,
//                        впишите его в эту переменную в Vercel — правки
//                        кода для этого не понадобится, изменения
//                        применятся к следующей же отправленной SMS.
//
// Если эти переменные не заданы вообще, функция просто ничего не делает
// (кроме записи в лог) — сайт и приём броней продолжают работать как
// раньше, просто без SMS-квитанции клиенту.

import crypto from 'crypto';

const ROCKETSMS_URL = 'https://api.rocketsms.by/json/send';

// Приводит любой ввод телефона к виду "375XXXXXXXXX", как требует
// RocketSMS — без "+", без скобок/дефисов/пробелов, с кодом страны. Та же
// логика (срезать 375/80/0), что уже используется в index.html/admin.html/
// staff.html для маски телефона и для поиска по нему — здесь применяется
// в обратную сторону, чтобы ДОБАВИТЬ код страны, а не убрать его.
export function normalizePhoneForRocketSms(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('375')) return digits;
  if (digits.startsWith('80')) return '375' + digits.slice(2);
  if (digits.startsWith('0')) return '375' + digits.slice(1);
  if (digits.length === 9) return '375' + digits;
  return digits;
}

// 23.09.2026: PAUSED at the owner's request — RocketSMS's default sender
// (a number/short name that isn't "Дело Мэри") is what customers currently
// see these come from, and the owner is waiting on RocketSMS to approve
// the alpha-name (ROCKETSMS_SENDER, see the comment above) before
// resuming. Nothing else about this feature changed — flip this back to
// true (nothing else needs editing here or at any call site) the moment
// the alpha-name is approved and set in Vercel. Exported (not just a local
// const) purely so the test suite can tell it's paused and adjust its own
// expectations, without needing its own copy of this flag.
export const SMS_RECEIPTS_ENABLED = false;

export async function sendBookingConfirmationSms(record) {
  if (!SMS_RECEIPTS_ENABLED) {
    console.error('RocketSMS: SMS-квитанции временно отключены (ждём одобрения альфа-имени) — квитанция не отправлена.');
    return;
  }
  try {
    const login = process.env.ROCKETSMS_LOGIN;
    const password = process.env.ROCKETSMS_PASSWORD;
    if (!login || !password) {
      console.error('ROCKETSMS_LOGIN/ROCKETSMS_PASSWORD не заданы — SMS-квитанция клиенту не отправлена (бронь это не затрагивает).');
      return;
    }

    const phone = normalizePhoneForRocketSms(record.phone);
    // 23.09.2026: was `< 11`, i.e. it only rejected 10 digits or fewer — but
    // a correctly-normalized Belarus number is always exactly 12 digits
    // ("375" + a 9-digit subscriber number), so an 11-digit result (e.g. a
    // customer's number typo'd one digit short, which still happens to
    // start with "375") silently passed this guard and was sent to
    // RocketSMS instead of being caught here as intended.
    if (phone.length !== 12 || !phone.startsWith('375')) {
      console.error('RocketSMS: не удалось привести телефон к формату 375XXXXXXXXX, SMS не отправлена:', record.phone);
      return;
    }

    // Держим текст покороче намеренно: кириллица в SMS идёт как UCS-2 (70
    // символов в одном сообщении, 67 — если частей несколько), и каждая
    // дополнительная часть — это отдельная платная SMS у RocketSMS. Этот
    // вариант укладывается в 2 части почти всегда; более длинная версия
    // с той же информацией уже уходила в 3.
    let text = `Дело Мэри: заявка на ${record.dateLabel || record.dateISO} в ${record.time} принята`;
    const details = [];
    // 23.09.2026: was `${record.players} чел.` — record.players is already
    // a full tier phrase from the booking widget (e.g. "1–2 человека" or
    // "3–4 человека"), not a bare number, so this produced a redundant
    // "1–2 человека чел." in the actual SMS text sent to real customers.
    if (record.players) details.push(String(record.players));
    if (record.price) details.push(`${record.price} Br`);
    if (details.length) text += ' (' + details.join(', ') + ')';
    text += '. Скоро позвоним для подтверждения. Тел.: +375 (44) 780-30-00';

    const passwordHash = crypto.createHash('md5').update(password).digest('hex');
    const params = new URLSearchParams({ username: login, password: passwordHash, phone, text });
    const sender = process.env.ROCKETSMS_SENDER;
    if (sender) params.set('sender', sender);

    const res = await fetch(ROCKETSMS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* см. лог ниже — RocketSMS иногда отвечает не-JSON текстом */ }

    if (!data || data.error) {
      console.error('RocketSMS: сервис отказал в отправке SMS-квитанции:', data ? data.error : raw);
    }
  } catch (err) {
    // Сеть недоступна, RocketSMS не отвечает и т.п. — бронь уже принята и
    // отправлена в Telegram владельцу, эта функция не должна её ломать.
    console.error('RocketSMS: ошибка при отправке SMS-квитанции:', err);
  }
}
