import type { AuditRun, BotScan, GeoAnalysis, Hypothesis, MarketAnalysis, MetricId } from '@mark/shared';
import { iceScore, sampleSizeForLift, twoProportionZTest, welchTTest } from '@mark/shared';
import { randomId } from '../crypto.js';
import { rootLogger } from '../logger.js';

/**
 * Генерация и расчёт гипотез роста.
 *
 * Источники гипотез: аудит сайта, бот-отчёт, GEO-анализ, Market-анализ и ручной ввод.
 * Каждая гипотеза получает ICE-приоритет, план A/B-теста и минимальный размер выборки.
 */

const log = rootLogger.child('hypotheses');

interface Draft {
  title: string;
  statement: string;
  metric: MetricId;
  expectedEffectPct: number;
  effort: number;
  confidence: number;
  source: Hypothesis['source'];
  sourceRef?: string;
  tags: string[];
}

const FINDING_TO_HYPOTHESIS: Record<string, Draft> = {
  'title-missing': {
    title: 'Переписать title главной с ключом и городом',
    statement: 'Если добавить в title ключевой запрос и город, CTR в поиске вырастет, а позиция по коммерческим запросам поднимется.',
    metric: 'ctr',
    expectedEffectPct: 12,
    effort: 1,
    confidence: 4,
    source: 'audit',
    tags: ['seo', 'title', 'быстрый-выигрыш'],
  },
  'title-too-long': {
    title: 'Сократить title до 60 символов',
    statement: 'Если убрать «хвосты» за 60 символов, сниппет перестанет обрезаться и ключи не потеряются.',
    metric: 'ctr',
    expectedEffectPct: 6,
    effort: 1,
    confidence: 4,
    source: 'audit',
    tags: ['seo', 'title'],
  },
  'description-missing': {
    title: 'Написать описания с оффером',
    statement: 'Если добавить description с выгодой и призывом, вырастет CTR из поиска при том же ранге.',
    metric: 'ctr',
    expectedEffectPct: 8,
    effort: 1,
    confidence: 4,
    source: 'audit',
    tags: ['seo', 'snippet'],
  },
  'no-local-schema': {
    title: 'Добавить разметку LocalBusiness с гео-данными',
    statement: 'Если разметить организацию (адрес, телефон, координаты, зона обслуживания), вырастет попадание в локальный блок и карточки.',
    metric: 'traffic',
    expectedEffectPct: 14,
    effort: 2,
    confidence: 4,
    source: 'audit',
    tags: ['geo', 'schema'],
  },
  'no-faq-schema': {
    title: 'Добавить FAQ-блок с разметкой',
    statement: 'Если собрать реальные вопросы клиентов и ответить на них в FAQ с разметкой, возрастёт шанс попасть в AI-ответы и расширенный сниппет.',
    metric: 'traffic',
    expectedEffectPct: 11,
    effort: 2,
    confidence: 3,
    source: 'audit',
    tags: ['geo-ai', 'контент'],
  },
  'no-llms-txt': {
    title: 'Опубликовать llms.txt для AI-поиска',
    statement: 'Если дать LLM карту сайта, увеличится частота цитирования и переходов из AI-ответов.',
    metric: 'traffic',
    expectedEffectPct: 7,
    effort: 1,
    confidence: 3,
    source: 'audit',
    tags: ['geo-ai'],
  },
  'slow-ttfb': {
    title: 'Ускорить ответ сервера до 400 мс',
    statement: 'Если включить кэширование и оптимизировать бэкенд, TTFB упадёт, показатель отказов снизится и позиции подрастут.',
    metric: 'bounce',
    expectedEffectPct: 9,
    effort: 3,
    confidence: 4,
    source: 'audit',
    tags: ['скорость', 'core-web-vitals'],
  },
  'many-scripts': {
    title: 'Отложить некритичные скрипты',
    statement: 'Если перенести счётчики и виджеты в defer, LCP улучшится и конверсия вырастет.',
    metric: 'cr',
    expectedEffectPct: 7,
    effort: 2,
    confidence: 3,
    source: 'audit',
    tags: ['скорость', 'конверсия'],
  },
  'images-no-alt': {
    title: 'Заполнить alt у изображений',
    statement: 'Если указать alt с ключами, трафик из поиска по картинкам и понимание страницы ИИ-моделями улучшатся.',
    metric: 'traffic',
    expectedEffectPct: 4,
    effort: 1,
    confidence: 4,
    source: 'audit',
    tags: ['картинки', 'доступность'],
  },
  'mixed-content': {
    title: 'Убрать смешанный контент',
    statement: 'Если перевести ресурсы на https, браузер перестанет блокировать и помечать сайт как небезопасный.',
    metric: 'bounce',
    expectedEffectPct: 5,
    effort: 2,
    confidence: 5,
    source: 'audit',
    tags: ['безопасность'],
  },
  'thin-content': {
    title: 'Расширить контент ключевых страниц',
    statement: 'Если усилить страницы фактами, ценами и кейсами, они начнут ранжироваться выше и чаще цитироваться.',
    metric: 'positions',
    expectedEffectPct: 15,
    effort: 4,
    confidence: 3,
    source: 'audit',
    tags: ['контент', 'seo'],
  },
  'duplicate-title': {
    title: 'Уникализировать title на похожих страницах',
    statement: 'Если развести заголовки по интенту, исчезнет каннибализация и каждая страница соберёт свои запросы.',
    metric: 'positions',
    expectedEffectPct: 10,
    effort: 2,
    confidence: 4,
    source: 'audit',
    tags: ['seo', 'индексация'],
  },
};

export interface GenerateOptions {
  audit?: AuditRun | null;
  botScan?: BotScan | null;
  geo?: GeoAnalysis | null;
  market?: MarketAnalysis | null;
  count?: number;
  niche?: string;
  siteName?: string;
}

export function generateHypotheses(options: GenerateOptions): Draft[] {
  const drafts: Draft[] = [];
  const push = (draft: Draft) => {
    if (!drafts.some((item) => item.title === draft.title)) drafts.push(draft);
  };

  // 1. Из аудита
  for (const finding of options.audit?.findings ?? []) {
    const template = FINDING_TO_HYPOTHESIS[finding.code];
    if (template) {
      push({ ...template, sourceRef: finding.id ?? finding.code, statement: `${template.statement} (причина: ${finding.title.toLowerCase()})` });
    } else if (finding.autoFixable && finding.severity !== 'low' && finding.severity !== 'info') {
      push({
        title: finding.recommendation.slice(0, 90),
        statement: `Обнаружено: ${finding.evidence}. Ожидаем эффект за счёт устранения проблемы «${finding.title}».`,
        metric: finding.category === 'speed' ? 'bounce' : finding.category === 'geo' ? 'traffic' : 'positions',
        expectedEffectPct: finding.severity === 'critical' ? 12 : finding.severity === 'high' ? 9 : 5,
        effort: finding.autoFixable ? 2 : 4,
        confidence: finding.severity === 'critical' ? 5 : 3,
        source: 'audit',
        sourceRef: finding.code,
        tags: [finding.category],
      });
    }
  }

  // 2. Из BotShield
  if (options.botScan) {
    const suspiciousShare = options.botScan.totals.suspiciousRequests / Math.max(options.botScan.totals.requests, 1);
    if (suspiciousShare > 0.1) {
      push({
        title: 'Отфильтровать ботов для точности аналитики',
        statement: `Если исключить ${Math.round(suspiciousShare * 100)}% «мусорного» трафика, метрики конверсии станут реальными, а решения по рекламе — обоснованными.`,
        metric: 'cr',
        expectedEffectPct: 9,
        effort: 3,
        confidence: 4,
        source: 'bot',
        tags: ['botshield', 'аналитика'],
      });
    }
    if (options.botScan.totals.aiCrawlerRequests > 50) {
      push({
        title: 'Разрешить AI-поиск и запретить обучение LLM',
        statement: 'Если разрешить ботов AI-поиска (OAI-SearchBot, PerplexityBot) и закрыть GPTBot/CCBot, вырастут переходы из AI-ответов без затрат на трафик обучения.',
        metric: 'traffic',
        expectedEffectPct: 8,
        effort: 1,
        confidence: 3,
        source: 'bot',
        tags: ['geo-ai', 'robots'],
      });
    }
    if (options.botScan.totals.wastedBytes > 512 * 1024 * 1024) {
      push({
        title: 'Включить rate limit и блокировки по ASN',
        statement: 'Если ограничить частоту для датацентров, снизится нагрузка на сервер и расход трафика.',
        metric: 'cr',
        expectedEffectPct: 6,
        effort: 3,
        confidence: 4,
        source: 'bot',
        tags: ['botshield', 'инфраструктура'],
      });
    }
  }

  // 3. Из GEO
  if (options.geo && options.geo.demandByRegion.length > 1) {
    const top = options.geo.demandByRegion[0]!;
    push({
      title: `Создать региональную страницу под ${top.regionName}`,
      statement: `Если выделить страницу с городом в title/H1/тексте, вырастет видимость по гео-запросам: спрос в регионе — ${top.demand.toLocaleString('ru-RU')} показов/мес.`,
      metric: 'traffic',
      expectedEffectPct: 13,
      effort: 3,
      confidence: 4,
      source: 'geo',
      tags: ['geo', 'региональные-страницы'],
    });
    const cheap = [...options.geo.demandByRegion].sort((a, b) => (a.cpc ?? 0) - (b.cpc ?? 0))[0];
    if (cheap) {
      push({
        title: `Тестировать рекламу в регионе ${cheap.regionName} (CPC ${cheap.cpc ?? '—'} ₽)`,
        statement: 'Если перенести часть бюджета туда, где клик дешевле, стоимость заявки снизится при том же объёме.',
        metric: 'cpl',
        expectedEffectPct: 18,
        effort: 2,
        confidence: 4,
        source: 'geo',
        tags: ['geo', 'реклама', 'бюджет'],
      });
    }
  }

  // 4. Из Market Analyzer
  if (options.market) {
    const gap = options.market.gapPercent ?? 0;
    if (gap > 15) {
      push({
        title: 'Снизить CPC до уровня бенчмарка ниши',
        statement: `Ваш CPC выше рынка на ${gap}%. Если ужесточить семантику, добавить минус-слова и переписать объявления, стоимость клика упадёт.`,
        metric: 'cpa',
        expectedEffectPct: Math.min(25, Math.round(gap * 0.7)),
        effort: 3,
        confidence: 4,
        source: 'market',
        tags: ['реклама', 'ставки'],
      });
    }
    const best = [...options.market.benchmarks].sort((a, b) => b.clicksEstimate - a.clicksEstimate)[0];
    if (best) {
      push({
        title: `Собрать отдельную группу под «${best.keyword}»`,
        statement: `Запрос даёт ≈${best.clicksEstimate} кликов/мес при CPC ${best.cpc} ₽. Отдельная группа повысит релевантность и CTR.`,
        metric: 'ctr',
        expectedEffectPct: 10,
        effort: 2,
        confidence: 4,
        source: 'market',
        tags: ['реклама', 'семантика'],
      });
    }
  }

  // 5. Универсальные быстрые выигрыши (если источников мало)
  const evergreen: Draft[] = [
    {
      title: 'Добавить квиз-калькулятор стоимости',
      statement: 'Если дать посетителю посчитать цену за 30 секунд, вырастет конверсия в заявку при том же трафике.',
      metric: 'cr',
      expectedEffectPct: 16,
      effort: 3,
      confidence: 3,
      source: 'library',
      tags: ['конверсия', 'лендинг'],
    },
    {
      title: 'Вынести форму заявки на первый экран',
      statement: 'Если сократить путь до заявки, уменьшится отток и вырастет CR.',
      metric: 'cr',
      expectedEffectPct: 12,
      effort: 2,
      confidence: 4,
      source: 'library',
      tags: ['конверсия', 'ux'],
    },
    {
      title: 'Добавить социальные доказательства к первому экрану',
      statement: 'Если показать отзывы с именами и цифрами (сроки, объёмы), вырастет доверие и конверсия.',
      metric: 'cr',
      expectedEffectPct: 9,
      effort: 1,
      confidence: 4,
      source: 'library',
      tags: ['конверсия', 'доверие'],
    },
    {
      title: 'Добавить онлайн-чат с автоответом',
      statement: 'Если отвечать на вопрос в момент сомнения, часть уходящих посетителей вернётся в воронку.',
      metric: 'cr',
      expectedEffectPct: 8,
      effort: 2,
      confidence: 3,
      source: 'library',
      tags: ['конверсия', 'коммуникации'],
    },
    {
      title: 'Тестировать другой заголовок первого экрана',
      statement: 'Если заменить заголовок на выгоду клиента вместо описания компании, вырастет вовлечённость.',
      metric: 'cr',
      expectedEffectPct: 7,
      effort: 1,
      confidence: 3,
      source: 'library',
      tags: ['конверсия', 'копирайтинг'],
    },
    {
      title: 'Проверить мобильную версию формы',
      statement: 'Если адаптировать поля под палец и убрать лишние шаги, на мобильных вырастет конверсия.',
      metric: 'cr',
      expectedEffectPct: 10,
      effort: 2,
      confidence: 4,
      source: 'library',
      tags: ['мобильные', 'конверсия'],
    },
  ];
  for (const item of evergreen) push(item);

  const limited = drafts.slice(0, options.count ?? 8);
  log.info(`Сгенерировано гипотез: ${limited.length}`);
  return limited;
}

export function toHypothesis(draft: Draft, ids: { tenantId: string; clientId?: string | null; siteProjectId?: string | null; campaignId?: string | null }): Hypothesis {
  const now = new Date().toISOString();
  const baselineRate = 0.03;
  const sample = sampleSizeForLift(baselineRate, draft.expectedEffectPct / 100);
  const hypothesis: Hypothesis = {
    id: randomId('hyp'),
    tenantId: ids.tenantId,
    clientId: ids.clientId ?? null,
    siteProjectId: ids.siteProjectId ?? null,
    campaignId: ids.campaignId ?? null,
    source: draft.source,
    sourceRef: draft.sourceRef ?? null,
    title: draft.title,
    statement: draft.statement,
    metric: draft.metric,
    expectedEffectPct: draft.expectedEffectPct,
    effort: draft.effort,
    confidence: draft.confidence,
    ice: iceScore({ expectedEffectPct: draft.expectedEffectPct, effort: draft.effort, confidence: draft.confidence }),
    priority: Math.round(iceScore({ expectedEffectPct: draft.expectedEffectPct, effort: draft.effort, confidence: draft.confidence })),
    status: 'backlog',
    testPlan: {
      design: 'ab',
      metric: draft.metric,
      successCriteria: `${metricLabel(draft.metric)} вырастет минимум на ${Math.max(5, Math.round(draft.expectedEffectPct * 0.6))}% при достоверности 95%`,
      minSamplePerVariant: sample,
      durationDays: Math.max(7, Math.ceil((sample * 2) / 300)),
      trafficSplit: [50, 50],
      trafficSource: 'Яндекс.Метрика / GA4 (эксперименты)',
    },
    tags: draft.tags,
    createdAt: now,
    updatedAt: now,
  };
  return hypothesis;
}

export function metricLabel(metric: MetricId): string {
  const map: Record<MetricId, string> = {
    ctr: 'CTR',
    cr: 'Конверсия сайта',
    cpl: 'Стоимость лида',
    cpa: 'Стоимость заявки',
    roas: 'ROAS',
    positions: 'Позиции в поиске',
    traffic: 'Трафик',
    bounce: 'Показатель отказов',
    aov: 'Средний чек',
    revenue: 'Выручка',
  };
  return map[metric] ?? metric;
}

/* --------------------------- Расчёт эксперимента --------------------------- */

export interface ExperimentObservation {
  variant: string;
  visitors: number;
  conversions: number;
  /** Опционально: значения метрики для t-теста (выручка, чек) */
  values?: number[];
}

export interface ExperimentResult {
  status: 'running' | 'winner' | 'no_difference' | 'insufficient_data';
  control: { variant: string; rate: number; visitors: number; conversions: number };
  variant: { variant: string; rate: number; visitors: number; conversions: number };
  z: number;
  pValue: number;
  liftPercent: number;
  significant: boolean;
  sampleReached: boolean;
  requiredSample: number;
  recommendations: string[];
  tTest?: { t: number; pValue: number; liftPercent: number; significant: boolean };
}

export function evaluateExperiment(
  observations: ExperimentObservation[],
  options: { baselineRate?: number; expectedLiftPercent?: number; alpha?: number } = {},
): ExperimentResult {
  const alpha = options.alpha ?? 0.05;
  const sorted = [...observations].sort((a, b) => a.variant.localeCompare(b.variant));
  const control = sorted.find((item) => /control|контроль|a$/i.test(item.variant)) ?? sorted[0];
  const variant = sorted.find((item) => item !== control) ?? sorted[1];

  if (!control || !variant) {
    throw new Error('Нужны данные минимум по двум вариантам эксперимента');
  }

  const controlRate = control.visitors ? control.conversions / control.visitors : 0;
  const variantRate = variant.visitors ? variant.conversions / variant.visitors : 0;
  const test = twoProportionZTest(
    { visitors: control.visitors, conversions: control.conversions },
    { visitors: variant.visitors, conversions: variant.conversions },
    alpha,
  );

  const baseline = options.baselineRate ?? (controlRate || 0.03);
  const requiredSample = sampleSizeForLift(baseline, (options.expectedLiftPercent ?? 10) / 100);
  const sampleReached = control.visitors >= requiredSample && variant.visitors >= requiredSample;

  let tTest: ExperimentResult['tTest'];
  if (control.values?.length && variant.values?.length) {
    const result = welchTTest(control.values, variant.values, alpha);
    tTest = { t: result.t, pValue: result.pValue, liftPercent: result.liftPercent, significant: result.significant };
  }

  const recommendations: string[] = [];
  if (!sampleReached) {
    const need = Math.max(0, requiredSample - Math.min(control.visitors, variant.visitors));
    recommendations.push(
      `Данных пока недостаточно: до минимальной выборки нужно ещё ≈${need.toLocaleString('ru-RU')} посетителей на вариант (по ${requiredSample.toLocaleString('ru-RU')} на каждый).`,
    );
  }
  if (test.significant && test.liftPercent > 0) {
    recommendations.push(`Вариант «${variant.variant}» побеждает с приростом ${test.liftPercent}% (p = ${test.pValue}). Внедряйте на 100% трафика.`);
    recommendations.push('Зафиксируйте результат в базе знаний и сформулируйте следующую гипотезу на базе этого выигрыша.');
  } else if (test.significant && test.liftPercent < 0) {
    recommendations.push(`Вариант «${variant.variant}» ухудшил метрику на ${Math.abs(test.liftPercent)}% — откатите изменения. Отрицательный результат тоже результат: зафиксируйте причину.`);
  } else {
    recommendations.push('Статистически значимой разницы нет. Проверьте размер эффекта: возможно, изменение слишком слабое, чтобы его заметить.');
    recommendations.push('Попробуйте более сильный вариант (крупный оффер, другая механика), либо переключитесь на гипотезу с большим ожидаемым эффектом.');
  }
  if (!sampleReached) {
    recommendations.push('Не принимайте решение до окончания теста — иначе получите ложный результат.');
  }

  const status: ExperimentResult['status'] = !sampleReached && !test.significant
    ? 'insufficient_data'
    : test.significant
      ? 'winner'
      : 'no_difference';

  return {
    status,
    control: { variant: control.variant, rate: Number((controlRate * 100).toFixed(3)), visitors: control.visitors, conversions: control.conversions },
    variant: { variant: variant.variant, rate: Number((variantRate * 100).toFixed(3)), visitors: variant.visitors, conversions: variant.conversions },
    z: test.z,
    pValue: test.pValue,
    liftPercent: test.liftPercent,
    significant: test.significant,
    sampleReached,
    requiredSample,
    recommendations,
    tTest,
  };
}
