import type { GeoAnalysis, GeoPagePlan, GeoPlan } from '@mark/shared';
import { detectNiche, regionName, REGION_MAP, slugify } from '@mark/shared';
import { randomId } from '../../crypto.js';
import { rootLogger } from '../../logger.js';
import { aggregate, collectWordstat, seasonalityFor } from './wordstat.js';

/**
 * GEO-анализатор: спрос по регионам, сезонность, приоритеты и региональная структура сайта.
 *
 * На основе данных Wordstat (реальных или демо) формирует:
 *  - карту спроса по регионам с CPC и приоритетом;
 *  - топ городов внутри регионов;
 *  - сезонность;
 *  - рекомендации по усилиям;
 *  - (вторым шагом) GEO-план: URL, title, description, hreflang, JSON-LD, задачи.
 */

const log = rootLogger.child('geo');

export interface AnalyzeGeoOptions {
  keywords: string[];
  regionIds: number[];
  niche?: string;
  token?: string;
  login?: string;
  useLive?: boolean;
  siteUrl?: string;
}

export async function analyzeGeo(options: AnalyzeGeoOptions): Promise<GeoAnalysis> {
  const niche = detectNiche(options.niche ?? options.keywords.join(' '));
  const keywords = options.keywords.slice(0, 60);
  const regionIds = options.regionIds.length ? options.regionIds.slice(0, 30) : [213];

  const { rows, source } = await collectWordstat({
    keywords,
    regions: regionIds,
    niche: niche.name,
    token: options.token,
    login: options.login,
    sandbox: !options.useLive,
  });

  const aggregated = aggregate(rows);
  const primary = aggregated.byRegion[0];
  const seasonality = seasonalityFor(niche.id, primary?.regionId ?? 213);

  const recommendations: string[] = [];
  if (aggregated.byRegion.length > 1) {
    const top = aggregated.byRegion.slice(0, 5);
    recommendations.push(
      `Создайте региональные страницы для приоритетных регионов: ${top.map((r) => r.regionName).join(', ')} — на них приходится ${top.reduce((acc, r) => acc + r.share, 0).toFixed(1)}% спроса.`,
    );
  }
  const lowCpc = [...aggregated.byRegion].sort((a, b) => a.cpc - b.cpc).slice(0, 3);
  if (primary && lowCpc[0] && lowCpc[0].cpc < primary.cpc * 0.8) {
    recommendations.push(
      `Дешевле всего трафик в регионах: ${lowCpc.map((r) => `${r.regionName} (${r.cpc} ₽)`).join(', ')} — тестируйте там рекламу с меньшим бюджетом.`,
    );
  }
  const peak = seasonality.reduce((max, item) => (item.index > max.index ? item : max), seasonality[0]!);
  recommendations.push(
    `Пик спроса — ${peak.month} (индекс ${peak.index.toFixed(2)}). Готовьте региональные страницы и объявления за 3–4 недели до пика.`,
  );
  recommendations.push(
    `Обязательно добавьте в hreflang и Schema.org разметку region/areaServed, а в title — название города: это усиливает и локальную выдачу, и ответы ИИ-поиска.`,
  );
  recommendations.push(
    `Настройте карточку в Яндекс.Бизнес для каждого города и синхронизируйте NAP (название, адрес, телефон) с сайтом — это ключевой фактор локального ранжирования.`,
  );
  if (source === 'sandbox') {
    recommendations.push(
      'Данные о частотности смоделированы локально (нет OAuth-токена Директа). Подключите Яндекс.Директ, чтобы получать фактические цифры Wordstat.',
    );
  }

  const analysis: GeoAnalysis = {
    id: randomId('geo'),
    tenantId: '',
    keywords,
    regionIds,
    source: source === 'api' ? 'wordstat_api' : 'sandbox',
    totalDemand: aggregated.total,
    demandByRegion: aggregated.byRegion,
    topCities: aggregated.topCities.slice(0, 30),
    seasonality,
    recommendations,
    createdAt: new Date().toISOString(),
    simulated: source !== 'api',
  };

  log.info(`GEO-анализ: ${keywords.length} запросов × ${regionIds.length} регионов, источник ${source}`);
  return analysis;
}

/* ----------------------------- GEO-план ----------------------------- */

export interface GeoPlanOptions {
  siteUrl: string;
  siteName: string;
  structure: 'subfolders' | 'subdomains' | 'single';
  analysis: GeoAnalysis;
  keywords?: string[];
  phone?: string;
}

export function buildGeoPlan(options: GeoPlanOptions): GeoPlan {
  const base = options.siteUrl.replace(/\/+$/, '');
  const baseHost = (() => {
    try {
      return new URL(base).hostname.replace(/^www\./, '');
    } catch {
      return baseHostFromInput(base);
    }
  })();
  const regions = options.analysis.demandByRegion.filter((region) => region.priority !== 'low').slice(0, 40);
  const keywords = (options.keywords?.length ? options.keywords : options.analysis.keywords).slice(0, 12);

  const pages: GeoPagePlan[] = regions.map((region) => {
    const cityName = region.regionName.replace(/\s*(и|область|край|республика).*/i, '').trim();
    const slug = slugify(cityName) || `region-${region.regionId}`;
    const keyword = keywords[0] ?? 'услуги';
    const url = options.structure === 'subdomains' ? `https://${slug}.${baseHost}/` : `${base}/${slug}/`;
    return {
      regionId: region.regionId,
      regionName: region.regionName,
      url,
      title: `${keyword} в ${cityName} — ${options.siteName}`.slice(0, 62),
      description: `${keyword} в ${cityName}: цена, сроки, гарантия. Оставьте заявку — рассчитаем стоимость за 15 минут. Работаем по всему региону: ${region.regionName}.`.slice(0, 168),
      h1: `${keyword} в ${cityName}`,
      keywords: keywords.map((kw) => `${kw} ${cityName.toLowerCase()}`),
      cityInContent: true,
    };
  });

  const hreflang = pages.slice(0, 20).map((page) => ({ lang: 'ru-RU', href: page.url }));
  if (pages.length) hreflang.push({ lang: 'x-default', href: `${base}/` });

  const schemaOrg = pages.map((page) => ({
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: `${options.siteName} — ${page.regionName}`,
    url: page.url,
    areaServed: { '@type': 'AdministrativeArea', name: page.regionName },
    ...(options.phone ? { telephone: options.phone } : {}),
  }));

  const sitemapAnnotations = pages.map((page) => `  <!-- ${page.regionName}: приоритет 0.8 -->\n  <url><loc>${page.url}</loc><changefreq>weekly</changefreq></url>`);

  const robotsAdditions = [
    'Allow: /*/',
    `# Региональные разделы: ${pages.slice(0, 5).map((p) => new URL(p.url).pathname).join(', ')}`,
  ];

  const campaignGeoSettings = options.analysis.demandByRegion.slice(0, 12).map((region) => ({
    regionId: region.regionId,
    targeting: `${region.regionName} (код региона Яндекса ${region.regionId})`,
    suggestion:
      region.priority === 'high'
        ? `Приоритет 1: отдельная кампания с дневным бюджетом от ${Math.round((region.cpc ?? 0) * 25)} ₽ (≈25 кликов/день)`
        : region.priority === 'medium'
          ? `Приоритет 2: отдельная группа в общей кампании, бюджет от ${Math.round((region.cpc ?? 0) * 10)} ₽`
          : 'Приоритет 3: включить в общую кампанию с корректировкой ставки',
  }));

  const tasks = [
    { title: 'Создать региональные страницы по плану и добавить их в sitemap', owner: 'SEO', effort: 3 },
    { title: 'Прописать title/description/H1 с названием города', owner: 'Контент', effort: 2 },
    { title: 'Добавить разметку LocalBusiness/areaServed и hreflang', owner: 'Разработка', effort: 2 },
    { title: 'Создать/обновить карточки Яндекс.Бизнес и Google Business Profile', owner: 'Маркетинг', effort: 3 },
    { title: 'Разделить рекламные кампании по приоритетным регионам', owner: 'PPC', effort: 2 },
    { title: 'Настроить отслеживание звонков и заявок по регионам', owner: 'Аналитика', effort: 2 },
    ...(pages.length > 10 ? [{ title: 'Проверить уникальность текстов региональных страниц', owner: 'Контент', effort: 2 }] : []),
  ];

  const plan: GeoPlan = {
    id: randomId('geoplan'),
    tenantId: '',
    siteProjectId: '',
    structure: options.structure,
    regionIds: pages.map((page) => page.regionId),
    pages,
    hreflang,
    schemaOrg,
    sitemapAnnotations,
    robotsAdditions,
    campaignGeoSettings,
    tasks,
    generatedAt: new Date().toISOString(),
    appliedAt: null,
    applyLog: [],
  };

  log.info(`GEO-план: ${pages.length} региональных страниц для ${baseHost}`);
  return plan;
}

function baseHostFromInput(input: string): string {
  const match = /^(?:https?:\/\/)?([^/]+)/i.exec(input);
  return (match?.[1] ?? 'example.ru').replace(/^www\./, '');
}

/** Краткая сводка для дашборда. */
export function geoSummary(analysis: GeoAnalysis) {
  return {
    regions: analysis.demandByRegion.length,
    demand: analysis.totalDemand,
    topRegion: analysis.demandByRegion[0]?.regionName,
    topCities: analysis.topCities.slice(0, 5),
    simulated: analysis.simulated ?? false,
  };
}

export function regionOptions(regionIds: number[]) {
  return regionIds.map((id) => ({ id, name: regionName(id), recommended: REGION_MAP[id]?.recommended ?? false }));
}
