import { httpError, httpJson, httpRequest, tcpCheck } from '../../../http/client.js';
import { field, isSandboxLike } from '../context.js';
import type { Validator } from '../types.js';

/** Проверки коннекторов сайтов, хостингов и инфраструктуры. */

const normalizeSite = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/* ------------------------------- Tilda ------------------------------- */

export const validateTilda: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const publicKey = field(ctx, 'publicKey');
  const secretKey = field(ctx, 'secretKey');

  await runner.step('format', 'Формат ключей', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: ключи не проверяются' };
    if (!publicKey || !secretKey) throw new Error('Нужны оба ключа: Public key и Secret key (Настройки сайта → API)');
    if (publicKey.length < 12 || secretKey.length < 12) {
      throw new Error('Ключи короче ожидаемого — скопируйте их целиком из настроек Tilda');
    }
    return { message: 'Оба ключа заполнены' };
  });

  await runner.step('api', 'Tilda API', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: проекты сгенерированы локально' };
    const result = await httpJson('https://api.tilda.cc/1/getprojectslist', {
      query: { publickey: publicKey, secretkey: secretKey },
      timeoutMs: 15_000,
    });
    if (result.status === 403 || /wrong|invalid|error/i.test(result.text.slice(0, 200))) {
      throw new Error(`Tilda отклонила ключи: ${result.text.slice(0, 200) || `HTTP ${result.status}`}`);
    }
    if (!result.ok) throw new Error(httpError(result, 'Tilda API вернул ошибку'));
    const projects = (result.data as { result?: { id?: string; title?: string; pages?: unknown[] }[] })?.result ?? [];
    return {
      message: `Ключи приняты, проектов: ${projects.length}`,
      details: { projects: projects.slice(0, 10).map((p) => ({ id: p.id, title: p.title, pages: p.pages?.length ?? 0 })) },
      status: projects.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('write', 'Права на запись', async () => {
    return {
      status: 'warn' as const,
      message:
        'Tilda API работает только на чтение. Для правок SEO и публикации MARK использует «Вход в редактор Tilda» — окно входа внутри приложения.',
    };
  });

  return { accountInfo: { sandbox } };
};

/* ----------------------------- WordPress ----------------------------- */

export const validateWordPress: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const siteUrl = normalizeSite(field(ctx, 'siteUrl'));
  const username = field(ctx, 'username');
  const appPassword = field(ctx, 'appPassword');
  let capabilities: Record<string, unknown> = {};
  let seoPlugin: string | null = null;

  await runner.step('reachable', 'Доступность сайта', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: сайт не опрашивается' };
    if (!siteUrl) throw new Error('Укажите адрес сайта (например, https://example.ru)');
    const result = await httpRequest(`${siteUrl}/wp-json/`, { raw: true, timeoutMs: 12_000, retries: 0 });
    if (!result.ok) {
      throw new Error(
        `REST API WordPress недоступен (${result.error ?? `HTTP ${result.status}`}). Проверьте адрес и что permalinks не «обычные» (нужны ЧПУ).`,
      );
    }
    const isWp = /"name"|"description"|"url"|wp\/v2/i.test(result.text.slice(0, 4000)) || /wp-json/i.test(result.text);
    if (!isWp) {
      return {
        status: 'warn' as const,
        message: 'Ответ получен, но признаки WordPress REST не найдены — возможно, REST отключён плагином безопасности',
        details: { contentType: result.headers['content-type'], snippet: result.text.slice(0, 120) },
      };
    }
    return { message: 'REST API WordPress отвечает', details: { url: `${siteUrl}/wp-json/` } };
  });

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: авторизация пропущена' };
    if (!username || !appPassword) {
      throw new Error('Для Application Password нужны логин и сгенерированный пароль приложения (Пользователи → Профиль → Пароли приложений).');
    }
    const basic = Buffer.from(`${username}:${appPassword.replace(/\s+/g, '')}`).toString('base64');
    const result = await httpJson<{ id?: number; name?: string; capabilities?: Record<string, unknown>; roles?: string[] }>(
      `${siteUrl}/wp-json/wp/v2/users/me`,
      { headers: { Authorization: `Basic ${basic}` }, query: { context: 'edit' } },
    );
    if (result.status === 401) {
      throw new Error('Логин или пароль приложения неверны (401). Проверьте, что пароль приложения создан именно для этого пользователя и не отозван.');
    }
    if (result.status === 403) {
      throw new Error('Доступ запрещён (403): Application Passwords отключены (например, плагином) или требуется HTTPS.');
    }
    if (!result.ok) throw new Error(httpError(result, 'WordPress вернул ошибку'));
    capabilities = result.data?.capabilities ?? {};
    return {
      message: `Авторизация успешна: ${result.data?.name ?? username} (роли: ${(result.data?.roles ?? []).join(', ') || '—'})`,
      details: { user: result.data?.name, roles: result.data?.roles },
    };
  });

  await runner.step('capabilities', 'Права на публикацию', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим' };
    const canEdit = capabilities['edit_posts'] === true || capabilities['edit_pages'] === true;
    const canPublish = capabilities['publish_posts'] === true || capabilities['publish_pages'] === true;
    if (!canEdit) {
      return { status: 'warn' as const, message: 'У пользователя нет прав на правку записей/страниц — CHANGE не сможет применить автоисправления' };
    }
    return {
      message: `Права: правка — да, публикация — ${canPublish ? 'да' : 'нет (изменения пойдут в черновики)'}`,
      details: { canEdit, canPublish, capabilities: Object.keys(capabilities).slice(0, 30) },
    };
  });

  await runner.step('seo', 'SEO-плагин', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    try {
      const home = await httpRequest(siteUrl, { raw: true, timeoutMs: 12_000, retries: 0 });
      const html = home.text.slice(0, 80_000);
      if (/Yoast SEO|yoast/i.test(html)) seoPlugin = 'Yoast SEO';
      else if (/rank[- ]?math/i.test(html)) seoPlugin = 'Rank Math';
      else if (/all in one seo|aioseo/i.test(html)) seoPlugin = 'All in One SEO';
      if (seoPlugin) return { message: `Обнаружен SEO-плагин: ${seoPlugin} — MARK будет писать мета-теги через него` };
    } catch {
      /* не критично */
    }
    return {
      status: 'warn' as const,
      message: 'SEO-плагин не определён. MARK добавит мета-теги напрямую через REST/тему — эффект тот же, но проверьте конфликты.',
    };
  });

  return { accountInfo: { siteUrl, seoPlugin, sandbox } };
};

/* ------------------------------- Vercel ------------------------------- */

export const validateVercel: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const teamId = field(ctx, 'teamId');
  const query = teamId ? { teamId } : {};

  await runner.step('auth', 'Проверка токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Vercel не опрашивается' };
    const result = await httpJson<{ user?: { username?: string; email?: string }; error?: { message?: string } }>(
      'https://api.vercel.com/v2/user',
      { headers: { Authorization: `Bearer ${token}` }, query },
    );
    if (result.status === 403 || result.status === 401) throw new Error('Токен Vercel не принят (проверьте, что он не отозван и относится к нужной команде)');
    if (!result.ok) throw new Error(result.data?.error?.message ?? httpError(result, 'Vercel вернул ошибку'));
    return { message: `Токен активен: ${result.data?.user?.username ?? result.data?.user?.email ?? 'аккаунт подтверждён'}` };
  });

  await runner.step('projects', 'Проекты', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: проекты сгенерированы' };
    const result = await httpJson<{ projects?: { name?: string; id?: string; framework?: string }[] }>(
      'https://api.vercel.com/v9/projects',
      { headers: { Authorization: `Bearer ${token}` }, query: { ...query, limit: 20 } },
    );
    if (!result.ok) throw new Error(httpError(result, 'Не удалось получить список проектов'));
    const projects = result.data?.projects ?? [];
    return {
      message: projects.length ? `Проектов: ${projects.length}` : 'Проекты не найдены',
      details: { projects: projects.slice(0, 10).map((p) => ({ name: p.name, framework: p.framework })) },
      status: projects.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('deployments', 'Деплойменты', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    const result = await httpJson<{ deployments?: { url?: string; state?: string; target?: string }[] }>(
      'https://api.vercel.com/v6/deployments',
      { headers: { Authorization: `Bearer ${token}` }, query: { ...query, limit: 5 } },
    );
    if (!result.ok) return { status: 'warn' as const, message: `История деплоев недоступна (HTTP ${result.status})` };
    const deployments = result.data?.deployments ?? [];
    return {
      message: deployments.length
        ? `Последний деплой: ${deployments[0]?.url ?? '—'} (${deployments[0]?.state ?? '—'})`
        : 'Деплоев ещё не было',
      details: { deployments },
    };
  });

  await runner.step('domains', 'Домены и редиректы', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    return {
      message: 'MARK сможет править redirects.json/next.config, variables и запускать пересборку через API',
    };
  });

  return { accountInfo: { teamId: teamId || null, sandbox } };
};

/* ------------------------------- Netlify ------------------------------- */

export const validateNetlify: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const headers = { Authorization: `Bearer ${token}` };

  await runner.step('auth', 'Проверка токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Netlify не опрашивается' };
    const result = await httpJson<{ email?: string; full_name?: string }>('https://api.netlify.com/api/v1/user', { headers });
    if (result.status === 401) throw new Error('Токен Netlify не принят (401). Создайте Personal Access Token в User settings → Applications.');
    if (!result.ok) throw new Error(httpError(result, 'Netlify вернул ошибку'));
    return { message: `Токен активен: ${result.data?.full_name ?? result.data?.email ?? 'аккаунт подтверждён'}` };
  });

  await runner.step('sites', 'Сайты', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: сайты сгенерированы' };
    const result = await httpJson<{ name?: string; url?: string; ssl_url?: string; published_deploy?: { state?: string } }[]>(
      'https://api.netlify.com/api/v1/sites',
      { headers, query: { per_page: 20 } },
    );
    if (!result.ok) throw new Error(httpError(result, 'Не удалось получить список сайтов'));
    const sites = Array.isArray(result.data) ? result.data : [];
    return {
      message: sites.length ? `Сайтов: ${sites.length} (первый: ${sites[0]?.name ?? '—'})` : 'Сайты не найдены',
      details: { sites: sites.slice(0, 10).map((s) => ({ name: s.name, url: s.ssl_url ?? s.url })) },
      status: sites.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('deploys', 'Деплои', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    return { message: 'MARK умеет запускать пересборку (build hook) и править _redirects/_headers' };
  });

  return { accountInfo: { sandbox } };
};

/* ------------------------------- GitHub ------------------------------- */

export const validateGithub: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let scopes: string[] = [];

  await runner.step('auth', 'Проверка токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: GitHub не опрашивается' };
    const result = await httpJson<{ login?: string; name?: string; plan?: { name?: string } }>('https://api.github.com/user', { headers });
    if (result.status === 401) throw new Error('Токен GitHub не принят (401). Проверьте срок действия и что он не отозван.');
    if (!result.ok) throw new Error(httpError(result, 'GitHub вернул ошибку'));
    scopes = (result.headers['x-oauth-scopes'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      message: `Токен активен: @${result.data?.login ?? 'user'}${scopes.length ? ` (scopes: ${scopes.join(', ')})` : ' (fine-grained токен)'}`,
      details: { login: result.data?.login, scopes },
    };
  });

  await runner.step('scopes', 'Права на запись в репозиторий', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим' };
    const hasRepo = scopes.length === 0 ? null : scopes.includes('repo') || scopes.includes('public_repo');
    if (hasRepo === false) {
      return { status: 'warn' as const, message: 'У токена нет scope «repo» — запись файлов (коммиты) будет недоступна' };
    }
    return { message: hasRepo ? 'Права на содержимое репозитория есть' : 'Fine-grained токен: убедитесь, что выдано Contents: Read and write' };
  });

  await runner.step('repos', 'Репозитории', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: репозитории сгенерированы' };
    const result = await httpJson<{ full_name?: string; private?: boolean; default_branch?: string }[]>(
      'https://api.github.com/user/repos',
      { headers, query: { per_page: 20, sort: 'updated' } },
    );
    if (!result.ok) throw new Error(httpError(result, 'Не удалось получить список репозиториев'));
    const repos = Array.isArray(result.data) ? result.data : [];
    return {
      message: repos.length ? `Доступно репозиториев: ${repos.length}` : 'Репозитории не найдены — для fine-grained токена выберите репозитории явно',
      details: { repos: repos.slice(0, 10).map((r) => ({ name: r.full_name, branch: r.default_branch, private: r.private })) },
      status: repos.length ? ('pass' as const) : ('warn' as const),
    };
  });

  return { accountInfo: { scopes, sandbox } };
};

/* ------------------------------- Webflow ------------------------------- */

export const validateWebflow: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const headers = { Authorization: `Bearer ${token}`, accept: 'application/json' };

  await runner.step('auth', 'Проверка токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Webflow не опрашивается' };
    const result = await httpJson<{ id?: string; email?: string; firstName?: string; error?: string; message?: string }>(
      'https://api.webflow.com/v2/token/authorized_by',
      { headers },
    );
    if (!result.ok) throw new Error(result.data?.message ?? httpError(result, 'Webflow отклонил токен'));
    return { message: `Токен активен: ${result.data?.email ?? result.data?.id ?? 'подтверждён'}` };
  });

  await runner.step('sites', 'Сайты', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: сайты сгенерированы' };
    const result = await httpJson<{ sites?: { id?: string; displayName?: string; shortName?: string }[] }>(
      'https://api.webflow.com/v2/sites',
      { headers },
    );
    if (!result.ok) throw new Error(httpError(result, 'Не удалось получить список сайтов'));
    const sites = result.data?.sites ?? [];
    return {
      message: sites.length ? `Сайтов: ${sites.length}` : 'Сайты не найдены',
      details: { sites: sites.slice(0, 10).map((s) => ({ id: s.id, name: s.displayName })) },
      status: sites.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('publish', 'Публикация', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    return { message: 'MARK сможет править SEO-поля страниц и публиковать сайт через /sites/:id/publish' };
  });

  return { accountInfo: { sandbox } };
};

/* ------------------------------ Cloudflare ------------------------------ */

export const validateCloudflare: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const token = field(ctx, 'token');
  const headers = { Authorization: `Bearer ${token}` };

  await runner.step('verify', 'Проверка токена', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: Cloudflare не опрашивается' };
    const result = await httpJson<{ success?: boolean; result?: { status?: string; id?: string }; errors?: { message?: string }[] }>(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { headers },
    );
    if (!result.data?.success) {
      throw new Error(result.data?.errors?.[0]?.message ?? `Токен отклонён (HTTP ${result.status})`);
    }
    return { message: `Токен активен${result.data.result?.status ? `, статус: ${result.data.result.status}` : ''}` };
  });

  await runner.step('zones', 'Зоны (домены)', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: зоны сгенерированы' };
    const result = await httpJson<{ result?: { name?: string; id?: string; status?: string }[]; errors?: { message?: string }[] }>(
      'https://api.cloudflare.com/client/v4/zones',
      { headers, query: { per_page: 20 } },
    );
    const zones = result.data?.result ?? [];
    if (!result.ok) throw new Error(result.data?.errors?.[0]?.message ?? httpError(result, 'Не удалось получить зоны'));
    return {
      message: zones.length ? `Зон в аккаунте: ${zones.length}` : 'Зоны не найдены — возможно, токен ограничен конкретной зоной',
      details: { zones: zones.slice(0, 10).map((z) => ({ name: z.name, status: z.status })) },
      status: zones.length ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('firewall', 'Firewall и правила ботов', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    return { message: 'MARK сможет применять правила BotShield (block/rate limit) и создавать редиректы/правила кэша' };
  });

  return { accountInfo: { sandbox } };
};

/* --------------------------------- FTP --------------------------------- */

export const validateFtpHosting: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const host = field(ctx, 'host');
  const port = Number(field(ctx, 'port') || 21);
  const user = field(ctx, 'user');
  const password = field(ctx, 'password');
  const root = field(ctx, 'root') || '/';

  await runner.step('connect', 'Подключение', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: FTP не опрашивается' };
    const check = await tcpCheck(host, port, 8000);
    if (!check.ok) throw new Error(`Не удалось подключиться к ${host}:${port} — ${check.error ?? 'порт закрыт'}`);
    return { message: `Порт ${port} доступен (${check.ms} мс)` };
  });

  let listed: { name: string; type: number; size: number }[] = [];

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим' };
    let Client: typeof import('basic-ftp').Client;
    try {
      ({ Client } = await import('basic-ftp'));
    } catch {
      throw new Error('Модуль basic-ftp не установлен. Выполните «npm install» в корне проекта.');
    }
    const client = new Client(12_000);
    client.ftp.verbose = false;
    try {
      await client.access({ host, port, user, password, secure: port === 21 ? false : true });
      listed = (await client.list(root)).map((item) => ({ name: item.name, type: item.type, size: item.size }));
    } catch (error) {
      throw new Error(`FTP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.close();
    }
    return { message: `Авторизация успешна, файлов в ${root}: ${listed.length}` };
  });

  await runner.step('root', 'Корень сайта', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    const hasIndex = listed.some((item) => /^index\.(html?|php)$/i.test(item.name));
    const hasWp = listed.some((item) => item.name === 'wp-content' || item.name === 'wp-config.php');
    if (!listed.length) return { status: 'warn' as const, message: `Каталог ${root} пуст или недоступен — проверьте путь к корню сайта` };
    return {
      message: hasIndex
        ? `Найден index-файл (${hasWp ? 'похоже на WordPress' : 'статический сайт'})`
        : `index-файл не найден. Содержимое: ${listed.slice(0, 8).map((i) => i.name).join(', ')}`,
      details: { files: listed.slice(0, 25) },
      status: hasIndex || listed.length > 3 ? ('pass' as const) : ('warn' as const),
    };
  });

  await runner.step('write', 'Права на запись', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    let Client: typeof import('basic-ftp').Client;
    try {
      ({ Client } = await import('basic-ftp'));
    } catch {
      return { status: 'warn' as const, message: 'Модуль basic-ftp не установлен — проверка записи пропущена' };
    }
    const client = new Client(12_000);
    const testName = `.mark-check-${Date.now()}.txt`;
    try {
      await client.access({ host, port, user, password, secure: port !== 21 });
      const stream = Buffer.from('MARK проверка записи');
      const { Readable } = await import('node:stream');
      await client.uploadFrom(Readable.from(stream), `${root.replace(/\/$/, '')}/${testName}`);
      await client.remove(`${root.replace(/\/$/, '')}/${testName}`);
      return { message: 'Запись и удаление файлов работают — автоисправления и sitemap будут применяться автоматически' };
    } catch (error) {
      return {
        status: 'warn' as const,
        message: `Запись недоступна (${error instanceof Error ? error.message : String(error)}). Останется режим «пакет исправлений».`,
      };
    } finally {
      client.close();
    }
  });

  return { accountInfo: { host, port, root, files: listed.length, sandbox } };
};

/* --------------------------------- SFTP --------------------------------- */

export const validateSftpHosting: Validator = async (ctx, runner) => {
  const sandbox = isSandboxLike(ctx);
  const host = field(ctx, 'host');
  const port = Number(field(ctx, 'port') || 22);
  const user = field(ctx, 'user');
  const password = field(ctx, 'password');
  const privateKey = field(ctx, 'privateKey');
  const root = field(ctx, 'root') || '/';

  await runner.step('connect', 'Подключение', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим: SFTP не опрашивается' };
    const check = await tcpCheck(host, port, 8000);
    if (!check.ok) throw new Error(`Не удалось подключиться к ${host}:${port} — ${check.error ?? 'порт закрыт'}`);
    return { message: `Порт ${port} доступен (${check.ms} мс)` };
  });

  await runner.step('auth', 'Авторизация', async () => {
    if (sandbox) return { status: 'pass' as const, message: 'Демо-режим' };
    let SftpClient: typeof import('ssh2-sftp-client').default;
    try {
      SftpClient = (await import('ssh2-sftp-client')).default;
    } catch {
      throw new Error('Модуль ssh2-sftp-client не установлен. Выполните «npm install» в корне проекта.');
    }
    const client = new SftpClient();
    try {
      await client.connect({ host, port, username: user, password: password || undefined, privateKey: privateKey || undefined, readyTimeout: 12_000 });
      const list = (await client.list(root)) as { name: string; type: string; size: number }[];
      return { message: `Подключение по SFTP успешно, файлов в ${root}: ${list.length}`, details: { files: list.slice(0, 20) } };
    } catch (error) {
      throw new Error(`SFTP: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  await runner.step('write', 'Права на запись', async () => {
    if (sandbox) return { status: 'warn' as const, message: 'Демо-режим' };
    let SftpClient: typeof import('ssh2-sftp-client').default;
    try {
      SftpClient = (await import('ssh2-sftp-client')).default;
    } catch {
      return { status: 'warn' as const, message: 'Модуль ssh2-sftp-client не установлен' };
    }
    const client = new SftpClient();
    const testPath = `${root.replace(/\/$/, '')}/.mark-check-${Date.now()}.txt`;
    try {
      await client.connect({ host, port, username: user, password: password || undefined, privateKey: privateKey || undefined, readyTimeout: 12_000 });
      await client.put(Buffer.from('MARK проверка записи'), testPath);
      await client.delete(testPath, false);
      return { message: 'Запись файлов работает — MARK сможет сам обновлять sitemap.xml, robots.txt и llms.txt' };
    } catch (error) {
      return { status: 'warn' as const, message: `Запись недоступна: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  return { accountInfo: { host, port, root, sandbox } };
};
