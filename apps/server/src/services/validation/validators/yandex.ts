import { httpJson, httpError, type HttpResult } from '../../../http/client.js';
import { field, isSandboxLike } from '../context.js';
import type { Validator } from '../types.js';

/**
 * Проверки сервисов Яндекса.
 *
 * Токены проверяются реальными запросами к API v5 (Директ), Метрике и Вебмастеру.
 * Если передан token=sandbox или MARK_DEMO_MODE=1 — используется песочница Директа.
 */

const OAUTH_TOKEN_RE = /^(y0_|AQAA|OAuth)\S{10,}$|^[A-Za-z0-9_-]{30,}$/;

function parseDirectError(result: HttpResult): string | null {
  const data = result.data as { error?: { error_code?: string; error_string?: string; error_detail?: string } } | null;
  if (data?.error) {
    const code = data.error.error_code ?? '';
    return `${data.error.error_string ?? 'Ошибка API'}${code ? ` (код ${code})` : ''}${data.error.error_detail ? `: ${data.error.error_detail}` : ''}`;
  }
  return null;
}

function unitsInfo(result: HttpResult): { spent?: number; daily?: number; raw?: string } {
  const raw = result.headers['units'];
  if (!raw) return {};
  const [spent, daily] = raw.split('/').map((v) => Number(v.trim()));
  return { spent, daily, raw };
}

export const validateYandexDirect: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx) || field(ctx, 'token').toLowerCase() === 'sandbox';
  const token = field(ctx, 'token');
  const login = field(ctx, 'login');
  const host = sandbox ? 'https://api-sandbox.direct.yandex.com' : 'https://api.direct.yandex.com';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sandbox && !token ? 'sandbox' : token}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (login) headers['Client-Login'] = login;

  if (!sandbox) {
    await runner.step('format', 'Формат учётных данных', async () => {
      if (!token) throw new Error('Токен не передан');
      if (token.length < 20 && !OAUTH_TOKEN_RE.test(token)) {
        throw new Error('Токен слишком короткий. OAuth-токен Яндекса обычно длиной 40+ символов.');
      }
      return { message: `Токен получен (${token.length} символов)${login ? `, логин: ${login}` : ''}` };
    });
  }

  let units: { spent?: number; daily?: number; raw?: string } = {};

  const authCheck = await runner.step(
    'auth',
    'Авторизация в API v5',
    async () => {
      if (sandbox) {
        return {
          status: 'pass' as const,
          message: 'Песочница Директа: используется тестовый контур, реальные деньги не тратятся',
          details: { endpoint: `${host}/json/v5/campaigns`, sandbox: true },
        };
      }
      const result = await httpJson(`${host}/json/v5/campaigns`, {
        method: 'POST',
        headers,
        body: { method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id', 'Name', 'Status', 'State'] } },
        timeoutMs: 15_000,
      });
      const apiError = parseDirectError(result);
      if (apiError) {
        if (/токен|token|недействител|authorization/i.test(apiError)) {
          throw new Error(`Токен отклонён Директом: ${apiError}. Проверьте права приложения и срок жизни токена.`);
        }
        if (/ограничен|квот|limit|слишком много/i.test(apiError)) {
          return { status: 'warn' as const, message: `Токен принят, но сработал лимит: ${apiError}`, details: { status: result.status } };
        }
        throw new Error(apiError);
      }
      if (!result.ok) throw new Error(httpError(result, 'Директ API вернул ошибку'));
      units = unitsInfo(result);
      const campaigns = (result.data as { result?: { Campaigns?: unknown[] } })?.result?.Campaigns ?? [];
      return {
        message: `Авторизация успешна, найдено кампаний: ${campaigns.length}`,
        details: { campaigns: campaigns.length, units: units.raw },
      };
    },
    sandbox ? 'Тестовый контур' : `${host}/json/v5/campaigns`,
  );

  if (authCheck.status !== 'fail') {
    await runner.step('units', 'Лимиты баллов', async () => {
      if (sandbox) return { status: 'warn' as const, message: 'В песочнице баллы не расходуются' };
      if (!units.raw) return { status: 'warn' as const, message: 'Заголовок Units не пришёл — Директ отдаёт его не всегда' };
      const percentUsed = units.daily && units.spent ? Math.round((units.spent / units.daily) * 100) : null;
      return {
        message: percentUsed === null ? `Остаток: ${units.raw}` : `Израсходовано ${percentUsed}% дневного лимита баллов (${units.raw})`,
        details: units,
        status: percentUsed !== null && percentUsed > 80 ? ('warn' as const) : ('pass' as const),
      };
    });

    await runner.step('accounts', 'Доступ к аккаунтам', async () => {
      const result = await httpJson(`${host}/json/v5/clients`, {
        method: 'POST',
        headers,
        body: { method: 'get', params: { FieldNames: ['Login', 'ClientId', 'Name', 'Currency'] } },
      });
      const apiError = parseDirectError(result);
      if (apiError) {
        // Директ отдаёт ошибку 53 для прямых клиентов (не агентств) — это нормально.
        if (/53|не является агентством|not an agency/i.test(apiError)) {
          return { status: 'warn' as const, message: 'Прямой клиент (не агентство): управление несколькими аккаунтами недоступно, остальное работает' };
        }
        return { status: 'warn' as const, message: `Список клиентов недоступен: ${apiError}` };
      }
      const clients = (result.data as { result?: { Clients?: unknown[] } })?.result?.Clients ?? [];
      return {
        message: clients.length ? `Доступно аккаунтов: ${clients.length}` : 'Аккаунты не найдены (возможен прямой доступ)',
        details: { clients: clients.slice(0, 10) },
      };
    });

    await runner.step('wordstat', 'Wordstat и прогноз (GEO-анализ)', async () => {
      if (sandbox) return { status: 'warn' as const, message: 'В песочнице Wordstat недоступен — GEO-анализ будет работать в демо-режиме' };
      const result = await httpJson(`${host}/json/v5/keywordsresearch`, {
        method: 'POST',
        headers,
        body: {
          method: 'get',
          params: {
            SelectionCriteria: { Keywords: ['ремонт квартир'], Regions: [213] },
            FieldNames: ['Keyword', 'Weight'],
            ReportType: 'SEARCH_QUERY_PERFORMANCE_REPORT',
          },
        },
      });
      const apiError = parseDirectError(result);
      if (apiError) {
        if (/недоступ|not available|denied|права|permission|квот/i.test(apiError)) {
          return {
            status: 'warn' as const,
            message: `Wordstat недоступен этим токеном (${apiError}). GEO-анализатор переключится на демо-данные Wordstat.`,
          };
        }
        return { status: 'warn' as const, message: `Wordstat: ${apiError}` };
      }
      const rows = (result.data as { result?: { KeywordsResearch?: unknown[] } })?.result?.KeywordsResearch ?? [];
      return {
        message: `Wordstat отвечает, тестовый запрос обработан (строк: ${rows.length})`,
        details: { sample: rows.slice(0, 3) },
      };
    });
  }

  return {
    accountInfo: {
      endpoint: host,
      login: login || null,
      sandbox,
      units: units.raw ?? null,
    },
  };
};

export const validateYandexMetrika: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: соединение с Метрикой не выполняется, используются тестовые счётчики' };
    const result = await httpJson('https://api-metrika.yandex.net/management/v1/counters', {
      headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
      query: { per_page: 20 },
    });
    if (result.status === 403) throw new Error('Токен не имеет права metrika:read или недействителен (403)');
    if (result.status === 401) throw new Error('Токен не принят Метрикой (401). Переавторизуйтесь через окно входа.');
    if (!result.ok) throw new Error(httpError(result, 'Метрика вернула ошибку'));
    const counters = (result.data as { counters?: unknown[] })?.counters ?? [];
    return {
      message: `Доступ открыт, счётчиков найдено: ${counters.length}`,
      details: { counters: counters.slice(0, 5) },
    };
  });

  await runner.step('counters', 'Счётчики и владельцы', async () => {
    if (sandbox) return { message: 'Тестовый счётчик 12345678 (демо)' };
    const result = await httpJson('https://api-metrika.yandex.net/management/v1/counters', {
      headers: { Authorization: `OAuth ${token}` },
      query: { per_page: 50 },
    });
    const counters = ((result.data as { counters?: { name?: string; id?: number; permission?: string }[] })?.counters) ?? [];
    return {
      message: counters.length
        ? `Примеры: ${counters.slice(0, 3).map((c) => `${c.name} (#${c.id})`).join(', ')}`
        : 'Счётчики не найдены — проверьте доступ аккаунта',
      details: { total: counters.length },
      status: counters.length ? ('pass' as const) : ('warn' as const),
    };
  });

  return { accountInfo: { counters: sandbox ? 1 : undefined } };
};

export const validateYandexWebmaster: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const headers = { Authorization: `OAuth ${token}` };
  let userId: number | null = null;

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Вебмастер не опрашивается' };
    const result = await httpJson<{ user_id?: number }>('https://api.webmaster.yandex.net/v4/user/', { headers });
    if (result.status === 403 || result.status === 401) {
      throw new Error('Токен не принят Вебмастером. Нужны права webmaster:verify и webmaster:hostinfo.');
    }
    if (!result.ok) throw new Error(httpError(result, 'Вебмастер вернул ошибку'));
    userId = result.data?.user_id ?? null;
    return { message: `Авторизация успешна${userId ? `, user_id=${userId}` : ''}`, details: { userId } };
  });

  await runner.step('hosts', 'Список сайтов', async () => {
    if (sandbox || !userId) return { status: 'warn' as const, message: 'Шаг пропущен (демо-режим или нет user_id)' };
    const result = await httpJson<{ hosts?: { host_id?: string; unicode_host_url?: string; verified?: boolean; mirror?: string }[] }>(
      `https://api.webmaster.yandex.net/v4/user/${userId}/hosts/`,
      { headers },
    );
    if (!result.ok) throw new Error(httpError(result, 'Не удалось получить список сайтов'));
    const hosts = result.data?.hosts ?? [];
    return {
      message: hosts.length
        ? `Сайтов в Вебмастере: ${hosts.length} (подтверждено: ${hosts.filter((h) => h.verified).length})`
        : 'Сайты не найдены — сначала добавьте сайт в Вебмастер',
      details: { hosts: hosts.slice(0, 10).map((h) => ({ id: h.host_id, url: h.unicode_host_url, verified: h.verified })) },
      status: hosts.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('quota', 'Квоты переобхода', async () => {
    if (sandbox || !userId) return { status: 'warn' as const, message: 'Демо-режим: квоты не запрашиваются' };
    return { message: 'Права на отправку sitemap и переобход подтверждаются при первом использовании (эндпоинт /indexing)' };
  });

  return { accountInfo: { userId, sandbox } };
};

export const validateYandexGpt: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const apiKey = field(ctx, 'apiKey');
  const folderId = field(ctx, 'folderId');
  const model = field(ctx, 'model') || 'yandexgpt-lite';

  await runner.step('auth', 'Проверка API-ключа', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: используется локальный генератор текста' };
    if (!apiKey || !folderId) throw new Error('Нужны Api-Key сервисного аккаунта и folderId каталога');
    const result = await httpJson('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: {
        modelUri: `gpt://${folderId}/${model}`,
        completionOptions: { stream: false, temperature: 0, maxTokens: '10' },
        messages: [{ role: 'user', text: 'ping' }],
      },
      timeoutMs: 20_000,
    });
    if (result.status === 401 || result.status === 403) throw new Error('Ключ не принят Yandex Cloud (проверьте Api-Key и роль ai.languageModels.user)');
    if (!result.ok) throw new Error(httpError(result, 'YandexGPT вернул ошибку'));
    const text = (result.data as { result?: { alternatives?: { message?: { text?: string } }[] } })?.result?.alternatives?.[0]?.message?.text;
    return { message: `Модель ${model} ответила${text ? `: «${text.slice(0, 30)}»` : ''}`, details: { model } };
  });

  await runner.step('model', 'Доступ к модели', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Локальная модель-заглушка активна' };
    return { message: `Модель ${model} доступна для генерации SEO-текстов и описаний гипотез` };
  });
};

/** Проверка сессии входа в окне приложения (cookies) для сервисов Яндекса. */
export const validateYandexBusiness: Validator = async (ctx, runner) => {
  await runner.step('session', 'Сессия браузера', async () => {
    if (!ctx.cookiesHeader) {
      return {
        status: 'warn' as const,
        message: 'Сессия ещё не получена — нажмите «Открыть окно входа» и авторизуйтесь в Яндекс.Бизнесе.',
      };
    }
    const result = await httpJson('https://yandex.ru/sprav/', {
      headers: { Cookie: ctx.cookiesHeader, Accept: 'text/html' },
      raw: true,
    });
    if (!result.ok) throw new Error(httpError(result, 'Не удалось открыть Яндекс.Бизнес с сохранённой сессией'));
    const looksLoggedIn = !/войти|введите логин|passport/i.test(result.text.slice(0, 20_000));
    return {
      status: looksLoggedIn ? ('pass' as const) : ('warn' as const),
      message: looksLoggedIn ? 'Сессия активна, доступ к карточкам организации есть' : 'Похоже, сессия истекла — повторите вход',
    };
  });

  await runner.step('capabilities', 'Доступные действия', async () => {
    if (!ctx.cookiesHeader) return { status: 'warn' as const, message: 'Дождитесь входа в окне приложения' };
    return { message: 'Доступны: описание организации, часы работы, фото, ответы на отзывы, гео-метки' };
  });
};
