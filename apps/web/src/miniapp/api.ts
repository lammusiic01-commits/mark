import { initData } from './telegram';

/**
 * Клиент API мини-приложения: /api/tg/*
 *
 * Каждый запрос несёт заголовок X-Telegram-Init-Data — по нему сервер
 * проверяет подпись Telegram и понимает, кто открыл приложение.
 * Ответы сервера всегда в формате { ok, data } — здесь распаковываются.
 */

export class MiniAppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MiniAppError';
  }
}

const BASE = `${import.meta.env.VITE_MARK_API ?? ''}/api/tg`;

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-telegram-init-data': initData() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new MiniAppError('Нет связи с сервером. Проверьте интернет и повторите.', 0);
  }

  const text = await response.text();
  let payload: { ok?: boolean; data?: T; error?: string; details?: unknown } | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || (payload && payload.ok === false)) {
    throw new MiniAppError(payload?.error ?? `Ошибка запроса (${response.status})`, response.status, payload?.details);
  }
  if (payload && payload.ok) return payload.data as T;
  return payload as unknown as T;
}

export const tgApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/* ------------------------------- Типы ответов ------------------------------- */

export interface MiniSession {
  session: { verified: boolean; role: 'owner' | 'manager' | 'viewer'; firstName: string; username: string | null };
  tenant: { id: string; agencyName: string; brandColor: string; hideMarkBranding: boolean };
  bot: { enabled: boolean; running: boolean; username: string | null };
  env: { demoMode: boolean; version: string };
  onboarding: boolean;
}

export interface MiniMetrics {
  clicks: number;
  clicks_change: number;
  spent: number;
  spent_change: number;
  conversions: number;
  conv_change: number;
  bot_pct: number;
  bot_change: number;
  bot_saved: number;
  seo_score: number;
}

export interface MiniAlert {
  code: string;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  detail: string;
  action?: string;
}

export interface MiniSummary {
  balance: number;
  plan: string | null;
  planUntil: string | null;
  metrics: MiniMetrics;
  hypotheses_count: number;
  campaigns_count: number;
  sites_count: number;
  charged30d: number;
  ai_tip: string;
  alerts: MiniAlert[];
}

export interface MiniServiceField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string | null;
  help: string | null;
  secret: boolean;
}

export interface MiniServiceAccount {
  id: string;
  label: string;
  status: string;
  sandbox: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  secretPreview: string | null;
}

export interface MiniService {
  id: string;
  name: string;
  vendor: string;
  category: string;
  docsUrl: string;
  capabilities: string[];
  supportsSandbox: boolean;
  notes: string[];
  color: string | null;
  authModes: { id: string; label: string; automation: string; needsInAppLogin: boolean; fields: MiniServiceField[] }[];
  validationPlan: { title: string }[];
  status: string;
  account: MiniServiceAccount | null;
}

export interface MiniAuditFinding {
  id: string;
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  title: string;
  evidence: string;
  recommendation: string;
  autoFixable: boolean;
  impact: number;
  url?: string;
}

export interface MiniAudit {
  id: string;
  score: number;
  grade: string;
  summary: { critical: number; high: number; medium: number; low: number; info: number; autoFixable: number };
  categoryScores: Record<string, number>;
  pagesCrawled: number;
  simulated: boolean;
  findings: MiniAuditFinding[];
}

export interface MiniBotScan {
  id: string;
  cleanlinessScore: number;
  totals: { requests: number; suspiciousRequests: number; uniqueIps: number; wastedMoneyEstimate: number };
  topIps: { ip: string; requests: number; suspicious: number; country?: string; asn?: string; reason?: string }[];
  topBots: { name: string; requests: number; kind: string; suspicious?: boolean }[];
  countries: { code: string; name: string; requests: number; suspicious: number }[];
  recommendations: { title: string; detail: string; severity: string }[];
  series: { date: string; value: number }[];
  errors: string[];
}

export interface MiniGeoAnalysis {
  id: string;
  totalDemand: number;
  source: string;
  regionName: string;
  demandByRegion: { regionId: number; regionName: string; demand: number; cpc: number; competition?: number; priority: string }[];
  seasonality: { month: string; index: number }[];
  topCities: { name: string; regionId: number; demand: number }[];
  recommendations: string[];
}

export interface MiniCampaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  strategy: string;
  dailyBudget: number;
  metrics: { clicks: number; cost: number; conversions: number; cpa: number; ctr: number };
  trend: { date: string; value: number }[];
  warnings: { code: string; message: string; severity: string }[];
}

export interface MiniHypothesis {
  id: string;
  title: string;
  statement: string;
  status: string;
  ice: { impact: number; confidence: number; ease: number; score: number };
  metric: string;
  expectedEffectPct: number;
  source: string;
  tags: string[];
  testPlan: Record<string, unknown>;
  createdAt: string;
}

export interface MiniReport {
  id: string;
  title: string;
  type: string;
  status: string;
  period: string;
  createdAt: string;
  kpis: { label: string; value: string | number; unit?: string }[];
}

export interface MiniBalance {
  balance: number;
  hold: number;
  currency: string;
  plan: string | null;
  planUntil: string | null;
  transactions: { id: string; type: string; amount: number; balanceAfter: number; description: string; createdAt: string }[];
  payments: { id: string; amount: number; status: string; createdAt: string; comment?: string | null }[];
  plans: { id: string; name: string; price: number; period: string; description: string; features: string[]; popular?: boolean }[];
  spend: { charged30d: number; toppedUp30d: number };
  limits: { min: number; max: number };
}

export interface MiniPayment {
  id: string;
  amount: number;
  status: string;
  sbpUrl: string;
  qrPngBase64: string;
  comment?: string | null;
  createdAt: string;
}
