import type { ServiceDef } from '../types.js';

/**
 * Каталог внешних сервисов.
 *
 * Для каждого сервиса описаны:
 *  - способы авторизации (API-токен, OAuth, вход в окне приложения, cookie, FTP/SFTP, git);
 *  - реальные эндпоинты проверки (используются сервером при валидации в реальном времени);
 *  - план валидации (шаги, которые видит пользователь в Connect.vue).
 *
 * ВАЖНО: сервер использует эти же данные — каталог является единым источником правды.
 */

const note = (s: string) => s;

export const SERVICES: ServiceDef[] = [
  /* ----------------------------- Яндекс ----------------------------- */
  {
    id: 'yandex-direct',
    name: 'Яндекс.Директ',
    category: 'ads',
    vendor: 'Яндекс',
    docsUrl: 'https://yandex.ru/dev/direct/',
    color: '#fc3f1d',
    supportsSandbox: true,
    capabilities: [
      'campaigns.read',
      'campaigns.write',
      'bids.write',
      'keywords.read',
      'keywords.write',
      'wordstat.read',
      'forecast.read',
      'analytics.read',
    ],
    notes: [
      note('API v5 принимает OAuth-токен (Яндекс ID). Токен можно получить в окне входа приложения — приложение само перехватит его из редиректа.'),
      note('Служба keywordsresearch отдаёт Wordstat-отчёты с разбивкой по регионам — на ней построен GEO-анализатор.'),
    ],
    authModes: [
      {
        id: 'oauth2',
        label: 'OAuth Яндекс (рекомендуется)',
        description:
          'Вход в аккаунт Яндекса в отдельном окне приложения. Приложение само поймает токен и будет продлевать сессию.',
        automation: 'full',
        needsInAppLogin: true,
        fields: [{ key: 'clientId', label: 'ClientID приложения', type: 'text', required: false, placeholder: 'из https://oauth.yandex.ru/', help: 'Необязательно: можно использовать встроенное приложение MARK.' }],
      },
      {
        id: 'api_token',
        label: 'Готовый OAuth-токен',
        description: 'Если токен уже выпущен — вставьте его, проверим прямым запросом к API.',
        automation: 'full',
        fields: [
          { key: 'token', label: 'OAuth-токен', type: 'password', required: true, secret: true, placeholder: 'y0_AgAAAA...' },
          { key: 'login', label: 'Логин аккаунта (опционально)', type: 'text', required: false, placeholder: 'agency-login' },
        ],
      },
      {
        id: 'browser_login',
        label: 'Вход в браузере приложения',
        description: 'Открываем окно direct.yandex.ru — вы входите руками (пароль, СМС, капча), дальше всё делает MARK.',
        automation: 'partial',
        needsInAppLogin: true,
        fields: [],
      },
      {
        id: 'api_token',
        label: 'Демо-режим (sandbox)',
        description: 'Вставьте token=sandbox — платформа включит песочницу Директа (api-sandbox.direct.yandex.com) и покажет реалистичные данные без реальных денег.',
        automation: 'full',
        fields: [{ key: 'token', label: 'Токен', type: 'password', required: true, secret: true, default: 'sandbox' }],
      },
    ],
    validationPlan: [
      { key: 'format', title: 'Формат учётных данных', hint: 'Проверяем, что токен похож на OAuth-токен Яндекса' },
      { key: 'auth', title: 'Авторизация в API v5', hint: 'POST /json/v5/campaigns — служебный запрос' },
      { key: 'units', title: 'Лимиты баллов', hint: 'Читаем заголовок Units и остаток дневного лимита' },
      { key: 'accounts', title: 'Доступ к аккаунтам', hint: 'Получаем список клиентов и кампаний' },
      { key: 'wordstat', title: 'Wordstat и прогноз', hint: 'Проверяем доступ к keywordsresearch' },
    ],
  },
  {
    id: 'yandex-metrika',
    name: 'Яндекс.Метрика',
    category: 'analytics',
    vendor: 'Яндекс',
    docsUrl: 'https://yandex.ru/dev/metrika/',
    color: '#fc3f1d',
    supportsSandbox: true,
    capabilities: ['analytics.read', 'traffic.logs'],
    notes: [note('Метрика даёт визиты/конверсии для гипотез и отчётов, а также выгрузку логов для BotShield.')],
    authModes: [
      { id: 'oauth2', label: 'OAuth Яндекс', description: 'Вход в окне приложения, выбор счётчика.', automation: 'full', needsInAppLogin: true, fields: [] },
      {
        id: 'api_token',
        label: 'OAuth-токен',
        description: 'Токен с доступом metrika:read.',
        automation: 'full',
        fields: [{ key: 'token', label: 'OAuth-токен', type: 'password', required: true, secret: true }],
      },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на metrika.yandex.ru для выгрузки отчётов.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Авторизация', hint: 'GET /management/v1/counters' },
      { key: 'counters', title: 'Счётчики', hint: 'Список доступных счётчиков и их владельцев' },
      { key: 'access', title: 'Права на данные', hint: 'Проверяем право читать статистику' },
    ],
  },
  {
    id: 'yandex-webmaster',
    name: 'Яндекс.Вебмастер',
    category: 'webmaster',
    vendor: 'Яндекс',
    docsUrl: 'https://yandex.ru/dev/webmaster/',
    color: '#fc3f1d',
    supportsSandbox: true,
    capabilities: ['site.read', 'indexing.submit'],
    notes: [note('Через Вебмастер MARK отправляет sitemap, запрашивает переобход страниц и получает поисковые запросы.')],
    authModes: [
      { id: 'oauth2', label: 'OAuth Яндекс', description: 'Вход в окне приложения.', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'api_token', label: 'OAuth-токен', description: 'Токен с доступом webmaster:verify, webmaster:hostinfo.', automation: 'full', fields: [{ key: 'token', label: 'OAuth-токен', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на webmaster.yandex.ru для отправки sitemap и переобхода.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Авторизация', hint: 'GET /v4/user/' },
      { key: 'hosts', title: 'Список сайтов', hint: 'Проверяем, что сайт добавлен и подтверждён' },
      { key: 'quota', title: 'Квоты переобхода', hint: 'Остаток дневных квот' },
    ],
  },
  {
    id: 'yandex-business',
    name: 'Яндекс.Бизнес (карточка организации)',
    category: 'site',
    vendor: 'Яндекс',
    docsUrl: 'https://yandex.ru/sprav/',
    color: '#fc3f1d',
    supportsSandbox: true,
    capabilities: ['listings.write', 'site.read'],
    notes: [note('Публичного API нет — MARK работает через окно входа в браузере приложения и автоматизацию интерфейса (CDP).')],
    authModes: [
      {
        id: 'browser_login',
        label: 'Вход в браузере приложения',
        description: 'Открываем yandex.ru/sprav — вы входите в аккаунт организации, MARK забирает сессию и управляет карточкой.',
        automation: 'full',
        needsInAppLogin: true,
        fields: [],
      },
    ],
    validationPlan: [
      { key: 'session', title: 'Сессия браузера', hint: 'Проверяем, что окно входа завершено и cookies сохранены' },
      { key: 'profile', title: 'Доступ к организации', hint: 'Проверяем страницу /sprav/' },
      { key: 'capabilities', title: 'Доступные действия', hint: 'Описание, часы работы, фото, отзывы' },
    ],
  },

  /* ---------------------------- Google ----------------------------- */
  {
    id: 'google-ads',
    name: 'Google Ads',
    category: 'ads',
    vendor: 'Google',
    docsUrl: 'https://developers.google.com/google-ads/api/docs/start',
    color: '#4285f4',
    supportsSandbox: true,
    capabilities: ['campaigns.read', 'campaigns.write', 'bids.write', 'keywords.read', 'keywords.write', 'forecast.read'],
    notes: [note('Нужны developer-token и доступ (Basic/Standard). MARK определит рабочую версию API автоматически.')],
    authModes: [
      { id: 'oauth2', label: 'OAuth Google', description: 'Вход в окне Google и выдача refresh-токена.', automation: 'full', needsInAppLogin: true, fields: [{ key: 'developerToken', label: 'Developer token', type: 'password', required: true, secret: true }, { key: 'loginCustomerId', label: 'Login customer ID (MCC)', type: 'text', required: false, placeholder: '1234567890' }] },
      { id: 'api_token', label: 'OAuth access token', description: 'Короткоживущий токен или refresh-токен с client_id/secret.', automation: 'full', fields: [{ key: 'accessToken', label: 'Access token', type: 'password', required: true, secret: true }, { key: 'refreshToken', label: 'Refresh token', type: 'password', required: false, secret: true }, { key: 'clientId', label: 'Client ID', type: 'text', required: false }, { key: 'clientSecret', label: 'Client secret', type: 'password', required: false, secret: true }, { key: 'developerToken', label: 'Developer token', type: 'password', required: true, secret: true }, { key: 'loginCustomerId', label: 'Login customer ID', type: 'text', required: false }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Для выгрузки отчётов и ручных действий в интерфейсе Ads.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'tokeninfo', title: 'Проверка токена', hint: 'oauth2.googleapis.com/tokeninfo' },
      { key: 'devtoken', title: 'Developer token', hint: 'Наличие и валидность developer-token' },
      { key: 'version', title: 'Версия API', hint: 'Автоподбор рабочей версии googleads.googleapis.com' },
      { key: 'customers', title: 'Доступные аккаунты', hint: 'customers:listAccessibleCustomers' },
    ],
  },
  {
    id: 'google-analytics',
    name: 'Google Analytics 4',
    category: 'analytics',
    vendor: 'Google',
    docsUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
    color: '#f9ab00',
    supportsSandbox: true,
    capabilities: ['analytics.read', 'traffic.logs'],
    authModes: [
      { id: 'oauth2', label: 'OAuth Google', description: 'Вход в Google, доступ к GA4.', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'api_token', label: 'Service Account / access token', description: 'JSON-ключ сервисного аккаунта или access token.', automation: 'full', fields: [{ key: 'serviceAccountJson', label: 'JSON сервисного аккаунта', type: 'textarea', required: false, secret: true }, { key: 'accessToken', label: 'Access token', type: 'password', required: false, secret: true }, { key: 'propertyId', label: 'Property ID', type: 'text', required: false, placeholder: 'properties/123456789' }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Выгрузка отчётов из интерфейса GA4.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'tokeninfo', title: 'Проверка токена', hint: 'oauth2.googleapis.com/tokeninfo' },
      { key: 'properties', title: 'Свойства GA4', hint: 'accountSummaries' },
      { key: 'access', title: 'Права на чтение', hint: 'Пробный runReport' },
    ],
  },
  {
    id: 'google-search-console',
    name: 'Google Search Console',
    category: 'webmaster',
    vendor: 'Google',
    docsUrl: 'https://developers.google.com/webmaster-tools',
    color: '#4285f4',
    supportsSandbox: true,
    capabilities: ['site.read', 'indexing.submit'],
    authModes: [
      { id: 'oauth2', label: 'OAuth Google', description: 'Вход в Google с доступом к GSC.', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'api_token', label: 'Access token', description: 'Готовый токен.', automation: 'full', fields: [{ key: 'accessToken', label: 'Access token', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Отправка sitemap и переобхода через интерфейс.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'tokeninfo', title: 'Проверка токена', hint: 'oauth2.googleapis.com/tokeninfo' },
      { key: 'sites', title: 'Список ресурсов', hint: 'GET /webmasters/v3/sites' },
      { key: 'sitemaps', title: 'Sitemap', hint: 'Чтение загруженных карт сайта' },
    ],
  },
  {
    id: 'google-business-profile',
    name: 'Google Business Profile',
    category: 'site',
    vendor: 'Google',
    docsUrl: 'https://developers.google.com/my-business',
    color: '#34a853',
    supportsSandbox: true,
    capabilities: ['listings.write', 'site.read'],
    authModes: [
      { id: 'oauth2', label: 'OAuth Google', description: 'Доступ к бизнес-профилю (карточки в Google Maps).', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Правки карточек через интерфейс.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'tokeninfo', title: 'Проверка токена', hint: 'tokeninfo' },
      { key: 'accounts', title: 'Аккаунты', hint: 'mybusinessaccountmanagement/v1/accounts' },
      { key: 'locations', title: 'Локации', hint: 'Список карточек организации' },
    ],
  },

  /* ------------------------------ VK ------------------------------- */
  {
    id: 'vk-ads',
    name: 'VK Реклама',
    category: 'ads',
    vendor: 'VK',
    docsUrl: 'https://ads.vk.com/doc/api',
    color: '#0077ff',
    supportsSandbox: true,
    capabilities: ['campaigns.read', 'campaigns.write', 'bids.write', 'keywords.read', 'keywords.write'],
    notes: [note('Эндпоинты VK Ads периодически меняются — MARK пробует несколько кандидатов и запоминает рабочий.')],
    authModes: [
      { id: 'oauth2', label: 'OAuth VK', description: 'Вход в VK в окне приложения.', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'api_token', label: 'Токен VK Ads', description: 'Bearer-токен из настроек агентства.', automation: 'full', fields: [{ key: 'token', label: 'Токен', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на ads.vk.com.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'format', title: 'Формат токена', hint: 'Проверка длины и допустимых символов' },
      { key: 'probe', title: 'Проверка API', hint: 'Перебор рабочих эндпоинтов ads.vk.com/api/v2' },
      { key: 'accounts', title: 'Аккаунты', hint: 'Список доступных аккаунтов и кампаний' },
    ],
  },
  {
    id: 'vk-metrika',
    name: 'VK / Top.Mail.Ru (счётчики)',
    category: 'analytics',
    vendor: 'VK',
    docsUrl: 'https://top.mail.ru/help/',
    color: '#0077ff',
    supportsSandbox: true,
    capabilities: ['analytics.read'],
    authModes: [{ id: 'browser_login', label: 'Вход в браузере приложения', description: 'Выгрузка статистики счётчиков.', automation: 'partial', needsInAppLogin: true, fields: [] }],
    validationPlan: [
      { key: 'session', title: 'Сессия', hint: 'Проверяем cookies после входа' },
      { key: 'counters', title: 'Счётчики', hint: 'Доступные счётчики' },
    ],
  },

  /* --------------------------- Платформы --------------------------- */
  {
    id: 'tilda',
    name: 'Tilda',
    category: 'site',
    vendor: 'Tilda Publishing',
    docsUrl: 'https://help-ru.tilda.cc/api',
    color: '#111111',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.write'],
    notes: [note('Tilda API — только чтение. Публикация и правки страниц делаются через окно входа в редактор Tilda (автоматизация браузера).')],
    authModes: [
      { id: 'api_token', label: 'Public/Secret key', description: 'Ключи из «Настройки проекта → API». Проверяем getprojectslist.', automation: 'partial', fields: [{ key: 'publicKey', label: 'Public key', type: 'text', required: true, secret: true }, { key: 'secretKey', label: 'Secret key', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в редактор Tilda', description: 'Открываем tilda.cc — вы входите, MARK управляет страницами и публикует изменения.', automation: 'full', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'format', title: 'Формат ключей', hint: 'Проверяем длину и состав ключей' },
      { key: 'api', title: 'Tilda API', hint: 'GET /1/getprojectslist' },
      { key: 'projects', title: 'Проекты', hint: 'Список проектов и страниц' },
      { key: 'write', title: 'Права на запись', hint: 'Определяем: доступен API-чтение или нужен вход в редактор' },
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'site',
    vendor: 'WordPress',
    docsUrl: 'https://developer.wordpress.org/rest-api/',
    color: '#21759b',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    notes: [note('Поддерживаются Application Passwords (WP 5.6+) и JWT. SEO-плагины: Yoast, Rank Math, All in One SEO.')],
    authModes: [
      { id: 'api_token', label: 'Application Password', description: 'Пользователь + пароль приложения.', automation: 'full', fields: [{ key: 'siteUrl', label: 'Адрес сайта', type: 'url', required: true, placeholder: 'https://example.ru' }, { key: 'username', label: 'Логин', type: 'text', required: true }, { key: 'appPassword', label: 'Application Password', type: 'password', required: true, secret: true, placeholder: 'xxxx xxxx xxxx xxxx' }] },
      { id: 'browser_login', label: 'Вход в /wp-admin', description: 'Вход в админку и управление через интерфейс.', automation: 'full', needsInAppLogin: true, fields: [{ key: 'siteUrl', label: 'Адрес сайта', type: 'url', required: true }] },
    ],
    validationPlan: [
      { key: 'reachable', title: 'Доступность сайта', hint: 'Проверяем HTTP и наличие wp-json' },
      { key: 'auth', title: 'Авторизация', hint: 'GET /wp-json/wp/v2/users/me' },
      { key: 'capabilities', title: 'Права', hint: 'Роли, публикация, рубрики, медиа' },
      { key: 'seo', title: 'SEO-плагин', hint: 'Наличие Yoast / Rank Math / AIOSEO' },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'infra',
    vendor: 'Vercel',
    docsUrl: 'https://vercel.com/docs/rest-api',
    color: '#000000',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.deploy', 'site.redirects'],
    notes: [note('Правки в исходники идут через git-репозиторий (коннектор GitHub/GitLab), Vercel пересобирает проект автоматически.')],
    authModes: [
      { id: 'api_token', label: 'API-токен', description: 'Токен из Account Settings → Tokens.', automation: 'full', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }, { key: 'teamId', label: 'Team ID', type: 'text', required: false }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на vercel.com для управления проектами и доменами.', automation: 'partial', needsInAppLogin: true, fields: [] },
      { id: 'git', label: 'Доступ к репозиторию', description: 'Коммиты в ветку проекта → автодеплой.', automation: 'full', fields: [{ key: 'repoUrl', label: 'URL репозитория', type: 'url', required: true }, { key: 'branch', label: 'Ветка', type: 'text', required: false, default: 'main' }, { key: 'token', label: 'Токен git-провайдера', type: 'password', required: true, secret: true }] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка токена', hint: 'GET /v2/user' },
      { key: 'projects', title: 'Проекты', hint: 'Список проектов и доменов' },
      { key: 'deployments', title: 'Деплойменты', hint: 'Последние сборки и их статус' },
      { key: 'domains', title: 'Домены и редиректы', hint: 'Возможность правок redirects.json' },
    ],
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'infra',
    vendor: 'Netlify',
    docsUrl: 'https://docs.netlify.com/api/get-started/',
    color: '#00c7b7',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.deploy', 'site.redirects'],
    authModes: [
      { id: 'api_token', label: 'Personal Access Token', description: 'Токен из User settings → Applications.', automation: 'full', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на app.netlify.com.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка токена', hint: 'GET /api/v1/user' },
      { key: 'sites', title: 'Сайты', hint: 'Список сайтов и домены' },
      { key: 'deploys', title: 'Деплои', hint: 'Последние деплои' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'infra',
    vendor: 'GitHub',
    docsUrl: 'https://docs.github.com/rest',
    color: '#24292f',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    notes: [note('Через GitHub MARK коммитит sitemap.xml, robots.txt, llms.txt, JSON-LD и правки шаблонов — это универсальный путь для Vercel/Netlify/Next/Astro.')],
    authModes: [
      { id: 'api_token', label: 'Personal Access Token', description: 'Fine-grained токен с правами Contents: read/write.', automation: 'full', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true, placeholder: 'github_pat_...' }, { key: 'owner', label: 'Владелец', type: 'text', required: false }, { key: 'repo', label: 'Репозиторий', type: 'text', required: false }] },
      { id: 'oauth2', label: 'OAuth GitHub', description: 'Вход через GitHub в окне приложения.', automation: 'full', needsInAppLogin: true, fields: [] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на github.com.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка токена', hint: 'GET /user' },
      { key: 'scopes', title: 'Права', hint: 'Проверяем scopes/права на Contents' },
      { key: 'repos', title: 'Репозитории', hint: 'Список доступных репозиториев' },
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'site',
    vendor: 'Webflow',
    docsUrl: 'https://developers.webflow.com/',
    color: '#4353ff',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    authModes: [
      { id: 'api_token', label: 'Site API token', description: 'Токен сайта из Project settings → Apps & integrations.', automation: 'full', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }, { key: 'siteId', label: 'Site ID', type: 'text', required: false }] },
      { id: 'oauth2', label: 'OAuth Webflow', description: 'Вход в окне приложения.', automation: 'full', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка токена', hint: 'GET /v2/token/authorized_by' },
      { key: 'sites', title: 'Сайты', hint: 'Список сайтов' },
      { key: 'publish', title: 'Публикация', hint: 'Права на publish и правки CMS' },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'infra',
    vendor: 'Cloudflare',
    docsUrl: 'https://developers.cloudflare.com/api/',
    color: '#f38020',
    supportsSandbox: true,
    capabilities: ['site.read', 'dns.write', 'site.redirects'],
    notes: [note('Cloudflare нужен для блокировок BotShield (Firewall Rules), редиректов, кэша и DNS.')],
    authModes: [
      { id: 'api_token', label: 'API Token', description: 'Токен с Zone:Read, DNS:Edit, Firewall Services:Edit.', automation: 'full', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }] },
      { id: 'browser_login', label: 'Вход в браузере приложения', description: 'Вход на dash.cloudflare.com.', automation: 'partial', needsInAppLogin: true, fields: [] },
    ],
    validationPlan: [
      { key: 'verify', title: 'Проверка токена', hint: 'GET /client/v4/user/tokens/verify' },
      { key: 'zones', title: 'Зоны', hint: 'Список доменов в аккаунте' },
      { key: 'firewall', title: 'Firewall', hint: 'Права на правила безопасности' },
    ],
  },

  /* ---------------------- Прочее (связь, AI) ----------------------- */
  {
    id: 'telegram',
    name: 'Telegram Bot',
    category: 'messenger',
    vendor: 'Telegram',
    docsUrl: 'https://core.telegram.org/bots/api',
    color: '#229ed9',
    supportsSandbox: true,
    capabilities: ['messaging.send'],
    notes: [note('Бот присылает алерты планировщика и отчёты в чат. Достаточно токена BotFather.')],
    authModes: [
      { id: 'api_token', label: 'Токен бота', description: 'Токен от @BotFather.', automation: 'full', fields: [{ key: 'botToken', label: 'Bot token', type: 'password', required: true, secret: true, placeholder: '123456:AA...' }, { key: 'chatId', label: 'Chat ID', type: 'text', required: false, placeholder: '-1001234567890' }] },
    ],
    validationPlan: [
      { key: 'me', title: 'Проверка бота', hint: 'GET /getMe' },
      { key: 'chat', title: 'Доступ к чату', hint: 'Отправляем служебное сообщение при необходимости' },
    ],
  },
  {
    id: 'email-smtp',
    name: 'E-mail (SMTP)',
    category: 'email',
    vendor: 'Any',
    docsUrl: '',
    color: '#6b7280',
    supportsSandbox: true,
    capabilities: ['email.send'],
    notes: [note('Отправка отчётов и алертов. Реализован собственный SMTP-клиент (TLS, AUTH LOGIN/PLAIN) — без внешних зависимостей.')],
    authModes: [
      {
        id: 'api_token',
        label: 'SMTP-сервер',
        description: 'Хост, порт, пользователь, пароль, адрес отправителя.',
        automation: 'full',
        fields: [
          { key: 'host', label: 'SMTP-хост', type: 'text', required: true, placeholder: 'smtp.yandex.ru' },
          { key: 'port', label: 'Порт', type: 'number', required: true, default: '465' },
          { key: 'secure', label: 'TLS (465) / STARTTLS (587)', type: 'select', required: true, default: 'tls', options: [{ value: 'tls', label: 'Implicit TLS (465)' }, { value: 'starttls', label: 'STARTTLS (587)' }, { value: 'none', label: 'Без шифрования' }] },
          { key: 'user', label: 'Пользователь', type: 'text', required: true },
          { key: 'password', label: 'Пароль', type: 'password', required: true, secret: true },
          { key: 'from', label: 'От кого', type: 'text', required: true, placeholder: 'mark@example.ru' },
        ],
      },
    ],
    validationPlan: [
      { key: 'connect', title: 'Подключение', hint: 'TCP/TLS-соединение с SMTP-сервером' },
      { key: 'ehlo', title: 'EHLO и возможности', hint: 'STARTTLS, AUTH, размер письма' },
      { key: 'auth', title: 'Авторизация', hint: 'AUTH LOGIN/PLAIN' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'ai',
    vendor: 'OpenAI',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    color: '#10a37f',
    supportsSandbox: true,
    capabilities: ['ai.generate'],
    notes: [note('Используется для генерации текстов гипотез, SEO-мета и контента региональных страниц. Есть локальный шаблонный генератор как fallback.')],
    authModes: [
      { id: 'api_token', label: 'API-ключ', description: 'Ключ проекта OpenAI.', automation: 'full', fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true, secret: true, placeholder: 'sk-...' }, { key: 'model', label: 'Модель', type: 'text', required: false, default: 'gpt-4o-mini' }, { key: 'baseUrl', label: 'Base URL', type: 'url', required: false, default: 'https://api.openai.com/v1' }] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка ключа', hint: 'GET /v1/models' },
      { key: 'model', title: 'Доступ к модели', hint: 'Пробный минимальный запрос' },
    ],
  },
  {
    id: 'yandex-gpt',
    name: 'YandexGPT',
    category: 'ai',
    vendor: 'Яндекс',
    docsUrl: 'https://cloud.yandex.ru/docs/yandexgpt/',
    color: '#fc3f1d',
    supportsSandbox: true,
    capabilities: ['ai.generate'],
    authModes: [
      { id: 'api_token', label: 'API-ключ сервисного аккаунта', description: 'Api-Key и folderId.', automation: 'full', fields: [{ key: 'apiKey', label: 'Api-Key', type: 'password', required: true, secret: true }, { key: 'folderId', label: 'Folder ID', type: 'text', required: true }, { key: 'model', label: 'Модель', type: 'text', required: false, default: 'yandexgpt-lite' }] },
    ],
    validationPlan: [
      { key: 'auth', title: 'Проверка ключа', hint: 'Минимальный запрос к foundationModels' },
      { key: 'model', title: 'Доступ к модели', hint: 'Проверяем имя модели и folderId' },
    ],
  },
  {
    id: 'ftp-hosting',
    name: 'Хостинг по FTP/SFTP',
    category: 'infra',
    vendor: 'Any',
    docsUrl: '',
    color: '#8b5cf6',
    supportsSandbox: true,
    capabilities: ['site.read', 'site.write', 'site.deploy'],
    notes: [note('Универсальный путь для сайтов на любом хостинге: загружаем sitemap.xml, robots.txt, llms.txt, .well-known, правим html/шаблоны.')],
    authModes: [
      { id: 'sftp', label: 'SFTP', description: 'SSH-доступ к файлам сайта.', automation: 'full', fields: [{ key: 'host', label: 'Хост', type: 'text', required: true }, { key: 'port', label: 'Порт', type: 'number', required: true, default: '22' }, { key: 'user', label: 'Пользователь', type: 'text', required: true }, { key: 'password', label: 'Пароль', type: 'password', required: false, secret: true }, { key: 'privateKey', label: 'Приватный ключ', type: 'textarea', required: false, secret: true }, { key: 'root', label: 'Корень сайта', type: 'text', required: false, default: '/www/example.ru' }] },
      { id: 'ftp', label: 'FTP', description: 'Классический FTP-доступ.', automation: 'full', fields: [{ key: 'host', label: 'Хост', type: 'text', required: true }, { key: 'port', label: 'Порт', type: 'number', required: true, default: '21' }, { key: 'user', label: 'Пользователь', type: 'text', required: true }, { key: 'password', label: 'Пароль', type: 'password', required: true, secret: true }, { key: 'root', label: 'Корень сайта', type: 'text', required: false, default: '/htdocs' }] },
    ],
    validationPlan: [
      { key: 'connect', title: 'Подключение', hint: 'Соединение с сервером (порт 21/22)' },
      { key: 'auth', title: 'Авторизация', hint: 'Проверка пары логин/пароль или ключа' },
      { key: 'root', title: 'Корень сайта', hint: 'Проверяем, что в каталоге лежит index.html' },
      { key: 'write', title: 'Права на запись', hint: 'Тестовый файл .mark-check.txt' },
    ],
  },
  {
    id: 'indexnow',
    name: 'IndexNow (Яндекс/Bing/Seznam)',
    category: 'webmaster',
    vendor: 'IndexNow',
    docsUrl: 'https://www.indexnow.org/documentation',
    color: '#0ea5e9',
    supportsSandbox: true,
    capabilities: ['indexing.submit'],
    notes: [note('Мгновенная индексация без OAuth: нужен ключ, выложенный в корень сайта. MARK умеет выложить его сам.')],
    authModes: [
      { id: 'api_token', label: 'Ключ IndexNow', description: 'Ключ и адрес файла ключа.', automation: 'full', fields: [{ key: 'key', label: 'Ключ', type: 'password', required: true, secret: true }, { key: 'host', label: 'Хост', type: 'text', required: true, placeholder: 'example.ru' }, { key: 'keyLocation', label: 'URL файла ключа', type: 'url', required: false, placeholder: 'https://example.ru/abc123.txt' }] },
    ],
    validationPlan: [
      { key: 'format', title: 'Формат ключа', hint: '8–128 символов, hex/base62' },
      { key: 'keyfile', title: 'Файл ключа', hint: 'Проверяем доступность keyLocation' },
      { key: 'ping', title: 'Отправка тестового URL', hint: 'POST /indexnow (200/202)' },
    ],
  },
];

export const SERVICE_MAP: Record<string, ServiceDef> = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

export const getService = (id: string): ServiceDef | undefined => SERVICE_MAP[id];

export const serviceName = (id: string) => SERVICE_MAP[id]?.name ?? id;

/** Официальные эндпоинты OAuth (используются сервером в режиме веб-приложения). */
export const OAUTH_PROVIDERS: Record<
  string,
  {
    authorizeUrl: string;
    tokenUrl: string;
    scope?: string;
    /** Можно ли получить токен implicit-потоком (без client_secret) */
    implicit: boolean;
    extraAuthParams?: Record<string, string>;
    /** Basic-заголовок при обмене кода на токен */
    tokenAuth?: 'body' | 'basic';
    notes?: string;
  }
> = {
  'yandex-direct': {
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    implicit: true,
    notes: 'Яндекс поддерживает implicit-поток (response_type=token) — удобно для десктопа без секрета.',
  },
  'yandex-metrika': {
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    implicit: true,
  },
  'yandex-webmaster': {
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    tokenUrl: 'https://oauth.yandex.ru/token',
    implicit: true,
  },
  'yandex-gpt': { authorizeUrl: '', tokenUrl: '', implicit: false },
  'google-ads': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/adwords',
    implicit: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    tokenAuth: 'body',
  },
  'google-analytics': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    implicit: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  'google-search-console': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/webmasters.readonly',
    implicit: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  'google-business-profile': {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/business.manage',
    implicit: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  'vk-ads': {
    authorizeUrl: 'https://oauth.vk.com/authorize',
    tokenUrl: 'https://oauth.vk.com/access_token',
    scope: 'ads,offline',
    implicit: true,
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'repo read:user',
    implicit: false,
    tokenAuth: 'body',
  },
  webflow: {
    authorizeUrl: 'https://webflow.com/oauth/authorize',
    tokenUrl: 'https://api.webflow.com/oauth/access_token',
    implicit: false,
    tokenAuth: 'body',
  },
};

/** Сервисы, для которых доступен вход в окне приложения (автоматизация браузера). */
export const BROWSER_LOGIN_URLS: Record<string, string> = {
  'yandex-direct': 'https://direct.yandex.ru/',
  'yandex-metrika': 'https://metrika.yandex.ru/',
  'yandex-webmaster': 'https://webmaster.yandex.ru/',
  'yandex-business': 'https://yandex.ru/sprav/',
  'google-ads': 'https://ads.google.com/',
  'google-analytics': 'https://analytics.google.com/',
  'google-search-console': 'https://search.google.com/search-console',
  'google-business-profile': 'https://business.google.com/',
  'vk-ads': 'https://ads.vk.com/',
  'vk-metrika': 'https://top.mail.ru/',
  tilda: 'https://tilda.cc/login/',
  wordpress: 'https://wordpress.com/log-in',
  vercel: 'https://vercel.com/login',
  netlify: 'https://app.netlify.com/',
  github: 'https://github.com/login',
  webflow: 'https://webflow.com/dashboard/login',
  cloudflare: 'https://dash.cloudflare.com/login',
};

/** Как проверить, что сессия входа жива (используется после закрытия окна). */
export const BROWSER_SESSION_PROBES: Record<string, { url: string; mustContainAny: string[]; mustNotContainAny?: string[] }> = {
  'yandex-direct': { url: 'https://direct.yandex.ru/', mustContainAny: ['Директ', 'Кампании'], mustNotContainAny: ['Введите логин', 'captcha'] },
  'yandex-metrika': { url: 'https://metrika.yandex.ru/list', mustContainAny: ['Счётчики', 'Метрика'], mustNotContainAny: ['Введите логин'] },
  'yandex-webmaster': { url: 'https://webmaster.yandex.ru/sites/', mustContainAny: ['Мои сайты', 'Сайты'], mustNotContainAny: ['Введите логин'] },
  'yandex-business': { url: 'https://yandex.ru/sprav/', mustContainAny: ['Организац', 'Бизнес'], mustNotContainAny: ['Введите логин'] },
  'google-ads': { url: 'https://ads.google.com/aw/overview', mustContainAny: ['Google Ads', 'Кампании'], mustNotContainAny: ['Войдите'] },
  'google-search-console': { url: 'https://search.google.com/search-console', mustContainAny: ['Search Console', 'Ресурс'], mustNotContainAny: ['Войдите'] },
  'vk-ads': { url: 'https://ads.vk.com/', mustContainAny: ['VK', 'Реклам'], mustNotContainAny: ['Войти'] },
  tilda: { url: 'https://tilda.cc/projects/', mustContainAny: ['Проект', 'Tilda'], mustNotContainAny: ['Пароль'] },
  vercel: { url: 'https://vercel.com/dashboard', mustContainAny: ['Project', 'Overview'], mustNotContainAny: ['Sign in'] },
  netlify: { url: 'https://app.netlify.com/teams', mustContainAny: ['Team', 'Sites'], mustNotContainAny: ['Log in'] },
  github: { url: 'https://github.com/settings/profile', mustContainAny: ['Profile', 'Public profile'], mustNotContainAny: ['Sign in'] },
  webflow: { url: 'https://webflow.com/dashboard', mustContainAny: ['Dashboard', 'Webflow'], mustNotContainAny: ['Sign in'] },
  cloudflare: { url: 'https://dash.cloudflare.com/', mustContainAny: ['Account', 'Websites'], mustNotContainAny: ['Sign in'] },
};
