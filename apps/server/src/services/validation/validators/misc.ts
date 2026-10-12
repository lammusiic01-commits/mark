import { httpError, httpJson, httpRequest } from '../../../http/client.js';
import { SmtpClient } from '../../smtp.js';
import { field, isSandboxLike } from '../context.js';
import type { Validator } from '../types.js';

/** VK Реклама, Telegram, SMTP, OpenAI, IndexNow и универсальные проверки сессий. */

/* ------------------------------- VK Ads ------------------------------- */

const VK_ADS_PROBES = [
  { url: 'https://ads.vk.com/api/v2/accounts.json', note: 'список аккаунтов' },
  { url: 'https://ads.vk.com/api/v2/agency/clients.json', note: 'клиенты агентства' },
  { url: 'https://ads.vk.com/api/v2/campaigns.json', note: 'кампании' },
  { url: 'https://ads.vk.com/api/v2/user.json', note: 'профиль' },
];

export const validateVkAds: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');

  await runner.step('format', 'Формат токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: VK Реклама не опрашивается' };
    if (!token) throw new Error('Токен не передан');
    if (/\s/.test(token)) throw new Error('В токене есть пробелы — скопируйте его целиком без переносов строк');
    if (token.length < 20) throw new Error('Токен VK обычно длиннее 20 символов — проверьте, что скопирован полностью');
    return { message: `Токен получен (${token.length} символов)` };
  });

  let endpoint: string | null = null;

  await runner.step('probe', 'Проверка API', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: используется тестовый набор данных' };
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const errors: string[] = [];
    for (const probe of VK_ADS_PROBES) {
      const result = await httpJson(probe.url, { headers, timeoutMs: 12_000, retries: 0 });
      if (result.ok) {
        endpoint = probe.url;
        return { message: `API отвечает (${probe.note}): ${probe.url}`, details: { endpoint: probe.url } };
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error(
          `Токен отклонён VK Рекламой (HTTP ${result.status}). Получите новый токен в настройках аккаунта/агентства на ads.vk.com → Настройки → API.`,
        );
      }
      errors.push(`${probe.url} → ${result.status || result.error}`);
    }
    return {
      status: 'warn' as const,
      message: `Ни один известный эндпоинт не ответил 200 (${errors.join('; ')}). Токен сохранён — при управлении кампаниями MARK повторит попытку и покажет фактический ответ API.`,
      details: { probes: errors },
    };
  });

  await runner.step('accounts', 'Аккаунты и кампании', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-аккаунт: 3 кампании, бюджет 1 500 ₽/день' };
    if (!endpoint) return { status: 'warn' as const, message: 'Пропущено: рабочий эндпоинт не определён' };
    const result = await httpJson(endpoint, { headers: { Authorization: `Bearer ${token}` }, raw: true });
    const preview = result.text.slice(0, 200).replace(/\s+/g, ' ');
    return { message: `Ответ API получен: ${preview}…`, details: { preview } };
  });

  return { accountInfo: { endpoint, sandbox } };
};

export const validateVkMetrika: Validator = async (ctx, runner) => {
  await runner.step('session', 'Сессия', async () => {
    if (!ctx.cookiesHeader) {
      return { status: 'warn' as const, message: 'Нужен вход в окне приложения (top.mail.ru) — статистика счётчиков берётся из интерфейса' };
    }
    const result = await httpRequest('https://top.mail.ru/my/', {
      headers: { Cookie: ctx.cookiesHeader },
      raw: true,
      timeoutMs: 12_000,
      retries: 0,
    });
    if (!result.ok) throw new Error(httpError(result, 'Не удалось открыть статистику со сохранённой сессией'));
    return { message: 'Сессия активна — можно выгружать данные счётчиков' };
  });

  await runner.step('counters', 'Счётчики', async () => {
    return { message: 'Счётчики будут определены по вашей сессии при первом отчёте' };
  });
};

/* ------------------------------ Telegram ------------------------------ */

export const validateTelegram: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const botToken = field(ctx, 'botToken');
  const chatId = field(ctx, 'chatId');
  let botInfo: { id?: number; username?: string; first_name?: string } | null = null;

  await runner.step('me', 'Проверка бота', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Telegram не опрашивается (уведомления пишутся в журнал)' };
    if (!botToken) throw new Error('Токен бота не передан (получите его у @BotFather)');
    const result = await httpJson<{ ok?: boolean; description?: string; result?: { id?: number; username?: string; first_name?: string } }>(
      `https://api.telegram.org/bot${botToken}/getMe`,
      { timeoutMs: 12_000 },
    );
    if (!result.ok || !result.data?.ok) {
      throw new Error(`Telegram отклонил токен: ${result.data?.description ?? `HTTP ${result.status}`}`);
    }
    botInfo = result.data.result ?? null;
    return {
      message: `Бот найден: @${botInfo?.username ?? '—'} (${botInfo?.first_name ?? 'без имени'})`,
      details: { bot: botInfo },
    };
  });

  await runner.step('chat', 'Доступ к чату', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    if (!chatId) {
      return { status: 'warn' as const, message: 'Chat ID не указан — впишите его, чтобы отчёты и алерты приходили в чат' };
    }
    const result = await httpJson<{ ok?: boolean; description?: string; result?: { title?: string; username?: string } }>(
      `https://api.telegram.org/bot${botToken}/getChat`,
      { query: { chat_id: chatId }, timeoutMs: 12_000 },
    );
    if (!result.data?.ok) {
      return {
        status: 'warn' as const,
        message: `Чат не найден: ${result.data?.description ?? `HTTP ${result.status}`}. Добавьте бота в чат/канал и дайте права администратора.`,
      };
    }
    return { message: `Чат доступен: ${result.data.result?.title ?? result.data.result?.username ?? chatId}` };
  });

  return { accountInfo: { bot: botInfo, chatId: chatId || null, sandbox } };
};

/* -------------------------------- SMTP -------------------------------- */

export const validateSmtp: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const host = field(ctx, 'host');
  const port = Number(field(ctx, 'port') || 465);
  const secure = (field(ctx, 'secure') || 'tls') as 'tls' | 'starttls' | 'none';
  const user = field(ctx, 'user');
  const password = field(ctx, 'password');
  const from = field(ctx, 'from');
  let capabilities: string[] = [];

  const options = {
    host,
    port,
    secure,
    user,
    password,
    from: from || user,
    timeoutMs: 12_000,
  };

  await runner.step('connect', 'Подключение', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: письма не отправляются, отчёты сохраняются в .data/reports' };
    const client = new SmtpClient(options);
    try {
      const greeting = await client.connect();
      return { message: `Сервер ответил ${greeting.code}: ${greeting.lines.join(' ').slice(0, 160)}` };
    } finally {
      client.close();
    }
  });

  await runner.step('ehlo', 'EHLO и возможности', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    const client = new SmtpClient(options);
    try {
      await client.connect();
      const prepared = await client.prepare();
      capabilities = prepared.capabilities;
      return {
        message: `Шифрование: ${prepared.tls ? 'включено' : 'нет'}; поддерживается: ${capabilities.slice(0, 6).join(', ')}`,
        details: { capabilities },
        status: prepared.tls || secure === 'none' ? ('pass' as const) : ('warn' as const),
      };
    } finally {
      client.close();
    }
  });

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    if (!user || !password) {
      return { status: 'warn' as const, message: 'Логин/пароль не указаны — будет использоваться анонимная отправка (работает только для локальных релеев)' };
    }
    const client = new SmtpClient(options);
    try {
      await client.connect();
      await client.prepare();
      await client.authenticate();
      return { message: `Авторизация успешна для ${user}. Письма будет отправлять ${from || user}` };
    } finally {
      client.close();
    }
  });

  return { accountInfo: { host, port, secure, user: user || null, capabilities } };
};

/* ------------------------------- OpenAI ------------------------------- */

export const validateOpenAi: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const apiKey = field(ctx, 'apiKey');
  const baseUrl = (field(ctx, 'baseUrl') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = field(ctx, 'model') || 'gpt-4o-mini';
  let models: string[] = [];

  await runner.step('auth', 'Проверка ключа', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: используется локальный генератор текстов' };
    const result = await httpJson<{ data?: { id?: string }[]; error?: { message?: string } }>(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 15_000,
    });
    if (result.status === 401) throw new Error('Ключ OpenAI отклонён (401) — проверьте ключ и организацию/проект');
    if (!result.ok) throw new Error(result.data?.error?.message ?? httpError(result, 'OpenAI вернул ошибку'));
    models = (result.data?.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    return {
      message: `Ключ активен, доступно моделей: ${models.length}`,
      details: { sample: models.slice(0, 12) },
    };
  });

  await runner.step('model', 'Доступ к модели', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим' };
    if (!models.length) return { status: 'warn' as const, message: 'Список моделей пуст — проверьте доступ проекта к API' };
    const has = models.includes(model) || models.some((m) => m.startsWith(model));
    return {
      message: has ? `Модель ${model} доступна` : `Модель ${model} не найдена в списке. Доступны, например: ${models.slice(0, 5).join(', ')}`,
      status: has ? ('pass' as const) : ('warn' as const),
    };
  });

  return { accountInfo: { models: models.slice(0, 40) } };
};

/* ------------------------------- IndexNow ------------------------------ */

export const validateIndexNow: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const key = field(ctx, 'key');
  const host = field(ctx, 'host').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const keyLocation = field(ctx, 'keyLocation') || (host ? `https://${host}/${key}.txt` : '');

  await runner.step('format', 'Формат ключа', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: IndexNow не опрашивается' };
    if (!key) throw new Error('Ключ IndexNow не передан (8–128 символов: буквы, цифры, дефис)');
    if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) {
      throw new Error('Ключ должен состоять из 8–128 символов: латиница, цифры и дефис (без подчёркиваний и пробелов)');
    }
    if (!host) throw new Error('Укажите хост сайта, например example.ru');
    return { message: `Ключ корректен, файл ключа: ${keyLocation}` };
  });

  await runner.step('keyfile', 'Файл ключа', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    const result = await httpRequest(keyLocation, { raw: true, timeoutMs: 12_000, retries: 0 });
    if (!result.ok) {
      return {
        status: 'warn' as const,
        message: `Файл ключа недоступен (HTTP ${result.status}). MARK умеет выложить его сам через коннектор сайта (FTP/Git/Tilda).`,
      };
    }
    const matches = result.text.trim() === key;
    return {
      message: matches ? 'Файл ключа найден и совпадает' : 'Файл найден, но содержимое отличается от ключа — исправьте или дайте MARK перезаписать его',
      status: matches ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('ping', 'Отправка тестового URL', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    const result = await httpJson('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: { host, key, keyLocation, urlList: [`https://${host}/`] },
      timeoutMs: 12_000,
    });
    if (result.status === 200 || result.status === 202) {
      return { message: `IndexNow принял запрос (HTTP ${result.status}) — Яндекс/Bing/Seznam получат URL немедленно` };
    }
    if (result.status === 403) throw new Error('Ключ не подтверждён (403): сначала выложите файл ключа в корень сайта');
    if (result.status === 422) return { status: 'warn' as const, message: 'URL не принят (422): проверьте хост и что URL принадлежит сайту' };
    if (result.status === 429) return { status: 'warn' as const, message: 'Превышена частота запросов (429) — это нормально, повторим позже' };
    return { status: 'warn' as const, message: `Ответ ${result.status}: ${result.text.slice(0, 160)}` };
  });

  return { accountInfo: { host, keyLocation, sandbox } };
};

/* --------------------- Универсальная проверка сессии --------------------- */

export const validateBrowserSession: Validator = async (ctx, runner) => {
  const probeUrl = ctx.account?.meta?.probeUrl as string | undefined;
  const mustContain = (ctx.account?.meta?.mustContain as string[] | undefined) ?? [];

  await runner.step(
    'session',
    'Сессия браузера',
    async () => {
      if (!ctx.cookiesHeader) {
        return {
          status: 'warn' as const,
          message:
            'Сессия ещё не получена. Нажмите «Открыть окно входа» — авторизуйтесь (пароль, СМС, 2FA, капча) в открывшемся окне, и MARK сам подхватит cookies.',
        };
      }
      if (!probeUrl) {
        return { message: 'Cookies сохранены. Проверка доступности сервиса выполнится при первой задаче.' };
      }
      const result = await httpRequest(probeUrl, {
        headers: { Cookie: ctx.cookiesHeader },
        raw: true,
        timeoutMs: 15_000,
        retries: 0,
      });
      if (!result.ok) {
        return {
          status: 'warn' as const,
          message: `Запрос с сохранённой сессией вернул HTTP ${result.status}. Сессия могла истечь — повторите вход.`,
        };
      }
      const missing = mustContain.filter((needle) => !result.text.includes(needle));
      return {
        status: missing.length ? ('warn' as const) : ('pass' as const),
        message: missing.length
          ? `Страница открылась, но не найдены признаки авторизации (${missing.join(', ')}). Возможно, нужен повторный вход.`
          : 'Сессия активна — MARK может управлять сервисом от вашего имени',
      };
    },
    probeUrl ? `Проверяем ${probeUrl}` : 'Ожидаем окно входа',
  );

  await runner.step('capabilities', 'Доступные возможности', async () => {
    if (!ctx.cookiesHeader) return { status: 'warn' as const, message: 'Возможности определятся после входа' };
    return { message: 'Сессия сохранена в зашифрованном виде; MARK обновит её автоматически при необходимости' };
  });

  return { accountInfo: { sessionBased: true, probeUrl: probeUrl ?? null } };
};
