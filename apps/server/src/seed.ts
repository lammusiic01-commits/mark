import type { Campaign, Hypothesis, ScheduleRule } from '@mark/shared';
import { randomId } from './crypto.js';
import { repos } from './db/repos.js';
import { rootLogger } from './logger.js';
import { simulateMetrics } from './services/campaigns.js';
import { generateHypotheses, toHypothesis } from './services/hypotheses.js';
import { defaultRules } from './services/scheduler.js';

/**
 * Демонстрационные данные: создаются один раз при первом запуске,
 * чтобы интерфейс сразу показывал живые цифры. Удаляются вместе с .data/.
 */

const log = rootLogger.child('seed');

export interface SeedResult {
  tenantId: string;
  created: boolean;
  clients: number;
  sites: number;
  campaigns: number;
  hypotheses: number;
  rules: number;
}

const DEMO = [
  {
    client: 'СтройМастер',
    site: 'СтройМастер — ремонт квартир',
    url: 'https://stroy-master.example',
    platform: 'wordpress',
    connectorId: 'wordpress-rest',
    niche: 'ремонт квартир',
    regions: [213, 2, 54],
    keywords: ['ремонт квартир', 'ремонт квартир под ключ', 'отделка новостройки'],
    budget: 240_000,
    spend: 165_000,
  },
  {
    client: 'DentaService',
    site: 'DentaService — стоматология',
    url: 'https://denta-service.example',
    platform: 'tilda',
    connectorId: 'tilda-browser',
    niche: 'стоматология',
    regions: [213, 2],
    keywords: ['имплантация зубов', 'стоматология рядом', 'брекеты цена'],
    budget: 180_000,
    spend: 142_000,
  },
  {
    client: 'АвтоТех',
    site: 'АвтоТех — автосервис',
    url: 'https://avtoteh.example',
    platform: 'bitrix',
    connectorId: 'ftp-hosting',
    niche: 'автосервис',
    regions: [54, 56, 213],
    keywords: ['автосервис', 'ремонт двигателя', 'кузовной ремонт'],
    budget: 120_000,
    spend: 88_000,
  },
];

/** Демонстрационный лог доступа: боты, AI-краулеры, атака и живые люди. */
const SAMPLE_LOG = [
  '66.249.66.1 - - [10/Oct/2026:03:12:11 +0300] "GET / HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '66.249.66.1 - - [10/Oct/2026:03:12:12 +0300] "GET /catalog/remont/ HTTP/1.1" 200 33112 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '5.255.253.10 - - [10/Oct/2026:03:40:02 +0300] "GET / HTTP/1.1" 200 45231 "https://yandex.ru/search/" "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"',
  '20.191.45.212 - - [10/Oct/2026:04:02:15 +0300] "GET /articles/ceny/ HTTP/1.1" 200 28890 "-" "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"',
  '3.91.44.17 - - [10/Oct/2026:05:15:41 +0300] "GET /wp-login.php HTTP/1.1" 404 512 "-" "python-requests/2.31.0"',
  '3.91.44.17 - - [10/Oct/2026:05:15:42 +0300] "GET /.env HTTP/1.1" 403 178 "-" "python-requests/2.31.0"',
  '3.91.44.17 - - [10/Oct/2026:05:15:43 +0300] "POST /xmlrpc.php HTTP/1.1" 404 512 "-" "python-requests/2.31.0"',
  '3.91.44.17 - - [10/Oct/2026:05:15:44 +0300] "GET /phpmyadmin/ HTTP/1.1" 403 178 "-" "python-requests/2.31.0"',
  '185.220.101.5 - - [10/Oct/2026:06:20:19 +0300] "GET /?utm_source=spam HTTP/1.1" 200 45231 "https://spam-site.ru/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/118.0.0.0 Safari/537.36"',
  '185.220.101.5 - - [10/Oct/2026:06:20:20 +0300] "GET /?page=2 HTTP/1.1" 200 45100 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/118.0.0.0 Safari/537.36"',
  '212.83.175.9 - - [10/Oct/2026:07:03:55 +0300] "GET / HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (compatible; AhrefsBot/7.1; +http://ahrefs.com/robot/)"',
  '212.83.175.9 - - [10/Oct/2026:07:04:11 +0300] "GET /catalog/ HTTP/1.1" 200 41002 "-" "Mozilla/5.0 (compatible; AhrefsBot/7.1; +http://ahrefs.com/robot/)"',
  '91.219.238.14 - - [10/Oct/2026:08:11:09 +0300] "GET / HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '91.219.238.14 - - [10/Oct/2026:08:11:10 +0300] "GET /price/ HTTP/1.1" 200 22100 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '91.219.238.14 - - [10/Oct/2026:08:11:11 +0300] "GET /admin/ HTTP/1.1" 404 512 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
  '95.108.213.5 - - [10/Oct/2026:09:30:00 +0300] "GET /sitemap.xml HTTP/1.1" 200 8100 "-" "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"',
  '34.98.99.10 - - [10/Oct/2026:10:05:33 +0300] "GET /blog/kak-vybrat/ HTTP/1.1" 200 33120 "-" "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"',
  '77.88.5.19 - - [10/Oct/2026:11:44:02 +0300] "GET / HTTP/1.1" 200 45231 "https://market.example.ru/" "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/118.0 Mobile Safari/537.36"',
  '93.180.53.211 - - [10/Oct/2026:12:22:17 +0300] "GET /catalog/?sort=price HTTP/1.1" 200 41002 "-" "Scrapy/2.11 (+https://scrapy.org)"',
  '93.180.53.211 - - [10/Oct/2026:12:22:18 +0300] "GET /catalog/?sort=date HTTP/1.1" 200 41002 "-" "Scrapy/2.11 (+https://scrapy.org)"',
  '93.180.53.211 - - [10/Oct/2026:12:22:19 +0300] "GET /catalog/?page=3 HTTP/1.1" 200 41002 "-" "Scrapy/2.11 (+https://scrapy.org)"',
  '46.4.101.77 - - [10/Oct/2026:13:10:44 +0300] "GET / HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)"',
  '51.75.65.10 - - [10/Oct/2026:14:02:01 +0300] "GET /wp-content/plugins/old/readme.txt HTTP/1.1" 404 512 "-" "masscan/1.3"',
  '51.75.65.10 - - [10/Oct/2026:14:02:02 +0300] "GET /phpmyadmin/ HTTP/1.1" 403 178 "-" "masscan/1.3"',
  '80.85.156.4 - - [10/Oct/2026:15:33:29 +0300] "GET /contacts/ HTTP/1.1" 200 19004 "https://yandex.ru/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36"',
  '80.85.156.4 - - [10/Oct/2026:15:34:02 +0300] "GET /price/ HTTP/1.1" 200 22100 "https://stroy-master.example/contacts/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36"',
  '185.220.101.5 - - [10/Oct/2026:16:01:11 +0300] "GET /?page=1 HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/118.0.0.0 Safari/537.36"',
  '185.220.101.5 - - [10/Oct/2026:16:01:12 +0300] "GET /?page=2 HTTP/1.1" 200 45231 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/118.0.0.0 Safari/537.36"',
  '20.191.45.212 - - [10/Oct/2026:17:15:31 +0300] "GET /blog/ HTTP/1.1" 200 33120 "-" "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"',
  '20.191.45.212 - - [10/Oct/2026:17:15:35 +0300] "GET /blog/kak-vybrat/ HTTP/1.1" 200 33120 "-" "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"',
  '95.108.213.5 - - [10/Oct/2026:18:02:12 +0300] "GET /catalog/ HTTP/1.1" 200 41002 "-" "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"',
  '80.85.156.4 - - [10/Oct/2026:19:11:04 +0300] "GET /blog/kak-vybrat/ HTTP/1.1" 200 33120 "https://vk.com/" "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/119.0 Mobile Safari/537.36"',
].join('\n');

export function demoLogSample(): string {
  return SAMPLE_LOG;
}

export async function ensureDemoData(): Promise<SeedResult> {
  const db = await repos();
  const existing = db.tenant.list({ limit: 1 })[0];
  if (existing) {
    return { tenantId: existing.id, created: false, clients: 0, sites: 0, campaigns: 0, hypotheses: 0, rules: 0 };
  }

  log.info('Первый запуск: создаю демонстрационные данные');
  const now = new Date().toISOString();
  const tenant = db.tenant.put({
    id: randomId('tnt'),
    tenantId: 'self',
    slug: 'agency',
    agencyName: 'MARK Demo Agency',
    brandColor: '#2563eb',
    accentColor: '#0ea5e9',
    logoDataUrl: null,
    faviconDataUrl: null,
    customDomain: null,
    supportEmail: 'hello@mark.local',
    supportPhone: '+7 (495) 000-00-00',
    footerNote: 'Отчёт подготовлен автоматически платформой MARK',
    reportHeader: null,
    reportFooter: 'Конфиденциально. Данные не подлежат передаче третьим лицам.',
    hideMarkBranding: false,
    locale: 'ru',
    createdAt: now,
    updatedAt: now,
  } as never);
  db.tenant.patch(tenant.id, { tenantId: tenant.id } as never);
  const tenantId = tenant.id;

  let clients = 0;
  let sites = 0;
  let campaigns = 0;
  let hypotheses = 0;
  let rules = 0;

  for (const demo of DEMO) {
    const client = db.client.put({
      id: randomId('cl'),
      tenantId,
      name: demo.client,
      contactName: 'Ирина Петрова',
      contactEmail: `client${clients + 1}@example.ru`,
      contactPhone: `+7 (495) 000-00-0${clients}`,
      monthlyBudget: demo.budget,
      notes: `Ниша: ${demo.niche}. Работаем по рекламе, SEO и локальной выдаче.`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as never);
    clients += 1;

    const site = db.siteProject.put({
      id: randomId('site'),
      tenantId,
      clientId: client.id,
      name: demo.site,
      url: demo.url,
      platform: demo.platform,
      platformConfidence: 90,
      platformEvidence: ['Определено автоматически при первом запуске (демо-данные)'],
      connectorId: demo.connectorId,
      accountId: null,
      goals: ['Заявки', 'Звонки', 'Рост видимости в поиске'],
      regions: demo.regions,
      keywords: demo.keywords,
      seoScore: 62 + sites * 7,
      lastAuditId: null,
      lastAuditAt: null,
      geoStatus: 'planned',
      status: 'active',
      notes: 'Демо-проект: данные сгенерированы для примера интерфейса',
      createdAt: now,
      updatedAt: now,
    } as never);
    sites += 1;

    for (let index = 0; index < 2; index += 1) {
      const dailyBudget = Math.round(demo.spend / 30 / 2);
      const base = { id: `${demo.client}-${index}`, dailyBudget, keywords: demo.keywords } as unknown as Campaign;
      const month = simulateMetrics(base, 30);
      db.campaign.put({
        id: randomId('cmp'),
        tenantId,
        clientId: client.id,
        siteProjectId: site.id,
        accountId: null,
        serviceId: 'yandex-direct',
        externalId: null,
        name: index === 0 ? `${demo.client} — Поиск` : `${demo.client} — РСЯ`,
        channel: 'yandex_direct',
        status: index === 0 ? 'active' : 'paused',
        strategy: index === 0 ? 'max_conversions' : 'max_clicks',
        dailyBudget,
        monthlyBudget: dailyBudget * 30,
        goal: 'Заявка с сайта',
        regionIds: demo.regions,
        keywords: demo.keywords,
        startDate: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
        bidAdjustmentPct: index === 0 ? 15 : 0,
        notes: null,
        metrics7d: simulateMetrics(base, 7).metrics,
        metrics30d: month.metrics,
        trend: month.trend,
        warnings: [],
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      } as never);
      campaigns += 1;
    }

    for (const draft of generateHypotheses({ count: 4, niche: demo.niche, siteName: demo.site })) {
      const hypothesis: Hypothesis = toHypothesis(draft, { tenantId, clientId: client.id, siteProjectId: site.id });
      db.hypothesis.put({ ...hypothesis, status: hypotheses % 3 === 0 ? 'running' : 'backlog' } as never);
      hypotheses += 1;
    }
  }

  for (const rule of defaultRules(tenantId, null)) {
    db.scheduleRule.put({ ...rule, id: randomId('rule'), createdAt: now, updatedAt: now } as never);
    rules += 1;
  }

  db.kv.set('demo:botlog', { content: SAMPLE_LOG, name: 'access.log (демо-образец)' });

  db.events.log({
    tenantId,
    type: 'system',
    level: 'info',
    message: 'Создан демо-тенант с примерами клиентов, сайтов, кампаний и гипотез',
    payload: { clients, sites, campaigns, hypotheses, rules },
  });

  log.info(`Демо-данные: клиентов ${clients}, сайтов ${sites}, кампаний ${campaigns}, гипотез ${hypotheses}, правил ${rules}`);
  return { tenantId, created: true, clients, sites, campaigns, hypotheses, rules };
}
