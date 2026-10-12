import {
  detectNiche,
  keywordMultiplier,
  regionName,
  REGION_MAP,
  seasonalMultiplier,
  syntheticCpc,
  syntheticFrequency,
  cpcMultiplierForRegion,
  type NicheBenchmark,
} from '@mark/shared';
import { httpJson } from '../../http/client.js';
import { rootLogger } from '../../logger.js';

/**
 * Доступ к частотности запросов (Яндекс Wordstat).
 *
 * Источники (по приоритету):
 *  1) Direct API v5 / keywordsresearch с OAuth-токеном — реальные данные Wordstat,
 *     включая разбивку по регионам (операция «Прогноз бюджета/Wordstat»);
 *  2) демо-модель MARK — детерминированная оценка на основе отраслевых бенчмарков
 *     и коэффициентов регионов. Используется, когда токена нет или DEMO-режим.
 *
 * Даже в демо-режиме данные воспроизводимы (одинаковый ввод → одинаковый вывод),
 * поэтому отчёты и гипотезы остаются согласованными между запусками.
 */

const log = rootLogger.child('wordstat');

export interface WordstatRow {
  keyword: string;
  regionId: number;
  frequency: number;
  cpc: number;
  source: 'api' | 'sandbox' | 'benchmark';
}

export interface WordstatOptions {
  token?: string;
  login?: string;
  sandbox?: boolean;
  regions: number[];
  keywords: string[];
  niche?: string;
}

async function fetchLive(options: WordstatOptions): Promise<WordstatRow[] | null> {
  if (!options.token || options.sandbox) return null;
  const host = 'https://api.direct.yandex.com';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Accept-Language': 'ru',
  };
  if (options.login) headers['Client-Login'] = options.login;

  const rows: WordstatRow[] = [];
  try {
    for (const regionId of options.regions.slice(0, 12)) {
      const result = await httpJson<{
        result?: { KeywordsResearch?: { Keyword?: string; Weight?: number; Shows?: number }[] };
        error?: { error_string?: string; error_code?: string };
      }>(`${host}/json/v5/keywordsresearch`, {
        method: 'POST',
        headers,
        body: {
          method: 'get',
          params: {
            SelectionCriteria: { Keywords: options.keywords.slice(0, 50), Regions: [regionId] },
            FieldNames: ['Keyword', 'Weight', 'Shows'],
            ReportType: 'SEARCH_QUERY_PERFORMANCE_REPORT',
          },
        },
        timeoutMs: 30_000,
      });
      if (result.data?.error) {
        log.warn('Wordstat API вернул ошибку', { error: result.data.error, regionId });
        return rows.length ? rows : null;
      }
      const items = result.data?.result?.KeywordsResearch ?? [];
      for (const item of items) {
        const frequency = Number(item.Weight ?? item.Shows ?? 0);
        const keyword = item.Keyword ?? '';
        const niche = detectNiche(options.niche ?? keyword);
        rows.push({
          keyword,
          regionId,
          frequency,
          cpc: syntheticCpc(niche, keyword, cpcMultiplierForRegion(regionId)),
          source: 'api',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300)); // бережём квоту API
    }
  } catch (error) {
    log.warn('Ошибка обращения к Wordstat', error);
    return rows.length ? rows : null;
  }
  return rows.length ? rows : null;
}

export function generateSandbox(options: WordstatOptions): WordstatRow[] {
  const rows: WordstatRow[] = [];
  for (const keyword of options.keywords.slice(0, 60)) {
    const niche: NicheBenchmark = detectNiche(options.niche ?? keyword);
    const baseFrequency = syntheticFrequency(keyword, 4200);
    for (const regionId of options.regions.slice(0, 20)) {
      const region = REGION_MAP[regionId];
      const share = (region?.demandShare ?? 1) / 100;
      const frequency = Math.max(10, Math.round(baseFrequency * (regionId === 225 || regionId === 0 ? 1 : share * 3.2)));
      rows.push({
        keyword,
        regionId,
        frequency,
        cpc: syntheticCpc(niche, keyword, cpcMultiplierForRegion(regionId)),
        source: 'sandbox',
      });
    }
  }
  return rows;
}

export async function collectWordstat(options: WordstatOptions): Promise<{ rows: WordstatRow[]; source: 'api' | 'sandbox' }> {
  const live = await fetchLive(options);
  if (live?.length) return { rows: live, source: 'api' };
  return { rows: generateSandbox(options), source: 'sandbox' };
}

/** Сезонность по нише и региону (12 месяцев). */
export function seasonalityFor(nicheId: string, regionId: number): { month: string; index: number }[] {
  const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const region = REGION_MAP[regionId];
  const regionAdjust = region?.discountPercent && region.discountPercent > 25 ? 0.96 : 1;
  return months.map((month, index) => ({
    month,
    index: Number((seasonalMultiplier(nicheId, index) * regionAdjust).toFixed(2)),
  }));
}

export interface AggregatedDemand {
  total: number;
  byRegion: { regionId: number; regionName: string; demand: number; share: number; cpc: number; priority: 'high' | 'medium' | 'low' }[];
  topCities: { name: string; regionId: number; demand: number }[];
  byKeyword: { keyword: string; demand: number; cpc: number; intent: string }[];
}

export function aggregate(rows: WordstatRow[]): AggregatedDemand {
  const total = rows.reduce((acc, row) => acc + row.frequency, 0);
  const regions = new Map<number, { demand: number; cpcSum: number; count: number }>();
  const keywords = new Map<string, { demand: number; cpc: number }>();

  for (const row of rows) {
    const region = regions.get(row.regionId) ?? { demand: 0, cpcSum: 0, count: 0 };
    region.demand += row.frequency;
    region.cpcSum += row.cpc;
    region.count += 1;
    regions.set(row.regionId, region);

    const keyword = keywords.get(row.keyword) ?? { demand: 0, cpc: row.cpc };
    keyword.demand += row.frequency;
    keywords.set(row.keyword, keyword);
  }

  const thresholds = { high: 0.08, medium: 0.02 };
  const sorted = [...regions.entries()].sort((a, b) => b[1].demand - a[1].demand);
  const byRegion = sorted.map(([regionId, value]) => ({
    regionId,
    regionName: regionName(regionId),
    demand: value.demand,
    share: total ? Number(((value.demand / total) * 100).toFixed(2)) : 0,
    cpc: value.count ? Number((value.cpcSum / value.count).toFixed(2)) : 0,
    priority: ((value.demand / (total || 1)) >= thresholds.high
      ? 'high'
      : (value.demand / (total || 1)) >= thresholds.medium
        ? 'medium'
        : 'low') as 'high' | 'medium' | 'low',
  }));

  const topCities: { name: string; regionId: number; demand: number }[] = [];
  for (const region of sorted.slice(0, 10)) {
    const meta = REGION_MAP[region[0]];
    const cities = meta?.cities ?? (meta ? [meta.name] : []);
    const perCity = Math.round(region[1].demand / Math.max(1, cities.length));
    for (const city of cities.slice(0, 4)) {
      topCities.push({ name: city, regionId: region[0], demand: perCity });
    }
  }

  const byKeyword = [...keywords.entries()]
    .map(([keyword, value]) => ({
      keyword,
      demand: value.demand,
      cpc: value.cpc,
      intent: keywordMultiplier(keyword).intent,
    }))
    .sort((a, b) => b.demand - a.demand);

  return { total, byRegion, topCities, byKeyword };
}
