import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_LOGIN_URLS, BROWSER_SESSION_PROBES, getService, type LoginSession } from '@mark/shared';
import { config } from '../config.js';
import { decryptJson, encryptJson, randomId } from '../crypto.js';
import { repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';

/**
 * Окна входа в сервисы.
 *
 * Сценарии:
 *  1) Electron (рекомендуется): десктопное приложение открывает настоящее окно браузера
 *     с изолированным хранилищем и присылает cookies на /api/sessions/:id/cookies.
 *  2) Playwright (опция): сервер сам запускает Chromium/Chrome в видимом режиме
 *     (если установлен пакет playwright-core и есть системный браузер).
 *  3) Ручной импорт: пользователь копирует cookie-строку из DevTools браузера.
 *
 * Cookies хранятся зашифрованными (AES-256-GCM) и привязаны к подключению сервиса.
 */

const log = rootLogger.child('browser-sessions');

export interface StartSessionOptions {
  serviceId: string;
  tenantId: string;
  clientId?: string | null;
  url?: string;
  mode?: LoginSession['mode'];
  /** Учётка, к которой привязать сессию */
  accountId?: string | null;
}

export interface CookieJar {
  /** Заголовок Cookie целиком */
  cookieHeader: string;
  cookies: { name: string; value: string; domain?: string; path?: string }[];
  userAgent?: string;
  savedAt: string;
  source: 'electron' | 'playwright' | 'manual';
}

export function loginUrlFor(serviceId: string, override?: string): string | null {
  if (override) return override;
  if (BROWSER_LOGIN_URLS[serviceId]) return BROWSER_LOGIN_URLS[serviceId];
  const service = getService(serviceId);
  return service?.docsUrl ?? null;
}

export function probeFor(serviceId: string) {
  return BROWSER_SESSION_PROBES[serviceId] ?? null;
}

export async function startLoginSession(options: StartSessionOptions): Promise<LoginSession> {
  const { tenantId, serviceId } = options;
  const now = new Date().toISOString();
  const url = loginUrlFor(serviceId, options.url) ?? 'https://example.com';
  const session: LoginSession = {
    id: randomId('login'),
    serviceId,
    url,
    mode: options.mode ?? 'electron',
    status: 'waiting_user',
    cookiesCount: 0,
    message:
      options.mode === 'electron'
        ? 'Открываем окно входа в приложении. Войдите в аккаунт — пароль, СМС, капча остаются у вас.'
        : 'Открываем окно входа. После авторизации MARK сам сохранит сессию.',
    createdAt: now,
    updatedAt: now,
  };

  const { loginSession } = await repos();
  loginSession.put({
    ...session,
    tenantId,
    clientId: options.clientId ?? null,
    accountId: options.accountId ?? null,
    serviceId,
    kind: 'login_session',
    status: session.status,
  } as never);

  hub.publish(channels.login(session.id), 'session', session);
  hub.publish(channels.activity, 'login:started', { sessionId: session.id, serviceId, url });

  if (session.mode === 'playwright') {
    // Запускаем браузер в фоне; если не получилось — сообщаем пользователю
    void launchPlaywright(session.id, url, serviceId, tenantId).catch((error) => {
      log.warn('Playwright-окно не запущено', error);
    });
  }

  log.info(`Сессия входа создана: ${serviceId} → ${url}`, { id: session.id, mode: session.mode });
  return session;
}

async function launchPlaywright(sessionId: string, url: string, serviceId: string, tenantId: string): Promise<void> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    await updateSession(sessionId, {
      status: 'failed',
      error:
        'Модуль playwright-core не установлен или нет графического окружения. Используйте десктопное приложение MARK (в нём окно входа работает без зависимостей) или импортируйте cookies вручную.',
    });
    return;
  }

  const userDataDir = path.join(config.sessionsDir, sessionId);
  fs.mkdirSync(userDataDir, { recursive: true });

  const candidates: ('chrome' | 'msedge' | 'chromium')[] = ['chrome', 'msedge', 'chromium'];
  let context: import('playwright-core').BrowserContext | null = null;
  let launched: string | null = null;

  for (const channel of candidates) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: channel === 'chromium' ? undefined : channel,
        headless: false,
        args: ['--no-first-run', '--no-default-browser-check'],
        viewport: { width: 1280, height: 900 },
      });
      launched = channel;
      break;
    } catch (error) {
      log.debug(`Не удалось запустить ${channel}`, error);
    }
  }

  if (!context) {
    await updateSession(sessionId, {
      status: 'failed',
      error:
        'Не найден браузер для окна входа. Установите Chrome/Edge или используйте десктопное приложение MARK.',
    });
    return;
  }

  await updateSession(sessionId, { status: 'waiting_user', message: `Окно входа открыто (${launched}). Выполните вход.` });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    page.on('framenavigated', () => {
      void updateSession(sessionId, { message: `Текущий адрес: ${page.url()}` });
    });

    const deadline = Date.now() + 10 * 60 * 1000;
    let captured = false;
    while (Date.now() < deadline && !captured) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const pages = context.pages();
      const probe = pages.find((p) => p.url().startsWith('http'));
      if (!probe) continue;
      const cookies = await context.cookies();
      const meaningful = cookies.filter((cookie) => /session|auth|token|sid|passport|SID|login/i.test(cookie.name));
      const looksLoggedIn = meaningful.length > 0 || cookies.length > 8;
      if (looksLoggedIn) {
        captured = true;
        await saveCookies(
          sessionId,
          {
            cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
            cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
            userAgent: await probe.evaluate(() => navigator.userAgent).catch(() => undefined),
            savedAt: new Date().toISOString(),
            source: 'playwright',
          },
          tenantId,
          serviceId,
        );
        break;
      }
    }

    if (!captured) {
      await updateSession(sessionId, { status: 'failed', error: 'Вход не завершён за 10 минут. Попробуйте снова или используйте десктопное приложение.' });
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function updateSession(sessionId: string, patch: Partial<LoginSession> & { error?: string; message?: string }) {
  const { loginSession } = await repos();
  const current = loginSession.get(sessionId);
  if (!current) return null;
  const next = loginSession.patch(sessionId, { ...patch, updatedAt: new Date().toISOString(), status: patch.status ?? current.status } as never);
  if (next) {
    const session: LoginSession = {
      id: next.id,
      serviceId: String(next.serviceId),
      url: String(next.url),
      mode: (next.mode as LoginSession['mode']) ?? 'electron',
      status: (next.status as LoginSession['status']) ?? 'waiting_user',
      cookiesCount: Number(next.cookiesCount ?? 0),
      message: next.message as string | undefined,
      error: next.error as string | undefined,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
    };
    hub.publish(channels.login(sessionId), 'session', session);
    return session;
  }
  return null;
}

/**
 * Сохранение cookies: шифруем и привязываем к подключению сервиса.
 * Если accountId не передан — создаём/обновляем подключение сервиса автоматически.
 */
export async function saveCookies(
  sessionId: string,
  jar: CookieJar,
  tenantId: string,
  serviceId: string,
): Promise<{ ok: boolean; accountId: string; cookiesCount: number }> {
  const { account, secrets, loginSession, client } = await repos();
  const session = loginSession.get(sessionId);
  let accountId = (session?.accountId as string | undefined) ?? '';

  if (!accountId) {
    const existing = account.list({ tenantId, limit: 200 }).find((item) => item.serviceId === serviceId && (item.authMode === 'browser_login' || item.authMode === 'cookie_import'));
    if (existing) {
      accountId = existing.id;
    } else {
      const defaultClient = client.list({ tenantId, limit: 1 })[0];
      const created = account.put({
        id: randomId('acc'),
        tenantId,
        clientId: (session?.clientId as string | undefined) ?? defaultClient?.id ?? null,
        serviceId,
        authMode: 'browser_login',
        label: `${getService(serviceId)?.name ?? serviceId} — вход в браузере`,
        status: 'validating',
        secretPreview: `${jar.cookies.length} cookies`,
        scopes: [],
        meta: {
          probeUrl: probeFor(serviceId)?.url,
          mustContain: probeFor(serviceId)?.mustContainAny,
          source: jar.source,
        },
        sandbox: false,
        lastCheckedAt: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accountId: null,
      } as never);
      accountId = created.id;
    }
  }

  secrets.save(accountId, encryptJson(jar));

  const updated = account.patch(accountId, {
    status: 'valid',
    secretPreview: `${jar.cookies.length} cookies (сохранено ${new Date().toLocaleString('ru-RU')})`,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    meta: {
      probeUrl: probeFor(serviceId)?.url,
      mustContain: probeFor(serviceId)?.mustContainAny,
      source: jar.source,
      userAgent: jar.userAgent,
    },
  } as never);

  await updateSession(sessionId, {
    status: 'captured',
    cookiesCount: jar.cookies.length,
    message: `Сессия сохранена: ${jar.cookies.length} cookies. MARK может работать от вашего имени.`,
    accountId,
  } as never);

  hub.publish(channels.activity, 'login:captured', { sessionId, serviceId, accountId, cookies: jar.cookies.length });
  log.info(`Сессия сохранена: ${serviceId}, cookies ${jar.cookies.length}`, { accountId });

  return { ok: Boolean(updated), accountId, cookiesCount: jar.cookies.length };
}

/** Прочитать cookies подключения (для последующих задач). */
export async function getCookiesHeader(accountId: string): Promise<string | null> {
  const { secrets } = await repos();
  const payload = secrets.load(accountId);
  if (!payload) return null;
  try {
    const jar = decryptJson<CookieJar>(payload);
    return jar.cookieHeader;
  } catch (error) {
    log.error('Не удалось прочитать cookies', error);
    return null;
  }
}

/** Обновить cookies (когда сервис перевыпустил сессию). */
export async function refreshCookies(accountId: string, jar: CookieJar): Promise<void> {
  const { secrets, account } = await repos();
  secrets.save(accountId, encryptJson(jar));
  account.patch(accountId, { status: 'valid', lastCheckedAt: new Date().toISOString(), lastError: null } as never);
  log.info('Cookies обновлены', { accountId, cookies: jar.cookies.length });
}

export function parseCookieHeader(raw: string): CookieJar {
  const pairs = raw
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      if (index === -1) return { name: part, value: '' };
      return { name: part.slice(0, index), value: part.slice(index + 1) };
    });
  return {
    cookieHeader: pairs.map((p) => `${p.name}=${p.value}`).join('; '),
    cookies: pairs,
    savedAt: new Date().toISOString(),
    source: 'manual',
  };
}
