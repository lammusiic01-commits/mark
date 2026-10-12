import type { ID, ISODate, Severity, TimePoint } from './types.js';

/* ------------------------------------------------------------------ */
/* Кампании                                                            */
/* ------------------------------------------------------------------ */

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'ended';
export type CampaignChannel = 'yandex_direct' | 'google_ads' | 'vk_ads' | 'telegram_ads' | 'seo';
export type CampaignStrategy =
  | 'manual'
  | 'max_clicks'
  | 'max_conversions'
  | 'max_profit'
  | 'avg_cpa'
  | 'target_roas'
  | 'seo';

export interface CampaignMetrics {
  impressions: number;
  clicks: number;
  ctr: number;
  cost: number;
  avgCpc: number;
  conversions: number;
  cr: number;
  cpa: number;
  revenue: number;
  roas: number;
  drr: number;
}

export interface Campaign {
  id: ID;
  tenantId: ID;
  clientId?: ID | null;
  siteProjectId?: ID | null;
  accountId?: ID | null;
  serviceId?: string | null;
  externalId?: string | null;
  name: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  strategy: CampaignStrategy;
  dailyBudget: number;
  monthlyBudget?: number | null;
  goal: string;
  regionIds: number[];
  keywords: string[];
  startDate?: ISODate | null;
  bidAdjustmentPct: number;
  notes?: string | null;
  metricsToday?: CampaignMetrics;
  metrics7d?: CampaignMetrics;
  metrics30d?: CampaignMetrics;
  trend: TimePoint[];
  warnings: { code: string; message: string; severity: Severity }[];
  lastSyncedAt?: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface BidSuggestion {
  keyword: string;
  currentBid: number;
  suggestedBid: number;
  deltaPercent: number;
  reason: string;
  confidence: number;
  cpa?: number;
  ctr?: number;
  action: 'raise' | 'lower' | 'pause' | 'keep';
}

/* ------------------------------------------------------------------ */
/* Отчёты                                                             */
/* ------------------------------------------------------------------ */

export type ReportType = 'seo' | 'geo' | 'bot' | 'market' | 'campaigns' | 'hypotheses' | 'summary';
export type ReportStatus = 'queued' | 'building' | 'done' | 'failed' | 'sent';

export interface ReportSection {
  id: string;
  title: string;
  /** Текстовый вывод (уже свёрстанный в абзацы) */
  paragraphs: string[];
  bullets: string[];
  table?: { columns: string[]; rows: (string | number)[][] };
  chart?: {
    type: 'line' | 'bar' | 'pie' | 'scatter';
    title: string;
    categories: string[];
    series: { name: string; data: number[] }[];
    unit?: string;
  };
  kpis?: { label: string; value: string; delta?: number; hint?: string }[];
}

export interface ReportRecord {
  id: ID;
  tenantId: ID;
  clientId?: ID | null;
  siteProjectId?: ID | null;
  type: ReportType;
  title: string;
  status: ReportStatus;
  periodFrom: string;
  periodTo: string;
  createdAt: ISODate;
  generatedAt?: ISODate | null;
  filePath?: string | null;
  fileSizeBytes?: number | null;
  sections: ReportSection[];
  kpis: { label: string; value: string; delta?: number; hint?: string }[];
  branding: {
    agencyName: string;
    brandColor: string;
    accentColor: string;
    logoDataUrl?: string | null;
    footerNote?: string | null;
    hideMarkBranding: boolean;
  };
  delivery: { channel: 'download' | 'email' | 'telegram'; status: 'pending' | 'sent' | 'failed'; target?: string; error?: string }[];
  error?: string | null;
  /** Снимок данных, использованный в отчёте */
  dataSnapshot?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Планировщик / автооптимизация                                      */
/* ------------------------------------------------------------------ */

export interface ScheduleRule {
  id: ID;
  tenantId: ID;
  name: string;
  clientId?: ID | null;
  enabled: boolean;
  cron: string;
  timezone: string;
  ruleType:
    | 'bid_up'
    | 'bid_down'
    | 'pause_low_ctr'
    | 'pause_no_conversions'
    | 'budget_reallocate'
    | 'negative_keywords'
    | 'dayparting'
    | 'min_balance'
    | 'weekly_report';
  params: {
    metric: 'ctr' | 'cpa' | 'cpl' | 'drr' | 'clicks' | 'cost' | 'conversions' | 'impressions';
    threshold: number;
    comparison: 'gt' | 'lt' | 'gte' | 'lte';
    windowDays: number;
    adjustPercent: number;
    minClicks: number;
    maxAppliesPerRun: number;
    targetCpa?: number;
    targetCtr?: number;
    hoursFrom?: number;
    hoursTo?: number;
  };
  requiresApproval: boolean;
  notify: ('telegram' | 'email' | 'inapp')[];
  maxChangesPerRun: number;
  searchOnly: boolean;
  lastRunAt?: ISODate | null;
  lastResult?: string | null;
  nextRunAt?: ISODate | null;
  runCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ScheduleChange {
  target: string;
  field: string;
  from: string;
  to: string;
  reason: string;
  applied: boolean;
  error?: string;
}

export interface ScheduleRun {
  id: ID;
  tenantId: ID;
  ruleId: ID;
  ruleName: string;
  status: 'running' | 'done' | 'failed' | 'skipped' | 'awaiting_approval';
  startedAt: ISODate;
  finishedAt?: ISODate | null;
  evaluated: number;
  changed: number;
  changes: ScheduleChange[];
  summary: string;
  error?: string | null;
  dryRun: boolean;
}

/* ------------------------------------------------------------------ */
/* Настройки приложения (одна запись на тенанта)                      */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  tenantId: ID;
  appName: string;
  defaultClientId?: ID | null;
  telegramChatId?: string | null;
  reportEmail?: string | null;
  autoOptimizationEnabled: boolean;
  botProtectionEnabled: boolean;
  geoEnabled: boolean;
  demoMode: boolean;
  updatedAt: ISODate;
}

export interface DashboardSummary {
  kpis: { label: string; value: string; delta?: number; hint?: string }[];
  seoScoreSeries: TimePoint[];
  budget: { used: number; planned: number; currency: string };
  botTrafficSeries: { date: string; human: number; bots: number; ai: number; suspicious: number }[];
  hypotheses: { total: number; running: number; done: number; avgLift: number };
  audit: {
    score: number;
    grade: string;
    critical: number;
    high: number;
    lastRunAt?: ISODate | null;
    autoFixable: number;
  } | null;
  geo: { regions: number; demand: number; topRegion?: string } | null;
  market: { niche: string; nicheCpc: number; yourCpc?: number | null; verdict: string } | null;
  alerts: { title: string; detail: string; severity: Severity; at: ISODate }[];
  accounts: { total: number; valid: number; expiring: number; broken: number };
  recentRuns: { id: ID; type: string; label: string; status: string; at: ISODate; result?: string }[];
  scheduled: { id: ID; name: string; nextRunAt?: ISODate | null; enabled: boolean; ruleType: string }[];
}
