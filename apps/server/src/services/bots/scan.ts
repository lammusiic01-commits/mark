import dns from 'node:dns/promises';
import net from 'node:net';
import {
  ASN_MAP,
  BOT_RECOMMENDATION_LIBRARY,
  BOT_SIGNATURES,
  RISKY_COUNTRIES,
  formatBytes,
  type BotScan,
  type BotVerdict,
  type Severity,
} from '@mark/shared';
import { randomId } from '../../crypto.js';
import { ipInAnyCidr, isPrivateIp, normalizeIp } from '../../http/cidr.js';
import { rootLogger } from '../../logger.js';
import { parseLogContent, quickSummary, type LogRecord } from './parser.js';

/**
 * BotShield: анализ логов и защита от ботов.
 *
 * Логика в четыре слоя:
 *  1) сигнатуры User-Agent (поисковые боты, AI-краулеры, SEO-сканеры, атаки);
 *  2) подтверждение IP: CIDR-диапазоны, а при verifyDns — обратный DNS + прямой;
 *  3) поведение: частота, разнообразие путей, доля ошибок, «плохие» пути, отсутствие referer;
 *  4) деньги: сколько трафика и бюджета сгорает впустую.
 *
 * Результат — готовый отчёт BotScan + рекомендации с артефактами (nginx/robots/Cloudflare).
 */

const log = rootLogger.child('botshield');

export interface ScanLogsOptions {
  content: string;
  format?: BotScan['format'];
  costPerGb?: number;
  valuePerVisit?: number;
  /** Проверять rDNS (точнее, но медленнее: до 30 IP) */
  verifyDns?: boolean;
  emit?: (type: string, payload: unknown) => void;
}

interface IpAggregate {
  ip: string;
  requests: number;
  bytes: number;
  firstAt: string;
  lastAt: string;
  userAgents: Map<string, number>;
  paths: Map<string, number>;
  statuses: Map<number, number>;
  referers: number;
  noReferer: number;
  methods: Map<string, number>;
}

const PROBE_PATHS = [
  '/.env', '/.git', '/wp-login.php', '/wp-admin', '/xmlrpc.php', '/phpmyadmin', '/pma', '/admin',
  '/administrator', '/cgi-bin', '/vendor/phpunit', '/.aws', '/config', '/backup', '/db.sql', '/.ssh',
  '/wp-content/plugins', '/wp-config', '/actuator', '/solr/', '/jenkins', '/.well-known/security.txt',
];

const DEFAULT_COST_PER_GB = 6;
const DEFAULT_VALUE_PER_VISIT = 22;

/** Классификация одного IP + User-Agent (для быстрой проверки из интерфейса). */
export function classifySingle(ip: string, userAgent: string): {
  ip: string;
  userAgent: string;
  classification: BotVerdict['classification'];
  humanScore: number;
  reasons: string[];
  signature?: { id: string; name: string; purpose: string; classification: BotVerdict['classification']; cidrs?: string[] };
} {
  const normalized = normalizeIp(ip);
  const signature = BOT_SIGNATURES.find((item) => item.pattern.test(userAgent));
  const reasons: string[] = [];
  let classification: BotVerdict['classification'] = 'human';
  let score = 70;

  if (!userAgent.trim()) {
    classification = 'bot';
    reasons.push('Пустой User-Agent — так делают только боты');
    score = 10;
  } else if (signature) {
    classification = signature.classification;
    reasons.push(`Совпала сигнатура: ${signature.name} (${signature.purpose})`);
    score = signature.classification === 'good_bot' ? 5 : signature.classification === 'ai_crawler' ? 15 : 20;
    if (signature.cidrs?.length) {
      const inRange = ipInAnyCidr(normalized, signature.cidrs);
      reasons.push(inRange ? `IP входит в официальные диапазоны ${signature.name} — подпись подтверждена` : `IP НЕ входит в официальные диапазоны ${signature.name} — вероятная подделка`);
      if (!inRange && signature.classification === 'good_bot') {
        classification = 'bot';
        score = 85;
      }
      if (inRange) score = 2;
    }
  } else if (/HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|puppeteer/i.test(userAgent)) {
    classification = 'headless';
    reasons.push('Признаки headless-браузера в User-Agent');
    score = 15;
  } else if (/python-requests|curl|wget|Go-http-client|Java\/|libwww|httpclient|okhttp|axios|node-fetch|Scrapy/i.test(userAgent)) {
    classification = 'scraper';
    reasons.push('User-Agent технического клиента (скрипт/скрапер)');
    score = 15;
  } else if (/(bot|crawler|spider|scan)/i.test(userAgent)) {
    classification = 'bot';
    reasons.push('User-Agent представляется ботом, но сигнатура неизвестна');
    score = 25;
  }

  if (isPrivateIp(normalized)) reasons.push('Локальный IP — вероятно, внутренний мониторинг');

  return {
    ip: normalized,
    userAgent,
    classification,
    humanScore: Math.max(0, Math.min(100, 100 - score)),
    reasons,
    signature: signature ? { id: signature.id, name: signature.name, purpose: signature.purpose, classification: signature.classification, cidrs: signature.cidrs } : undefined,
  };
}

/** Основной анализ логов. */
export async function scanLogs(options: ScanLogsOptions): Promise<Omit<BotScan, 'tenantId' | 'clientId' | 'siteProjectId' | 'source'>> {
  const startedAt = new Date().toISOString();
  const emit = options.emit ?? (() => undefined);
  const warnings: string[] = [];

  emit('stage', { stage: 'parse', message: 'Разбираю лог' });
  const parsed = parseLogContent(options.content, options.format ?? 'auto');
  if (!parsed.records.length) {
    warnings.push('В логе не найдено ни одной разобранной строки — проверьте формат');
  }
  if (parsed.skipped) warnings.push(`Пропущено строк: ${parsed.skipped}`);

  emit('stage', { stage: 'aggregate', message: 'Считаю статистику по IP' });

  // ── 1. Агрегация по IP
  const byIp = new Map<string, IpAggregate>();
  const pathCounter = new Map<string, { requests: number; bot: number }>();
  const dailyTotals = new Map<string, { human: number; bots: number; suspicious: number; ai: number }>();

  for (const record of parsed.records) {
    const ip = normalizeIp(record.ip);
    if (!ip) continue;
    const aggregate = byIp.get(ip) ?? {
      ip,
      requests: 0,
      bytes: 0,
      firstAt: record.time,
      lastAt: record.time,
      userAgents: new Map(),
      paths: new Map(),
      statuses: new Map(),
      referers: 0,
      noReferer: 0,
      methods: new Map(),
    };
    aggregate.requests += 1;
    aggregate.bytes += record.bytes;
    if (record.time < aggregate.firstAt) aggregate.firstAt = record.time;
    if (record.time > aggregate.lastAt) aggregate.lastAt = record.time;
    aggregate.userAgents.set(record.userAgent, (aggregate.userAgents.get(record.userAgent) ?? 0) + 1);
    aggregate.paths.set(record.path, (aggregate.paths.get(record.path) ?? 0) + 1);
    aggregate.statuses.set(record.status, (aggregate.statuses.get(record.status) ?? 0) + 1);
    aggregate.methods.set(record.method, (aggregate.methods.get(record.method) ?? 0) + 1);
    if (record.referer) aggregate.referers += 1;
    else aggregate.noReferer += 1;
    byIp.set(ip, aggregate);

    const day = record.time.slice(0, 10);
    const bucket = dailyTotals.get(day) ?? { human: 0, bots: 0, suspicious: 0, ai: 0 };
    dailyTotals.set(day, bucket);
  }

  // ── 2. Классификация
  emit('stage', { stage: 'classify', message: `Проверяю ${byIp.size} уникальных IP` });
  const verdicts: BotVerdict[] = [];
  let verifyCount = 0;

  for (const aggregate of byIp.values()) {
    const topUserAgent = [...aggregate.userAgents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const base = classifySingle(aggregate.ip, topUserAgent);
    const reasons = [...base.reasons];
    let classification = base.classification;
    let humanScore = base.humanScore;

    const windowMinutes = Math.max(1, (Date.parse(aggregate.lastAt) - Date.parse(aggregate.firstAt)) / 60_000);
    const perMinute = aggregate.requests / windowMinutes;
    const errorCount = [...aggregate.statuses.entries()].filter(([status]) => status >= 400).reduce((acc, [, count]) => acc + count, 0);
    const errorShare = aggregate.requests ? errorCount / aggregate.requests : 0;
    const probeHits = [...aggregate.paths.keys()].filter((path) => PROBE_PATHS.some((probe) => path.toLowerCase().startsWith(probe)));
    const noRefShare = aggregate.requests ? aggregate.noReferer / aggregate.requests : 0;

    if (perMinute > 60) {
      reasons.push(`Экстремальная частота: ${perMinute.toFixed(0)} запросов/мин (похоже на DDoS или парсер)`);
      humanScore -= 45;
      if (classification === 'human' || classification === 'bot') classification = perMinute > 300 ? 'ddos' : 'attack';
    } else if (perMinute > 20 && classification === 'human') {
      reasons.push(`Высокая частота: ${perMinute.toFixed(0)} запросов/мин`);
      humanScore -= 20;
      classification = 'bot';
    }

    if (aggregate.userAgents.size > 3) {
      reasons.push(`${aggregate.userAgents.size} разных User-Agent с одного IP — маскировка`);
      humanScore -= 25;
      if (['human', 'bot'].includes(classification)) classification = 'scraper';
    }

    if (errorShare > 0.5 && aggregate.requests > 10) {
      reasons.push(`${Math.round(errorShare * 100)}% запросов с ошибками — перебор страниц`);
      humanScore -= 20;
      if (classification === 'human') classification = 'scraper';
    }

    if (probeHits.length >= 3) {
      reasons.push(`Перебор служебных путей: ${probeHits.slice(0, 4).join(', ')}`);
      humanScore -= 35;
      if (classification !== 'ddos') classification = 'attack';
    }

    if (aggregate.paths.size > 200 && classification === 'human') {
      reasons.push(`${aggregate.paths.size} уникальных URL за сессию — полный обход сайта`);
      humanScore -= 15;
      classification = 'scraper';
    }

    if (noRefShare > 0.98 && aggregate.requests > 30 && classification === 'human') {
      reasons.push('Практически нет referer — прямой обход');
      humanScore -= 10;
    }

    if (base.signature?.classification === 'good_bot' && classification === 'good_bot' && base.signature.cidrs?.length) {
      humanScore = 100; // подтверждённый поисковый бот — легитимен
    }

    // rDNS-подтверждение (дорого, поэтому только для подозрительных с «хорошим» UA)
    if (options.verifyDns && verifyCount < 30 && /googlebot|yandexbot|bingbot|applebot|semrush|ahrefs/i.test(topUserAgent)) {
      verifyCount += 1;
      const verified = await verifyBotDns(aggregate.ip, base.signature?.name ?? '');
      if (verified.checked) {
        reasons.push(verified.reason);
        if (!verified.ok && classification === 'good_bot') {
          classification = 'bot';
          humanScore = Math.min(humanScore, 5);
        }
        if (verified.ok) humanScore = 100;
      }
    }

    const asn = guessAsn(aggregate.ip);
    humanScore = Math.max(0, Math.min(100, humanScore));

    verdicts.push({
      id: randomId('ipv'),
      ip: aggregate.ip,
      asn: asn?.asn ?? null,
      org: asn?.org ?? null,
      userAgent: topUserAgent,
      requests: aggregate.requests,
      humanScore,
      classification,
      reasons: reasons.slice(0, 8),
      firstSeen: aggregate.firstAt,
      lastSeen: aggregate.lastAt,
      countries: asn ? ['RU'] : undefined,
      topPaths: [...aggregate.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path]) => path),
    });

    // наполняем дневные срезы и статистику путей по итоговой классификации
    for (const [path, count] of aggregate.paths) {
      const bucket = pathCounter.get(path) ?? { requests: 0, bot: 0 };
      bucket.requests += count;
      if (!['human', 'good_bot'].includes(classification)) bucket.bot += count;
      pathCounter.set(path, bucket);
    }
    for (const record of parsed.records) {
      if (normalizeIp(record.ip) !== aggregate.ip) continue;
      const bucket = dailyTotals.get(record.time.slice(0, 10));
      if (!bucket) continue;
      if (classification === 'human') bucket.human += 1;
      else if (classification === 'good_bot') bucket.bots += 1;
      else if (classification === 'ai_crawler') bucket.ai += 1;
      else bucket.suspicious += 1;
    }
  }

  // ── 3. Итоги
  emit('stage', { stage: 'totals', message: 'Считаю потери и рекомендации' });
  const summary = quickSummary(parsed.records);
  const costPerGb = options.costPerGb ?? DEFAULT_COST_PER_GB;
  const valuePerVisit = options.valuePerVisit ?? DEFAULT_VALUE_PER_VISIT;

  const totals = {
    lines: parsed.lines,
    parsed: parsed.records.length,
    requests: parsed.records.length,
    uniqueIps: byIp.size,
    humanRequests: 0,
    botRequests: 0,
    suspiciousRequests: 0,
    goodBotRequests: 0,
    aiCrawlerRequests: 0,
    bandwidthBytes: summary.bandwidthBytes,
    wastedBytes: 0,
    wastedMoneyEstimate: 0,
  };

  const verdictByIp = new Map(verdicts.map((verdict) => [verdict.ip, verdict]));
  for (const record of parsed.records) {
    const verdict = verdictByIp.get(normalizeIp(record.ip));
    const classification = verdict?.classification ?? 'human';
    if (classification === 'human') totals.humanRequests += 1;
    else if (classification === 'good_bot') totals.goodBotRequests += 1;
    else if (classification === 'ai_crawler') totals.aiCrawlerRequests += 1;
    else totals.suspiciousRequests += 1;
    if (classification !== 'human' && classification !== 'good_bot') totals.wastedBytes += record.bytes;
  }
  totals.botRequests = totals.goodBotRequests + totals.aiCrawlerRequests + totals.suspiciousRequests;

  // Оценка денег: трафик по цене ГБ + доля «сгоревших» визитов
  const wastedGb = totals.wastedBytes / 1024 ** 3;
  totals.wastedMoneyEstimate = Math.round(wastedGb * costPerGb + totals.suspiciousRequests * valuePerVisit * 0.02);

  const share = totals.requests ? totals.suspiciousRequests / totals.requests : 0;
  const cleanlinessScore = Math.max(0, Math.min(100, Math.round(100 - share * 100 * 1.6 - (totals.aiCrawlerRequests / Math.max(totals.requests, 1)) * 12)));

  const topBots = aggregateBots(parsed.records, verdictByIp);
  const countries = RISKY_COUNTRIES.map((country) => {
    const ips = verdicts.filter((verdict) => verdict.countries?.includes(country.code) || guessCountry(verdict.ip) === country.code);
    const requests = ips.reduce((acc, item) => acc + item.requests, 0);
    const botRequests = ips.filter((item) => !['human', 'good_bot'].includes(item.classification)).reduce((acc, item) => acc + item.requests, 0);
    return { country: country.name, code: country.code, requests, botShare: requests ? Math.round((botRequests / requests) * 100) : 0 };
  }).filter((item) => item.requests > 0).sort((a, b) => b.requests - a.requests);

  const asnList = buildAsnList(verdicts);

  const series = [...dailyTotals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, bucket]) => ({ date, ...bucket }));

  const topIps = [...verdicts].sort((a, b) => b.requests - a.requests).slice(0, 40);
  const topPaths = [...pathCounter.entries()]
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 20)
    .map(([path, value]) => ({ path, requests: value.requests, botShare: Math.round((value.bot / Math.max(value.requests, 1)) * 100) }));

  const recommendations = buildRecommendations({
    verdicts,
    totals,
    cleanlinessScore,
    costPerGb,
    valuePerVisit,
    hasAiCrawlers: totals.aiCrawlerRequests > 0,
    hasAttack: verdicts.some((verdict) => ['attack', 'ddos'].includes(verdict.classification)),
    hasFakeGoogle: verdicts.some((verdict) => verdict.reasons.some((reason) => reason.includes('подделка'))),
    probeHits: verdicts.some((verdict) => verdict.reasons.some((reason) => reason.includes('служебных путей'))),
    wastedMoney: totals.wastedMoneyEstimate,
  });

  const finishedAt = new Date().toISOString();
  const errors = [...(parsed.errors ?? []), ...warnings];
  log.info(`BotShield: ${totals.requests} запросов, ${totals.uniqueIps} IP, чистота ${cleanlinessScore}/100, потери ≈ ${totals.wastedMoneyEstimate} ₽`);

  return {
    id: randomId('scan'),
    format: parsed.format,
    status: 'done',
    startedAt,
    finishedAt,
    totals,
    cleanlinessScore,
    series,
    topBots,
    topIps,
    topPaths,
    countries,
    asnList,
    recommendations,
    errors,
    simulated: false,
  };
}

/* --------------------------------- Хелперы --------------------------------- */

interface RecommendationContext {
  verdicts: BotVerdict[];
  totals: {
    requests: number;
    suspiciousRequests: number;
    aiCrawlerRequests: number;
    wastedBytes: number;
    wastedMoneyEstimate: number;
    goodBotRequests: number;
  };
  cleanlinessScore: number;
  costPerGb: number;
  valuePerVisit: number;
  hasAiCrawlers: boolean;
  hasAttack: boolean;
  hasFakeGoogle: boolean;
  probeHits: boolean;
  wastedMoney: number;
}

function buildRecommendations(context: RecommendationContext): BotScan['recommendations'] {
  const out: BotScan['recommendations'] = [];
  const byId = new Map(BOT_RECOMMENDATION_LIBRARY.map((rule) => [rule.id, rule]));
  const push = (id: string, detail?: string) => {
    const rule = byId.get(id);
    if (!rule) return;
    out.push({ title: rule.title, detail: detail ?? rule.detail, severity: rule.severity, action: rule.artifact.content.slice(0, 1500) });
  };

  if (context.hasFakeGoogle) {
    push('block-fake-googlebot', 'Найдены IP, которые представляются Googlebot, но не подтверждаются обратным DNS — это гарантированные фальшивки, их нужно блокировать на уровне nginx/Cloudflare.');
  }
  if (context.hasAttack || context.probeHits) push('block-attacks');
  if (context.hasAiCrawlers) {
    push('block-ai-training');
    push('allow-ai-search', 'AI-краулеры, которые приводят трафик (OAI-SearchBot, PerplexityBot), лучше не блокировать: они дают показы в ответах ИИ.');
  }
  const aggressive = context.verdicts.filter((verdict) => !['human', 'good_bot'].includes(verdict.classification) && verdict.requests >= 30);
  if (aggressive.length >= 3) {
    push(
      'rate-limit-crawlers',
      `Под агрессивным парсингом: ${aggressive.length} IP с суммарно ${aggressive.reduce((acc, item) => acc + item.requests, 0)} запросами. Ограничьте частоту: 60 запросов/мин на IP.`,
    );
  }
  const seo = context.verdicts.filter((verdict) => /semrush|ahrefs|mj12|megaindex|serpstat|screaming|botize|netpeak/i.test(verdict.userAgent));
  if (seo.length) {
    push('block-seo-crawlers', `SEO-краулеры конкурентов: ${seo.map((item) => item.userAgent.slice(0, 40)).join('; ')}. Если вы не работаете с ними — блокируйте.`);
  }
  if (context.totals.wastedMoneyEstimate > 500) {
    push(
      'wasted-budget',
      `По оценке сгорает ≈ ${context.totals.wastedMoneyEstimate.toLocaleString('ru-RU')} ₽/мес: сожжено ${formatBytes(context.totals.wastedBytes)} трафика и ${context.totals.suspiciousRequests.toLocaleString('ru-RU')} «мусорных» визитов (${context.costPerGb} ₽/ГБ, ${context.valuePerVisit} ₽ за визит).`,
    );
  }
  if (!out.length && context.cleanlinessScore > 85) {
    out.push({
      title: 'Трафик чистый — плановое наблюдение',
      detail: `Чистота ${context.cleanlinessScore}/100: серьёзных угроз нет. Оставьте ежедневный мониторинг — MARK пришлёт уведомление, если что-то изменится.`,
      severity: 'info',
      action: 'Оставьте правило «BotShield: ежедневный отчёт» включённым.',
    });
  }

  // Персональные правила для самых активных «плохих» IP
  const topBad = aggressive.filter((verdict) => verdict.classification === 'attack' || verdict.classification === 'scraper' || verdict.classification === 'ddos').slice(0, 5);
  if (topBad.length) {
    const nginx = [
      '# Топ нарушителей — блокировка на уровне nginx',
      ...topBad.map((verdict) => `deny ${verdict.ip}; # ${verdict.classification}, ${verdict.requests} запросов, ${verdict.reasons[0] ?? ''}`),
      'limit_req_zone $binary_remote_addr zone=mark_general:10m rate=60r/m;',
      '# В location /: limit_req zone=mark_general burst=20 nodelay;',
    ].join('\n');
    out.push({
      title: `Заблокировать ${topBad.length} самых активных нарушителя`,
      detail: `Суммарно ${topBad.reduce((acc, item) => acc + item.requests, 0)} запросов с ${topBad.length} адресов. Готовый блок для nginx — скопируйте в конфиг сайта.`,
      severity: 'high',
      action: nginx,
    });
  }

  return out.slice(0, 8);
}

function aggregateBots(records: LogRecord[], verdictByIp: Map<string, BotVerdict>): BotScan['topBots'] {
  const counter = new Map<string, { name: string; requests: number; classification: string }>();
  for (const record of records) {
    const verdict = verdictByIp.get(normalizeIp(record.ip));
    if (!verdict || ['human'].includes(verdict.classification)) continue;
    const signature = BOT_SIGNATURES.find((item) => item.pattern.test(record.userAgent));
    const name = signature?.name ?? verdict.classification;
    const bucket = counter.get(name) ?? { name, requests: 0, classification: verdict.classification };
    bucket.requests += 1;
    counter.set(name, bucket);
  }
  return [...counter.values()].sort((a, b) => b.requests - a.requests).slice(0, 15).map((item) => ({ ...item, userAgent: item.name }));
}

function buildAsnList(verdicts: BotVerdict[]): BotScan['asnList'] {
  const counter = new Map<string, { org: string; requests: number; bot: number }>();
  for (const verdict of verdicts) {
    if (!verdict.asn) continue;
    const bucket = counter.get(verdict.asn) ?? { org: verdict.org ?? '', requests: 0, bot: 0 };
    bucket.requests += verdict.requests;
    if (!['human', 'good_bot'].includes(verdict.classification)) bucket.bot += verdict.requests;
    counter.set(verdict.asn, bucket);
  }
  return [...counter.entries()]
    .map(([asn, value]) => ({ asn, org: value.org, requests: value.requests, botShare: Math.round((value.bot / Math.max(value.requests, 1)) * 100) }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 15);
}

/** Локальная эвристика: определить ASN по IP без внешнего сервиса. */
function guessAsn(ip: string): { asn: string; org: string } | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return null;
  const [a, b] = parts as [number, number, number, number];
  const table: { prefix: string; asn: string }[] = [
    { prefix: '66.249.', asn: 'AS15169' },
    { prefix: '72.14.', asn: 'AS15169' },
    { prefix: '74.125.', asn: 'AS15169' },
    { prefix: '34.100.', asn: 'AS15169' },
    { prefix: '35.247.', asn: 'AS396982' },
    { prefix: '209.85.', asn: 'AS15169' },
    { prefix: '52.167.', asn: 'AS8075' },
    { prefix: '40.77.', asn: 'AS8075' },
    { prefix: '13.66.', asn: 'AS8075' },
    { prefix: '20.15.', asn: 'AS8075' },
    { prefix: '5.255.', asn: 'AS200350' },
    { prefix: '37.9.', asn: 'AS200350' },
    { prefix: '100.43.', asn: 'AS200350' },
    { prefix: '178.154.', asn: 'AS200350' },
    { prefix: '213.180.', asn: 'AS200350' },
    { prefix: '95.108.', asn: 'AS200350' },
    { prefix: '77.88.', asn: 'AS200350' },
    { prefix: '185.32.187.', asn: 'AS200350' },
    { prefix: '51.75.', asn: 'AS16276' },
    { prefix: '5.196.', asn: 'AS16276' },
    { prefix: '3.91.', asn: 'AS16509' },
    { prefix: '18.194.', asn: 'AS16509' },
    { prefix: '20.191.', asn: 'AS8075' },
    { prefix: '93.180.', asn: 'AS24940' },
    { prefix: '46.4.', asn: 'AS24940' },
    { prefix: '91.219.', asn: 'AS197695' },
    { prefix: '212.83.', asn: 'AS12876' },
  ];
  const match = table.find((item) => ip.startsWith(item.prefix)) ?? (a === 185 && b === 220 ? { prefix: '185.220.', asn: 'AS200651' } : null);
  if (!match) return null;
  const asn = ASN_MAP[match.asn];
  return { asn: match.asn, org: asn?.org ?? match.asn };
}

function guessCountry(ip: string): string {
  if (ipInAnyCidr(ip, ['5.255.253.0/24', '37.9.113.0/24', '95.108.128.0/17', '77.88.0.0/18', '178.154.131.0/24', '213.180.193.0/24'])) return 'RU';
  if (ipInAnyCidr(ip, ['66.249.64.0/19', '72.14.199.0/25', '209.85.238.0/24'])) return 'US';
  if (ipInAnyCidr(ip, ['5.45.192.0/18', '87.250.224.0/19'])) return 'RU';
  if (ip.startsWith('185.220.')) return 'DE';
  if (ipInAnyCidr(ip, ['40.77.167.0/24', '157.55.39.0/24', '207.46.13.0/24', '52.167.144.0/24'])) return 'US';
  return 'US';
}

async function verifyBotDns(ip: string, botName: string): Promise<{ checked: boolean; ok: boolean; reason: string }> {
  if (!net.isIPv4(ip) || isPrivateIp(ip)) return { checked: false, ok: false, reason: '' };
  try {
    const domains = net.isIPv6(ip) ? [] : await dns.reverse(ip);
    const hostname = domains[0] ?? '';
    const trusted = ['googlebot.com', 'google.com', 'yandex.ru', 'yandex.net', 'search.msn.com', 'bing.com', 'applebot.apple.com', 'apple.com', 'duckduckgo.com'];
    const ok = trusted.some((domain) => hostname.endsWith(domain));
    if (!ok) {
      return { checked: true, ok: false, reason: `rDNS ${ip} → ${hostname || 'нет записи'} не подтверждает ${botName || 'бота'}` };
    }
    try {
      const forward = await dns.lookup(hostname, { all: true });
      const backMatches = forward.some((entry) => entry.address === ip);
      return backMatches
        ? { checked: true, ok: true, reason: `rDNS подтверждён: ${ip} ↔ ${hostname}` }
        : { checked: true, ok: false, reason: `Обратная проверка не сошлась: ${hostname} не указывает на ${ip}` };
    } catch {
      return { checked: true, ok: true, reason: `rDNS подтверждён: ${hostname}` };
    }
  } catch {
    return { checked: true, ok: false, reason: `У IP ${ip} нет обратной DNS-записи — для поискового бота это подозрительно` };
  }
}

export type { Severity };
