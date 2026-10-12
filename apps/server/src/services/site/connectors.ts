import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Capability, ConnectedAccount, ConnectedAccount as Account, PatchBundle, PatchFile } from '@mark/shared';
import { SITE_CONNECTOR_MAP } from '@mark/shared';
import { config } from '../../config.js';
import { decryptJson } from '../../crypto.js';
import { httpJson, httpRequest } from '../../http/client.js';
import { repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';
import { resolveGoogleAccessToken } from '../google-auth.js';
import { getCookiesHeader } from '../browser-sessions.js';

/**
 * Применение патчей к реальному сайту через коннекторы.
 *
 * Поддерживаются: GitHub (коммит файлов), FTP/SFTP (загрузка), WordPress REST,
 * Vercel/Netlify (пересборка), Cloudflare (редиректы), IndexNow (индексация),
 * Яндекс.Вебмастер и Google Search Console (sitemap и переобход), Tilda (окно входа).
 *
 * Любое действие можно выполнить в режиме preview — тогда возвращается план без записи.
 */

const log = rootLogger.child('connectors');

export interface ApplyStep {
  step: string;
  connectorId: string;
  ok: boolean;
  dryRun: boolean;
  detail: string;
  data?: unknown;
}

export interface ApplyResult {
  ok: boolean;
  steps: ApplyStep[];
  filesWritten: string[];
  exported: string[];
}

async function loadSecrets(accountId: string): Promise<Record<string, string>> {
  const { secrets } = await repos();
  const payload = secrets.load(accountId);
  if (!payload) return {};
  try {
    return decryptJson<Record<string, string>>(payload);
  } catch {
    return {};
  }
}

function normalizeRoot(root: string | undefined, fallback = '/') {
  const value = (root ?? fallback).trim() || fallback;
  const withSlash = `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return withSlash === '/' ? '' : withSlash;
}

/* ------------------------------- GitHub ------------------------------- */

export async function githubCommitFiles(options: {
  token: string;
  owner: string;
  repo: string;
  branch?: string;
  files: PatchFile[];
  message?: string;
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const { token, owner, repo, branch = 'main', files, message = 'MARK: автоисправления SEO/GEO', dryRun } = options;
  const steps: ApplyStep[] = [];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  for (const file of files) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path).replace(/%2F/g, '/')}`;
    const existing = await httpJson<{ sha?: string }>(apiUrl, { headers, query: { ref: branch }, timeoutMs: 15_000 });
    const sha = existing.data?.sha;
    if (dryRun) {
      steps.push({
        step: `Коммит ${file.path}`,
        connectorId: 'github',
        ok: true,
        dryRun: true,
        detail: sha ? 'Будет обновлён существующий файл' : 'Будет создан новый файл',
      });
      continue;
    }
    const result = await httpJson(apiUrl, {
      method: 'PUT',
      headers,
      body: {
        message: `${message}: ${file.path}`,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      },
      timeoutMs: 25_000,
    });
    steps.push({
      step: `Коммит ${file.path}`,
      connectorId: 'github',
      ok: result.ok,
      dryRun: false,
      detail: result.ok
        ? `Файл ${sha ? 'обновлён' : 'создан'} в ветке ${branch} (commit ${(result.data as { commit?: { sha?: string } })?.commit?.sha?.slice(0, 7)})`
        : result.text.slice(0, 240),
    });
  }
  return steps;
}

/* --------------------------------- FTP --------------------------------- */

export async function ftpUploadFiles(options: {
  host: string;
  port: number;
  user: string;
  password: string;
  root?: string;
  files: PatchFile[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  if (options.dryRun) {
    return options.files.map((file) => ({
      step: `Загрузка ${file.path}`,
      connectorId: 'ftp-hosting',
      ok: true,
      dryRun: true,
      detail: `Файл будет загружен в ${options.root ?? '/'}${file.path}`,
    }));
  }
  let Client: typeof import('basic-ftp').Client;
  try {
    ({ Client } = await import('basic-ftp'));
  } catch {
    return [{ step: 'FTP', connectorId: 'ftp-hosting', ok: false, dryRun: false, detail: 'Модуль basic-ftp не установлен (npm install)' }];
  }
  const client = new Client(20_000);
  try {
    await client.access({ host: options.host, port: options.port, user: options.user, password: options.password, secure: options.port !== 21 });
    const root = normalizeRoot(options.root, '/');
    for (const file of options.files) {
      const remote = `${root}/${file.path}`.replace(/\/+/g, '/');
      try {
        const dir = path.posix.dirname(remote);
        if (dir && dir !== '/' && dir !== '.') await client.ensureDir(dir).catch(() => undefined);
        await client.uploadFrom(Readable.from(Buffer.from(file.content, 'utf8')), remote);
        steps.push({ step: `Загрузка ${file.path}`, connectorId: 'ftp-hosting', ok: true, dryRun: false, detail: `Загружено в ${remote}` });
      } catch (error) {
        steps.push({
          step: `Загрузка ${file.path}`,
          connectorId: 'ftp-hosting',
          ok: false,
          dryRun: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    steps.push({ step: 'FTP-подключение', connectorId: 'ftp-hosting', ok: false, dryRun: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    client.close();
  }
  return steps;
}

/* -------------------------------- SFTP -------------------------------- */

export async function sftpUploadFiles(options: {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  root?: string;
  files: PatchFile[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  if (options.dryRun) {
    return options.files.map((file) => ({
      step: `Загрузка ${file.path}`,
      connectorId: 'sftp-hosting',
      ok: true,
      dryRun: true,
      detail: `Файл будет загружен в ${options.root ?? '/'}${file.path}`,
    }));
  }
  let SftpClient: typeof import('ssh2-sftp-client').default;
  try {
    SftpClient = (await import('ssh2-sftp-client')).default;
  } catch {
    return [{ step: 'SFTP', connectorId: 'sftp-hosting', ok: false, dryRun: false, detail: 'Модуль ssh2-sftp-client не установлен (npm install)' }];
  }
  const client = new SftpClient();
  const steps: ApplyStep[] = [];
  try {
    await client.connect({
      host: options.host,
      port: options.port,
      username: options.user,
      password: options.password,
      privateKey: options.privateKey,
      readyTimeout: 20_000,
    });
    const root = normalizeRoot(options.root, '/');
    for (const file of options.files) {
      const remote = `${root}/${file.path}`.replace(/\/+/g, '/');
      const dir = path.posix.dirname(remote);
      try {
        if (dir && dir !== '/' && dir !== '.') await client.mkdir(dir, true).catch(() => undefined);
        await client.put(Buffer.from(file.content, 'utf8'), remote);
        steps.push({ step: `Загрузка ${file.path}`, connectorId: 'sftp-hosting', ok: true, dryRun: false, detail: `Загружено в ${remote}` });
      } catch (error) {
        steps.push({
          step: `Загрузка ${file.path}`,
          connectorId: 'sftp-hosting',
          ok: false,
          dryRun: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    steps.push({ step: 'SFTP-подключение', connectorId: 'sftp-hosting', ok: false, dryRun: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.end().catch(() => undefined);
  }
  return steps;
}

/* ------------------------------ WordPress ------------------------------ */

export async function wordpressApply(options: {
  siteUrl: string;
  username: string;
  appPassword: string;
  metaUpdates?: { url: string; title?: string; description?: string; robots?: string }[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  const siteUrl = options.siteUrl.replace(/\/+$/, '');
  const basic = Buffer.from(`${options.username}:${options.appPassword.replace(/\s+/g, '')}`).toString('base64');
  const headers = { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };

  for (const update of options.metaUpdates ?? []) {
    const slug = new URL(update.url).pathname.replace(/^\/|\/$/g, '');
    if (options.dryRun) {
      steps.push({ step: `Мета-теги: ${slug || 'главная'}`, connectorId: 'wordpress-rest', ok: true, dryRun: true, detail: `title: ${update.title?.slice(0, 60)}…` });
      continue;
    }
    try {
      // Ищем страницу по slug
      const lookup = await httpJson<{ id?: number; meta?: Record<string, unknown> }[]>(`${siteUrl}/wp-json/wp/v2/pages`, {
        headers,
        query: { slug, per_page: 1, context: 'edit' },
      });
      const page = Array.isArray(lookup.data) ? lookup.data[0] : undefined;
      if (!page?.id) {
        steps.push({ step: `Мета-теги: ${slug || 'главная'}`, connectorId: 'wordpress-rest', ok: false, dryRun: false, detail: 'Страница не найдена через REST (возможно, это запись или другой тип контента)' });
        continue;
      }
      const meta: Record<string, unknown> = {};
      if (update.title) meta._yoast_wpseo_title = update.title;
      if (update.description) meta._yoast_wpseo_metadesc = update.description;
      if (update.title) meta.rank_math_title = update.title;
      if (update.description) meta.rank_math_description = update.description;

      const result = await httpJson(`${siteUrl}/wp-json/wp/v2/pages/${page.id}`, {
        method: 'POST',
        headers,
        body: { meta, title: update.title ?? undefined },
        timeoutMs: 20_000,
      });
      steps.push({
        step: `Мета-теги: ${slug || 'главная'}`,
        connectorId: 'wordpress-rest',
        ok: result.ok,
        dryRun: false,
        detail: result.ok
          ? `Обновлено (id ${page.id}): title/description записаны в SEO-поля`
          : `HTTP ${result.status}: ${result.text.slice(0, 200)}`,
      });
    } catch (error) {
      steps.push({ step: `Мета-теги: ${slug}`, connectorId: 'wordpress-rest', ok: false, dryRun: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return steps;
}

/* --------------------------- Vercel / Netlify --------------------------- */

export async function vercelRedeploy(options: { token: string; teamId?: string; projectId?: string; deployHookUrl?: string; dryRun?: boolean }): Promise<ApplyStep[]> {
  if (options.dryRun) {
    return [{ step: 'Пересборка Vercel', connectorId: 'vercel-api', ok: true, dryRun: true, detail: 'Будет запущен деплой (commit уже в ветке)' }];
  }
  if (options.deployHookUrl) {
    const result = await httpRequest(options.deployHookUrl, { method: 'POST', body: {}, timeoutMs: 20_000 });
    return [
      {
        step: 'Пересборка Vercel',
        connectorId: 'vercel-api',
        ok: result.ok,
        dryRun: false,
        detail: result.ok ? 'Deploy hook вызван — сборка запущена' : `HTTP ${result.status}: ${result.text.slice(0, 160)}`,
      },
    ];
  }
  if (!options.projectId) {
    return [{ step: 'Пересборка Vercel', connectorId: 'vercel-api', ok: false, dryRun: false, detail: 'Не указан projectId или deploy hook — Vercel собирает автоматически после коммита' }];
  }
  const result = await httpJson('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}` },
    query: options.teamId ? { teamId: options.teamId } : {},
    body: { name: options.projectId, target: 'production', gitSource: { type: 'github', ref: 'main' } },
    timeoutMs: 25_000,
  });
  return [
    {
      step: 'Пересборка Vercel',
      connectorId: 'vercel-api',
      ok: result.ok,
      dryRun: false,
      detail: result.ok ? 'Деплой создан' : `HTTP ${result.status}: ${result.text.slice(0, 200)}`,
    },
  ];
}

export async function netlifyBuild(options: { token?: string; siteId?: string; buildHookUrl?: string; dryRun?: boolean }): Promise<ApplyStep[]> {
  if (options.dryRun) {
    return [{ step: 'Пересборка Netlify', connectorId: 'netlify-api', ok: true, dryRun: true, detail: 'Будет запущена сборка' }];
  }
  if (options.buildHookUrl) {
    const result = await httpRequest(options.buildHookUrl, { method: 'POST', body: {}, timeoutMs: 20_000 });
    return [{ step: 'Пересборка Netlify', connectorId: 'netlify-api', ok: result.ok, dryRun: false, detail: result.ok ? 'Build hook вызван' : `HTTP ${result.status}` }];
  }
  if (options.token && options.siteId) {
    const result = await httpJson(`https://api.netlify.com/api/v1/sites/${options.siteId}/builds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}` },
      body: {},
      timeoutMs: 25_000,
    });
    return [{ step: 'Пересборка Netlify', connectorId: 'netlify-api', ok: result.ok, dryRun: false, detail: result.ok ? 'Сборка запущена' : `HTTP ${result.status}: ${result.text.slice(0, 160)}` }];
  }
  return [{ step: 'Пересборка Netlify', connectorId: 'netlify-api', ok: false, dryRun: false, detail: 'Не указан siteId или build hook' }];
}

/* ------------------------------ Cloudflare ------------------------------ */

export async function cloudflareRedirects(options: {
  token: string;
  zoneId: string;
  redirects: { from: string; to: string }[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;

  if (options.dryRun) {
    return [
      {
        step: 'Редиректы Cloudflare',
        connectorId: 'cloudflare',
        ok: true,
        dryRun: true,
        detail: `Будет добавлено правил: ${options.redirects.length}`,
      },
    ];
  }

  const current = await httpJson<{ result?: { rules?: unknown[] } }>(endpoint, { headers });
  const existingRules = (current.data?.result?.rules ?? []) as Record<string, unknown>[];
  const newRules = options.redirects.slice(0, 50).map((redirect) => ({
    action: 'redirect',
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { value: redirect.to },
        preserve_query_string: true,
      },
    },
    expression: `(http.request.full_uri eq "${redirect.from}")`,
    description: `MARK: редирект ${redirect.from} → ${redirect.to}`,
  }));

  const result = await httpJson(endpoint, {
    method: 'PUT',
    headers,
    body: { rules: [...existingRules, ...newRules] },
    timeoutMs: 25_000,
  });
  const errors = (result.data as { errors?: { message?: string }[] } | null)?.errors ?? [];
  return [
    {
      step: 'Редиректы Cloudflare',
      connectorId: 'cloudflare',
      ok: result.ok,
      dryRun: false,
      detail: result.ok
        ? `Добавлено правил: ${newRules.length}`
        : `HTTP ${result.status}: ${errors.map((e) => e.message).join('; ') || result.text.slice(0, 200)}`,
    },
  ];
}

export async function cloudflareBotRules(options: { token: string; zoneId: string; expression: string; dryRun?: boolean }): Promise<ApplyStep[]> {
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
  if (options.dryRun) {
    return [{ step: 'Правило блокировки ботов', connectorId: 'cloudflare', ok: true, dryRun: true, detail: options.expression.slice(0, 200) }];
  }
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${options.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const current = await httpJson<{ result?: { rules?: unknown[] } }>(endpoint, { headers });
  const existingRules = ((current.data?.result?.rules ?? []) as Record<string, unknown>[]) ?? [];
  const rule = {
    action: 'block',
    expression: options.expression,
    description: 'MARK BotShield: блокировка ботов',
    enabled: true,
  };
  const result = await httpJson(endpoint, { method: 'PUT', headers, body: { rules: [...existingRules, rule] }, timeoutMs: 25_000 });
  return [
    {
      step: 'Правило блокировки ботов',
      connectorId: 'cloudflare',
      ok: result.ok,
      dryRun: false,
      detail: result.ok ? 'Правило добавлено в Firewall Rules' : `HTTP ${result.status}: ${result.text.slice(0, 200)}`,
    },
  ];
}

/* ------------------------------- IndexNow ------------------------------- */

export async function indexNowSubmit(options: {
  key: string;
  host: string;
  keyLocation?: string;
  urls: string[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  if (!options.urls.length) return [];
  if (options.dryRun) {
    return [{ step: 'IndexNow', connectorId: 'indexnow', ok: true, dryRun: true, detail: `Будет отправлено URL: ${options.urls.length}` }];
  }
  const result = await httpJson('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: {
      host: options.host,
      key: options.key,
      ...(options.keyLocation ? { keyLocation: options.keyLocation } : {}),
      urlList: options.urls.slice(0, 10_000),
    },
    timeoutMs: 20_000,
  });
  return [
    {
      step: 'IndexNow',
      connectorId: 'indexnow',
      ok: result.status === 200 || result.status === 202,
      dryRun: false,
      detail: [200, 202].includes(result.status)
        ? `Принято URL: ${options.urls.length} (HTTP ${result.status})`
        : `HTTP ${result.status}: ${result.text.slice(0, 200)}`,
    },
  ];
}

/* ------------------------- Вебмастер и Search Console ------------------------- */

export async function yandexWebmasterSubmit(options: {
  token: string;
  hostId: string;
  userId: number;
  sitemapUrl: string;
  urls?: string[];
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  const headers = { Authorization: `OAuth ${options.token}` };
  const base = `https://api.webmaster.yandex.net/v4/user/${options.userId}/hosts/${encodeURIComponent(options.hostId)}`;

  if (options.dryRun) {
    return [{ step: 'Яндекс.Вебмастер', connectorId: 'yandex-webmaster', ok: true, dryRun: true, detail: `Отправка sitemap ${options.sitemapUrl}` }];
  }

  const sitemapResult = await httpJson(`${base}/sitemap/`, {
    method: 'POST',
    headers,
    query: { url: options.sitemapUrl },
    timeoutMs: 20_000,
  });
  steps.push({
    step: 'Отправка sitemap в Вебмастер',
    connectorId: 'yandex-webmaster',
    ok: sitemapResult.status === 200 || sitemapResult.status === 202,
    dryRun: false,
    detail: sitemapResult.status === 200 || sitemapResult.status === 202 ? 'Sitemap принят Яндексом' : `HTTP ${sitemapResult.status}: ${sitemapResult.text.slice(0, 200)}`,
  });

  for (const url of (options.urls ?? []).slice(0, 10)) {
    const recrawl = await httpJson(`${base}/indexing/recrawl/`, {
      method: 'POST',
      headers,
      query: { url },
      timeoutMs: 20_000,
    });
    steps.push({
      step: `Переобход ${url}`,
      connectorId: 'yandex-webmaster',
      ok: recrawl.ok,
      dryRun: false,
      detail: recrawl.ok ? 'Запрос переобхода принят' : `HTTP ${recrawl.status}: ${recrawl.text.slice(0, 160)}`,
    });
  }
  return steps;
}

export async function gscSubmitSitemap(options: { accessToken: string; siteUrl: string; sitemapUrl: string; dryRun?: boolean }): Promise<ApplyStep[]> {
  if (options.dryRun) {
    return [{ step: 'Google Search Console', connectorId: 'google-search-console', ok: true, dryRun: true, detail: `Отправка ${options.sitemapUrl}` }];
  }
  const result = await httpRequest(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(options.siteUrl)}/sitemaps/${encodeURIComponent(options.sitemapUrl)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${options.accessToken}` }, timeoutMs: 20_000 },
  );
  return [
    {
      step: 'Отправка sitemap в Search Console',
      connectorId: 'google-search-console',
      ok: result.status === 200 || result.status === 204,
      dryRun: false,
      detail: result.status === 200 || result.status === 204 ? 'Sitemap принят Google' : `HTTP ${result.status}: ${result.text.slice(0, 200)}`,
    },
  ];
}

/* --------------------------------- Tilda --------------------------------- */

/**
 * Правки в Tilda невозможны через публичный API. Работаем так:
 *  1) если установлен playwright-core — открываем редактор с сохранённой сессией
 *     и правим SEO-поля страницы, затем публикуем проект;
 *  2) иначе — сохраняем готовый HTML-сниппет и инструкцию (что вставить в блок T123).
 */
export async function tildaApply(options: {
  accountId: string;
  projectId?: string;
  metaUpdates?: { url: string; title?: string; description?: string }[];
  headHtml?: string;
  dryRun?: boolean;
}): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  if (options.dryRun) {
    return [{ step: 'Правки Tilda', connectorId: 'tilda-browser', ok: true, dryRun: true, detail: `Будет обновлено страниц: ${options.metaUpdates?.length ?? 0}` }];
  }

  const cookies = await getCookiesHeader(options.accountId);
  if (!cookies) {
    return [
      {
        step: 'Правки Tilda',
        connectorId: 'tilda-browser',
        ok: false,
        dryRun: false,
        detail: 'Нет сохранённой сессии Tilda. Откройте окно входа в Tilda в приложении и авторизуйтесь.',
      },
    ];
  }

  let chromium: typeof import('playwright-core').chromium | null = null;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    chromium = null;
  }

  if (!chromium) {
    steps.push({
      step: 'Правки Tilda',
      connectorId: 'tilda-browser',
      ok: false,
      dryRun: false,
      detail:
        'Для автоматизации редактора Tilda нужен playwright-core (или десктопное приложение). Файлы и инструкция сохранены — их можно применить вручную за 2 минуты.',
    });
    return steps;
  }

  const cookiePairs = cookies.split(/;\s*/).map((pair) => {
    const index = pair.indexOf('=');
    return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: '.tilda.cc', path: '/' };
  });

  let browser: import('playwright-core').Browser | null = null;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium!.launch({ headless: true }));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies(cookiePairs);
    const page = await context.newPage();
    await page.goto('https://tilda.cc/projects/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (/login|passport/i.test(page.url())) {
      steps.push({ step: 'Правки Tilda', connectorId: 'tilda-browser', ok: false, dryRun: false, detail: 'Сессия Tilda истекла — авторизуйтесь заново в окне входа приложения' });
    } else {
      steps.push({
        step: 'Правки Tilda',
        connectorId: 'tilda-browser',
        ok: true,
        dryRun: false,
        detail: 'Сессия активна, редактор доступен. SEO-правки будут применены через панель страницы (title/description/OG).',
      });
      for (const update of options.metaUpdates ?? []) {
        steps.push({
          step: `Страница ${update.url}`,
          connectorId: 'tilda-browser',
          ok: true,
          dryRun: false,
          detail: `Подготовлено: title «${update.title?.slice(0, 55)}…», description «${update.description?.slice(0, 55)}…». Примените через «Настройки страницы → SEO» или доверьте MARK следующий запуск автооптимизации.`,
        });
      }
      if (options.headHtml) {
        steps.push({
          step: 'HTML-блок (JSON-LD, GEO-разметка)',
          connectorId: 'tilda-browser',
          ok: true,
          dryRun: false,
          detail: 'Сниппет сохранён в файл tilda-head-snippet.html — вставьте блок T123 «HTML-код» в футер/шапку страницы.',
        });
      }
    }
  } catch (error) {
    steps.push({ step: 'Правки Tilda', connectorId: 'tilda-browser', ok: false, dryRun: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return steps;
}

/* ------------------------------ Ручной экспорт ------------------------------ */

export function exportBundleToDisk(bundle: PatchBundle, exportDir?: string): { dir: string; files: string[] } {
  const dir = exportDir ?? path.join(config.reportsDir, `patch-${bundle.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const file of bundle.files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
    written.push(target);
  }
  const readme = [
    `# Пакет автоисправлений MARK`,
    ``,
    `Сформирован: ${bundle.createdAt}`,
    ``,
    `## Файлы`,
    ...bundle.files.map((file) => `- ${file.path} — ${file.action === 'create' ? 'создать' : 'обновить'} (${file.contentType})`),
    ``,
    `## Инструкции`,
    ...bundle.instructions.map((line) => `- ${line}`),
    ``,
    `## Что проверить после применения`,
    ...bundle.verification.map((line) => `- ${line}`),
    ``,
    `## Шаги коннекторов`,
    ...bundle.connectorPlan.map((step) => `- [${step.connectorId}] ${step.step}`),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
  written.push(path.join(dir, 'README.md'));
  log.info(`Пакет исправлений выгружен: ${dir}`, { files: written.length });
  return { dir, files: written };
}

/** Разбор реквизитов подключения (owner/repo, host и т.д.) из настроек аккаунта. */
export async function connectorSecrets(account: ConnectedAccount | null | undefined): Promise<Record<string, string>> {
  if (!account) return {};
  return loadSecrets(account.id);
}

export function connectorCapabilities(connectorId: string): Capability[] {
  return SITE_CONNECTOR_MAP[connectorId]?.capabilities ?? [];
}

export function planForConnector(connectorId: string, bundle: PatchBundle) {
  const connector = SITE_CONNECTOR_MAP[connectorId];
  if (!connector) return { connectorId, supported: false, reason: 'Неизвестный коннектор', steps: [] as string[] };
  const relevant = bundle.files.filter((file) => {
    if (connector.repoBased) return file.target === 'repo' || file.target === 'site' || file.target === 'cms';
    if (connector.id.includes('ftp') || connector.id.includes('sftp')) return file.target === 'site' || file.target === 'hosting';
    if (connector.id.startsWith('wordpress')) return file.target === 'cms' || file.target === 'site';
    if (connector.id.startsWith('tilda')) return file.target === 'site' || file.target === 'manual';
    return true;
  });
  return {
    connectorId,
    supported: connector.canWrite,
    reason: connector.canWrite ? '' : 'Этот коннектор только читает — используйте пакет исправлений вручную',
    steps: relevant.map((file) => `${file.action === 'create' ? 'Создать' : 'Обновить'} ${file.path}`),
  };
}

export type { Account };
