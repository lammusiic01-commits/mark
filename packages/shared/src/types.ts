/**
 * @mark/shared — общие типы домена MARK.
 * Используются и сервером, и фронтендом. Никаких Node-only зависимостей.
 */

/* ------------------------------------------------------------------ */
/* Общее                                                              */
/* ------------------------------------------------------------------ */

export type ISODate = string;
export type ID = string;

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface TimePoint {
  /** YYYY-MM-DD */
  date: string;
  value: number;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/* ------------------------------------------------------------------ */
/* Мультитенантность / White-label                                    */
/* ------------------------------------------------------------------ */

export interface WhiteLabel {
  id: ID;
  /** Короткий slug тенанта */
  slug: string;
  agencyName: string;
  brandColor: string;
  accentColor: string;
  logoDataUrl?: string | null;
  faviconDataUrl?: string | null;
  customDomain?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  footerNote?: string | null;
  reportHeader?: string | null;
  reportFooter?: string | null;
  hideMarkBranding: boolean;
  locale: 'ru' | 'en';
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Client {
  id: ID;
  tenantId: ID;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  monthlyBudget?: number | null;
  notes?: string | null;
  status: 'active' | 'paused' | 'archived';
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface User {
  id: ID;
  tenantId: ID;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'manager' | 'viewer';
  createdAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Каталог сервисов и подключения                                     */
/* ------------------------------------------------------------------ */

export type AuthModeId =
  | 'api_token'
  | 'oauth2'
  | 'browser_login'
  | 'cookie_import'
  | 'ftp'
  | 'sftp'
  | 'git'
  | 'manual';

export type ServiceCategory =
  | 'ads'
  | 'analytics'
  | 'webmaster'
  | 'site'
  | 'infra'
  | 'messenger'
  | 'ai'
  | 'email';

export type Capability =
  | 'campaigns.read'
  | 'campaigns.write'
  | 'bids.write'
  | 'keywords.read'
  | 'keywords.write'
  | 'wordstat.read'
  | 'forecast.read'
  | 'analytics.read'
  | 'traffic.logs'
  | 'site.read'
  | 'site.write'
  | 'site.deploy'
  | 'site.redirects'
  | 'indexing.submit'
  | 'listings.write'
  | 'messaging.send'
  | 'ai.generate'
  | 'email.send'
  | 'dns.write';

export interface ServiceFieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'textarea' | 'select' | 'number' | 'checkbox';
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  /** Секретное поле: шифруется в БД и маскируется в API-ответах */
  secret?: boolean;
  /** Значение по умолчанию */
  default?: string;
}

export interface ServiceAuthModeDef {
  id: AuthModeId;
  label: string;
  description: string;
  fields: ServiceFieldDef[];
  /** full — автоматизация целиком; partial — часть действий руками; manual — только генерация артефактов */
  automation: 'full' | 'partial' | 'manual';
  /** Требуется ли интерактивное окно входа внутри приложения */
  needsInAppLogin?: boolean;
}

export interface ValidationStepDef {
  key: string;
  title: string;
  /** Что реально проверяем (для UI) */
  hint: string;
}

export interface ServiceDef {
  id: string;
  name: string;
  category: ServiceCategory;
  vendor: string;
  docsUrl: string;
  /** Можно ли работать без реального аккаунта (демо-режим) */
  supportsSandbox: boolean;
  capabilities: Capability[];
  authModes: ServiceAuthModeDef[];
  validationPlan: ValidationStepDef[];
  /** Встроенные ограничения/предупреждения (rate limit, требования) */
  notes?: string[];
  color?: string;
}

/* ------------------------------------------------------------------ */
/* Баланс и оплата (СБП)                                              */
/* ------------------------------------------------------------------ */

export interface PaymentPlan {
  id: string;
  name: string;
  price: number;
  period: string;
  description: string;
  features: string[];
  popular?: boolean;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface PaymentRecord {
  id: ID;
  tenantId: ID;
  amount: number;
  status: PaymentStatus;
  provider: 'sbp' | 'sbp_test' | 'manual' | 'card';
  sbpUrl?: string | null;
  payload?: string | null;
  comment?: string | null;
  createdAt: ISODate;
  paidAt?: ISODate | null;
  confirmedBy?: string | null;
}

export interface BalanceTransaction {
  id: ID;
  tenantId: ID;
  type: 'topup' | 'topup_pending' | 'charge' | 'refund' | 'bonus';
  amount: number;
  balanceAfter: number;
  description: string;
  paymentId?: ID | null;
  createdAt: ISODate;
}

export interface BalanceSnapshot {
  balance: number;
  hold: number;
  currency: 'RUB';
  plan?: string | null;
  planUntil?: ISODate | null;
}

/** Привязанный чат Telegram: кто получает уведомления и кому доступны команды. */
export interface TelegramLink {
  id: ID;
  tenantId: ID;
  chatId: string;
  userId?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** owner — полный доступ, manager — действия, viewer — только просмотр */
  role: 'owner' | 'manager' | 'viewer';
  notifications: boolean;
  clientId?: ID | null;
  linkedAt: ISODate;
  lastSeenAt?: ISODate | null;
}

/** Состояние Telegram-бота агентства (для интерфейса и Mini App). */
export interface TelegramBotStatus {
  enabled: boolean;
  running: boolean;
  username?: string | null;
  botName?: string | null;
  webAppUrl?: string | null;
  tokenSource: 'env' | 'account' | 'none';
  chats: number;
  commands: { command: string; description: string }[];
  hint?: string;
}

export interface ConnectedAccount {
  id: ID;
  tenantId: ID;
  clientId?: ID | null;
  serviceId: string;
  authMode: AuthModeId;
  label: string;
  status: 'unchecked' | 'validating' | 'valid' | 'invalid' | 'expired';
  /** Маскированные значения секретов для UI */
  secretPreview?: string | null;
  scopes?: string[];
  meta?: Record<string, unknown>;
  sandbox: boolean;
  lastCheckedAt?: ISODate | null;
  lastError?: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ValidationCheck {
  key: string;
  title: string;
  status: 'pending' | 'running' | 'pass' | 'warn' | 'fail';
  message?: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface ValidationResult {
  serviceId: string;
  authMode: AuthModeId;
  mode: 'live' | 'sandbox';
  status: 'pass' | 'warn' | 'fail';
  checks: ValidationCheck[];
  /** Нормализованные данные (название аккаунта, счётчики, лимиты) */
  accountInfo?: Record<string, unknown>;
  capabilities?: Capability[];
  startedAt: ISODate;
  finishedAt: ISODate;
}

export interface LoginSession {
  id: ID;
  serviceId: string;
  url: string;
  mode: 'electron' | 'playwright' | 'oauth' | 'manual';
  status: 'starting' | 'waiting_user' | 'captured' | 'failed' | 'closed';
  cookiesCount: number;
  message?: string;
  error?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/* ------------------------------------------------------------------ */
/* Сайт, SEO, GEO                                                     */
/* ------------------------------------------------------------------ */

export type PlatformId =
  | 'tilda'
  | 'wordpress'
  | 'bitrix'
  | 'modx'
  | 'joomla'
  | 'dle'
  | 'webflow'
  | 'wix'
  | 'squarespace'
  | 'shopify'
  | 'ghost'
  | 'nextjs'
  | 'nuxt'
  | 'astro'
  | 'hugo'
  | 'jekyll'
  | 'static-html'
  | 'spa'
  | 'unknown';

export interface PlatformDef {
  id: PlatformId;
  name: string;
  /** Регулярки по HTML/заголовкам для детекта */
  signatures: { source: 'html' | 'header' | 'url'; pattern: string; weight: number; note: string }[];
  /** Рекомендуемые коннекторы (id из site-connectors) в порядке приоритета */
  connectors: string[];
  /** Требуется ли сборка/деплой после правок */
  buildRequired: boolean;
}

export interface SiteConnectorDef {
  id: string;
  name: string;
  /** Платформы, для которых коннектор работает «из коробки» */
  platforms: PlatformId[];
  authModes: AuthModeId[];
  capabilities: Capability[];
  /** Может ли писать правки в код/контент сайта */
  canWrite: boolean;
  /** Требуется ли доступ к репозиторию */
  repoBased?: boolean;
  description: string;
}

export type FindingCategory =
  | 'technical'
  | 'indexing'
  | 'content'
  | 'speed'
  | 'mobile'
  | 'links'
  | 'geo'
  | 'generative'
  | 'security';

export interface Finding {
  id?: ID;
  code: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  url?: string | null;
  evidence: string;
  recommendation: string;
  autoFixable: boolean;
  /** Ожидаемый эффект (условные баллы) */
  impact?: number;
  /** Данные для автоисправления */
  fix?: Record<string, unknown> | null;
}

export interface PageSnapshot {
  url: string;
  status: number;
  title?: string;
  description?: string;
  h1: string[];
  headings: { level: number; text: string }[];
  canonical?: string | null;
  robotsMeta?: string | null;
  og: Record<string, string>;
  images: { src: string; alt?: string | null; loading?: string | null; bytes?: number }[];
  links: { href: string; internal: boolean; anchor?: string }[];
  scripts: string[];
  styles: string[];
  jsonLd: unknown[];
  textLength: number;
  wordCount: number;
  lang?: string | null;
  hasViewport: boolean;
  isHttps: boolean;
  ttfbMs?: number;
  loadMs?: number;
  htmlBytes: number;
  compressed?: boolean;
  hreflang: { lang: string; href: string }[];
  geoMeta?: Record<string, string>;
  /** Данные TLS-сертификата (заполняет детектор платформы/краулер) */
  httpsCertificate?: { daysLeft?: number; issuer?: string; validTo?: string } | null;
}

export interface AuditRun {
  id: ID;
  tenantId: ID;
  siteProjectId: ID;
  status: 'running' | 'done' | 'failed';
  startedAt: ISODate;
  finishedAt?: ISODate | null;
  baseUrl: string;
  pagesCrawled: number;
  pagesDiscovered: number;
  score: number;
  grade: string;
  findings: Finding[];
  categoryScores: Record<string, number>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    autoFixable: number;
  };
  robotsTxt?: string | null;
  sitemapFound?: string | null;
  sitemapsDetected: string[];
  errors: string[];
  simulated?: boolean;
}

export interface SiteProject {
  id: ID;
  tenantId: ID;
  clientId?: ID | null;
  name: string;
  url: string;
  platform: PlatformId;
  platformConfidence: number;
  platformEvidence: string[];
  connectorId?: string | null;
  accountId?: ID | null;
  goals: string[];
  regions: number[];
  keywords: string[];
  seoScore?: number | null;
  lastAuditId?: ID | null;
  lastAuditAt?: ISODate | null;
  geoStatus: 'none' | 'planned' | 'applied';
  status: 'active' | 'paused' | 'archived';
  notes?: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface GeoRegion {
  id: number;
  name: string;
  /** Приоритетные города (для региональной структуры) */
  cities?: string[];
  discountPercent?: number;
  demandShare?: number;
  recommended?: boolean;
}

export interface GeoAnalysis {
  id: ID;
  tenantId: ID;
  siteProjectId?: ID | null;
  keywords: string[];
  regionIds: number[];
  source: 'wordstat_api' | 'wordstat_browser' | 'sandbox' | 'manual';
  totalDemand: number;
  demandByRegion: { regionId: number; regionName: string; demand: number; share: number; cpc?: number; competition?: number; priority: 'high' | 'medium' | 'low' }[];
  topCities: { name: string; regionId: number; demand: number }[];
  seasonality: { month: string; index: number }[];
  recommendations: string[];
  createdAt: ISODate;
  simulated?: boolean;
}

export interface GeoPagePlan {
  regionId: number;
  regionName: string;
  url: string;
  title: string;
  description: string;
  h1: string;
  keywords: string[];
  cityInContent: boolean;
}

export interface GeoPlan {
  id: ID;
  tenantId: ID;
  siteProjectId: ID;
  structure: 'subfolders' | 'subdomains' | 'single';
  regionIds: number[];
  pages: GeoPagePlan[];
  hreflang: { lang: string; href: string }[];
  schemaOrg: unknown[];
  sitemapAnnotations: string[];
  robotsAdditions: string[];
  campaignGeoSettings: { regionId: number; targeting: string; suggestion: string }[];
  tasks: { title: string; owner: string; effort: number }[];
  generatedAt: ISODate;
  appliedAt?: ISODate | null;
  applyLog?: { step: string; ok: boolean; detail: string }[];
}

export interface PatchFile {
  path: string;
  content: string;
  contentType: string;
  action: 'create' | 'update' | 'replace';
  target?: 'site' | 'repo' | 'hosting' | 'manual' | 'cms';
}

export interface PatchBundle {
  id: ID;
  siteProjectId: ID;
  createdAt: ISODate;
  files: PatchFile[];
  instructions: string[];
  connectorPlan: { step: string; connectorId: string; action: string; payload?: unknown }[];
  verification: string[];
}

/* ------------------------------------------------------------------ */
/* Market Analyzer                                                    */
/* ------------------------------------------------------------------ */

export interface MarketBenchmark {
  keyword: string;
  frequency: number;
  cpc: number;
  competition: 'low' | 'medium' | 'high' | 'very_high';
  clicksEstimate: number;
  ctr: number;
}

export interface MarketAnalysis {
  id: ID;
  tenantId: ID;
  niche: string;
  regionId: number;
  regionName: string;
  keywords: string[];
  source: 'wordstat_api' | 'benchmark_dataset' | 'mixed' | 'sandbox';
  nicheCpc: number;
  yourCpc?: number | null;
  gapPercent?: number | null;
  verdict: string;
  benchmarks: MarketBenchmark[];
  budgetPlan: { scenario: 'economy' | 'balanced' | 'aggressive'; dailyBudget: number; clicks: number; conversions: number; cpa: number; note: string }[];
  competitors: { name: string; domain: string; adShare?: number; note: string }[];
  insights: string[];
  createdAt: ISODate;
  simulated?: boolean;
}

/* ------------------------------------------------------------------ */
/* BotShield                                                          */
/* ------------------------------------------------------------------ */

export interface BotVerdict {
  id: ID;
  ip: string;
  asn?: string | null;
  org?: string | null;
  userAgent: string;
  requests: number;
  humanScore: number;
  classification: 'human' | 'good_bot' | 'ai_crawler' | 'bot' | 'headless' | 'scraper' | 'attack' | 'ddos';
  reasons: string[];
  firstSeen: ISODate;
  lastSeen: ISODate;
  countries?: string[];
  topPaths: string[];
  blocked?: boolean;
}

export interface BotScan {
  id: ID;
  tenantId: ID;
  siteProjectId?: ID | null;
  source: 'upload' | 'url' | 'connector' | 'sandbox';
  format: 'nginx' | 'apache' | 'json' | 'cloudflare' | 'auto';
  status: 'running' | 'done' | 'failed';
  startedAt: ISODate;
  finishedAt?: ISODate | null;
  totals: {
    lines: number;
    parsed: number;
    requests: number;
    uniqueIps: number;
    humanRequests: number;
    botRequests: number;
    suspiciousRequests: number;
    goodBotRequests: number;
    aiCrawlerRequests: number;
    bandwidthBytes: number;
    wastedBytes: number;
    wastedMoneyEstimate: number;
  };
  cleanlinessScore: number;
  series: { date: string; human: number; bots: number; suspicious: number; ai: number }[];
  topBots: { name: string; userAgent: string; requests: number; classification: string }[];
  topIps: BotVerdict[];
  topPaths: { path: string; requests: number; botShare: number }[];
  countries: { country: string; requests: number; botShare: number }[];
  asnList: { asn: string; org: string; requests: number; botShare: number }[];
  recommendations: { title: string; detail: string; severity: Severity; action: string }[];
  errors: string[];
  simulated?: boolean;
}

/* ------------------------------------------------------------------ */
/* Гипотезы и эксперименты                                            */
/* ------------------------------------------------------------------ */

export type HypothesisStatus = 'backlog' | 'planned' | 'running' | 'done' | 'rejected';
export type MetricId = 'ctr' | 'cr' | 'cpl' | 'cpa' | 'roas' | 'positions' | 'traffic' | 'bounce' | 'aov' | 'revenue';

export interface Hypothesis {
  id: ID;
  tenantId: ID;
  clientId?: ID | null;
  siteProjectId?: ID | null;
  campaignId?: ID | null;
  source: 'library' | 'audit' | 'bot' | 'geo' | 'market' | 'manual';
  sourceRef?: string | null;
  title: string;
  statement: string;
  /** Проверяемая метрика */
  metric: MetricId;
  /** Ожидаемый прирост, % */
  expectedEffectPct: number;
  /** Затраты 1..5 (1 — дёшево) */
  effort: number;
  /** Уверенность 1..5 */
  confidence: number;
  ice: number;
  priority: number;
  status: HypothesisStatus;
  testPlan: {
    design: 'ab' | 'aba' | 'before_after';
    metric: MetricId;
    successCriteria: string;
    minSamplePerVariant: number;
    durationDays: number;
    trafficSplit: number[];
    trafficSource?: string;
  };
  tags: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
}
