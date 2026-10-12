import { z } from 'zod';

/** Единые схемы валидации запросов (используются сервером и клиентом). */

export const idSchema = z.string().min(1).max(80);
export const slugSchema = z.string().min(2).max(60).regex(/^[a-z0-9-]+$/u, 'Только латиница, цифры и дефис');

export const regionIdsSchema = z.array(z.number().int().min(0).max(2_000_000)).min(1).max(120);
export const keywordListSchema = z.array(z.string().trim().min(2).max(120)).min(1).max(300);

export const siteUrlSchema = z
  .string()
  .trim()
  .min(4)
  .max(500)
  .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
  .refine((v) => {
    try {
      const u = new URL(v);
      return Boolean(u.hostname) && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Некорректный адрес сайта');

/* --------------------------- Белая метка --------------------------- */

export const whiteLabelSchema = z.object({
  agencyName: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u).default('#2563eb'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u).default('#0ea5e9'),
  logoDataUrl: z.string().max(600_000).nullish(),
  faviconDataUrl: z.string().max(200_000).nullish(),
  customDomain: z.string().trim().max(200).nullish(),
  supportEmail: z.string().email().max(200).nullish().or(z.literal('')).transform((v) => v || null),
  supportPhone: z.string().max(40).nullish(),
  footerNote: z.string().max(400).nullish(),
  reportHeader: z.string().max(600).nullish(),
  reportFooter: z.string().max(600).nullish(),
  hideMarkBranding: z.boolean().default(false),
  locale: z.enum(['ru', 'en']).default('ru'),
});

export const clientSchema = z.object({
  name: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).nullish(),
  contactEmail: z.string().email().max(160).nullish().or(z.literal('')).transform((v) => v || null),
  contactPhone: z.string().max(40).nullish(),
  monthlyBudget: z.number().nonnegative().max(1_000_000_000).nullish(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
});

/* ----------------------------- Подключения ----------------------------- */

export const connectSchema = z.object({
  serviceId: z.string().min(2).max(60),
  authMode: z.enum(['api_token', 'oauth2', 'browser_login', 'cookie_import', 'ftp', 'sftp', 'git', 'manual']),
  label: z.string().trim().max(120).optional(),
  clientId: idSchema.nullish(),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  sandbox: z.boolean().default(false),
});

export const validateSchema = connectSchema.omit({ label: true }).extend({
  /** Сохранять подключение при успешной проверке */
  persist: z.boolean().default(true),
  accountId: idSchema.nullish(),
});

export const loginSessionSchema = z.object({
  serviceId: z.string().min(2).max(60),
  url: z.string().url().optional(),
  mode: z.enum(['electron', 'playwright', 'oauth', 'manual']).default('playwright'),
  clientId: idSchema.nullish(),
});

/* ------------------------------- Сайты ------------------------------- */

export const siteProjectSchema = z.object({
  name: z.string().trim().min(2).max(160),
  url: siteUrlSchema,
  clientId: idSchema.nullish(),
  platform: z.string().max(40).optional(),
  connectorId: z.string().max(60).nullish(),
  accountId: idSchema.nullish(),
  goals: z.array(z.string().max(60)).max(20).default([]),
  regions: regionIdsSchema.default([213]),
  keywords: z.array(z.string().max(120)).max(200).default([]),
  notes: z.string().max(4000).nullish(),
});

export const detectPlatformSchema = z.object({ url: siteUrlSchema });

export const auditRequestSchema = z.object({
  siteProjectId: idSchema,
  maxPages: z.number().int().min(1).max(200).default(25),
  includeSubdomains: z.boolean().default(false),
  runPsi: z.boolean().default(true),
});

export const geoAnalyzeSchema = z.object({
  siteProjectId: idSchema.nullish(),
  keywords: keywordListSchema,
  regionIds: regionIdsSchema,
  useLive: z.boolean().default(false),
});

export const geoPlanSchema = z.object({
  siteProjectId: idSchema,
  structure: z.enum(['subfolders', 'subdomains', 'single']).default('subfolders'),
  regionIds: regionIdsSchema,
  keywords: keywordListSchema.optional(),
});

export const marketAnalyzeSchema = z.object({
  siteProjectId: idSchema.nullish(),
  niche: z.string().trim().max(120).optional(),
  keywords: keywordListSchema.optional(),
  regionId: z.number().int().min(0).default(213),
  yourCpc: z.number().nonnegative().max(100000).nullish(),
  budget: z.number().nonnegative().max(100_000_000).nullish(),
});

/* ------------------------------ BotShield ------------------------------ */

export const botScanSchema = z.object({
  siteProjectId: idSchema.nullish(),
  source: z.enum(['upload', 'url', 'connector', 'sandbox']).default('upload'),
  format: z.enum(['nginx', 'apache', 'json', 'cloudflare', 'auto']).default('auto'),
  /** Сырые строки лога (до 8 МБ) */
  logContent: z.string().max(8_000_000).optional(),
  logUrl: z.string().url().optional(),
  accountId: idSchema.nullish(),
  logPath: z.string().max(500).optional(),
});

/* ------------------------------ Гипотезы ------------------------------ */

export const hypothesisSchema = z.object({
  title: z.string().trim().min(4).max(200),
  statement: z.string().trim().max(2000).default(''),
  clientId: idSchema.nullish(),
  siteProjectId: idSchema.nullish(),
  campaignId: idSchema.nullish(),
  source: z.enum(['library', 'audit', 'bot', 'geo', 'market', 'manual']).default('manual'),
  sourceRef: z.string().max(200).nullish(),
  metric: z.enum(['ctr', 'cr', 'cpl', 'cpa', 'roas', 'positions', 'traffic', 'bounce', 'aov', 'revenue']).default('cr'),
  expectedEffectPct: z.number().min(0.5).max(500).default(10),
  effort: z.number().int().min(1).max(5).default(3),
  confidence: z.number().int().min(1).max(5).default(3),
  priority: z.number().int().min(0).max(100).default(0),
  tags: z.array(z.string().max(40)).max(20).default([]),
  testPlan: z
    .object({
      design: z.enum(['ab', 'aba', 'before_after']).default('ab'),
      metric: z.enum(['ctr', 'cr', 'cpl', 'cpa', 'roas', 'positions', 'traffic', 'bounce', 'aov', 'revenue']).default('cr'),
      successCriteria: z.string().max(600).default(''),
      minSamplePerVariant: z.number().int().min(50).max(5_000_000).default(1000),
      durationDays: z.number().int().min(3).max(180).default(14),
      trafficSplit: z.array(z.number().min(0).max(100)).min(2).max(4).default([50, 50]),
      trafficSource: z.string().max(120).optional(),
    })
    .default({}),
  status: z.enum(['backlog', 'planned', 'running', 'done', 'rejected']).default('backlog'),
});

export const hypothesisGenerateSchema = z.object({
  siteProjectId: idSchema.nullish(),
  clientId: idSchema.nullish(),
  niche: z.string().max(120).optional(),
  auditId: idSchema.nullish(),
  botScanId: idSchema.nullish(),
  count: z.number().int().min(1).max(40).default(8),
});

/* ------------------------------ Кампании ------------------------------ */

export const campaignCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  clientId: idSchema.nullish(),
  siteProjectId: idSchema.nullish(),
  channel: z.enum(['yandex_direct', 'google_ads', 'vk_ads', 'telegram_ads', 'seo']).default('yandex_direct'),
  accountId: idSchema.nullish(),
  dailyBudget: z.number().nonnegative().max(100_000_000).default(0),
  strategy: z.enum(['manual', 'max_clicks', 'max_conversions', 'max_profit', 'avg_cpa', 'target_roas', 'seo']).default('max_clicks'),
  goal: z.string().max(120).default('Заявка'),
  regionIds: regionIdsSchema.default([213]),
  keywords: z.array(z.string().max(120)).max(500).default([]),
  startDate: z.string().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const campaignPatchSchema = campaignCreateSchema.partial().extend({
  status: z.enum(['draft', 'active', 'paused', 'ended']).optional(),
  bidAdjustmentPct: z.number().min(-90).max(400).optional(),
});

/* ------------------------------ Отчёты ------------------------------ */

export const reportRequestSchema = z.object({
  type: z.enum(['seo', 'geo', 'bot', 'market', 'campaigns', 'hypotheses', 'summary']).default('summary'),
  clientId: idSchema.nullish(),
  siteProjectId: idSchema.nullish(),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  includeCharts: z.boolean().default(true),
  /** Белая метка: id тенанта-агентства */
  brand: z.boolean().default(true),
  delivery: z.array(z.enum(['download', 'email', 'telegram'])).max(3).default(['download']),
  recipients: z.array(z.string().max(200)).max(20).default([]),
});

export const reportHistoryQuerySchema = z.object({
  type: z.string().max(40).optional(),
  clientId: idSchema.optional(),
  status: z.enum(['queued', 'building', 'done', 'failed', 'sent']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

/* --------------------------- Автооптимизация --------------------------- */

export const scheduleRuleSchema = z.object({
  name: z.string().trim().min(2).max(160),
  clientId: idSchema.nullish(),
  enabled: z.boolean().default(true),
  /** cron-выражение (5 полей) */
  cron: z
    .string()
    .trim()
    .min(9)
    .max(80)
    .regex(/^[\d*,\-/ ]+$/u, 'Некорректное cron-выражение')
    .default('0 9 * * *'),
  timezone: z.string().max(60).default('Europe/Moscow'),
  ruleType: z.enum([
    'bid_up',
    'bid_down',
    'pause_low_ctr',
    'pause_no_conversions',
    'budget_reallocate',
    'negative_keywords',
    'dayparting',
    'min_balance',
    'weekly_report',
  ]),
  params: z
    .object({
      metric: z.enum(['ctr', 'cpa', 'cpl', 'drr', 'clicks', 'cost', 'conversions', 'impressions']).default('cpa'),
      threshold: z.number().default(5),
      comparison: z.enum(['gt', 'lt', 'gte', 'lte']).default('gt'),
      windowDays: z.number().int().min(1).max(90).default(7),
      adjustPercent: z.number().min(-90).max(400).default(15),
      minClicks: z.number().int().min(0).max(1_000_000).default(30),
      maxAppliesPerRun: z.number().int().min(1).max(500).default(50),
      targetCpa: z.number().positive().max(1_000_000).optional(),
      targetCtr: z.number().positive().max(100).optional(),
      hoursFrom: z.number().int().min(0).max(23).optional(),
      hoursTo: z.number().int().min(0).max(23).optional(),
    })
    .default({}),
  /** Требуется подтверждение перед применением изменений в реальном аккаунте */
  requiresApproval: z.boolean().default(true),
  notify: z.array(z.enum(['telegram', 'email', 'inapp'])).max(3).default(['inapp']),
  maxChangesPerRun: z.number().int().min(1).max(200).default(20),
  searchOnly: z.boolean().default(true),
});

export const scheduleRunSchema = z.object({ ruleId: idSchema, dryRun: z.boolean().default(false) });

/* ------------------------------ Планировщик ------------------------------ */

export const orchestrateSchema = z.object({
  clientId: idSchema,
  tasks: z
    .array(
      z.object({
        type: z.enum(['audit', 'bot_scan', 'geo_analysis', 'market_analysis', 'hypotheses', 'report', 'autofix', 'schedule_run']),
        params: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(20),
  dryRun: z.boolean().default(false),
});

/* --------------------------- Аудит (автоисправления) --------------------------- */

export const autofixSchema = z.object({
  siteProjectId: idSchema,
  auditRunId: idSchema.nullish(),
  findingCodes: z.array(z.string().max(80)).min(1).max(60),
  connectorId: z.string().max(60).nullish(),
  accountId: idSchema.nullish(),
  mode: z.enum(['preview', 'apply']).default('preview'),
  dryRunAlways: z.boolean().default(false),
});

export const patchApplySchema = z.object({
  bundleId: idSchema,
  connectorId: z.string().max(60),
  accountId: idSchema.nullish(),
  mode: z.enum(['preview', 'apply']).default('preview'),
  commitMessage: z.string().max(200).optional(),
});

/* ------------------------------ Auth/настройки ------------------------------ */

export const settingsPatchSchema = z.object({
  appName: z.string().max(80).optional(),
  defaultTenantId: idSchema.optional(),
  telegramChatId: z.string().max(60).nullish(),
  reportEmail: z.string().max(200).nullish(),
  autoOptimizationEnabled: z.boolean().optional(),
  botProtectionEnabled: z.boolean().optional(),
  geoEnabled: z.boolean().optional(),
  demoMode: z.boolean().optional(),
});

export type WhiteLabelInput = z.infer<typeof whiteLabelSchema>;
export type ClientInput = z.infer<typeof clientSchema>;
export type ConnectInput = z.infer<typeof connectSchema>;
export type ValidateInput = z.infer<typeof validateSchema>;
export type SiteProjectInput = z.infer<typeof siteProjectSchema>;
export type GeoAnalyzeInput = z.infer<typeof geoAnalyzeSchema>;
export type GeoPlanInput = z.infer<typeof geoPlanSchema>;
export type MarketAnalyzeInput = z.infer<typeof marketAnalyzeSchema>;
export type BotScanInput = z.infer<typeof botScanSchema>;
export type HypothesisInput = z.infer<typeof hypothesisSchema>;
export type HypothesisGenerateInput = z.infer<typeof hypothesisGenerateSchema>;
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type ReportRequestInput = z.infer<typeof reportRequestSchema>;
export type ScheduleRuleInput = z.infer<typeof scheduleRuleSchema>;
export type OrchestrateInput = z.infer<typeof orchestrateSchema>;
export type AutofixInput = z.infer<typeof autofixSchema>;
