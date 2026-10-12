import { httpError, httpJson } from '../../../http/client.js';
import { googleTokenInfo, resolveGoogleAccessToken } from '../../google-auth.js';
import { field, isSandboxLike } from '../context.js';
import type { Validator } from '../types.js';

/** Проверки сервисов Google: Ads, GA4, Search Console, Business Profile. */

const ADS_API_VERSIONS = ['v24', 'v23', 'v22', 'v21', 'v20', 'v19'];

function credsFrom(ctx: { fields: Record<string, string> }) {
  return {
    accessToken: ctx.fields.accessToken?.trim(),
    refreshToken: ctx.fields.refreshToken?.trim(),
    clientId: ctx.fields.clientId?.trim(),
    clientSecret: ctx.fields.clientSecret?.trim(),
    serviceAccountJson: ctx.fields.serviceAccountJson?.trim(),
  };
}

async function resolveToken(runner: Parameters<Validator>[1], ctx: Parameters<Validator>[0]) {
  const credentials = credsFrom(ctx);
  const resolved = await resolveGoogleAccessToken(credentials);
  await runner.step('tokeninfo', 'Проверка токена', async () => {
    if (isSandboxLike(ctx)) return { status: 'pass' as const, message: 'Демо-режим: обращения к Google не выполняются' };
    if (!resolved.ok || !resolved.token) throw new Error(resolved.error ?? 'Не удалось получить access_token');
    const info = await googleTokenInfo(resolved.token);
    if (!info.ok) throw new Error(`Google отклонил токен: ${info.error}`);
    return {
      message: `Токен действителен${info.email ? ` (${info.email})` : ''}${info.expiresIn ? `, истекает через ${Math.round(info.expiresIn / 60)} мин` : ''}`,
      details: { method: resolved.method, scopes: info.scopes?.slice(0, 12), email: info.email },
    };
  });
  return resolved.token;
}

export const validateGoogleAds: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const developerToken = field(ctx, 'developerToken');
  const loginCustomerId = field(ctx, 'loginCustomerId');
  const accessToken = await resolveToken(runner, ctx);
  let workingVersion: string | null = null;
  let customers: string[] = [];

  if (!sandbox) {
    await runner.step('devtoken', 'Developer token', async () => {
      if (!developerToken) throw new Error('Не указан developer-token — без него Google Ads API недоступен');
      if (developerToken.length < 15) throw new Error('developer-token выглядит слишком коротким');
      return { message: `Developer token получен (${developerToken.length} символов)` };
    });

    await runner.step('version', 'Версия API', async () => {
      for (const version of ADS_API_VERSIONS) {
        const result = await httpJson(`https://googleads.googleapis.com/${version}/customers:listAccessibleCustomers`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': developerToken,
            ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}),
          },
          timeoutMs: 12_000,
        });
        if (result.ok) {
          workingVersion = version;
          customers = ((result.data as { resourceNames?: string[] })?.resourceNames ?? []).map((r) => r.split('/')[1] ?? r);
          return {
            message: `Рабочая версия API: ${version}. Доступных аккаунтов: ${customers.length}`,
            details: { version, customers: customers.slice(0, 20) },
            status: customers.length ? ('pass' as const) : ('warn' as const),
          };
        }
        if ([404, 400, 405].includes(result.status)) continue;
        if (result.status === 401) throw new Error('Access token отклонён Google Ads (401). Получите новый токен.');
        if (result.status === 403) {
          const message = result.text.slice(0, 400);
          if (/developer token/i.test(message)) {
            throw new Error('Developer token не одобрен для этого аккаунта (нужен Basic access). Запросите доступ в Google Ads API Center.');
          }
          throw new Error(`Доступ запрещён (403): ${message}`);
        }
        throw new Error(httpError(result, 'Google Ads API вернул ошибку'));
      }
      throw new Error(`Ни одна из версий API (${ADS_API_VERSIONS.join(', ')}) не ответила. Проверьте developer-token и доступ к сети.`);
    });

    await runner.step('customers', 'Доступные аккаунты', async () => {
      if (!workingVersion) return { status: 'warn' as const, message: 'Пропущено: рабочая версия API не определена' };
      if (!customers.length) {
        return { status: 'warn' as const, message: 'Аккаунты не найдены. Для MCC укажите login-customer-id, для одного аккаунта — id клиента в настройках кампании.' };
      }
      return {
        message: `Найдено клиентских аккаунтов: ${customers.length}. Первые: ${customers.slice(0, 5).join(', ')}`,
        details: { customers },
      };
    });
  } else {
    workingVersion = 'sandbox';
  }

  return {
    accountInfo: {
      apiVersion: workingVersion,
      customers: customers.slice(0, 50),
      loginCustomerId: loginCustomerId || null,
      sandbox,
    },
  };
};

export const validateGoogleAnalytics: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const accessToken = await resolveToken(runner, ctx);
  let properties: { name?: string; displayName?: string }[] = [];

  await runner.step('properties', 'Свойства GA4', async () => {
    if (sandbox || !accessToken) return { status: 'warn' as const, message: 'Демо-режим: свойства не запрашиваются' };
    const result = await httpJson<{ accountSummaries?: { propertySummaries?: { property?: string; displayName?: string }[] }[] }>(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      { headers: { Authorization: `Bearer ${accessToken}` }, query: { pageSize: 50 } },
    );
    if (!result.ok) {
      if (result.status === 403) throw new Error('Нет прав analytics.readonly или сервисный аккаунт не добавлен в GA4-ресурс');
      throw new Error(httpError(result, 'GA4 Admin API вернул ошибку'));
    }
    properties = (result.data?.accountSummaries ?? []).flatMap((a) => a.propertySummaries ?? []);
    return {
      message: properties.length ? `Доступно свойств GA4: ${properties.length}` : 'Свойства не найдены — добавьте сервисный аккаунт в GA4 (Администратор → Управление доступом)',
      details: { properties: properties.slice(0, 10) },
      status: properties.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('access', 'Права на чтение данных', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: данные GA4 генерируются локально' };
    const propertyId = field(ctx, 'propertyId').replace(/^properties\//, '');
    if (!propertyId) {
      return {
        message: properties.length ? 'Property ID не указан — подставьте его в кампании или в настройках отчёта' : 'Property ID не указан',
        status: properties.length ? ('pass' as const) : ('warn' as const),
      };
    }
    const result = await httpJson(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: { dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] },
    });
    if (!result.ok) throw new Error(httpError(result, `Не удалось прочитать свойство ${propertyId}`));
    const row = (result.data as { rows?: { metricValues?: { value?: string }[] }[] })?.rows?.[0];
    return { message: `Свойство ${propertyId} читается (сессии за 7 дней: ${row?.metricValues?.[0]?.value ?? 'нет данных'})` };
  });

  return { accountInfo: { properties: properties.slice(0, 50) } };
};

export const validateGoogleSearchConsole: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const accessToken = await resolveToken(runner, ctx);
  let sites: string[] = [];

  await runner.step('sites', 'Список ресурсов', async () => {
    if (sandbox || !accessToken) return { status: 'warn' as const, message: 'Демо-режим: ресурсы не запрашиваются' };
    const result = await httpJson<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>(
      'https://www.googleapis.com/webmasters/v3/sites',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!result.ok) throw new Error(httpError(result, 'Search Console API вернул ошибку'));
    sites = (result.data?.siteEntry ?? []).map((s) => s.siteUrl ?? '').filter(Boolean);
    return {
      message: sites.length ? `Ресурсов в Search Console: ${sites.length}` : 'Ресурсы не найдены — добавьте сайт в Search Console для этого аккаунта',
      details: { sites: sites.slice(0, 10) },
      status: sites.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('sitemaps', 'Sitemap', async () => {
    if (sandbox || !accessToken) return { status: 'warn' as const, message: 'Демо-режим' };
    const site = encodeURIComponent(sites[0] ?? field(ctx, 'siteUrl') ?? '');
    if (!site) return { status: 'warn' as const, message: 'Не выбран ресурс для проверки sitemap' };
    const result = await httpJson(`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!result.ok) return { status: 'warn' as const, message: `Sitemap не прочитан: HTTP ${result.status}` };
    const maps = (result.data as { sitemap?: { path?: string; lastDownloaded?: string }[] })?.sitemap ?? [];
    return {
      message: maps.length ? `Загружено карт: ${maps.length} (последняя: ${maps[0]?.path ?? '—'})` : 'Sitemap ещё не загружался — MARK может отправить его автоматически',
    };
  });

  return { accountInfo: { sites } };
};

export const validateGoogleBusinessProfile: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const accessToken = await resolveToken(runner, ctx);
  let accounts: string[] = [];

  await runner.step('accounts', 'Аккаунты', async () => {
    if (sandbox || !accessToken) return { status: 'warn' as const, message: 'Демо-режим: аккаунты не запрашиваются' };
    const result = await httpJson<{ accounts?: { name?: string; accountName?: string; type?: string }[] }>(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${accessToken}` }, query: { pageSize: 20 } },
    );
    if (!result.ok) {
      if (result.status === 403) {
        throw new Error('Нет доступа к Business Profile API (нужно одобрение Google для проекта и scope business.manage)');
      }
      throw new Error(httpError(result, 'Business Profile API вернул ошибку'));
    }
    accounts = (result.data?.accounts ?? []).map((a) => a.accountName ?? a.name ?? '').filter(Boolean);
    return {
      message: accounts.length ? `Аккаунтов: ${accounts.length}` : 'Бизнес-аккаунты не найдены',
      details: { accounts: accounts.slice(0, 10) },
      status: accounts.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('locations', 'Локации', async () => {
    if (sandbox || !accessToken || !accounts.length) return { status: 'warn' as const, message: 'Демо-режим или нет аккаунтов' };
    const result = await httpJson<{ locations?: { locationName?: string; title?: string }[] }>(
      'https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations',
      { headers: { Authorization: `Bearer ${accessToken}` }, query: { pageSize: 20, readMask: 'name,title,storefrontAddress' } },
    );
    if (!result.ok) return { status: 'warn' as const, message: `Локации не прочитаны (HTTP ${result.status}) — возможно, требуется доп. включение API` };
    const locations = result.data?.locations ?? [];
    return { message: `Карточек организации: ${locations.length}`, details: { locations: locations.slice(0, 10) } };
  });

  return { accountInfo: { accounts } };
};
