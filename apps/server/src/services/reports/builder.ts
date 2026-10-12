import type {
  AuditRun,
  BotScan,
  Campaign,
  Client,
  GeoAnalysis,
  Hypothesis,
  MarketAnalysis,
  ReportRecord,
  ReportSection,
  ReportType,
  WhiteLabel,
} from '@mark/shared';
import { addDays, formatBytes, formatMoney, percentDelta, toISODate } from '@mark/shared';
import { randomId } from '../../crypto.js';
import { repos, type Repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';
import { simulateMetrics } from '../campaigns.js';

/** Сборка отчётов: собирает данные из всех модулей в один структурированный документ. */

const log = rootLogger.child('report-builder');

export interface BuildReportOptions {
  tenantId: string;
  type: ReportType;
  clientId?: string | null;
  siteProjectId?: string | null;
  periodFrom?: string;
  periodTo?: string;
  brand?: WhiteLabel | null;
}

const TYPE_TITLES: Record<ReportType, string> = {
  seo: 'SEO-отчёт',
  geo: 'GEO-отчёт (региональный спрос)',
  bot: 'Отчёт BotShield (качество трафика)',
  market: 'Market-отчёт (CPC и бенчмарки)',
  campaigns: 'Отчёт по рекламным кампаниям',
  hypotheses: 'Отчёт по гипотезам и экспериментам',
  summary: 'Сводный отчёт',
};

export async function buildReport(options: BuildReportOptions): Promise<ReportRecord> {
  const db = await repos();
  const periodTo = options.periodTo ?? toISODate(new Date());
  const periodFrom = options.periodFrom ?? toISODate(addDays(new Date(periodTo), -30));

  const client = options.clientId ? (db.client.get(options.clientId) as unknown as Client | undefined) : undefined;
  const siteProjects = db.siteProject.list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 50 });
  const siteProject = options.siteProjectId
    ? siteProjects.find((item) => item.id === options.siteProjectId)
    : siteProjects[0];

  const audit = pickLatest<AuditRun>(db.audit.list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 20 }));
  const geo = pickLatest<GeoAnalysis>(db.geoAnalysis.list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 20 }));
  const market = pickLatest<MarketAnalysis>(db.marketAnalysis.list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 20 }));
  const botScan = pickLatest<BotScan>(db.botScan.list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 20 }));
  const campaigns = db.campaign
    .list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 100 })
    .map((item) => item as unknown as Campaign);
  const hypotheses = db.hypothesis
    .list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 200 })
    .map((item) => item as unknown as Hypothesis);
  const runs = db.scheduleRun.list({ tenantId: options.tenantId, limit: 40 });

  const sections: ReportSection[] = [];
  const kpis: ReportRecord['kpis'] = [];

  const brand = options.brand ?? (db.tenant.list({ tenantId: options.tenantId, limit: 1 })[0] as unknown as WhiteLabel | undefined) ?? null;

  /* ----------------------------- Сводка ----------------------------- */

  if (options.type === 'summary' || options.type === 'campaigns') {
    const totals = campaigns.reduce(
      (acc, campaign) => {
        const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
        acc.cost += metrics.cost;
        acc.clicks += metrics.clicks;
        acc.conversions += metrics.conversions;
        acc.impressions += metrics.impressions;
        return acc;
      },
      { cost: 0, clicks: 0, conversions: 0, impressions: 0 },
    );
    const cpa = totals.conversions ? totals.cost / totals.conversions : 0;

    const campaignSection: ReportSection = {
      id: 'campaigns',
      title: 'Рекламные кампании',
      paragraphs: [
        `За период ${periodFrom} — ${periodTo} в работе ${campaigns.length} кампаний. Общий расход — ${formatMoney(totals.cost)}, получено ${totals.clicks} кликов и ${totals.conversions} конверсий.`,
        cpa
          ? `Средняя стоимость конверсии — ${formatMoney(cpa)}. ${cpa < 2000 ? 'Показатель в пределах здорового диапазона для большинства ниш.' : 'Есть потенциал снижения: проверьте минус-слова и качество посадочных страниц.'}`
          : 'Конверсии пока не зафиксированы — проверьте настройку целей в Метрике.',
      ],
      bullets: campaigns.slice(0, 10).map((campaign) => {
        const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
        return `${campaign.name}: ${formatMoney(metrics.cost)}, кликов ${metrics.clicks}, конверсий ${metrics.conversions}, CPA ${formatMoney(metrics.cpa)}`;
      }),
      table: {
        columns: ['Кампания', 'Статус', 'Расход', 'Клики', 'CTR', 'Конверсии', 'CPA', 'ROAS'],
        rows: campaigns.map((campaign) => {
          const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
          return [
            campaign.name,
            campaign.status,
            formatMoney(metrics.cost),
            metrics.clicks,
            `${metrics.ctr}%`,
            metrics.conversions,
            formatMoney(metrics.cpa),
            metrics.roas.toFixed(2),
          ];
        }),
      },
      chart: {
        type: 'bar',
        title: 'Расход по кампаниям, ₽',
        categories: campaigns.slice(0, 10).map((campaign) => campaign.name.slice(0, 18)),
        series: [
          {
            name: 'Расход',
            data: campaigns.slice(0, 10).map((campaign) => (campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics).cost),
          },
        ],
        unit: '₽',
      },
      kpis: [
        { label: 'Расход', value: formatMoney(totals.cost) },
        { label: 'Клики', value: totals.clicks.toLocaleString('ru-RU') },
        { label: 'Конверсии', value: totals.conversions.toLocaleString('ru-RU') },
        { label: 'CPA', value: formatMoney(cpa) },
      ],
    };
    sections.push(campaignSection);
    kpis.push(...campaignSection.kpis!);
  }

  /* ------------------------------- SEO ------------------------------- */

  if ((options.type === 'summary' || options.type === 'seo') && audit) {
    const severityBullets = Object.entries(audit.summary)
      .filter(([key]) => key !== 'autoFixable')
      .map(([key, value]) => `${severityLabel(key)}: ${value}`);
    const section: ReportSection = {
      id: 'seo',
      title: 'Технический аудит и SEO',
      paragraphs: [
        `Проверено ${audit.pagesCrawled} страниц (обнаружено ${audit.pagesDiscovered}). Итоговый балл — ${audit.score}/100 (${audit.grade}).`,
        audit.score >= 80
          ? 'Сайт в хорошем техническом состоянии: базовые требования поиска выполнены.'
          : audit.score >= 60
            ? 'Есть системные замечания средней важности — их устранение даст заметный рост видимости.'
            : 'Найдены критичные проблемы: они напрямую ограничивают индексацию и ранжирование.',
        `Автоматически исправимых замечаний: ${audit.summary.autoFixable} — MARK может применить их через коннекторы сайта.`,
      ],
      bullets: [...severityBullets, ...audit.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').slice(0, 10).map((f) => `${f.title}: ${f.recommendation.slice(0, 140)}`)],
      table: {
        columns: ['Замечание', 'Важность', 'Категория', 'Автоисправление', 'Рекомендация'],
        rows: audit.findings.slice(0, 25).map((finding) => [
          finding.title,
          severityLabel(finding.severity),
          finding.category,
          finding.autoFixable ? 'да' : 'вручную',
          finding.recommendation.slice(0, 120),
        ]),
      },
      chart: {
        type: 'pie',
        title: 'Замечания по важности',
        categories: ['Критичные', 'Высокие', 'Средние', 'Низкие'],
        series: [
          {
            name: 'Количество',
            data: [audit.summary.critical, audit.summary.high, audit.summary.medium, audit.summary.low],
          },
        ],
      },
      kpis: [
        { label: 'Балл SEO', value: `${audit.score}/100`, hint: `Оценка ${audit.grade}` },
        { label: 'Страниц проверено', value: String(audit.pagesCrawled) },
        { label: 'Критичных', value: String(audit.summary.critical) },
        { label: 'Автоисправимых', value: String(audit.summary.autoFixable) },
      ],
    };
    sections.push(section);
    kpis.push(...section.kpis!);
  }

  /* ------------------------------- GEO ------------------------------- */

  if ((options.type === 'summary' || options.type === 'geo') && geo) {
    const top = geo.demandByRegion.slice(0, 10);
    const section: ReportSection = {
      id: 'geo',
      title: 'GEO: региональный спрос',
      paragraphs: [
        `Проанализировано ${geo.keywords.length} запросов по ${geo.demandByRegion.length} регионам. Суммарный спрос — ${geo.totalDemand.toLocaleString('ru-RU')} показов в месяц.`,
        top.length
          ? `Основной спрос формируют: ${top.slice(0, 5).map((r) => `${r.regionName} (${r.share}%)`).join(', ')}.`
          : 'Недостаточно данных для выделения приоритетных регионов.',
        geo.simulated
          ? 'Источник данных: демо-модель MARK (отраслевые коэффициенты). Подключите Яндекс.Директ для фактических цифр Wordstat.'
          : 'Источник данных: API Wordstat Яндекс.Директа.',
      ],
      bullets: geo.recommendations,
      table: {
        columns: ['Регион', 'Спрос/мес', 'Доля', 'CPC', 'Приоритет'],
        rows: top.map((region) => [region.regionName, region.demand.toLocaleString('ru-RU'), `${region.share}%`, formatMoney(region.cpc ?? 0), priorityLabel(region.priority)]),
      },
      chart: {
        type: 'bar',
        title: 'Спрос по регионам, показов/мес',
        categories: top.map((region) => region.regionName.slice(0, 16)),
        series: [{ name: 'Спрос', data: top.map((region) => region.demand) }],
      },
      kpis: [
        { label: 'Регионов', value: String(geo.demandByRegion.length) },
        { label: 'Спрос/мес', value: geo.totalDemand.toLocaleString('ru-RU') },
        { label: 'Лидер', value: geo.demandByRegion[0]?.regionName ?? '—' },
        { label: 'Средний CPC', value: formatMoney(geo.demandByRegion.reduce((acc, r) => acc + (r.cpc ?? 0), 0) / Math.max(geo.demandByRegion.length, 1)) },
      ],
    };
    sections.push(section);
    kpis.push(...section.kpis!);
  }

  /* ----------------------------- BotShield ----------------------------- */

  if ((options.type === 'summary' || options.type === 'bot') && botScan) {
    const totals = botScan.totals;
    const section: ReportSection = {
      id: 'bots',
      title: 'Качество трафика (BotShield)',
      paragraphs: [
        `Проанализировано ${totals.requests.toLocaleString('ru-RU')} запросов от ${totals.uniqueIps.toLocaleString('ru-RU')} уникальных адресов.`,
        `Доля «живого» трафика — ${(100 - (totals.botRequests / Math.max(totals.requests, 1)) * 100).toFixed(1)}%. Оценка чистоты трафика: ${botScan.cleanlinessScore}/100.`,
        `Боты израсходовали ${formatBytes(totals.wastedBytes)} трафика — это ≈ ${formatMoney(totals.wastedMoneyEstimate)} прямых потерь и искажение аналитики.`,
        `AI-краулеры: ${totals.aiCrawlerRequests.toLocaleString('ru-RU')} запросов. ${totals.aiCrawlerRequests > 0 ? 'Их визиты — это источник AI-видимости: разрешите ботов AI-поиска и запретите обучение LLM.' : 'AI-краулеры не обнаружены.'}`,
      ],
      bullets: botScan.recommendations.slice(0, 6).map((rec) => `${rec.title}: ${rec.detail.slice(0, 180)}`),
      table: {
        columns: ['Адрес', 'Классификация', 'Запросов', 'Оценка человека', 'Причины'],
        rows: botScan.topIps.slice(0, 20).map((verdict) => [
          verdict.ip,
          verdict.classification,
          verdict.requests,
          `${verdict.humanScore}/100`,
          verdict.reasons.slice(0, 2).join('; ').slice(0, 140),
        ]),
      },
      chart: {
        type: 'line',
        title: 'Трафик по дням: люди vs боты',
        categories: botScan.series.map((point) => point.date),
        series: [
          { name: 'Люди', data: botScan.series.map((point) => point.human) },
          { name: 'Поисковые боты', data: botScan.series.map((point) => point.bots) },
          { name: 'AI-краулеры', data: botScan.series.map((point) => point.ai) },
          { name: 'Подозрительные', data: botScan.series.map((point) => point.suspicious) },
        ],
      },
      kpis: [
        { label: 'Чистота трафика', value: `${botScan.cleanlinessScore}/100` },
        { label: 'Запросов', value: totals.requests.toLocaleString('ru-RU') },
        { label: 'Подозрительных', value: totals.suspiciousRequests.toLocaleString('ru-RU') },
        { label: 'Потери', value: formatMoney(totals.wastedMoneyEstimate) },
      ],
    };
    sections.push(section);
    kpis.push(...section.kpis!);
  }

  /* ------------------------------- Market ------------------------------- */

  if ((options.type === 'summary' || options.type === 'market') && market) {
    const section: ReportSection = {
      id: 'market',
      title: 'Market: бенчмарки CPC и бюджет',
      paragraphs: [
        `Ниша «${market.niche}», регион ${market.regionName}. Средний CPC по рынку — ${formatMoney(market.nicheCpc)}${market.yourCpc ? `, ваш CPC — ${formatMoney(market.yourCpc)} (отклонение ${market.gapPercent}%)` : ''}.`,
        market.verdict,
      ],
      bullets: market.insights,
      table: {
        columns: ['Сценарий', 'Бюджет/день', 'Кликов/мес', 'Конверсий/мес', 'CPA', 'Комментарий'],
        rows: market.budgetPlan.map((plan) => [
          plan.scenario,
          formatMoney(plan.dailyBudget),
          plan.clicks.toLocaleString('ru-RU'),
          plan.conversions.toLocaleString('ru-RU'),
          formatMoney(plan.cpa),
          plan.note,
        ]),
      },
      chart: {
        type: 'bar',
        title: 'CPC по ключевым запросам, ₽',
        categories: market.benchmarks.slice(0, 10).map((benchmark) => benchmark.keyword.slice(0, 18)),
        series: [{ name: 'CPC', data: market.benchmarks.slice(0, 10).map((benchmark) => benchmark.cpc) }],
        unit: '₽',
      },
      kpis: [
        { label: 'CPC рынка', value: formatMoney(market.nicheCpc) },
        { label: 'Ваш CPC', value: market.yourCpc ? formatMoney(market.yourCpc) : '—' },
        { label: 'Отклонение', value: market.gapPercent !== null ? `${market.gapPercent}%` : '—' },
        { label: 'Запросов в анализе', value: String(market.benchmarks.length) },
      ],
    };
    sections.push(section);
    kpis.push(...section.kpis!);
  }

  /* ----------------------------- Гипотезы ----------------------------- */

  if (options.type === 'summary' || options.type === 'hypotheses') {
    const running = hypotheses.filter((hypothesis) => hypothesis.status === 'running');
    const done = hypotheses.filter((hypothesis) => hypothesis.status === 'done');
    const avgIce = hypotheses.length ? hypotheses.reduce((acc, hypothesis) => acc + hypothesis.ice, 0) / hypotheses.length : 0;
    const section: ReportSection = {
      id: 'hypotheses',
      title: 'Гипотезы роста и эксперименты',
      paragraphs: [
        `Всего гипотез: ${hypotheses.length}. В работе: ${running.length}, завершено: ${done.length}. Средний ICE-приоритет — ${avgIce.toFixed(1)}/100.`,
        'Приоритет считается как ICE (Impact × Confidence × Ease): в первую очередь берём гипотезы с высоким ICE и низкой трудоёмкостью.',
      ],
      bullets: hypotheses.slice(0, 12).map((hypothesis) => `[${hypothesis.ice}] ${hypothesis.title} — ожидаем +${hypothesis.expectedEffectPct}% к «${hypothesis.metric}», статус: ${hypothesis.status}`),
      table: {
        columns: ['Гипотеза', 'ICE', 'Метрика', 'Эффект', 'Статус', 'Выборка на вариант'],
        rows: hypotheses.slice(0, 25).map((hypothesis) => [
          hypothesis.title.slice(0, 70),
          hypothesis.ice,
          hypothesis.metric,
          `+${hypothesis.expectedEffectPct}%`,
          hypothesis.status,
          hypothesis.testPlan.minSamplePerVariant.toLocaleString('ru-RU'),
        ]),
      },
      kpis: [
        { label: 'Гипотез всего', value: String(hypotheses.length) },
        { label: 'В работе', value: String(running.length) },
        { label: 'Завершено', value: String(done.length) },
        { label: 'Средний ICE', value: avgIce.toFixed(1) },
      ],
    };
    sections.push(section);
    kpis.push(...section.kpis!);
  }

  /* --------------------------- Автооптимизация --------------------------- */

  if (runs.length) {
    const applied = runs.filter((run) => run.status === 'done');
    const totalChanges = applied.reduce((acc, run) => acc + Number(run.changed ?? 0), 0);
    sections.push({
      id: 'automation',
      title: 'Работа автооптимизации',
      paragraphs: [
        `За период выполнено ${applied.length} запусков автоматических правил, применено ${totalChanges} изменений.`,
        'Правила работают по расписанию (cron): двигают ставки, останавливают неэффективные фразы, перераспределяют бюджет и присылают уведомления.',
      ],
      bullets: runs.slice(0, 10).map((run) => `${run.ruleName ?? 'правило'}: ${run.summary ?? ''} (${run.status})`),
      table: {
        columns: ['Правило', 'Статус', 'Запуск', 'Изменений', 'Итог'],
        rows: runs.slice(0, 20).map((run) => [
          String(run.ruleName ?? ''),
          String(run.status ?? ''),
          String(run.startedAt ?? '').slice(0, 16).replace('T', ' '),
          Number(run.changed ?? 0),
          String(run.summary ?? '').slice(0, 120),
        ]),
      },
    });
  }

  if (!sections.length) {
    sections.push({
      id: 'empty',
      title: 'Данных пока нет',
      paragraphs: [
        'Для выбранного клиента ещё не выполнялись аудит, GEO-анализ, бот-анализ или сбор кампаний.',
        'Запустите любую задачу в MARK (Аудит сайта, GEO-анализ, BotShield, Market Analyzer) — и отчёт наполнится автоматически.',
      ],
      bullets: ['Совет: откройте раздел «Кампании» → «Автоматизация» и включите планировщик: отчёты будут собираться и отправляться сами.'],
    });
  }

  const priorPeriod = db.report
    .list({ tenantId: options.tenantId, clientId: options.clientId ?? undefined, limit: 50 })
    .find((item) => (item as { type?: string }).type === options.type && item.status === 'done');

  const record: ReportRecord = {
    id: randomId('rep'),
    tenantId: options.tenantId,
    clientId: options.clientId ?? null,
    siteProjectId: siteProject?.id ?? null,
    type: options.type,
    title: `${TYPE_TITLES[options.type]}${client ? ` — ${client.name}` : ''} · ${periodFrom} — ${periodTo}`,
    status: 'queued',
    periodFrom,
    periodTo,
    createdAt: new Date().toISOString(),
    generatedAt: null,
    filePath: null,
    fileSizeBytes: null,
    sections,
    kpis,
    branding: {
      agencyName: brand?.agencyName ?? 'MARK',
      brandColor: brand?.brandColor ?? '#2563eb',
      accentColor: brand?.accentColor ?? '#0ea5e9',
      logoDataUrl: brand?.logoDataUrl ?? null,
      footerNote: brand?.footerNote ?? null,
      hideMarkBranding: brand?.hideMarkBranding ?? false,
    },
    delivery: [],
    dataSnapshot: {
      auditScore: audit?.score ?? null,
      geoDemand: geo?.totalDemand ?? null,
      botCleanliness: botScan?.cleanlinessScore ?? null,
      marketCpc: market?.nicheCpc ?? null,
      campaigns: campaigns.length,
      hypotheses: hypotheses.length,
      previousReportId: priorPeriod?.id ?? null,
    },
  };

  // Сравнение с прошлым периодом в KPI (если были данные)
  if (priorPeriod) {
    const previousKpis = (priorPeriod as unknown as ReportRecord).kpis ?? [];
    for (const kpi of record.kpis) {
      const previous = previousKpis.find((item) => item.label === kpi.label);
      if (!previous) continue;
      const parse = (value: string) => Number(String(value).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.')) || 0;
      const delta = percentDelta(parse(kpi.value), parse(previous.value));
      if (Number.isFinite(delta) && Math.abs(delta) > 0.5) kpi.delta = delta;
    }
  }

  log.info(`Отчёт собран: ${record.type}, секций ${sections.length}, KPI ${kpis.length}`);
  return record;
}

function pickLatest<T>(items: { id: string }[]): T | null {
  if (!items.length) return null;
  return items[0] as unknown as T;
}

function severityLabel(severity: string): string {
  const map: Record<string, string> = {
    critical: 'Критичные',
    high: 'Высокие',
    medium: 'Средние',
    low: 'Низкие',
    info: 'Информационные',
  };
  return map[severity] ?? severity;
}

function priorityLabel(priority: string): string {
  const map: Record<string, string> = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
  return map[priority] ?? priority;
}
