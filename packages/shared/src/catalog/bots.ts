import type { Severity } from '../types.js';

/**
 * База сигнатур для BotShield: классификация трафика в логах сервера.
 *
 * Каждая запись — проверяемое правило. Для «хороших» ботов дополнительно
 * указаны домены для обратного DNS-подтверждения (rDNS) — это единственный
 * надёжный способ отличить настоящего Googlebot от подделки.
 */

export interface BotSignature {
  id: string;
  /** Отображаемое имя */
  name: string;
  classification: 'good_bot' | 'ai_crawler' | 'bot' | 'headless' | 'scraper' | 'attack';
  /** Регэксп по User-Agent */
  pattern: RegExp;
  /** Домены, которые должны быть у rDNS-записи (для верификации) */
  verifyDomains?: string[];
  /** Диапазоны IP (CIDR) — быстрая проверка без rDNS */
  cidrs?: string[];
  /** Что делает */
  purpose: string;
  /** Нужно ли разрешать в robots.txt / firewall */
  recommendation: string;
}

/* Реальные диапазоны поисковых ботов (публичные списки). */
const GOOGLEBOT_CIDRS = [
  '66.249.64.0/19',
  '66.249.64.0/20',
  '72.14.199.0/25',
  '209.85.238.0/24',
  '34.100.182.96/28',
  '35.247.243.240/28',
  '74.125.216.0/23',
];
const YANDEX_CIDRS = [
  '5.255.253.0/24',
  '37.9.113.0/24',
  '100.43.81.0/24',
  '178.154.131.0/24',
  '213.180.193.0/24',
  '213.180.203.0/24',
  '5.45.192.0/18',
  '87.250.224.0/19',
  '90.156.181.0/24',
  '95.108.128.0/17',
  '185.32.187.0/24',
  '77.88.0.0/18',
];
const BING_CIDRS = [
  '40.77.167.0/24',
  '157.55.39.0/24',
  '207.46.13.0/24',
  '13.66.139.0/24',
  '13.66.144.0/24',
  '52.167.144.0/24',
  '13.67.10.16/28',
  '20.15.133.160/27',
];

export const BOT_SIGNATURES: BotSignature[] = [
  /* ------------------------- Поисковые (хорошие) ------------------------- */
  {
    id: 'googlebot',
    name: 'Googlebot',
    classification: 'good_bot',
    pattern: /Googlebot/i,
    verifyDomains: ['googlebot.com', 'google.com'],
    cidrs: GOOGLEBOT_CIDRS,
    purpose: 'Индексация Google',
    recommendation: 'Разрешить, проверять rDNS (частые подделки под Googlebot).',
  },
  {
    id: 'yandexbot',
    name: 'YandexBot',
    classification: 'good_bot',
    pattern: /YandexBot/i,
    verifyDomains: ['yandex.ru', 'yandex.net', 'yandex.com'],
    cidrs: YANDEX_CIDRS,
    purpose: 'Индексация Яндекса',
    recommendation: 'Разрешить, проверять rDNS.',
  },
  {
    id: 'yandex-images',
    name: 'YandexImages',
    classification: 'good_bot',
    pattern: /YandexImages|YandexImageResizer|YandexMobileBot|YandexMetrika|YandexDirect|YandexUserProxy|YandexAccessibilityBot|YandexWebmaster/i,
    verifyDomains: ['yandex.ru', 'yandex.net'],
    purpose: 'Роботы сервисов Яндекса',
    recommendation: 'Разрешить.',
  },
  {
    id: 'bingbot',
    name: 'Bingbot',
    classification: 'good_bot',
    pattern: /bingbot|BingPreview|adidxbot|MicrosoftPreview/i,
    verifyDomains: ['search.msn.com', 'bing.com', 'microsoft.com'],
    cidrs: BING_CIDRS,
    purpose: 'Индексация Bing',
    recommendation: 'Разрешить.',
  },
  {
    id: 'duckduckbot',
    name: 'DuckDuckBot',
    classification: 'good_bot',
    pattern: /DuckDuckBot|DuckDuckGo/i,
    verifyDomains: ['duckduckgo.com'],
    purpose: 'Индексация DuckDuckGo',
    recommendation: 'Разрешить.',
  },
  {
    id: 'applebot',
    name: 'Applebot',
    classification: 'good_bot',
    pattern: /Applebot(?!-Extended)/i,
    verifyDomains: ['applebot.apple.com', 'apple.com'],
    cidrs: ['17.0.0.0/8'],
    purpose: 'Индексация Apple / Siri',
    recommendation: 'Разрешить.',
  },
  {
    id: 'baiduspider',
    name: 'Baiduspider',
    classification: 'good_bot',
    pattern: /Baiduspider/i,
    purpose: 'Индексация Baidu',
    recommendation: 'Разрешить, если есть аудитория в Китае.',
  },
  {
    id: 'mail-ru-bot',
    name: 'Mail.Ru Bot',
    classification: 'good_bot',
    pattern: /Mail\.RU_Bot|MailRuBot|Mail\.Ru/i,
    purpose: 'Индексация Mail.ru / новости',
    recommendation: 'Разрешить.',
  },
  {
    id: 'uptime-monitors',
    name: 'Сервисы мониторинга',
    classification: 'bot',
    pattern: /Pingdom|UptimeRobot|StatusCake|Datadog|NewRelicPinger|Better Uptime|Uptime|Site24x7|Zabbix|Nagios/i,
    purpose: 'Проверка доступности сайта',
    recommendation: 'Разрешить в robots/firewall (не влияет на SEO, но нужно для мониторинга).',
  },
  {
    id: 'social-previews',
    name: 'Превью соцсетей',
    classification: 'bot',
    pattern: /facebookexternalhit|Facebot|Twitterbot|TelegramBot|WhatsApp|Slackbot|LinkedInBot|Viber|SkypeUriPreview|vkShare|OdklBot|Discordbot|Pinterestbot/i,
    purpose: 'Построение превью ссылок',
    recommendation: 'Разрешить — иначе ссылки в соцсетях раскроются без картинки.',
  },

  /* --------------------------- AI-краулеры --------------------------- */
  {
    id: 'gptbot',
    name: 'GPTBot (OpenAI)',
    classification: 'ai_crawler',
    pattern: /GPTBot/i,
    verifyDomains: ['openai.com'],
    purpose: 'Сбор данных для обучения моделей OpenAI',
    recommendation:
      'Решается бизнесом: обычно блокируется (обучение конкурентов), но OpenAI ссылается на источники. Управляется в llms.txt.',
  },
  {
    id: 'oai-search',
    name: 'OAI-SearchBot / ChatGPT-User',
    classification: 'ai_crawler',
    pattern: /OAI-SearchBot|ChatGPT-User/i,
    verifyDomains: ['openai.com'],
    purpose: 'Поисковые ответы ChatGPT (трафик из AI-поиска!)',
    recommendation:
      'Разрешить: это вход для трафика из ChatGPT. Для GEO это ключевой бот — блокировка лишает вас AI-видимости.',
  },
  {
    id: 'claude',
    name: 'ClaudeBot / anthropic-ai',
    classification: 'ai_crawler',
    pattern: /ClaudeBot|anthropic-ai|Claude-Web|Claude-SearchBot/i,
    verifyDomains: ['anthropic.com'],
    purpose: 'Краулер Anthropic',
    recommendation: 'Разрешить Claude-SearchBot (AI-поиск), ClaudeBot — на усмотрение.',
  },
  {
    id: 'perplexity',
    name: 'PerplexityBot',
    classification: 'ai_crawler',
    pattern: /PerplexityBot|Perplexity-User/i,
    verifyDomains: ['perplexity.ai'],
    purpose: 'AI-поиск Perplexity (даёт переходы)',
    recommendation: 'Разрешить — источник AI-трафика с ссылками.',
  },
  {
    id: 'google-extended',
    name: 'Google-Extended',
    classification: 'ai_crawler',
    pattern: /Google-Extended/i,
    purpose: 'Обучение моделей Gemini',
    recommendation: 'Блокируется отдельно от Googlebot, не влияет на обычный поиск Google.',
  },
  {
    id: 'ccbot',
    name: 'CCBot (Common Crawl)',
    classification: 'ai_crawler',
    pattern: /CCBot/i,
    verifyDomains: ['commoncrawl.org'],
    purpose: 'Открытый датасет Common Crawl (основа многих LLM)',
    recommendation: 'Обычно блокируется: пользы для трафика нет.',
  },
  {
    id: 'bytespider',
    name: 'Bytespider (ByteDance)',
    classification: 'ai_crawler',
    pattern: /Bytespider|ByteDance|TikTokBot/i,
    purpose: 'Краулер ByteDance/TikTok',
    recommendation: 'Обычно блокируется: высокая нагрузка, нет переходов.',
  },
  {
    id: 'meta-ai',
    name: 'Meta-ExternalAgent',
    classification: 'ai_crawler',
    pattern: /meta-externalagent|FacebookBot|meta-webindexer/i,
    purpose: 'Краулер Meta для AI',
    recommendation: 'На усмотрение; блокируется на большинстве сайтов.',
  },
  {
    id: 'applebot-extended',
    name: 'Applebot-Extended',
    classification: 'ai_crawler',
    pattern: /Applebot-Extended/i,
    purpose: 'Обучение Apple Intelligence',
    recommendation: 'Не влияет на Siri/Spotlight-индексацию, можно блокировать.',
  },
  {
    id: 'other-ai',
    name: 'Прочие AI-краулеры',
    classification: 'ai_crawler',
    pattern: /Amazonbot|cohere-ai|YouBot|Diffbot|ImagesiftBot|Omgilibot|Omgili|PetalBot|SemrushBot-OCOB|Webzio|Timpibot|Brightbot|AI2Bot|Scrapy|Thinkbot|FriendlyCrawler/i,
    purpose: 'Сбор контента для AI-сервисов',
    recommendation: 'Проверяйте индивидуально; настраивается в llms.txt и robots.txt.',
  },
  {
    id: 'ai-user-agents',
    name: 'AI-агенты (запросы от пользователя)',
    classification: 'bot',
    pattern: /ChatGPT-User|Claude-User|Copilot|MistralAI-User|Gemini-User|Perplexity-User/i,
    purpose: 'Пользователь через AI-ассистента открывает страницу',
    recommendation: 'Разрешить: это живой трафик.',
  },

  /* --------------------------- SEO-краулеры --------------------------- */
  {
    id: 'seo-crawlers',
    name: 'SEO-краулеры (Ahrefs/Semrush и др.)',
    classification: 'scraper',
    pattern: /AhrefsBot|SemrushBot|MJ12bot|DotBot|BLEXBot|DataForSeoBot|SerpstatBot|SeznamBot|MegaIndex|linkdexbot|spbot|Screaming Frog|ScreamingFrog|Xenu|SISTRIX|rogerbot|Expanse|Moz\.com|MozBot/i,
    purpose: 'Сбор ссылок и позиций конкурентов',
    recommendation:
      'Обычно блокируется в firewall (нагрузка без пользы). Исключение — боты аналитики, в которые вы сами платите.',
  },

  /* ---------------------- Автоматизация/скрейпинг ---------------------- */
  {
    id: 'headless',
    name: 'Headless-браузеры',
    classification: 'headless',
    pattern: /HeadlessChrome|PhantomJS|Selenium|puppeteer|Playwright|electron|Nightmare|SlimerJS|HtmlUnit|jsdom/i,
    purpose: 'Парсинг и автоматизация (часто фрод и скрейпинг цен)',
    recommendation: 'Блокировать при высокой частоте; проверять через JS-челлендж.',
  },
  {
    id: 'lib-fetchers',
    name: 'HTTP-библиотеки',
    classification: 'scraper',
    pattern: /python-requests|python-urllib|aiohttp|httpx|axios\/|node-fetch|got \(|Go-http-client|okhttp|Java\/|Apache-HttpClient|libwww-perl|httpclient|Ruby|curl\/|Wget|HTTrack|aria2|PostmanRuntime|Insomnia|restsharp|guzzle|Mechanize|WinHTTP|Microsoft\.NET|scrapy/i,
    purpose: 'Программные запросы без браузера',
    recommendation: 'Не блокировать целиком (мешает API-клиентам), но следить за частотой и поведением.',
  },
  {
    id: 'price-parsers',
    name: 'Парсеры цен и мониторинг конкурентов',
    classification: 'scraper',
    pattern: /Price2Spy|Prisync|Priceva|Competera|incompetitor|SimilarWeb|spywords|KeyCollector|Topvisor|Yazzle|Linkpad|BuzzSumo|SerpStat|serpstat|RankActive|SE Ranking|SE-Ranking|advodka|Megaindex|Rookee|Pirate|Bullparse|SiteAnalyzer/i,
    purpose: 'Мониторинг цен/позиций',
    recommendation: 'Блокировать при существенной доле трафика; согласовать с вашими подрядчиками.',
  },
  {
    id: 'spam-backlinks-checkers',
    name: 'Спам-сканеры и сканеры ссылок',
    classification: 'scraper',
    pattern: /SemrushBot-BA|AhrefsBot\/6|BacklinkChecker|SEO-Audit|siteliner|UpTimeBot|linkchecker|W3C_Validator|Validator\.nu|FeedParser|Feedfetcher/i,
    purpose: 'Аудит ссылок и валидация',
    recommendation: 'Обычно безвредно, но корректируйте rate limit.',
  },

  /* --------------------- Атаки и вредоносная активность --------------------- */
  {
    id: 'vuln-scanners',
    name: 'Сканеры уязвимостей',
    classification: 'attack',
    pattern: /nikto|nmap|masscan|zgrab|sqlmap|Acunetix|Nessus|Netsparker|OpenVAS|w3af|dirbuster|gobuster|wpscan|Xray|Netsparker|Qualys|Censys|shodan|nuclei|Hydra|wpscan|Arachni|Skipfish|whatweb|dirb|ffuf|feroxbuster|Havij|jbrofuzz|ZmEu|Morfeus|Safe3|antSword|WAFNinja|ZAP|OWASP/i,
    purpose: 'Поиск уязвимостей / брутфорс',
    recommendation: 'Немедленно блокировать по IP/ASN, включать rate limit и WAF.',
  },
  {
    id: 'abuse-tools',
    name: 'Инструменты парсинга и обхода защиты',
    classification: 'attack',
    pattern: /eval\(|base64_|Brandwatch|Scrapy\/|masscan|censure|Hydra|Brutus|StormBreaker|webshell|xxe|%00|\.\.\/|union\s+select|<script|passwd|cmd=|exec\(/i,
    purpose: 'Признаки эксплуатации (инъекции, треверсинг)',
    recommendation: 'Блокировать, проверить серверные логи и целостность файлов.',
  },
];

/* --------------------------- Датацентры --------------------------- */

export interface DatacenterAsn {
  asn: string;
  org: string;
  /** Вероятность, что трафик оттуда — бот/скрапер */
  risk: number;
  note: string;
}

export const DATACENTER_ASNS: DatacenterAsn[] = [
  { asn: 'AS14061', org: 'DigitalOcean', risk: 85, note: 'Скраперы, боты, VPN — практически нет живых пользователей' },
  { asn: 'AS14618', org: 'Amazon AWS', risk: 78, note: 'Облачные скраперы; исключение — известные боты поиска' },
  { asn: 'AS16509', org: 'Amazon AWS (EC2)', risk: 78, note: 'То же' },
  { asn: 'AS15169', org: 'Google LLC', risk: 35, note: 'Googlebot — легитимен, остальное — облачные скраперы' },
  { asn: 'AS8075', org: 'Microsoft', risk: 45, note: 'Bingbot легитимен, прочее — Azure-боты' },
  { asn: 'AS396982', org: 'Google Cloud', risk: 70, note: 'Облачные скраперы' },
  { asn: 'AS24940', org: 'Hetzner Online', risk: 88, note: 'Очень много скраперов и VPN' },
  { asn: 'AS16276', org: 'OVH SAS', risk: 82, note: 'Скраперы, боты' },
  { asn: 'AS51167', org: 'Contabo', risk: 85, note: 'Дёшево — популярно у скраперов' },
  { asn: 'AS20473', org: 'Vultr / Choopa', risk: 84, note: 'Скраперы' },
  { asn: 'AS63949', org: 'Akamai/Linode', risk: 80, note: 'Скраперы' },
  { asn: 'AS9009', org: 'M247 Europe', risk: 86, note: 'VPN и прокси' },
  { asn: 'AS45102', org: 'Alibaba Cloud', risk: 82, note: 'Скраперы, боты из Азии' },
  { asn: 'AS132203', org: 'Tencent Cloud', risk: 82, note: 'Скраперы, боты' },
  { asn: 'AS20940', org: 'Akamai Technologies', risk: 30, note: 'CDN — обычно легитимные клиенты' },
  { asn: 'AS13335', org: 'Cloudflare', risk: 25, note: 'CDN/WARP — легитимные пользователи и краулеры' },
  { asn: 'AS200651', org: 'Flokinet / прочие bulletproof', risk: 92, note: 'Абьюз-хостинг' },
  { asn: 'AS4134', org: 'China Telecom', risk: 75, note: 'Боты и сканеры' },
  { asn: 'AS4837', org: 'China Unicom', risk: 75, note: 'Боты и сканеры' },
  { asn: 'AS49505', org: 'Selectel', risk: 55, note: 'Российский датацентр, есть легитимный трафик' },
  { asn: 'AS197695', org: 'Reg.Ru', risk: 45, note: 'РФ-хостинг' },
  { asn: 'AS29182', org: 'ISPsystem / First Server', risk: 65, note: 'РФ-датацентр' },
  { asn: 'AS51765', org: 'Malware hosting / VPN', risk: 90, note: 'Высокий риск' },
];

export const ASN_MAP: Record<string, DatacenterAsn> = Object.fromEntries(DATACENTER_ASNS.map((a) => [a.asn, a]));

/* --------------------------- Страны --------------------------- */

export const RISKY_COUNTRIES: { code: string; name: string; risk: number; note: string }[] = [
  { code: 'US', name: 'США', risk: 35, note: 'Облачные скраперы и легитимные боты' },
  { code: 'NL', name: 'Нидерланды', risk: 45, note: 'Хостинги/прокси' },
  { code: 'DE', name: 'Германия', risk: 40, note: 'Хостинги/прокси, но много и живых' },
  { code: 'SG', name: 'Сингапур', risk: 55, note: 'Скраперы' },
  { code: 'CN', name: 'Китай', risk: 72, note: 'Бот-сети, сканеры' },
  { code: 'RU', name: 'Россия', risk: 10, note: 'Целевая аудитория' },
  { code: 'IN', name: 'Индия', risk: 50, note: 'Скраперы и фрод' },
  { code: 'VN', name: 'Вьетнам', risk: 65, note: 'Бот-сети' },
  { code: 'BR', name: 'Бразилия', risk: 45, note: 'Фрод-трафик' },
  { code: 'UA', name: 'Украина', risk: 30, note: 'Смешанный' },
  { code: 'TR', name: 'Турция', risk: 40, note: 'Скраперы' },
  { code: 'IR', name: 'Иран', risk: 70, note: 'Сканеры' },
];

export const COUNTRY_MAP: Record<string, { name: string; risk: number; note: string }> = Object.fromEntries(
  RISKY_COUNTRIES.map((c) => [c.code, { name: c.name, risk: c.risk, note: c.note }]),
);

/* --------------------------- Рекомендации --------------------------- */

export interface BotRecommendationRule {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  /** Готовый артефакт: правила для nginx / robots.txt / llms.txt / Cloudflare */
  artifact:
    | { type: 'nginx'; content: string }
    | { type: 'robots'; content: string }
    | { type: 'llms'; content: string }
    | { type: 'cloudflare'; content: string }
    | { type: 'htaccess'; content: string }
    | { type: 'note'; content: string };
}

export const BOT_RECOMMENDATION_LIBRARY: BotRecommendationRule[] = [
  {
    id: 'block-ai-training',
    title: 'Заблокировать сбор контента для обучения LLM',
    detail:
      'GPTBot, CCBot, Bytespider, Google-Extended скачивают контент для обучения моделей. Переходов не дают, нагрузку создают. Блокировка в robots.txt — самый безопасный способ.',
    severity: 'medium',
    artifact: {
      type: 'llms',
      content: `# llms.txt — политика использования контента AI-системами
User-Agent: GPTBot
Disallow: /

User-Agent: CCBot
Disallow: /

User-Agent: Bytespider
Disallow: /

User-Agent: Google-Extended
Disallow: /

User-Agent: meta-externalagent
Disallow: /`,
    },
  },
  {
    id: 'allow-ai-search',
    title: 'Оставить доступ для AI-поиска (GEO-видимость)',
    detail:
      'OAI-SearchBot, ChatGPT-User, PerplexityBot и Claude-SearchBot приводят реальные переходы из AI-ответов. Их блокировка = потеря AI-трафика. Разрешите явно, если в robots.txt стоит общий Disallow для ботов.',
    severity: 'high',
    artifact: {
      type: 'robots',
      content: `# AI-поиск: явное разрешение (GEO)
User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /`,
    },
  },
  {
    id: 'block-seo-crawlers',
    title: 'Ограничить SEO-краулеры конкурентов',
    detail:
      'Ahrefs, Semrush, MJ12 скачивают весь сайт, чтобы строить отчёты для конкурентов. Обычно их блокируют. Исключение — сервисы, в которые вы платите сами.',
    severity: 'medium',
    artifact: {
      type: 'nginx',
      content: `# Блокировка SEO-краулеров конкурентов
map $http_user_agent $seo_crawler {
    default 0;
    "~*AhrefsBot"        1;
    "~*SemrushBot"       1;
    "~*MJ12bot"          1;
    "~*DotBot"           1;
    "~*BLEXBot"          1;
    "~*DataForSeoBot"    1;
    "~*SerpstatBot"      1;
    "~*MegaIndex"        1;
    "~*ScreamingFrog"    1;
}

server {
    if ($seo_crawler) { return 403; }
}`,
    },
  },
  {
    id: 'rate-limit-crawlers',
    title: 'Rate limit для «серых» краулеров',
    detail:
      'PetalBot, scrapy, headless-браузеры и HTTP-библиотеки часто бомбят каталоги. Ограничение по скорости сохраняет сервер и не мешает индексации.',
    severity: 'medium',
    artifact: {
      type: 'nginx',
      content: `# Ограничение частоты запросов
limit_req_zone $binary_remote_addr zone=perip:10m rate=20r/s;
limit_req_zone $server_name zone=perserver:10m rate=200r/s;

server {
    limit_req zone=perip burst=40 nodelay;
    limit_req zone=perserver burst=100;
    limit_req_status 429;
    limit_conn_status 429;
}`,
    },
  },
  {
    id: 'block-fake-googlebot',
    title: 'Блокировать поддельные поисковые боты',
    detail:
      'Самый частый обман: User-Agent Googlebot с IP датацентра. Настоящий Googlebot всегда подтверждается обратным DNS в домене googlebot.com. Мы нашли N таких запросов.',
    severity: 'critical',
    artifact: {
      type: 'nginx',
      content: `# Проверка настоящего Googlebot (rDNS) + whitelist диапазонов
geo $is_google_range {
    default 0;
    66.249.64.0/19 1;
    72.14.199.0/25 1;
    209.85.238.0/24 1;
}

map $http_user_agent $claims_googlebot {
    default 0;
    "~*Googlebot" 1;
}

server {
    # Googlebot, но не из диапазонов Google и не проверен по rDNS → 403
    if ($claims_googlebot) { set $fake $is_google_range; }
    if ($fake = 0) { return 403; }
}`,
    },
  },
  {
    id: 'block-attacks',
    title: 'Немедленно блокировать сканеры уязвимостей',
    detail:
      'В логах есть запросы nikto/nmap/masscan/sqlmap и попытки эксплуатации (.env, wp-login, ../). Это атака, а не индексация — блокируйте на входе (WAF/Cloudflare) и проверяйте целостность сайта.',
    severity: 'critical',
    artifact: {
      type: 'cloudflare',
      content: `# Cloudflare Firewall Rules (Expression)
( http.user_agent contains "nikto" ) or
( http.user_agent contains "sqlmap" ) or
( http.user_agent contains "nmap" ) or
( http.user_agent contains "masscan" ) or
( http.user_agent contains "zgrab" ) or
( http.request.uri.path contains "/wp-login.php" and http.request.method eq "POST" ) or
( http.request.uri.path contains "/.env" ) or
( http.request.uri.path contains "/xmlrpc.php" )

Action: Block
Include: Bot Fight Mode для всей зоны`,
    },
  },
  {
    id: 'wasted-budget',
    title: 'Сократить «сожжённый» трафик',
    detail:
      'Боты расходуют N ГБ трафика и создают ложные визиты в аналитике, что искажает отчёты и решения по рекламе. После фильтрации метрики становятся релевантными.',
    severity: 'high',
    artifact: {
      type: 'nginx',
      content: `# Реальный IP из-за прокси/Cloudflare (нужно для корректных блокировок)
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
real_ip_header CF-Connecting-IP;

# Логирование с классификацией
map $http_user_agent $bot_class {
    default "human";
    "~*Googlebot"     "googlebot";
    "~*YandexBot"     "yandexbot";
    "~*GPTBot"        "ai";
    "~*AhrefsBot"     "seo";
    "~*HeadlessChrome" "headless";
}
log_format mark_json escape=json
  '{"ts":"$time_iso8601","ip":"$remote_addr","ua":"$http_user_agent",'
  '"class":"$bot_class","uri":"$request_uri","status":$status,"bytes":$body_bytes_sent}';
access_log /var/log/nginx/access-mark.json mark_json;`,
    },
  },
];

/* --------------------------- Готовые robots.txt --------------------------- */

export const ROBOTS_TEMPLATE = (sitemapUrl: string, allowAiSearch = true, blockAiTraining = true) => `# robots.txt — сгенерировано MARK
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /cart/
Disallow: /*?sort=
Disallow: /*?filter=

# Поисковые системы
User-agent: YandexBot
Allow: /

User-agent: Googlebot
Allow: /

Sitemap: ${sitemapUrl}
${allowAiSearch ? `
# --- GEO: AI-поиск разрешён (источник трафика) ---
User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Claude-SearchBot
Allow: /
` : ''}${blockAiTraining ? `
# --- Обучение LLM запрещено ---
User-agent: GPTBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Bytespider
Disallow: /
` : ''}`;

export const LLMS_TXT_TEMPLATE = (siteName: string, url: string, summary: string, pages: { title: string; url: string; note: string }[]) => `# ${siteName}

> ${summary}

Данный файл описывает сайт для больших языковых моделей (стандарт llms.txt).
Полные условия использования контента — в robots.txt. Контент предназначен для
цитирования со ссылкой на источник.

## Основные разделы
${pages.map((p) => `- [${p.title}](${p.url}): ${p.note}`).join('\n')}

## Контакты
- Сайт: ${url}
- Дата обновления: ${new Date().toISOString().slice(0, 10)}

## Условия использования
- Цитирование с указанием источника — разрешено
- Обучение моделей на контенте без письменного согласия — запрещено
`;
