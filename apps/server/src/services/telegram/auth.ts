import crypto from 'node:crypto';
import type { TelegramUser } from './api.js';

/**
 * Проверка подписи Telegram WebApp (initData).
 *
 * Алгоритм из документации Telegram: секрет = HMAC_SHA256("WebAppData", bot_token),
 * подпись = HMAC_SHA256(секрет, data_check_string), где data_check_string —
 * отсортированные пары key=value (кроме hash), склеенные переводом строки.
 *
 * Если токен бота не настроен (локальная разработка), проверка пропускается —
 * и вызывающая сторона получает флаг verified: false.
 */

export interface InitDataCheck {
  ok: boolean;
  verified: boolean;
  reason?: string;
  user?: TelegramUser;
  chatId?: string;
  queryId?: string;
  startParam?: string;
  authDate?: number;
  raw: Record<string, string>;
}

function parseInitData(initData: string): Record<string, string> {
  const params = new URLSearchParams(initData);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

export function validateInitData(initData: string, botToken: string | null, options: { maxAgeSec?: number } = {}): InitDataCheck {
  const raw = initData ? parseInitData(initData) : {};
  const user = raw.user ? (safeJson<TelegramUser>(raw.user) ?? undefined) : undefined;

  let startParam = raw.start_param;
  // В новых клиентах параметр приходит в формате base64url (startapp=...)
  if (startParam && /^[\w-]+={0,2}$/.test(startParam) && !startParam.includes('_')) {
    try {
      const decoded = Buffer.from(startParam, 'base64url').toString('utf8');
      if (/^[\w-]{1,64}$/.test(decoded)) startParam = decoded;
    } catch {
      /* оставляем как есть */
    }
  }

  if (!botToken) {
    return { ok: true, verified: false, reason: 'Токен бота не задан — проверка подписи пропущена (локальный режим)', user, startParam, authDate: Number(raw.auth_date ?? 0) || undefined, raw };
  }

  const hash = raw.hash;
  if (!hash) return { ok: false, verified: false, reason: 'В initData нет подписи hash', user, raw };

  const dataCheckString = Object.keys(raw)
    .filter((key) => key !== 'hash' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${raw[key]}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computed, hash)) {
    return { ok: false, verified: false, reason: 'Подпись initData не совпала — данные пришли не из Telegram', user, raw };
  }

  const authDate = Number(raw.auth_date ?? 0);
  const maxAge = options.maxAgeSec ?? 86_400;
  if (authDate && Date.now() / 1000 - authDate > maxAge) {
    return { ok: false, verified: true, reason: 'Сессия приложения устарела — откройте MARK из Telegram заново', user, raw };
  }

  return {
    ok: true,
    verified: true,
    user,
    chatId: raw.chat_instance,
    queryId: raw.query_id,
    startParam,
    authDate: authDate || undefined,
    raw,
  };
}

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
