import type { PlatformDef, SiteConnectorDef } from '../types.js';

/**
 * Детектор платформы сайта + матрица возможностей коннекторов.
 * Позволяет MARK подобрать подходящий коннектор и режим авторизации
 * для ЛЮБОГО сайта: Tilda, WordPress, Bitrix, Vercel/Next, Tilda, Wix, статика на FTP и т.д.
 */

export const PLATFORMS: PlatformDef[] = [
  {
    id: 'tilda',
    name: 'Tilda Publishing',
    buildRequired: false,
    connectors: ['tilda-browser', 'tilda-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'tildacdn\\.com', weight: 40, note: 'CDN Tilda в разметке' },
      { source: 'html', pattern: 'tilda\\.ws', weight: 20, note: 'домен tilda.ws' },
      { source: 'html', pattern: 'class="t-body|t-records|t-cover', weight: 20, note: 'классы блоков Tilda' },
      { source: 'html', pattern: '<!--[^>]*Tilda', weight: 10, note: 'комментарий Tilda' },
      { source: 'header', pattern: 'tilda', weight: 20, note: 'заголовок сервера' },
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    buildRequired: false,
    connectors: ['wordpress-rest', 'wordpress-browser', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'wp-content|wp-includes', weight: 45, note: 'пути wp-content / wp-includes' },
      { source: 'html', pattern: 'name="generator" content="WordPress', weight: 30, note: 'meta generator WordPress' },
      { source: 'url', pattern: '/wp-json/', weight: 25, note: 'доступен REST API' },
      { source: 'html', pattern: 'wp-emoji|wp-block-', weight: 15, note: 'скрипты/классы блочного редактора' },
    ],
  },
  {
    id: 'bitrix',
    name: '1C-Битрикс',
    buildRequired: false,
    connectors: ['ftp-hosting', 'bitrix-rest', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: '/bitrix/(js|templates|cache)', weight: 45, note: 'пути /bitrix/' },
      { source: 'html', pattern: 'BX\\.|bitrix24', weight: 20, note: 'внутренние объекты Битрикса' },
      { source: 'header', pattern: 'PHPSESSID', weight: 5, note: 'сессия PHP' },
      { source: 'html', pattern: 'bitrix', weight: 15, note: 'упоминание bitrix' },
    ],
  },
  {
    id: 'modx',
    name: 'MODX',
    buildRequired: false,
    connectors: ['ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'MODX|modx\\.io', weight: 35, note: 'упоминание MODX' },
      { source: 'header', pattern: 'modx', weight: 25, note: 'заголовок MODX' },
      { source: 'html', pattern: '/assets/(templates|components)/', weight: 15, note: 'структура assets' },
    ],
  },
  {
    id: 'joomla',
    name: 'Joomla',
    buildRequired: false,
    connectors: ['ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'name="generator" content="Joomla', weight: 40, note: 'meta generator Joomla' },
      { source: 'html', pattern: '/media/jui/|/templates/system/', weight: 25, note: 'пути Joomla' },
      { source: 'html', pattern: 'joomla', weight: 10, note: 'упоминание Joomla' },
    ],
  },
  {
    id: 'dle',
    name: 'DataLife Engine',
    buildRequired: false,
    connectors: ['ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'DataLife Engine|datalifeengine', weight: 40, note: 'подпись DLE' },
      { source: 'html', pattern: '/engine/(classes|ajax|skins)/', weight: 30, note: 'пути /engine/' },
      { source: 'header', pattern: 'DataLife', weight: 25, note: 'заголовок DLE' },
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    buildRequired: false,
    connectors: ['webflow-api', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'webflow\\.(com|io)|assets\\.website-files\\.com', weight: 40, note: 'CDN Webflow' },
      { source: 'html', pattern: 'w-nav|w-container|data-wf-page', weight: 30, note: 'классы Webflow' },
      { source: 'header', pattern: 'webflow', weight: 20, note: 'заголовок Webflow' },
    ],
  },
  {
    id: 'wix',
    name: 'Wix',
    buildRequired: false,
    connectors: ['wix-api', 'wix-browser', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'wixstatic\\.com|static\\.parastorage\\.com', weight: 45, note: 'CDN Wix' },
      { source: 'html', pattern: 'X-Wix-|wixCode', weight: 20, note: 'внутренние признаки Wix' },
    ],
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    buildRequired: false,
    connectors: ['squarespace-browser', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'squarespace\\.(com|cdn)', weight: 40, note: 'CDN Squarespace' },
      { source: 'html', pattern: 'static1\\.squarespace\\.com', weight: 30, note: 'статика Squarespace' },
      { source: 'header', pattern: 'Squarespace', weight: 20, note: 'заголовок' },
    ],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    buildRequired: false,
    connectors: ['shopify-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'cdn\\.shopify\\.com|Shopify\\.theme', weight: 45, note: 'CDN и тема Shopify' },
      { source: 'header', pattern: 'Shopify|x-shopid', weight: 35, note: 'заголовки Shopify' },
      { source: 'url', pattern: '/products/|/collections/', weight: 10, note: 'структура каталога' },
    ],
  },
  {
    id: 'ghost',
    name: 'Ghost',
    buildRequired: false,
    connectors: ['ghost-api', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'name="generator" content="Ghost', weight: 40, note: 'meta generator Ghost' },
      { source: 'header', pattern: 'Ghost', weight: 25, note: 'заголовок Ghost' },
      { source: 'url', pattern: '/ghost/', weight: 15, note: 'админка /ghost/' },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js (обычно Vercel)',
    buildRequired: true,
    connectors: ['vercel-api', 'github', 'netlify-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: '/_next/static/', weight: 45, note: 'бандлы Next.js' },
      { source: 'header', pattern: 'x-vercel-id|^Next.js', weight: 35, note: 'заголовки Vercel/Next' },
      { source: 'html', pattern: '__NEXT_DATA__', weight: 30, note: 'страница Pages Router' },
    ],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    buildRequired: true,
    connectors: ['github', 'netlify-api', 'vercel-api', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: '__NUXT__|_nuxt/', weight: 45, note: 'бандлы Nuxt' },
      { source: 'html', pattern: 'data-n-head', weight: 20, note: 'разметка head' },
    ],
  },
  {
    id: 'astro',
    name: 'Astro',
    buildRequired: true,
    connectors: ['github', 'netlify-api', 'vercel-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'astro-island|data-astro-', weight: 45, note: 'Astro-острова' },
      { source: 'html', pattern: 'name="generator" content="Astro', weight: 30, note: 'meta generator Astro' },
    ],
  },
  {
    id: 'hugo',
    name: 'Hugo',
    buildRequired: true,
    connectors: ['github', 'netlify-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'name="generator" content="Hugo', weight: 50, note: 'meta generator Hugo' },
      { source: 'url', pattern: '/index.xml', weight: 10, note: 'RSS Hugo' },
    ],
  },
  {
    id: 'jekyll',
    name: 'Jekyll',
    buildRequired: true,
    connectors: ['github', 'netlify-api', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: 'name="generator" content="Jekyll', weight: 50, note: 'meta generator Jekyll' },
      { source: 'header', pattern: 'GitHub\\.com', weight: 15, note: 'заголовок GitHub Pages' },
    ],
  },
  {
    id: 'static-html',
    name: 'Статичный HTML/хостинг',
    buildRequired: false,
    connectors: ['ftp-hosting', 'sftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: '<!DOCTYPE html', weight: 5, note: 'обычный HTML' },
      { source: 'url', pattern: '/(index|about|contacts)\\.html$', weight: 20, note: 'страницы .html' },
    ],
  },
  {
    id: 'spa',
    name: 'SPA (Vue/React без SSR)',
    buildRequired: true,
    connectors: ['github', 'ftp-hosting', 'manual-patch'],
    signatures: [
      { source: 'html', pattern: '<div id="(app|root)"></div>', weight: 30, note: 'пустой контейнер приложения' },
      { source: 'html', pattern: 'type="module"', weight: 10, note: 'ES-модули' },
      { source: 'html', pattern: '/assets/(index|main)-[A-Za-z0-9]{6,}\\.js', weight: 25, note: 'хешированные бандлы' },
    ],
  },
  {
    id: 'unknown',
    name: 'Неизвестная платформа',
    buildRequired: false,
    connectors: ['manual-patch', 'ftp-hosting'],
    signatures: [],
  },
];

export const PLATFORM_MAP: Record<string, PlatformDef> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

/**
 * Коннекторы сайтов: чем и как MARK правит сайт.
 * `canWrite` — реально ли коннектор вносит изменения (а не только читает).
 */
export const SITE_CONNECTORS: SiteConnectorDef[] = [
  {
    id: 'tilda-api',
    name: 'Tilda API (чтение)',
    platforms: ['tilda'],
    authModes: ['api_token'],
    capabilities: ['site.read'],
    canWrite: false,
    description: 'Читаем проекты, страницы и статистику. Для записи используйте вход в редактор Tilda.',
  },
  {
    id: 'tilda-browser',
    name: 'Tilda — редактор в окне приложения',
    platforms: ['tilda'],
    authModes: ['browser_login'],
    capabilities: ['site.read', 'site.write', 'site.deploy', 'indexing.submit'],
    canWrite: true,
    description:
      'Вход в tilda.cc в отдельном окне приложения. MARK открывает нужные страницы, правит SEO-блоки (title/description/OG), добавляет HTML-блоки (JSON-LD, hreflang), публикует проект.',
  },
  {
    id: 'wordpress-rest',
    name: 'WordPress REST + Application Password',
    platforms: ['wordpress'],
    authModes: ['api_token'],
    capabilities: ['site.read', 'site.write', 'site.deploy', 'indexing.submit'],
    canWrite: true,
    description:
      'Правки через /wp-json: SEO-поля Yoast/Rank Math, контент, медиа, редиректы, меню. Обновление robots.txt и sitemap через SEO-плагин.',
  },
  {
    id: 'wordpress-browser',
    name: 'WordPress — админка в окне приложения',
    platforms: ['wordpress'],
    authModes: ['browser_login'],
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    canWrite: true,
    description: 'Вход в /wp-admin, установка плагинов и правка настроек, если REST недоступен.',
  },
  {
    id: 'vercel-api',
    name: 'Vercel API + git-репозиторий',
    platforms: ['nextjs', 'nuxt', 'astro', 'spa', 'hugo', 'jekyll', 'static-html'],
    authModes: ['api_token', 'git'],
    capabilities: ['site.read', 'site.write', 'site.deploy', 'site.redirects'],
    canWrite: true,
    repoBased: true,
    description:
      'MARK коммитит файлы (public/, app/, pages/, sitemap, robots, llms.txt, JSON-LD) в репозиторий проекта и запускает сборку Vercel, затем проверяет результат на проде.',
  },
  {
    id: 'netlify-api',
    name: 'Netlify API + git-репозиторий',
    platforms: ['nextjs', 'nuxt', 'astro', 'hugo', 'jekyll', 'static-html', 'spa'],
    authModes: ['api_token', 'git'],
    capabilities: ['site.read', 'site.write', 'site.deploy', 'site.redirects'],
    canWrite: true,
    repoBased: true,
    description: 'Коммит в репозиторий → автосборка Netlify; _headers/_redirects тоже можно обновлять.',
  },
  {
    id: 'github',
    name: 'GitHub (коммиты в репозиторий)',
    platforms: ['nextjs', 'nuxt', 'astro', 'hugo', 'jekyll', 'static-html', 'spa'],
    authModes: ['api_token', 'oauth2', 'browser_login', 'git'],
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    canWrite: true,
    repoBased: true,
    description: 'Универсальный путь: коммит файлов и правок шаблонов через Contents API (ветка + PR).',
  },
  {
    id: 'webflow-api',
    name: 'Webflow API',
    platforms: ['webflow'],
    authModes: ['api_token', 'oauth2'],
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    canWrite: true,
    description: 'Правки SEO-полей страниц и коллекций, публикация сайта.',
  },
  {
    id: 'wix-api',
    name: 'Wix REST API',
    platforms: ['wix'],
    authModes: ['api_token'],
    capabilities: ['site.read', 'site.write'],
    canWrite: true,
    description: 'SEO-настройки страниц и структурированные данные через Wix API.',
  },
  {
    id: 'wix-browser',
    name: 'Wix — редактор в окне приложения',
    platforms: ['wix'],
    authModes: ['browser_login'],
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    canWrite: true,
    description: 'Автоматизация редактора Wix: SEO-панель, редиректы, публикация.',
  },
  {
    id: 'squarespace-browser',
    name: 'Squarespace — панель в окне приложения',
    platforms: ['squarespace'],
    authModes: ['browser_login'],
    capabilities: ['site.read', 'site.write'],
    canWrite: true,
    description: 'Правки SEO-полей и Code Injection через панель Squarespace.',
  },
  {
    id: 'shopify-api',
    name: 'Shopify Admin API',
    platforms: ['shopify'],
    authModes: ['api_token'],
    capabilities: ['site.read', 'site.write'],
    canWrite: true,
    description: 'Правки метаполей страниц/товаров, редиректы, тема (snippets с JSON-LD).',
  },
  {
    id: 'ghost-api',
    name: 'Ghost Admin API',
    platforms: ['ghost'],
    authModes: ['api_token'],
    capabilities: ['site.read', 'site.write'],
    canWrite: true,
    description: 'Мета-теги, sitemap, структурированные данные через Admin API темы.',
  },
  {
    id: 'bitrix-rest',
    name: 'Битрикс (REST/вебхук)',
    platforms: ['bitrix'],
    authModes: ['api_token'],
    capabilities: ['site.read', 'site.write'],
    canWrite: true,
    description: 'Вебхук Битрикс24/Битрикс: инфоблоки, SEO-свойства страниц.',
  },
  {
    id: 'ftp-hosting',
    name: 'FTP/SFTP-хостинг (универсальный)',
    platforms: ['static-html', 'wordpress', 'bitrix', 'modx', 'joomla', 'dle', 'tilda', 'hugo', 'jekyll', 'spa', 'unknown'],
    authModes: ['ftp', 'sftp'],
    capabilities: ['site.read', 'site.write', 'site.deploy', 'indexing.submit'],
    canWrite: true,
    description:
      'Работает на любом классическом хостинге: загрузка sitemap.xml, robots.txt, llms.txt, .well-known/indexnow-key.txt, правка HTML-шаблонов и .htaccess/nginx.',
  },
  {
    id: 'sftp-hosting',
    name: 'SFTP-хостинг',
    platforms: ['static-html', 'wordpress', 'bitrix', 'modx', 'joomla', 'dle', 'unknown'],
    authModes: ['sftp'],
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    canWrite: true,
    description: 'То же, но по SFTP (SSH-ключ или пароль).',
  },
  {
    id: 'manual-patch',
    name: 'Пакет исправлений (универсальный)',
    platforms: ['tilda', 'wordpress', 'bitrix', 'modx', 'joomla', 'dle', 'webflow', 'wix', 'squarespace', 'shopify', 'ghost', 'nextjs', 'nuxt', 'astro', 'hugo', 'jekyll', 'static-html', 'spa', 'unknown'],
    authModes: ['manual'],
    capabilities: ['site.read'],
    canWrite: false,
    description:
      'Если автоматический доступ невозможен — MARK формирует готовый ZIP/набор файлов и пошаговую инструкцию (что и куда вставить). Работает всегда.',
  },
];

export const SITE_CONNECTOR_MAP: Record<string, SiteConnectorDef> = Object.fromEntries(
  SITE_CONNECTORS.map((c) => [c.id, c]),
);

/** Коннекторы, доступные для платформы (по убыванию приоритета). */
export function connectorsForPlatform(platformId: string): SiteConnectorDef[] {
  const platform = PLATFORM_MAP[platformId];
  if (!platform) return SITE_CONNECTORS.filter((c) => c.id === 'manual-patch');
  return platform.connectors
    .map((id) => SITE_CONNECTOR_MAP[id])
    .filter((c): c is SiteConnectorDef => Boolean(c));
}
