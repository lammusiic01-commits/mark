import type { MarketAnalysis, MarketBenchmark } from '@mark/shared';
import {
  cpcMultiplierForRegion,
  detectNiche,
  keywordMultiplier,
  regionName,
  seasonalMultiplier,
  syntheticFrequency,
  round,
} from '@mark/shared';
import { randomId } from '../../crypto.js';
import { rootLogger } from '../../logger.js';
import { collectWordstat } from '../geo/wordstat.js';

/**
 * Market Analyzer: сравнение вашего CPC с бенчмарками ниши.
 *
 * Отвечает на вопросы: «дорого ли я плачу за клик?», «сколько кликов/лидов
 * даст бюджет?», «в каких регионах дешевле?», «какие сценарии бюджета выбрать?».
 */

const log = rootLogger.child('market');

export interface AnalyzeMarketOptions {
  niche?: string;
  keywords: string[];
  regionId: number;
  yourCpc?: number | null;
  budget?: number | null;
  token?: string;
  login?: string;
  useLive?: boolean;
  siteName?: string;
}

const competitionLabel: Record<string, string> = {
  low: 'низкая',
  medium: 'средняя',
  high: 'высокая',
  very_high: 'очень высокая',
};

export async function analyzeMarket(options: AnalyzeMarketOptions): Promise<MarketAnalysis> {
  const niche = detectNiche(options.niche ?? options.keywords.join(' '));
  const regionMultiplier = cpcMultiplierForRegion(options.regionId);
  const region = regionName(options.regionId);
  const keywords = (options.keywords.length ? options.keywords : niche.keywords).slice(0, 40);

  const { rows, source } = await collectWordstat({
    keywords,
    regions: [options.regionId],
    niche: niche.name,
    token: options.token,
    login: options.login,
    sandbox: !options.useLive,
  });

  const liveByKeyword = new Map<string, { frequency: number; cpc: number }>();
  for (const row of rows) {
    const current = liveByKeyword.get(row.keyword) ?? { frequency: 0, cpc: 0 };
    liveByKeyword.set(row.keyword, { frequency: current.frequency + row.frequency, cpc: row.cpc });
  }

  const benchmarks: MarketBenchmark[] = keywords.map((keyword) => {
    const live = liveByKeyword.get(keyword);
    const frequency = live?.frequency ?? syntheticFrequency(keyword);
    const cpc = live?.cpc ?? round(niche.cpcMoscow * regionMultiplier * keywordMultiplier(keyword).multiplier, 2);
    const ctr = round(niche.ctr * (0.85 + keywordMultiplier(keyword).multiplier * 0.2), 2);
    return {
      keyword,
      frequency,
      cpc,
      competition: niche.competition,
      clicksEstimate: Math.round((frequency * ctr) / 100),
      ctr,
    };
  });

  const nicheCpc = round(benchmarks.reduce((acc, item) => acc + item.cpc, 0) / Math.max(1, benchmarks.length), 2);
  const yourCpc = options.yourCpc ?? null;
  const gapPercent = yourCpc && nicheCpc ? round(((yourCpc - nicheCpc) / nicheCpc) * 100, 1) : null;

  const verdict =
    gapPercent === null
      ? `Бенчмарк ниши «${niche.name}» в регионе ${region}: ${nicheCpc} ₽ за клик. Укажите ваш текущий CPC, чтобы мы показали отклонение.`
      : gapPercent <= -15
        ? `Вы платите на ${Math.abs(gapPercent)}% ниже рынка (${yourCpc} ₽ против ${nicheCpc} ₽) — можно масштабировать ставки и забрать больше трафика.`
        : gapPercent <= 15
          ? `Ваш CPC в рынке (отклонение ${gapPercent}%). Рост даст работа над CTR и качеством объявлений, а не ставкой.`
          : `Вы платите на ${gapPercent}% выше бенчмарка (${yourCpc} ₽ против ${nicheCpc} ₽). Проверьте релевантность объявлений, минус-слова и региональные корректировки.`;

  const dailyBudgetDefault = options.budget ?? Math.round(nicheCpc * 30);
  const monthlyBudget = Math.round(dailyBudgetDefault * 30);
  const conversion = niche.conversion / 100;

  const scenarios: MarketAnalysis['budgetPlan'] = [
    {
      scenario: 'economy',
      dailyBudget: Math.round(monthlyBudget * 0.4 / 30),
      clicks: Math.round((monthlyBudget * 0.4) / nicheCpc),
      conversions: Math.round(((monthlyBudget * 0.4) / nicheCpc) * conversion),
      cpa: Math.round(nicheCpc / Math.max(conversion, 0.0001)),
      note: 'Мягкий старт: тестируем объявления и аудитории, минимизируем риск.',
    },
    {
      scenario: 'balanced',
      dailyBudget: Math.round(monthlyBudget / 30),
      clicks: Math.round(monthlyBudget / nicheCpc),
      conversions: Math.round((monthlyBudget / nicheCpc) * conversion),
      cpa: Math.round(nicheCpc / Math.max(conversion, 0.0001)),
      note: 'Рабочий режим: стабильный поток лидов при контроле CPA и DRR.',
    },
    {
      scenario: 'aggressive',
      dailyBudget: Math.round((monthlyBudget * 2) / 30),
      clicks: Math.round((monthlyBudget * 2) / nicheCpc),
      conversions: Math.round(((monthlyBudget * 2) / nicheCpc) * conversion),
      cpa: Math.round((nicheCpc * 1.12) / Math.max(conversion, 0.0001)),
      note: 'Захват доли рынка: аукцион дороже на 10–15%, зато максимум заявок в сезон.',
    },
  ];

  const seasonNow = seasonalMultiplier(niche.id, new Date().getUTCMonth());
  const insights: string[] = [
    `Конкуренция в нише «${niche.name}»: ${competitionLabel[niche.competition] ?? niche.competition}. Средний CPC — ${nicheCpc} ₽, CTR в поиске ≈ ${niche.ctr}%, конверсия сайта ≈ ${niche.conversion}%.`,
    `Средний чек/ценность лида в нише: ${niche.averageOrderValue.toLocaleString('ru-RU')} ₽. При CPA ${Math.round(nicheCpc / Math.max(conversion, 0.0001))} ₽ реклама окупается при конверсии сайта от ${(nicheCpc / Math.max(conversion, 0.0001) / niche.averageOrderValue * 100).toFixed(1)}%.`,
    `Текущий сезонный коэффициент: ${seasonNow.toFixed(2)} — ${seasonNow > 1.05 ? 'спрос выше среднего, ставки стоит поднять' : seasonNow < 0.95 ? 'спрос ниже среднего, экономьте бюджет и готовьтесь к пику' : 'спрос на среднем уровне'}.`,
    `Самые дорогие запросы ниши: ${[...benchmarks].sort((a, b) => b.cpc - a.cpc).slice(0, 3).map((b) => `${b.keyword} (${b.cpc} ₽)`).join(', ')}.`,
    `Самые «жирные» по спросу: ${[...benchmarks].sort((a, b) => b.frequency - a.frequency).slice(0, 3).map((b) => `${b.keyword} (${b.frequency}/мес)`).join(', ')}.`,
    'Ориентируйтесь на «стоимость лида», а не на CPC: снижение CTR на 1% при том же бюджете даёт −7% лидов.',
  ];

  if (source === 'sandbox') {
    insights.push('Частотность и CPC — модель MARK на основе отраслевых бенчмарков. Подключите Яндекс.Директ для фактических данных Wordstat по вашему аккаунту.');
  } else {
    insights.push('Данные частотности получены из Wordstat через API Директа — можно использовать для планирования.');
  }

  const analysis: MarketAnalysis = {
    id: randomId('market'),
    tenantId: '',
    niche: niche.name,
    regionId: options.regionId,
    regionName: region,
    keywords,
    source: source === 'api' ? 'wordstat_api' : 'benchmark_dataset',
    nicheCpc,
    yourCpc,
    gapPercent,
    verdict,
    benchmarks,
    budgetPlan: scenarios,
    competitors: niche.competitors.map((competitor) => ({
      name: competitor.name,
      domain: competitor.domain,
      note: competitor.note,
    })),
    insights,
    createdAt: new Date().toISOString(),
    simulated: source !== 'api',
  };

  log.info(`Market-анализ «${niche.name}» (${region}): ниша ${nicheCpc} ₽${yourCpc ? `, у клиента ${yourCpc} ₽ (${gapPercent}%)` : ''}`);
  return analysis;
}
