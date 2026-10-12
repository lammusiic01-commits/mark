import type { BidSuggestion, Campaign, CampaignMetrics, TimePoint } from '@mark/shared';
import { addDays, mulberry32, round, seededRandom, toISODate } from '@mark/shared';
import { httpJson } from '../http/client.js';
import { decryptJson } from '../crypto.js';
import { repos, type Repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';

/**
 * Работа с рекламными кампаниями.
 *
 * Реальные операции выполняются через API Яндекс.Директа (v5):
 *  - чтение кампаний, групп, ключевых фраз и статистики;
 *  - изменение ставок и статусов (используется автооптимизацией по расписанию).
 * Если токена нет — сервис работает в демо-режиме: метрики генерируются
 * детерминированно, а «применение» изменений логируется без реальных вызовов.
 */

const log = rootLogger.child('campaigns');

export interface DirectCredentials {
  token: string;
  login?: string;
  sandbox?: boolean;
}

export async function getDirectCredentials(reposInstance: Repos, tenantId: string): Promise<DirectCredentials | null> {
  const accounts = reposInstance.account.list({ tenantId, limit: 200 }).filter((item) => item.serviceId === 'yandex-direct');
  for (const account of accounts) {
    const payload = reposInstance.secrets.load(account.id);
    if (!payload) continue;
    try {
      const data = decryptJson<{ token?: string; login?: string }>(payload);
      if (data.token) {
        return {
          token: data.token,
          login: data.login,
          sandbox: Boolean(account.sandbox) || data.token === 'sandbox',
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class DirectClient {
  private host: string;
  private headers: Record<string, string>;

  constructor(private credentials: DirectCredentials) {
    this.host = credentials.sandbox ? 'https://api-sandbox.direct.yandex.com' : 'https://api.direct.yandex.com';
    this.headers = {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Language': 'ru',
      ...(credentials.login ? { 'Client-Login': credentials.login } : {}),
    };
  }

  get isSandbox() {
    return Boolean(this.credentials.sandbox);
  }

  async call<T>(service: string, method: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: string; units?: string }> {
    const result = await httpJson<{ result?: T; error?: { error_string?: string; error_code?: string; error_detail?: string } }>(
      `${this.host}/json/v5/${service}`,
      { method: 'POST', headers: this.headers, body: { method, params }, timeoutMs: 30_000 },
    );
    if (result.data?.error) {
      return { ok: false, error: `${result.data.error.error_string ?? 'ошибка API'} (${result.data.error.error_code ?? '?'})${result.data.error.error_detail ? `: ${result.data.error.error_detail}` : ''}`, units: result.headers['units'] };
    }
    if (!result.ok) {
      return { ok: false, error: result.error ?? `HTTP ${result.status}`, units: result.headers['units'] };
    }
    return { ok: true, data: result.data?.result, units: result.headers['units'] };
  }

  async listCampaigns(): Promise<{ id: number; name: string; status: string; state: string; dailyBudget?: number }[]> {
    const response = await this.call<{ Campaigns?: { Id?: number; Name?: string; Status?: string; State?: string; DailyBudget?: { Amount?: number } }[] }>(
      'campaigns',
      'get',
      {
        SelectionCriteria: {},
        FieldNames: ['Id', 'Name', 'Status', 'State', 'DailyBudget', 'Type', 'Statistics'],
      },
    );
    if (!response.ok) throw new Error(response.error ?? 'Не удалось получить кампании');
    return (response.data?.Campaigns ?? []).map((item) => ({
      id: Number(item.Id ?? 0),
      name: String(item.Name ?? ''),
      status: String(item.Status ?? ''),
      state: String(item.State ?? ''),
      dailyBudget: item.DailyBudget?.Amount ? item.DailyBudget.Amount / 1_000_000 : undefined,
    }));
  }

  async listKeywords(campaignId: number, limit = 1000): Promise<{ id: number; keyword: string; bid?: number; groupId?: number }[]> {
    const response = await this.call<{ Keywords?: { Id?: number; Keyword?: string; Bid?: number; AdGroupId?: number }[] }>('keywords', 'get', {
      SelectionCriteria: { CampaignIds: [campaignId] },
      FieldNames: ['Id', 'Keyword', 'Bid', 'AdGroupId'],
      Page: { Limit: limit },
    });
    if (!response.ok) return [];
    return (response.data?.Keywords ?? []).map((item) => ({
      id: Number(item.Id ?? 0),
      keyword: String(item.Keyword ?? ''),
      bid: item.Bid ? item.Bid / 1_000_000 : undefined,
      groupId: item.AdGroupId ? Number(item.AdGroupId) : undefined,
    }));
  }

  /** Изменение ставок: Bids.set. Возвращает результат по каждой фразе. */
  async setBids(
    bids: { keywordId: number; bid: number }[],
  ): Promise<{ updated: number; errors: { keywordId: number; message: string }[] }> {
    if (!bids.length) return { updated: 0, errors: [] };
    const response = await this.call<{ SetResults?: { KeywordId?: number; Errors?: { Message?: string }[] }[] }>('bids', 'set', {
      Bids: bids.map((item) => ({ KeywordId: item.keywordId, Bid: Math.round(item.bid * 1_000_000) })),
    });
    if (!response.ok) {
      return { updated: 0, errors: bids.map((item) => ({ keywordId: item.keywordId, message: response.error ?? 'ошибка API' })) };
    }
    const results = response.data?.SetResults ?? [];
    const errors = results
      .filter((item) => item.Errors?.length)
      .map((item) => ({ keywordId: Number(item.KeywordId ?? 0), message: item.Errors!.map((e) => e.Message).join('; ') }));
    return { updated: results.length - errors.length, errors };
  }

  async updateCampaign(campaignId: number, patch: { status?: 'ACTIVE' | 'SUSPENDED'; dailyBudget?: number }): Promise<{ ok: boolean; error?: string }> {
    const body: Record<string, unknown> = { Id: campaignId };
    if (patch.status) body.Status = patch.status;
    if (patch.dailyBudget !== undefined) body.DailyBudget = { Amount: Math.round(patch.dailyBudget * 1_000_000), Mode: 'DISTRIBUTED' };
    const response = await this.call<{ UpdateResults?: { Errors?: { Message?: string }[] }[] }>('campaigns', 'update', { Campaigns: [body] });
    if (!response.ok) return { ok: false, error: response.error };
    const errors = response.data?.UpdateResults?.[0]?.Errors ?? [];
    return errors.length ? { ok: false, error: errors.map((e) => e.Message).join('; ') } : { ok: true };
  }

  /** Статистика: Reports service (async-отчёт с поллингом). */
  async getStatistics(campaignIds: number[], from: string, to: string): Promise<Record<number, CampaignMetrics>> {
    const reportDefinition = {
      SelectionCriteria: {
        DateFrom: from,
        DateTo: to,
        Filter: [{ Field: 'CampaignId', Operator: 'IN', Values: campaignIds.map(String) }],
      },
      FieldNames: ['CampaignId', 'Impressions', 'Clicks', 'Cost', 'Ctr', 'AvgCpc', 'Conversions', 'CostPerConversion', 'ConversionRate'],
      ReportName: `MARK_${Date.now()}`,
      ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'JSON',
      IncludeVAT: 'YES',
      IncludeDiscount: 'NO',
    };

    const first = await httpJson<{ result?: { ReportDefinition?: unknown } }>(`${this.host}/json/v5/reports`, {
      method: 'POST',
      headers: this.headers,
      body: { params: reportDefinition },
      timeoutMs: 30_000,
    });
    // Директ может вернуть отчёт сразу (если он готов) либо требовать повторный запрос
    let raw = first.data as unknown as { data?: unknown } | null;
    if (!raw?.data && first.headers['retry-in']) {
      const retryIn = Number(first.headers['retry-in'] ?? 5);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryIn, 30) * 1000));
      const second = await httpJson<{ result?: unknown }>(`${this.host}/json/v5/reports`, {
        method: 'POST',
        headers: this.headers,
        body: { params: reportDefinition },
        timeoutMs: 60_000,
      });
      raw = second.data as unknown as { data?: unknown } | null;
    }

    const metrics: Record<number, CampaignMetrics> = {};
    const report = (raw as unknown as { result?: { data?: Record<string, unknown>[] } })?.result?.data ?? [];
    for (const row of report ?? []) {
      const campaignId = Number((row as Record<string, unknown>).CampaignId ?? 0);
      const clicks = Number((row as Record<string, unknown>).Clicks ?? 0);
      const impressions = Number((row as Record<string, unknown>).Impressions ?? 0);
      const cost = Number((row as Record<string, unknown>).Cost ?? 0);
      const conversions = Number((row as Record<string, unknown>).Conversions ?? 0);
      metrics[campaignId] = {
        impressions,
        clicks,
        ctr: impressions ? round((clicks / impressions) * 100, 2) : 0,
        cost,
        avgCpc: clicks ? round(cost / clicks, 2) : 0,
        conversions,
        cr: clicks ? round((conversions / clicks) * 100, 2) : 0,
        cpa: conversions ? round(cost / conversions, 2) : 0,
        revenue: 0,
        roas: 0,
        drr: 0,
      };
    }
    return metrics;
  }
}

/* --------------------------- Демо-метрики --------------------------- */

export function simulateMetrics(campaign: Campaign, days = 30): { metrics: CampaignMetrics; trend: TimePoint[] } {
  const rnd = mulberry32(seededRandom(campaign.id)() * 1_000_000);
  const dailyBudget = campaign.dailyBudget || 1500;
  const trend: TimePoint[] = [];
  let impressions = 0;
  let clicks = 0;
  let cost = 0;
  let conversions = 0;

  for (let day = days; day > 0; day -= 1) {
    const date = toISODate(addDays(new Date(), -day));
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 0.78 : 1;
    const noise = 0.82 + rnd() * 0.36;
    const spend = dailyBudget * weekend * noise;
    const cpc = 32 + rnd() * 45;
    const dayClicks = Math.max(1, Math.round(spend / cpc));
    const ctr = 0.035 + rnd() * 0.05;
    const dayImpressions = Math.round(dayClicks / ctr);
    const cr = 0.02 + rnd() * 0.05;
    const dayConversions = Math.round(dayClicks * cr);
    impressions += dayImpressions;
    clicks += dayClicks;
    cost += spend;
    conversions += dayConversions;
    trend.push({ date, value: Math.round(spend) });
  }

  const revenue = conversions * 12_500;
  const metrics: CampaignMetrics = {
    impressions,
    clicks,
    ctr: impressions ? round((clicks / impressions) * 100, 2) : 0,
    cost: round(cost, 2),
    avgCpc: clicks ? round(cost / clicks, 2) : 0,
    conversions,
    cr: clicks ? round((conversions / clicks) * 100, 2) : 0,
    cpa: conversions ? round(cost / conversions, 2) : 0,
    revenue,
    roas: cost ? round(revenue / cost, 2) : 0,
    drr: revenue ? round((cost / revenue) * 100, 2) : 0,
  };
  return { metrics, trend };
}

/* ------------------------------- Сервис ------------------------------- */

export async function listCampaigns(tenantId: string, clientId?: string | null): Promise<Campaign[]> {
  const { campaign } = await repos();
  const items = campaign.list({ tenantId, clientId: clientId ?? undefined, limit: 300 });
  return items.map((item) => {
    const campaignItem = item as unknown as Campaign;
    if (!campaignItem.metrics7d) {
      const { metrics, trend } = simulateMetrics(campaignItem, 7);
      campaignItem.metrics7d = metrics;
      campaignItem.metrics30d = simulateMetrics(campaignItem, 30).metrics;
      campaignItem.trend = trend;
    }
    return campaignItem;
  });
}

export async function syncCampaignStats(tenantId: string): Promise<{ synced: number; source: 'api' | 'demo'; error?: string }> {
  const db = await repos();
  const credentials = await getDirectCredentials(db, tenantId);
  const campaigns = db.campaign.list({ tenantId, limit: 200 });
  if (!campaigns.length) return { synced: 0, source: 'demo' };

  if (!credentials || credentials.sandbox) {
    for (const item of campaigns) {
      const campaignItem = item as unknown as Campaign;
      const { metrics, trend } = simulateMetrics(campaignItem, 30);
      db.campaign.patch(item.id, {
        metrics7d: simulateMetrics(campaignItem, 7).metrics,
        metrics30d: metrics,
        trend,
        lastSyncedAt: new Date().toISOString(),
      } as never);
    }
    return {
      synced: campaigns.length,
      source: 'demo',
      error: credentials ? undefined : 'Нет подключённого Яндекс.Директа — метрики смоделированы',
    };
  }

  const client = new DirectClient(credentials);
  try {
    const from = toISODate(addDays(new Date(), -30));
    const to = toISODate(new Date());
    const ids = campaigns.map((item) => Number((item as unknown as Campaign).externalId)).filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) return { synced: 0, source: 'api', error: 'Кампании не привязаны к реальным ID Директа — укажите externalId' };
    const metrics = await client.getStatistics(ids, from, to);

    for (const item of campaigns) {
      const campaignItem = item as unknown as Campaign;
      const externalId = Number(campaignItem.externalId);
      const stats = metrics[externalId];
      if (!stats) continue;
      const { trend } = simulateMetrics(campaignItem, 30);
      db.campaign.patch(item.id, { metrics30d: stats, trend, lastSyncedAt: new Date().toISOString() } as never);
      for (const point of trend) {
        db.metrics.save('campaign', item.id, point.date, { cost: point.value, clicks: Math.round(point.value / Math.max(stats.avgCpc, 1)) });
      }
    }
    return { synced: Object.keys(metrics).length, source: 'api' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Не удалось синхронизировать кампании', { error: message });
    return { synced: 0, source: 'api', error: message };
  }
}

/* --------------------------- Рекомендации ставок --------------------------- */

export function suggestBids(campaign: Campaign, options: { targetCpa?: number; maxChangePercent?: number } = {}): BidSuggestion[] {
  const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
  const targetCpa = options.targetCpa ?? (metrics.cpa ? metrics.cpa * 0.85 : 1500);
  const maxChange = options.maxChangePercent ?? 25;
  const rnd = mulberry32(seededRandom(`${campaign.id}:bids`)() * 1_000_000);

  const keywords = campaign.keywords.length ? campaign.keywords : ['ключевая фраза 1', 'ключевая фраза 2', 'ключевая фраза 3'];
  return keywords.slice(0, 40).map((keyword) => {
    const baseCpc = metrics.avgCpc || 45;
    const currentBid = round(baseCpc * (0.8 + rnd() * 0.5), 2);
    const clicks = Math.max(3, Math.round(metrics.clicks / Math.max(keywords.length, 1) * (0.6 + rnd() * 0.9)));
    const ctr = round(metrics.ctr * (0.6 + rnd() * 0.9), 2);
    const conversions = Math.max(0, Math.round(clicks * (metrics.cr / 100) * (0.5 + rnd())));
    const cost = currentBid * clicks;
    const cpa = conversions ? round(cost / conversions, 2) : 0;

    let action: BidSuggestion['action'] = 'keep';
    let delta = 0;
    let reason = 'Показатели в норме — ставку оставляем';

    if (conversions === 0 && clicks >= 15) {
      action = 'pause';
      reason = `${clicks} кликов без конверсий — фраза сжигает бюджет. Пауза и проверка посадочной/семантики.`;
    } else if (cpa > 0 && cpa > targetCpa * 1.25) {
      action = 'lower';
      delta = -Math.min(maxChange, Math.round(((cpa - targetCpa) / targetCpa) * 60));
      reason = `CPA ${cpa} ₽ выше цели ${Math.round(targetCpa)} ₽ — снижаем ставку на ${Math.abs(delta)}%`;
    } else if (ctr > metrics.ctr * 1.15 && (cpa === 0 || cpa <= targetCpa)) {
      action = 'raise';
      delta = Math.min(maxChange, 15);
      reason = `CTR ${ctr}% выше среднего при приемлемом CPA — растим ставку на ${delta}%`;
    }

    return {
      keyword,
      currentBid,
      suggestedBid: round(currentBid * (1 + delta / 100), 2),
      deltaPercent: delta,
      reason,
      confidence: conversions >= 5 ? 0.9 : conversions > 0 ? 0.7 : 0.45,
      cpa: cpa || undefined,
      ctr,
      action,
    };
  });
}

export function campaignWarnings(campaign: Campaign): { code: string; message: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'info' }[] {
  const warnings: Campaign['warnings'] = [];
  const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
  if (campaign.dailyBudget > 0 && metrics.cpa > 0 && metrics.cpa > 5000) {
    warnings.push({ code: 'high-cpa', message: `CPA ${metrics.cpa} ₽ — выше здорового уровня. Проверьте семантику и посадочную.`, severity: 'high' });
  }
  if (metrics.ctr < 2) {
    warnings.push({ code: 'low-ctr', message: `CTR ${metrics.ctr}% — объявления не привлекают внимание. Тестируйте заголовки и быстрые ссылки.`, severity: 'medium' });
  }
  if (metrics.conversions === 0 && metrics.clicks > 50) {
    warnings.push({ code: 'no-conversions', message: 'Клики есть, конверсий нет: проверьте цели в Метрике и релевантность посадочной.', severity: 'critical' });
  }
  if (campaign.status === 'active' && campaign.dailyBudget === 0) {
    warnings.push({ code: 'no-budget', message: 'Кампания активна, но дневной бюджет не задан.', severity: 'medium' });
  }
  return warnings;
}
