import { Router } from 'express';
import {
  campaignCreateSchema,
  campaignPatchSchema,
  hypothesisGenerateSchema,
  hypothesisSchema,
  orchestrateSchema,
  reportHistoryQuerySchema,
  reportRequestSchema,
  scheduleRunSchema,
  scheduleRuleSchema,
  type Campaign,
  type Hypothesis,
  type ReportRecord,
  type ScheduleRule,
  type ScheduleRun,
} from '@mark/shared';
import { randomId } from '../crypto.js';
import { config } from '../config.js';
import { repos } from '../db/repos.js';
import { ApiError, ah, currentTenantId, ok, parseBody } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';
import {
  DirectClient,
  campaignWarnings,
  getDirectCredentials,
  listCampaigns,
  simulateMetrics,
  suggestBids,
  syncCampaignStats,
} from '../services/campaigns.js';
import { generateHypotheses, evaluateExperiment, toHypothesis } from '../services/hypotheses.js';
import { buildReport } from '../services/reports/builder.js';
import { renderReportCsv, renderReportHtml, renderReportPdf, saveReportHtml } from '../services/reports/renderer.js';
import { describeCron, defaultRules, runRule, scheduler, validateCron } from '../services/scheduler.js';
import { orchestrate } from '../services/orchestrator.js';

/** Маршруты операций: гипотезы, кампании, автооптимизация, отчёты, оркестрация. */

const log = rootLogger.child('routes.ops');
export const opsRouter = Router();

/* ------------------------------ Гипотезы ------------------------------ */

opsRouter.get(
  '/hypotheses',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const items = db.hypothesis
      .list({ tenantId, clientId: (req.query.clientId as string) || undefined, status: (req.query.status as string) || undefined, limit: Number(req.query.limit ?? 200) })
      .map((item) => item as unknown as Hypothesis)
      .sort((a, b) => b.ice - a.ice);
    ok(res, {
      items,
      stats: {
        total: items.length,
        byStatus: items.reduce<Record<string, number>>((acc, item) => {
          acc[item.status] = (acc[item.status] ?? 0) + 1;
          return acc;
        }, {}),
        avgIce: items.length ? items.reduce((acc, item) => acc + item.ice, 0) / items.length : 0,
        expectedLift: items.filter((i) => i.status === 'done').reduce((acc, item) => acc + item.expectedEffectPct, 0),
      },
    });
  }),
);

opsRouter.post(
  '/hypotheses',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(hypothesisSchema, req.body);
    const db = await repos();
    const hypothesis = toHypothesis(
      {
        title: input.title,
        statement: input.statement,
        metric: input.metric,
        expectedEffectPct: input.expectedEffectPct,
        effort: input.effort,
        confidence: input.confidence,
        source: input.source,
        sourceRef: input.sourceRef ?? undefined,
        tags: input.tags,
      },
      { tenantId, clientId: input.clientId ?? null, siteProjectId: input.siteProjectId ?? null, campaignId: input.campaignId ?? null },
    );
    const merged: Hypothesis = {
      ...hypothesis,
      testPlan: { ...hypothesis.testPlan, ...input.testPlan, metric: input.testPlan.metric ?? hypothesis.testPlan.metric },
      status: input.status,
      priority: input.priority || hypothesis.priority,
    };
    ok(res, db.hypothesis.put(merged as never), 201);
  }),
);

opsRouter.patch(
  '/hypotheses/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.hypothesis.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    const patch = parseBody(hypothesisSchema.partial(), req.body);
    ok(res, db.hypothesis.patch(current.id, patch as never));
  }),
);

opsRouter.delete(
  '/hypotheses/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.hypothesis.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    db.hypothesis.delete(current.id);
    ok(res, { deleted: current.id });
  }),
);

/** Автогенерация гипотез из аудита, GEO, Market и BotShield. */
opsRouter.post(
  '/hypotheses/generate',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(hypothesisGenerateSchema, req.body);
    const db = await repos();
    const audit = input.auditId
      ? db.audit.get(input.auditId)
      : db.audit.list({ tenantId, clientId: input.clientId ?? undefined, limit: 1 })[0];
    const botScan = input.botScanId
      ? db.botScan.get(input.botScanId)
      : db.botScan.list({ tenantId, clientId: input.clientId ?? undefined, limit: 1 })[0];
    const geo = db.geoAnalysis.list({ tenantId, clientId: input.clientId ?? undefined, limit: 1 })[0];
    const market = db.marketAnalysis.list({ tenantId, clientId: input.clientId ?? undefined, limit: 1 })[0];
    const site = input.siteProjectId
      ? db.siteProject.get(input.siteProjectId)
      : db.siteProject.list({ tenantId, clientId: input.clientId ?? undefined, limit: 1 })[0];

    const drafts = generateHypotheses({
      audit: audit as never,
      botScan: botScan as never,
      geo: geo as never,
      market: market as never,
      count: input.count,
      niche: input.niche,
      siteName: String(site?.name ?? ''),
    });

    const created = drafts.map((draft) =>
      db.hypothesis.put(
        toHypothesis(draft, {
          tenantId,
          clientId: input.clientId ?? null,
          siteProjectId: site?.id ?? null,
        }) as never,
      ),
    );
    db.events.log({ tenantId, type: 'hypotheses', level: 'info', message: `Сгенерировано гипотез: ${created.length}`, payload: { source: apiSourceLabel(input.auditId, botScan?.id) } });
    ok(res, { created, drafts: drafts.length }, 201);
  }),
);

function apiSourceLabel(auditId?: string | null, scanId?: unknown) {
  return auditId ? 'audit' : scanId ? 'bot' : 'library';
}

/** Старт теста: перевод гипотезы в «в работе» с расчётом выборки. */
opsRouter.post(
  '/hypotheses/:id/start-test',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.hypothesis.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    const hypothesis = current as unknown as Hypothesis;
    const updated = db.hypothesis.patch(current.id, {
      status: 'running',
      testPlan: {
        ...hypothesis.testPlan,
        trafficSource: String(req.body?.trafficSource ?? hypothesis.testPlan.trafficSource ?? 'Яндекс.Метрика / эксперименты'),
      },
    } as never);
    db.experiment.put({
      id: randomId('exp'),
      tenantId,
      clientId: hypothesis.clientId ?? null,
      hypothesisId: hypothesis.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      plan: hypothesis.testPlan,
      observations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    ok(res, updated);
  }),
);

/** Внесение результатов теста и статистическая оценка (z-тест / t-тест). */
opsRouter.post(
  '/hypotheses/:id/evaluate',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.hypothesis.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    const observations = (req.body?.observations ?? []) as { variant: string; visitors: number; conversions: number; values?: number[] }[];
    if (observations.length < 2) throw new ApiError(422, 'Передайте данные минимум по двум вариантам: control и variant');
    const hypothesis = current as unknown as Hypothesis;
    const result = evaluateExperiment(observations, {
      expectedLiftPercent: hypothesis.expectedEffectPct,
      baselineRate: Number(req.body?.baselineRate ?? 0.03),
    });
    db.experiment.put({
      id: randomId('exp'),
      tenantId,
      clientId: hypothesis.clientId ?? null,
      hypothesisId: hypothesis.id,
      status: result.status,
      finishedAt: new Date().toISOString(),
      plan: hypothesis.testPlan,
      observations,
      result,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    if (result.status === 'winner') {
      db.hypothesis.patch(hypothesis.id, { status: 'done' } as never);
    } else if (result.status === 'no_difference' && result.sampleReached) {
      db.hypothesis.patch(hypothesis.id, { status: 'rejected' } as never);
    }
    ok(res, result);
  }),
);

/* ------------------------------ Кампании ------------------------------ */

opsRouter.get(
  '/campaigns',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const items = await listCampaigns(tenantId, (req.query.clientId as string) || undefined);
    const enriched = items.map((campaign) => ({ ...campaign, warnings: campaignWarnings(campaign) }));
    const totals = enriched.reduce(
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
    ok(res, {
      items: enriched,
      totals: { ...totals, cpa: totals.conversions ? totals.cost / totals.conversions : 0, ctr: totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0 },
    });
  }),
);

opsRouter.post(
  '/campaigns',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(campaignCreateSchema, req.body);
    const db = await repos();
    const { metrics, trend } = simulateMetrics({ id: randomId('cmp'), dailyBudget: input.dailyBudget, keywords: input.keywords } as unknown as Campaign, 30);
    const campaign = db.campaign.put({
      id: randomId('cmp'),
      tenantId,
      clientId: input.clientId ?? null,
      siteProjectId: input.siteProjectId ?? null,
      accountId: input.accountId ?? null,
      serviceId: input.channel === 'google_ads' ? 'google-ads' : input.channel === 'vk_ads' ? 'vk-ads' : 'yandex-direct',
      externalId: req.body?.externalId ?? null,
      name: input.name,
      channel: input.channel,
      status: 'draft',
      strategy: input.strategy,
      dailyBudget: input.dailyBudget,
      monthlyBudget: input.dailyBudget * 30,
      goal: input.goal,
      regionIds: input.regionIds,
      keywords: input.keywords,
      startDate: input.startDate ?? null,
      bidAdjustmentPct: 0,
      notes: input.notes ?? null,
      metrics7d: metrics,
      metrics30d: metrics,
      trend,
      warnings: [],
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    ok(res, campaign, 201);
  }),
);

opsRouter.patch(
  '/campaigns/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.campaign.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Кампания не найдена');
    const patch = parseBody(campaignPatchSchema, req.body);
    ok(res, db.campaign.patch(current.id, patch as never));
  }),
);

opsRouter.delete(
  '/campaigns/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.campaign.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Кампания не найдена');
    db.campaign.delete(current.id);
    ok(res, { deleted: current.id });
  }),
);

/** Синхронизация с Яндекс.Директом (или генерация демо-метрик). */
opsRouter.post(
  '/campaigns/sync',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    ok(res, await syncCampaignStats(tenantId));
  }),
);

/** Импорт кампаний из реального аккаунта Директа. */
opsRouter.post(
  '/campaigns/import',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const credentials = await getDirectCredentials(db, tenantId);
    if (!credentials) throw new ApiError(422, 'Сначала подключите Яндекс.Директ с OAuth-токеном');
    const client = new DirectClient(credentials);
    const remote = await client.listCampaigns();
    const created: string[] = [];
    for (const item of remote) {
      const existing = db.campaign.list({ tenantId, limit: 300 }).find((campaign) => Number((campaign as unknown as Campaign).externalId) === item.id);
      if (existing) continue;
      const { metrics, trend } = simulateMetrics({ id: String(item.id), dailyBudget: item.dailyBudget ?? 1000, keywords: [] } as unknown as Campaign, 30);
      const saved = db.campaign.put({
        id: randomId('cmp'),
        tenantId,
        clientId: req.body?.clientId ?? null,
        siteProjectId: null,
        accountId: null,
        serviceId: 'yandex-direct',
        externalId: String(item.id),
        name: item.name,
        channel: 'yandex_direct',
        status: item.state === 'ARCHIVED' ? 'ended' : item.state === 'SUSPENDED' ? 'paused' : 'active',
        strategy: 'max_clicks',
        dailyBudget: item.dailyBudget ?? 0,
        goal: 'Заявка',
        regionIds: [213],
        keywords: [],
        bidAdjustmentPct: 0,
        metrics7d: metrics,
        metrics30d: metrics,
        trend,
        warnings: [],
        lastSyncedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never);
      created.push(saved.id);
    }
    ok(res, { imported: created.length, source: credentials.sandbox ? 'sandbox' : 'direct-api' });
  }),
);

/** Рекомендации по ставкам (с кнопкой «применить»). */
opsRouter.get(
  '/campaigns/:id/bids',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.campaign.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Кампания не найдена');
    const campaign = current as unknown as Campaign;
    const suggestions = suggestBids(campaign, {
      targetCpa: Number(req.query.targetCpa ?? 0) || undefined,
      maxChangePercent: Number(req.query.maxChangePercent ?? 25),
    });
    ok(res, {
      campaign: campaign.name,
      suggestions,
      summary: {
        raise: suggestions.filter((item) => item.action === 'raise').length,
        lower: suggestions.filter((item) => item.action === 'lower').length,
        pause: suggestions.filter((item) => item.action === 'pause').length,
        keep: suggestions.filter((item) => item.action === 'keep').length,
        potentialSaving: Math.round(
          suggestions.filter((item) => item.action === 'lower').reduce((acc, item) => acc + (item.currentBid - item.suggestedBid) * 20, 0),
        ),
      },
    });
  }),
);

opsRouter.post(
  '/campaigns/:id/apply-bids',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.campaign.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Кампания не найдена');
    const campaign = current as unknown as Campaign;
    const targetCpa = Number(req.body?.targetCpa ?? 0) || undefined;
    const suggestions = suggestBids(campaign, { targetCpa }).filter((item) => item.action !== 'keep' && item.action !== 'pause');
    const credentials = await getDirectCredentials(db, tenantId);

    if (!credentials || credentials.sandbox) {
      ok(res, {
        applied: 0,
        planned: suggestions.length,
        mode: 'preview',
        message:
          'Изменения подготовлены, но не отправлены: нет реального подключения к Директу с OAuth-токеном. Подключите сервис с боевым токеном, чтобы MARK менял ставки сам.',
        suggestions,
      });
      return;
    }

    const client = new DirectClient(credentials);
    const externalId = Number(campaign.externalId);
    if (!Number.isFinite(externalId) || externalId <= 0) throw new ApiError(422, 'У кампании нет внешнего ID — сначала выполните импорт кампаний из Директа');
    const keywords = await client.listKeywords(externalId);
    const bidChanges = suggestions
      .map((suggestion) => {
        const match = keywords.find((keyword) => keyword.keyword.toLowerCase().trim() === suggestion.keyword.toLowerCase().trim());
        return match ? { keywordId: match.id, bid: suggestion.suggestedBid } : null;
      })
      .filter((item): item is { keywordId: number; bid: number } => Boolean(item));

    const result = await client.setBids(bidChanges);
    ok(res, {
      applied: result.updated,
      planned: suggestions.length,
      errors: result.errors,
      mode: 'live',
      message: result.updated ? `Ставки отправлены в Директ: ${result.updated}. Ошибок: ${result.errors.length}` : 'Ни одна ставка не применена — проверьте соответствие фраз',
    });
  }),
);

/* -------------------------- Автооптимизация -------------------------- */

opsRouter.get(
  '/schedules',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const rules = db.scheduleRule.list({ tenantId, limit: 200 }).map((item) => item as unknown as ScheduleRule);
    ok(res, {
      rules: rules.map((rule) => ({
        ...rule,
        scheduleDescription: describeCron(rule.cron),
        active: scheduler.list().includes(rule.id),
      })),
      runs: db.scheduleRun.list({ tenantId, limit: 40 }).map((item) => item as unknown as ScheduleRun),
      cronHelp: [
        { expression: '0 9 * * *', description: 'Каждый день в 09:00' },
        { expression: '*/30 * * * *', description: 'Каждые 30 минут' },
        { expression: '0 */6 * * *', description: 'Каждые 6 часов' },
        { expression: '0 10 * * 1', description: 'По понедельникам в 10:00' },
        { expression: '0 9 * * 1-5', description: 'По будням в 09:00' },
      ],
    });
  }),
);

opsRouter.post(
  '/schedules',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(scheduleRuleSchema, req.body);
    const db = await repos();
    const check = validateCron(input.cron);
    if (!check.valid) throw new ApiError(422, `Некорректное cron-выражение: ${input.cron}. Пример: 0 9 * * *`);
    const rule = db.scheduleRule.put({
      id: randomId('rule'),
      tenantId,
      clientId: input.clientId ?? null,
      name: input.name,
      enabled: input.enabled,
      cron: input.cron,
      timezone: input.timezone,
      ruleType: input.ruleType,
      params: input.params,
      requiresApproval: input.requiresApproval,
      notify: input.notify,
      maxChangesPerRun: input.maxChangesPerRun,
      searchOnly: input.searchOnly,
      lastRunAt: null,
      lastResult: null,
      runCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    const ruleFull = rule as unknown as ScheduleRule;
    if (ruleFull.enabled) scheduler.schedule(ruleFull);
    ok(res, rule, 201);
  }),
);

/** Установка комплекта рекомендованных правил (быстрый старт автооптимизации). */
opsRouter.post(
  '/schedules/presets',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const clientId = (req.body?.clientId as string) ?? null;
    const db = await repos();
    const created = defaultRules(tenantId, clientId).map((rule) =>
      db.scheduleRule.put({ ...rule, id: randomId('rule'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never),
    );
    for (const item of created) {
      const rule = item as unknown as ScheduleRule;
      if (rule.enabled) scheduler.schedule(rule);
    }
    ok(res, created, 201);
  }),
);

opsRouter.patch(
  '/schedules/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.scheduleRule.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Правило не найдено');
    const patch = parseBody(scheduleRuleSchema.partial(), req.body);
    if (patch.cron && !validateCron(patch.cron).valid) throw new ApiError(422, 'Некорректное cron-выражение');
    const updated = db.scheduleRule.patch(current.id, patch as never);
    const rule = updated as unknown as ScheduleRule;
    if (rule.enabled) scheduler.schedule(rule);
    else scheduler.unschedule(rule.id);
    ok(res, updated);
  }),
);

opsRouter.delete(
  '/schedules/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const current = db.scheduleRule.get(req.params.id!);
    if (!current || current.tenantId !== tenantId) throw new ApiError(404, 'Правило не найдено');
    scheduler.unschedule(current.id);
    db.scheduleRule.delete(current.id);
    ok(res, { deleted: current.id });
  }),
);

/** Ручной запуск правила (с возможностью проверки без применения). */
opsRouter.post(
  '/schedules/:id/run',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(scheduleRunSchema, { ...req.body, ruleId: req.params.id });
    const run = await runRule(tenantId, req.params.id!, { dryRun: input.dryRun });
    ok(res, run);
  }),
);

/** Подтверждение изменений, подготовленных правилом (requiresApproval). */
opsRouter.post(
  '/schedules/runs/:runId/approve',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const run = db.scheduleRun.get(req.params.runId!);
    if (!run || run.tenantId !== tenantId) throw new ApiError(404, 'Запуск правила не найден');
    if (run.status !== 'awaiting_approval') throw new ApiError(409, 'Этот запуск не ожидает подтверждения');
    const result = await runRule(tenantId, String(run.ruleId), { approve: true, dryRun: Boolean(req.body?.dryRun) });
    ok(res, result);
  }),
);

/* ------------------------------- Отчёты ------------------------------- */

opsRouter.post(
  '/reports',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(reportRequestSchema, req.body);
    const db = await repos();
    const tenant = db.tenant.list({ tenantId, limit: 1 })[0];
    const report = await buildReport({
      tenantId,
      type: input.type,
      clientId: input.clientId ?? null,
      siteProjectId: input.siteProjectId ?? null,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      brand: tenant as never,
    });
    const saved = saveReportHtml({ ...report, status: 'done', generatedAt: new Date().toISOString() });
    const stored = db.report.put({
      ...report,
      status: 'done',
      generatedAt: new Date().toISOString(),
      filePath: saved.filePath,
      fileSizeBytes: saved.sizeBytes,
    } as never);

    const delivery: ReportRecord['delivery'] = [];
    if (input.delivery.includes('email') || input.delivery.includes('telegram')) {
      const { deliverReport } = await import('../services/reports/delivery.js');
      delivery.push(...(await deliverReport(tenantId, stored as unknown as ReportRecord, input.delivery, input.recipients)));
    }
    ok(res, { ...stored, delivery }, 201);
  }),
);

opsRouter.get(
  '/reports',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const query = parseBody(reportHistoryQuerySchema, req.query);
    const items = db.report
      .list({ tenantId, clientId: query.clientId ?? undefined, status: query.status, limit: query.limit, offset: query.offset })
      .filter((item) => (query.type ? (item as { type?: string }).type === query.type : true))
      .map((item) => {
        const report = item as unknown as ReportRecord;
        return {
          ...report,
          sections: undefined,
          sectionsCount: report.sections?.length ?? 0,
          kpis: report.kpis?.slice(0, 4) ?? [],
        };
      });
    ok(res, { items, total: db.report.count({ tenantId }), limit: query.limit, offset: query.offset });
  }),
);

opsRouter.get(
  '/reports/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    ok(res, report);
  }),
);

opsRouter.get(
  '/reports/:id/html',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    res.type('html').send(renderReportHtml(report as unknown as ReportRecord, { forPrint: Boolean(req.query.print) }));
  }),
);

opsRouter.get(
  '/reports/:id/csv',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    res
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${report.id}.csv"`)
      .send(`\uFEFF${renderReportCsv(report as unknown as ReportRecord)}`);
  }),
);

/** PDF: реальный PDF через Chromium, либо печатный HTML (если движка нет). */
opsRouter.get(
  '/reports/:id/pdf',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    const record = report as unknown as ReportRecord;
    const pdf = await renderReportPdf(record);
    if (pdf) {
      res
        .type('application/pdf')
        .setHeader('Content-Disposition', `attachment; filename="${report.id}.pdf"`)
        .send(pdf);
      return;
    }
    // Резерв: печатный HTML с автооткрытием диалога печати (браузер сохранит как PDF)
    res.type('html').send(
      `${renderReportHtml(record, { forPrint: true }).replace(
        '</body>',
        `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},350);});</script>
        <div style="position:fixed;bottom:12px;right:12px;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;font:13px system-ui">
          Движок PDF недоступен локально — нажмите «Сохранить как PDF» в диалоге печати.
        </div></body>`,
      )}`,
    );
  }),
);

opsRouter.post(
  '/reports/:id/deliver',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    const { deliverReport } = await import('../services/reports/delivery.js');
    const channelsInput = (req.body?.delivery ?? ['email']) as ('download' | 'email' | 'telegram')[];
    const recipients = (req.body?.recipients ?? []) as string[];
    const results = await deliverReport(tenantId, report as unknown as ReportRecord, channelsInput, recipients);
    db.report.patch(report.id, { delivery: results, status: results.some((item) => item.status === 'sent') ? 'sent' : report.status } as never);
    ok(res, results);
  }),
);

opsRouter.delete(
  '/reports/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const report = db.report.get(req.params.id!);
    if (!report || report.tenantId !== tenantId) throw new ApiError(404, 'Отчёт не найден');
    db.report.delete(report.id);
    ok(res, { deleted: report.id });
  }),
);

/* ----------------------------- Оркестрация ----------------------------- */

opsRouter.post(
  '/orchestrate',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(orchestrateSchema, req.body);
    const runId = randomId('orch');
    ok(res, { runId, channel: channels.run(runId) }, 202);
    void orchestrate({
      tenantId,
      clientId: input.clientId,
      runId,
      tasks: input.tasks.map((task) => ({ type: task.type, params: task.params as Record<string, unknown> })),
      dryRun: input.dryRun,
    }).catch((error) => log.error('Оркестрация упала', error));
  }),
);

/* ------------------------------ Диагностика ------------------------------ */

opsRouter.get(
  '/system/status',
  ah(async (_req, res) => {
    const db = await repos();
    const rules = db.scheduleRule.list({ limit: 500 }).map((item) => item as unknown as ScheduleRule);
    ok(res, {
      version: '1.0.0',
      demoMode: config.demoMode,
      allowOutbound: config.allowOutbound,
      dataDir: config.dataDir,
      scheduler: { active: scheduler.list(), total: rules.length, enabled: rules.filter((rule) => rule.enabled).length },
      hub: hub.stats(),
      counts: {
        clients: db.client.count({}),
        sites: db.siteProject.count({}),
        accounts: db.account.count({}),
        rules: db.scheduleRule.count({}),
        campaigns: db.campaign.count({}),
        hypotheses: db.hypothesis.count({}),
        reports: db.report.count({}),
        audits: db.audit.count({}),
        scans: db.botScan.count({}),
      },
    });
  }),
);

/** Совместимость: маршрут для «быстрого запуска полного цикла». */
opsRouter.post(
  '/quick-run',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const clientId = String(req.body?.clientId ?? '');
    if (!clientId) throw new ApiError(422, 'Выберите клиента для полного цикла');
    const runId = randomId('orch');
    ok(res, { runId, channel: channels.run(runId) }, 202);
    void orchestrate({
      tenantId,
      clientId,
      runId,
      tasks: [
        { type: 'audit', params: { siteProjectId: req.body?.siteProjectId } },
        { type: 'autofix', params: {} },
        { type: 'geo_analysis', params: req.body?.keywords ? { keywords: req.body.keywords, regionIds: req.body.regionIds } : {} },
        { type: 'market_analysis', params: { yourCpc: req.body?.yourCpc } },
        { type: 'hypotheses', params: { count: 8 } },
        { type: 'report', params: { type: 'summary' } },
      ],
      dryRun: Boolean(req.body?.dryRun),
    }).catch((error) => log.error('Быстрый цикл упал', error));
  }),
);
