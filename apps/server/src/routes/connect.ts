import { Router } from 'express';
import {
  BROWSER_LOGIN_URLS,
  OAUTH_PROVIDERS,
  SERVICES,
  connectSchema,
  getService,
  validateSchema,
  type AuthModeId,
  type ConnectedAccount,
} from '@mark/shared';
import { config } from '../config.js';
import { decryptJson, encryptJson, maskSecret, randomId, randomToken } from '../crypto.js';
import { repos, type Repos } from '../db/repos.js';
import { ApiError, ah, currentTenantId, ok, parseBody } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';
import {
  getCookiesHeader,
  parseCookieHeader,
  refreshCookies,
  saveCookies,
  startLoginSession,
  updateSession,
} from '../services/browser-sessions.js';
import { authModeHelp, isSessionMode, runValidation } from '../services/validation/index.js';
import type { ValidationContext } from '../services/validation/context.js';

/**
 * Подключения: каталог сервисов, сохранение учётных данных (зашифровано),
 * валидация в реальном времени, окна входа и OAuth-поток.
 */

const log = rootLogger.child('routes.connect');
export const connectRouter = Router();

/* ------------------------------ Каталог ------------------------------ */

connectRouter.get('/services', (_req, res) => {
  ok(
    res,
    SERVICES.map((service) => ({
      ...service,
      hasBrowserLogin: Boolean(BROWSER_LOGIN_URLS[service.id]),
      hasOauth: Boolean(OAUTH_PROVIDERS[service.id]?.authorizeUrl),
    })),
  );
});

connectRouter.get('/services/:id', (req, res) => {
  const service = getService(req.params.id!);
  if (!service) throw new ApiError(404, `Сервис «${req.params.id}» не найден в каталоге`);
  ok(res, {
    ...service,
    hasBrowserLogin: Boolean(BROWSER_LOGIN_URLS[service.id]),
    hasOauth: Boolean(OAUTH_PROVIDERS[service.id]?.authorizeUrl),
    authHelp: Object.fromEntries(service.authModes.map((mode) => [mode.id, authModeHelp(service.id, mode.id)])),
    browserLoginUrl: BROWSER_LOGIN_URLS[service.id] ?? null,
  });
});

/* ------------------------------ Проверки ------------------------------ */

const validations = new Map<string, { result?: unknown; startedAt: number }>();

interface ResolvedContext {
  service: NonNullable<ReturnType<typeof getService>>;
  context: ValidationContext;
}

async function resolveValidationContext(
  db: Repos,
  tenantId: string,
  input: { serviceId: string; authMode: string; fields: Record<string, unknown>; sandbox: boolean; accountId?: string | null },
): Promise<ResolvedContext> {
  const service = getService(input.serviceId);
  if (!service) throw new ApiError(404, `Сервис «${input.serviceId}» не найден`);

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (value === null || value === undefined) continue;
    fields[key] = typeof value === 'string' ? value : String(value);
  }

  // Для сессионных режимов подмешиваем сохранённые cookies
  let account: ConnectedAccount | undefined;
  if (input.accountId) account = db.account.get(input.accountId);
  if (!account && isSessionMode(input.authMode as AuthModeId)) {
    account = db.account.list({ tenantId, limit: 200 }).find((item) => item.serviceId === input.serviceId);
  }
  let cookiesHeader: string | null = null;
  let storedFields: Record<string, string> = {};
  if (account) {
    const payload = db.secrets.load(account.id);
    if (payload) {
      try {
        const decrypted = decryptJson<Record<string, unknown>>(payload);
        if (typeof decrypted.cookieHeader === 'string') cookiesHeader = decrypted.cookieHeader;
        storedFields = Object.fromEntries(
          Object.entries(decrypted).filter(([, value]) => typeof value === 'string') as [string, string][],
        );
      } catch {
        /* секрет повреждён — валидатор сообщит об этом */
      }
    }
  }

  return {
    service,
    context: {
      serviceId: input.serviceId,
      authMode: input.authMode as AuthModeId,
      fields: { ...storedFields, ...fields },
      sandbox: input.sandbox,
      account,
      cookiesHeader,
      emit: () => undefined as void,
    },
  };
}

/** Проверка без сохранения: стримит шаги в канал test:<id> через WebSocket. */
connectRouter.post(
  '/validate',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(validateSchema, req.body);
    const db = await repos();
    const { context } = await resolveValidationContext(db, tenantId, input);
    const validationId = randomId('check');
    validations.set(validationId, { startedAt: Date.now() });

    context.emit = (type, payload) => hub.publish(channels.validation(validationId), type, payload);

    // Ответ отдаём сразу с id — клиент подписывается на канал и получает шаги в реальном времени
    ok(res, { validationId, channel: channels.validation(validationId) }, 202);

    const result = await runValidation(context);
    validations.set(validationId, { result, startedAt: Date.now() });

    if (input.persist && result.status !== 'fail') {
      await persistAccount(db, tenantId, input, result, context.fields);
    }
  }),
);

connectRouter.get('/validate/:id', (req, res) => {
  const entry = validations.get(req.params.id!);
  if (!entry) throw new ApiError(404, 'Результат проверки не найден (создайте новую проверку)');
  ok(res, entry.result ?? { pending: true });
});

/** Синхронная проверка (удобно для автотестов и скриптов). */
connectRouter.post(
  '/validate/sync',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(validateSchema, req.body);
    const db = await repos();
    const { context } = await resolveValidationContext(db, tenantId, input);
    const events: unknown[] = [];
    context.emit = (type, payload) => events.push({ type, payload });
    const result = await runValidation(context);
    if (input.persist && result.status !== 'fail') await persistAccount(db, tenantId, input, result, context.fields);
    ok(res, { result, events });
  }),
);

async function persistAccount(
  db: Repos,
  tenantId: string,
  input: { serviceId: string; authMode: string; clientId?: string | null; fields: Record<string, unknown>; sandbox: boolean; label?: string },
  result: { status: string; accountInfo?: Record<string, unknown>; capabilities?: unknown; checks: { message?: string }[] },
  effectiveFields: Record<string, string> = {},
) {
  const service = getService(input.serviceId);
  const existing = db.account
    .list({ tenantId, limit: 300 })
    .find((item) => item.serviceId === input.serviceId && item.authMode === input.authMode);
  const id = existing?.id ?? randomId('acc');
  const isSession = isSessionMode(input.authMode as never);
  const secretValue = !isSession ? effectiveFields.token ?? effectiveFields.apiKey ?? effectiveFields.appPassword ?? null : null;

  const account = db.account.put({
    id,
    tenantId,
    clientId: (existing?.clientId as string | null) ?? input.clientId ?? null,
    serviceId: input.serviceId,
    authMode: input.authMode,
    label: input.label ?? existing?.label ?? `${service?.name ?? input.serviceId} (${input.authMode})`,
    status: result.status === 'pass' ? 'valid' : result.status === 'warn' ? 'valid' : 'invalid',
    secretPreview: isSession ? existing?.secretPreview ?? 'сессия браузера' : maskSecret(secretValue),
    scopes: (result.capabilities as string[]) ?? [],
    meta: {
      accountInfo: result.accountInfo ?? {},
      lastChecks: result.checks.map((check) => check.message).filter(Boolean).slice(0, 8),
    },
    sandbox: input.sandbox,
    lastCheckedAt: new Date().toISOString(),
    lastError: result.status === 'fail' ? result.checks.find((c) => c.message)?.message ?? 'Проверка не пройдена' : null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  if (!isSession) {
    db.secrets.save(id, encryptJson(effectiveFields));
  }
  hub.publish(channels.activity, 'account:saved', { accountId: id, serviceId: input.serviceId, status: account.status });
  log.info(`Подключение сохранено: ${input.serviceId} (${input.authMode}) — ${account.status}`);
  return account;
}

/* ------------------------------ Подключения ------------------------------ */

connectRouter.get(
  '/accounts',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const items = db.account.list({ tenantId, limit: 300 }).map((item) => ({
      ...item,
      service: getService(String(item.serviceId))?.name ?? item.serviceId,
      capabilities: getService(String(item.serviceId))?.capabilities ?? [],
    }));
    ok(res, items);
  }),
);

connectRouter.post(
  '/accounts',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(connectSchema, req.body);
    const db = await repos();
    const { service, context } = await resolveValidationContext(db, tenantId, {
      serviceId: input.serviceId,
      authMode: input.authMode,
      fields: input.fields as Record<string, unknown>,
      sandbox: input.sandbox,
    });
    const events: unknown[] = [];
    context.emit = (type, payload) => events.push({ type, payload });
    const result = await runValidation(context);
    const account = await persistAccount(
      db,
      tenantId,
      { ...input, fields: input.fields as Record<string, unknown> },
      result,
      context.fields,
    );
    ok(res, { account, result, events }, result.status === 'fail' ? 200 : 201);
  }),
);

connectRouter.patch(
  '/accounts/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.get(req.params.id!);
    if (!account || account.tenantId !== tenantId) throw new ApiError(404, 'Подключение не найдено');
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.label === 'string') patch.label = req.body.label.slice(0, 120);
    if (typeof req.body?.clientId === 'string' || req.body?.clientId === null) patch.clientId = req.body.clientId;
    if (req.body?.enabled === false) patch.status = 'expired';
    const updated = db.account.patch(account.id, patch as never);
    ok(res, updated);
  }),
);

connectRouter.delete(
  '/accounts/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.get(req.params.id!);
    if (!account || account.tenantId !== tenantId) throw new ApiError(404, 'Подключение не найдено');
    db.secrets.delete(account.id);
    db.account.delete(account.id);
    ok(res, { deleted: account.id });
  }),
);

connectRouter.post(
  '/accounts/:id/validate',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.get(req.params.id!);
    if (!account || account.tenantId !== tenantId) throw new ApiError(404, 'Подключение не найдено');

    const validationId = randomId('check');
    const { context } = await resolveValidationContext(db, tenantId, {
      serviceId: String(account.serviceId),
      authMode: String(account.authMode),
      fields: {},
      sandbox: Boolean(account.sandbox),
      accountId: account.id,
    });
    context.emit = (type, payload) => hub.publish(channels.validation(validationId), type, payload);
    ok(res, { validationId, channel: channels.validation(validationId) }, 202);

    const result = await runValidation(context);
    validations.set(validationId, { result, startedAt: Date.now() });
    db.account.patch(account.id, {
      status: result.status === 'fail' ? 'invalid' : 'valid',
      lastCheckedAt: new Date().toISOString(),
      lastError: result.status === 'fail' ? result.checks.find((c) => c.status === 'fail')?.message ?? 'Проверка не пройдена' : null,
    } as never);
  }),
);

/* --------------------------- Окна входа --------------------------- */

connectRouter.post(
  '/sessions',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const serviceId = String(req.body?.serviceId ?? '');
    if (!getService(serviceId)) throw new ApiError(404, `Сервис «${serviceId}» не найден`);
    const session = await startLoginSession({
      serviceId,
      tenantId,
      clientId: req.body?.clientId ?? null,
      url: req.body?.url,
      mode: req.body?.mode ?? 'electron',
      accountId: req.body?.accountId ?? null,
    });
    ok(res, { ...session, channel: channels.login(session.id) }, 201);
  }),
);

connectRouter.get(
  '/sessions',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, db.loginSession.list({ tenantId, limit: 50 }));
  }),
);

connectRouter.get('/sessions/:id', (req, res) => {
  void (async () => {
    const db = await repos();
    const session = db.loginSession.get(req.params.id!);
    if (!session) throw new ApiError(404, 'Сессия не найдена');
    ok(res, session);
  })().catch((error) => {
    throw error;
  });
});

/** Приём cookies из окна входа (Electron, Playwright или ручной импорт). */
connectRouter.post(
  '/sessions/:id/cookies',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const session = db.loginSession.get(req.params.id!);
    if (!session) throw new ApiError(404, 'Сессия не найдена');
    const raw = String(req.body?.cookieHeader ?? '');
    if (!raw) throw new ApiError(422, 'Передайте cookieHeader с cookies сервиса');
    const jarFromBody = req.body?.cookies;
    const jar = Array.isArray(jarFromBody) && jarFromBody.length
      ? {
          cookieHeader: Array.isArray(jarFromBody)
            ? jarFromBody.map((cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`).join('; ')
            : raw,
          cookies: jarFromBody as { name: string; value: string; domain?: string }[],
          userAgent: req.body?.userAgent as string | undefined,
          savedAt: new Date().toISOString(),
          source: 'electron' as const,
        }
      : parseCookieHeader(raw);
    const result = await saveCookies(String(session.id), jar, tenantId, String(session.serviceId));
    ok(res, result);
  }),
);

/** Ручной импорт cookies без создания сессии (если вход недоступен). */
connectRouter.post(
  '/sessions/import',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const serviceId = String(req.body?.serviceId ?? '');
    const cookieHeader = String(req.body?.cookieHeader ?? '');
    if (!getService(serviceId)) throw new ApiError(404, `Сервис «${serviceId}» не найден`);
    if (!cookieHeader) throw new ApiError(422, 'Вставьте строку cookies из DevTools (Network → любой запрос → Cookie)');
    const session = await startLoginSession({ serviceId, tenantId, clientId: req.body?.clientId ?? null, mode: 'manual' });
    const result = await saveCookies(session.id, parseCookieHeader(cookieHeader), tenantId, serviceId);
    ok(res, { session, ...result }, 201);
  }),
);

connectRouter.post(
  '/sessions/:id/close',
  ah(async (req, res) => {
    const session = await updateSession(req.params.id!, { status: 'closed', message: 'Окно входа закрыто пользователем' });
    if (!session) throw new ApiError(404, 'Сессия не найдена');
    ok(res, session);
  }),
);

/* ------------------------------ OAuth ------------------------------ */

interface OauthState {
  serviceId: string;
  tenantId: string;
  clientId?: string | null;
  redirectUri: string;
  clientIdValue?: string;
  clientSecret?: string;
  createdAt: string;
  implicit: boolean;
}

function callbackUrl(req: { protocol: string; get: (name: string) => string | undefined }): string {
  const host = req.get('host') ?? `localhost:${config.port}`;
  const proto = req.get('x-forwarded-proto') ?? req.protocol ?? 'http';
  return `${proto}://${host}/api/oauth/callback`;
}

connectRouter.post(
  '/oauth/:serviceId/start',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const serviceId = req.params.serviceId!;
    const provider = OAUTH_PROVIDERS[serviceId];
    if (!provider?.authorizeUrl) throw new ApiError(400, `Для сервиса «${serviceId}» OAuth не настроен — используйте вход в окне приложения или API-токен`);
    const db = await repos();
    const clientIdValue = String(req.body?.clientId ?? '');
    const clientSecret = req.body?.clientSecret ? String(req.body.clientSecret) : undefined;
    const implicit = provider.implicit && !clientSecret;
    if (!clientIdValue && !implicit) throw new ApiError(422, 'Укажите client_id приложения (и client_secret для конфиденциального клиента)');

    const state = randomToken(24);
    const redirectUri = callbackUrl(req);
    const payload: OauthState = {
      serviceId,
      tenantId,
      clientId: req.body?.clientIdAccount ?? null,
      redirectUri,
      clientIdValue,
      clientSecret,
      createdAt: new Date().toISOString(),
      implicit,
    };
    db.kv.set(`oauth:${state}`, payload);

    const url = new URL(provider.authorizeUrl);
    url.searchParams.set('response_type', implicit ? 'token' : 'code');
    if (clientIdValue) url.searchParams.set('client_id', clientIdValue);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    if (provider.scope) url.searchParams.set('scope', provider.scope);
    for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) url.searchParams.set(key, value);
    if (!clientIdValue) url.searchParams.set('client_id', 'mark-built-in');

    ok(res, { authorizeUrl: url.toString(), state, implicit, redirectUri });
  }),
);

/** OAuth-callback: обмен кода на токен и сохранение подключения. */
connectRouter.get(
  '/oauth/callback',
  ah(async (req, res) => {
    const state = String(req.query.state ?? '');
    const code = String(req.query.code ?? '');
    const db = await repos();
    const payload = db.kv.get<OauthState>(`oauth:${state}`);
    if (!payload) {
      res.status(400).send(htmlMessage('Ссылка устарела', 'Начните авторизацию заново из интерфейса MARK.'));
      return;
    }
    db.kv.delete(`oauth:${state}`);

    const provider = OAUTH_PROVIDERS[payload.serviceId];
    if (!provider || !code) {
      res.status(400).send(htmlMessage('Некорректный ответ сервиса', 'Сервис не вернул код авторизации.'));
      return;
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: payload.redirectUri,
    });
    if (payload.clientIdValue) body.set('client_id', payload.clientIdValue);
    if (payload.clientSecret) body.set('client_secret', payload.clientSecret);

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (provider.tokenAuth === 'basic' && payload.clientIdValue && payload.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${payload.clientIdValue}:${payload.clientSecret}`).toString('base64')}`;
      body.delete('client_id');
      body.delete('client_secret');
    }

    const result = await (await import('../http/client.js')).httpJson<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>(
      provider.tokenUrl,
      { method: 'POST', headers, body },
    );

    if (!result.data?.access_token) {
      res
        .status(400)
        .send(htmlMessage('Не удалось получить токен', result.data?.error_description ?? result.data?.error ?? `HTTP ${result.status}`));
      return;
    }

    const account = db.account.put({
      id: randomId('acc'),
      tenantId: payload.tenantId,
      clientId: payload.clientId ?? null,
      serviceId: payload.serviceId,
      authMode: 'oauth2',
      label: `${getService(payload.serviceId)?.name ?? payload.serviceId} — OAuth`,
      status: 'valid',
      secretPreview: maskSecret(result.data.access_token),
      scopes: (provider.scope ?? '').split(/\s+/).filter(Boolean),
      meta: { method: 'oauth', expiresIn: result.data.expires_in ?? null },
      sandbox: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    db.secrets.save(
      account.id,
      encryptJson({
        token: result.data.access_token,
        refreshToken: result.data.refresh_token,
        clientId: payload.clientIdValue,
        clientSecret: payload.clientSecret,
      }),
    );

    hub.publish(channels.activity, 'oauth:connected', { serviceId: payload.serviceId, accountId: account.id });
    res.send(
      htmlMessage(
        'Готово — доступ подключён',
        `Сервис ${getService(payload.serviceId)?.name ?? payload.serviceId} подключён к MARK. Можно закрыть это окно и вернуться в приложение.`,
      ),
    );
  }),
);

/** Завершение implicit-потока (Яндекс/VK возвращают токен во фрагменте URL). */
connectRouter.post(
  '/oauth/implicit',
  ah(async (req, res) => {
    const state = String(req.body?.state ?? '');
    const token = String(req.body?.accessToken ?? '');
    const db = await repos();
    const payload = db.kv.get<OauthState>(`oauth:${state}`);
    if (!payload) throw new ApiError(400, 'Состояние авторизации устарело — начните заново');
    if (!token) throw new ApiError(422, 'Сервис не вернул access_token');
    db.kv.delete(`oauth:${state}`);

    const account = db.account.put({
      id: randomId('acc'),
      tenantId: payload.tenantId,
      clientId: payload.clientId ?? null,
      serviceId: payload.serviceId,
      authMode: 'oauth2',
      label: `${getService(payload.serviceId)?.name ?? payload.serviceId} — OAuth`,
      status: 'valid',
      secretPreview: maskSecret(token),
      scopes: (OAUTH_PROVIDERS[payload.serviceId]?.scope ?? '').split(/\s+/).filter(Boolean),
      meta: { method: 'oauth-implicit' },
      sandbox: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    db.secrets.save(account.id, encryptJson({ token }));
    ok(res, { accountId: account.id }, 201);
  }),
);

/** Страница, которая забирает токен из фрагмента и отправляет его на сервер. */
connectRouter.get('/oauth/implicit-callback', (req, res) => {
  const state = String(req.query.state ?? '');
  res.type('html').send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Авторизация MARK</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:40px;max-width:560px;margin:0 auto;color:#111827}</style></head>
<body><h1>Завершаем авторизацию…</h1><p id="status">Получаем токен от сервиса.</p>
<script>
  (function () {
    var hash = window.location.hash.replace(/^#/, '');
    var params = new URLSearchParams(hash || window.location.search.replace(/^\\?/, ''));
    var token = params.get('access_token') || params.get('token');
    var state = new URLSearchParams(window.location.search).get('state') || ${JSON.stringify(state)};
    var status = document.getElementById('status');
    if (!token) { status.textContent = 'Сервис не вернул токен. Попробуйте войти в окне приложения.'; return; }
    fetch('/api/oauth/implicit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state, accessToken: token })
    }).then(function (r) { return r.json(); }).then(function (r) {
      status.textContent = r.ok ? 'Готово! Доступ подключён — закройте окно и вернитесь в MARK.' : ('Ошибка: ' + (r.error || 'неизвестная'));
    }).catch(function (e) { status.textContent = 'Ошибка сети: ' + e.message; });
  })();
</script></body></html>`);
});

connectRouter.get(
  '/cookies/:accountId',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.get(req.params.accountId!);
    if (!account || account.tenantId !== tenantId) throw new ApiError(404, 'Подключение не найдено');
    const cookies = await getCookiesHeader(account.id);
    ok(res, { accountId: account.id, hasCookies: Boolean(cookies), cookiesPreview: cookies ? `${cookies.split(';').length} cookies` : null });
  }),
);

connectRouter.post(
  '/cookies/:accountId',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.get(req.params.accountId!);
    if (!account || account.tenantId !== tenantId) throw new ApiError(404, 'Подключение не найдено');
    const header = String(req.body?.cookieHeader ?? '');
    if (!header) throw new ApiError(422, 'Передайте cookieHeader');
    await refreshCookies(account.id, parseCookieHeader(header));
    ok(res, { updated: true });
  }),
);

function htmlMessage(title: string, text: string): string {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:40px;max-width:560px;margin:0 auto;color:#111827}h1{font-size:20px}</style>
</head><body><h1>${title}</h1><p>${text}</p></body></html>`;
}
