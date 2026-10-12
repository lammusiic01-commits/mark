import { Router } from 'express';
import {
  BOT_RECOMMENDATION_LIBRARY,
  MARK_VERSION,
  NICHES,
  PLATFORMS,
  REGIONS,
  REGION_GROUPS,
  SERVICES,
  SITE_CONNECTORS,
  clientSchema,
  settingsPatchSchema,
  whiteLabelSchema,
  type Campaign,
  type DashboardSummary,
  type Hypothesis,
  type ReportRecord,
  type ScheduleRule,
  type SiteProject,
  type TimePoint,
} from '@mark/shared';
import { randomId } from '../crypto.js';
import { config } from '../config.js';
import { repos } from '../db/repos.js';
import { ApiError, ah, currentTenantId, ok, parseBody } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { hub } from '../realtime.js';
import { simulateMetrics } from '../services/campaigns.js';
import { ruleLabel, validateCron } from '../services/scheduler.js';

/** Общие маршруты: метаданные каталогов, клиенты, настройки, white-label, дашборд, события. */

const log = rootLogger.child('routes.root');
export const apiRouter = Router();

/* -------------------------------- Служебное -------------------------------- */

apiRouter.get('/health', (_req, res) => {
  ok(res, {
    status: 'ok',
    version: MARK_VERSION,
    uptimeSec: Math.round(process.uptime()),
    demoMode: config.demoMode,
    allowOutbound: config.allowOutbound,
    time: new Date().toISOString(),
  });
});

/** Метаданные для фронтенда: каталоги, версия, справочники. */
apiRouter.get('/meta', (_req, res) => {
  ok(res, {
    version: MARK_VERSION,
    demoMode: config.demoMode,
    allowOutbound: config.allowOutbound,
    services: SERVICES,
    platforms: PLATFORMS,
    siteConnectors: SITE_CONNECTORS,
    regions: REGIONS,
    regionGroups: REGION_GROUPS,
    niches: NICHES.map((niche) => ({
      id: niche.id,
      name: niche.name,
      cpcMoscow: niche.cpcMoscow,
      ctr: niche.ctr,
      conversion: niche.conversion,
      competition: niche.competition,
      keywords: niche.keywords,
    })),
    botRecommendations: BOT_RECOMMENDATION_LIBRARY.map((rule) => ({ id: rule.id, title: rule.title, severity: rule.severity, artifactType: rule.artifact.type })),
    ruleTypes: [
      { id: 'bid_up', label: 'Повышение ставок (эффективные фразы)' },
      { id: 'bid_down', label: 'Снижение ставок (дорогой CPA)' },
      { id: 'pause_low_ctr', label: 'Пауза при низком CTR' },
      { id: 'pause_no_conversions', label: 'Пауза без конверсий' },
      { id: 'budget_reallocate', label: 'Перераспределение бюджета' },
      { id: 'negative_keywords', label: 'Минус-слова' },
      { id: 'dayparting', label: 'Корректировки по времени' },
      { id: 'min_balance', label: 'Контроль баланса' },
      { id: 'weekly_report', label: 'Еженедельный отчёт' },
    ],
    metrics: [
      { id: 'ctr', label: 'CTR' },
      { id: 'cr', label: 'Конверсия сайта' },
      { id: 'cpl', label: 'Стоимость лида' },
      { id: 'cpa', label: 'Стоимость заявки' },
      { id: 'roas', label: 'ROAS' },
      { id: 'positions', label: 'Позиции' },
      { id: 'traffic', label: 'Трафик' },
      { id: 'bounce', label: 'Отказы' },
      { id: 'aov', label: 'Средний чек' },
      { id: 'revenue', label: 'Выручка' },
    ],
    cronPresets: [
      { expression: '0 9 * * *', label: 'Каждый день в 09:00' },
      { expression: '0 10 * * 1-5', label: 'По будням в 10:00' },
      { expression: '*/30 * * * *', label: 'Каждые 30 минут' },
      { expression: '0 */4 * * *', label: 'Каждые 4 часа' },
      { expression: '0 3 * * *', label: 'Ночью в 03:00' },
    ],
    plugins: [
      { id: 'yandex-wordstat', title: 'GEO-анализатор (Wordstat по регионам)', status: 'ready' },
      { id: 'market-analyzer', title: 'Market Analyzer (CPC vs бенчмарки)', status: 'ready' },
      { id: 'autopilot', title: 'Автооптимизация по cron', status: 'ready' },
      { id: 'white-label', title: 'Белая метка для агентств', status: 'ready' },
      { id: 'connectors', title: 'Коннекторы сайтов (Tilda, WordPress, GitHub, FTP, Vercel…)', status: 'ready' },
      { id: 'browser-login', title: 'Вход в сервисы в окне приложения', status: 'ready' },
    ],
  });
});

/* -------------------------------- Тенант -------------------------------- */

apiRouter.get(
  '/branding',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, db.tenant.get(tenantId));
  }),
);

apiRouter.put(
  '/branding',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(whiteLabelSchema, req.body);
    const db = await repos();
    const current = db.tenant.get(tenantId);
    const updated = db.tenant.patch(tenantId, {
      ...input,
      slug: input.slug ?? current?.slug ?? 'agency',
    } as never);
    ok(res, updated);
  }),
);

/* ------------------------------- Клиенты ------------------------------- */

apiRouter.get(
  '/clients',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const items = db.client
      .list({ tenantId, status: (req.query.status as string) || undefined, limit: 300 })
      .map((client) => {
        const sites = db.siteProject.list({ tenantId, clientId: client.id, limit: 50 });
        const campaigns = db.campaign.list({ tenantId, clientId: client.id, limit: 50 }) as unknown as Campaign[];
        const spend = campaigns.reduce((acc, campaign) => acc + (campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics).cost, 0);
        return { ...client, sites: sites.length, campaigns: campaigns.length, monthlySpend: Math.round(spend) };
      });
    ok(res, items);
  }),
);

apiRouter.post(
  '/clients',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(clientSchema, req.body);
    const db = await repos();
    const client = db.client.put({
      id: randomId('cl'),
      tenantId,
      name: input.name,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      monthlyBudget: input.monthlyBudget ?? null,
      notes: input.notes ?? null,
      status: input.status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    ok(res, client, 201);
  }),
);

apiRouter.patch(
  '/clients/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const client = db.client.get(req.params.id!);
    if (!client || client.tenantId !== tenantId) throw new ApiError(404, 'Клиент не найден');
    const patch = parseBody(clientSchema.partial(), req.body);
    ok(res, db.client.patch(client.id, patch as never));
  }),
);

apiRouter.delete(
  '/clients/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const client = db.client.get(req.params.id!);
    if (!client || client.tenantId !== tenantId) throw new ApiError(404, 'Клиент не найден');
    db.client.delete(client.id);
    ok(res, { deleted: client.id });
  }),
);

/* ------------------------------ Настройки ------------------------------ */

apiRouter.get(
  '/settings',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, {
      settings: db.kv.get(`settings:${tenantId}`) ?? {
        tenantId,
        appName: 'MARK',
        autoOptimizationEnabled: true,
        botProtectionEnabled: true,
        geoEnabled: true,
        demoMode: config.demoMode,
      },
      env: {
        demoMode: config.demoMode,
        allowOutbound: config.allowOutbound,
        dryRunAlways: config.dryRunAlways,
        dataDir: config.dataDir,
        port: config.port,
        nodeEnv: config.nodeEnv,
      },
    });
  }),
);

apiRouter.patch(
  '/settings',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(settingsPatchSchema, req.body);
    const db = await repos();
    const current = db.kv.get<Record<string, unknown>>(`settings:${tenantId}`) ?? {};
    const next = { ...current, ...input, tenantId, updatedAt: new Date().toISOString() };
    db.kv.set(`settings:${tenantId}`, next);
    ok(res, next);
  }),
);

/* ------------------------------- Дашборд ------------------------------- */

apiRouter.get(
  '/dashboard',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const clientId = (req.query.clientId as string) || null;

    const clients = db.client.list({ tenantId, limit: 300 });
    const accounts = db.account.list({ tenantId, limit: 300 });
    const sites = db.siteProject.list({ tenantId, clientId: clientId ?? undefined, limit: 200 }) as unknown as SiteProject[];
    const campaigns = db.campaign.list({ tenantId, clientId: clientId ?? undefined, limit: 200 }) as unknown as Campaign[];
    const hypotheses = db.hypothesis.list({ tenantId, clientId: clientId ?? undefined, limit: 300 }) as unknown as Hypothesis[];
    const audit = db.audit.list({ tenantId, clientId: clientId ?? undefined, limit: 5 })[0];
    const geo = db.geoAnalysis.list({ tenantId, clientId: clientId ?? undefined, limit: 1 })[0];
    const market = db.marketAnalysis.list({ tenantId, clientId: clientId ?? undefined, limit: 1 })[0];
    const botScan = db.botScan.list({ tenantId, clientId: clientId ?? undefined, limit: 1 })[0];
    const rules = db.scheduleRule.list({ tenantId, clientId: clientId ?? undefined, limit: 50 }) as unknown as ScheduleRule[];
    const runs = db.scheduleRun.list({ tenantId, limit: 20 });
    const events = db.events.list(tenantId, 20);
    const reports = db.report.list({ tenantId, clientId: clientId ?? undefined, limit: 30 }) as unknown as ReportRecord[];

    const spend = campaigns.reduce((acc, campaign) => acc + (campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics).cost, 0);
    const conversions = campaigns.reduce((acc, campaign) => acc + (campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics).conversions, 0);
    const clicks = campaigns.reduce((acc, campaign) => acc + (campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics).clicks, 0);
    const wastedMoney = Number(botScan?.totals?.wastedMoneyEstimate ?? 0);

    const seoScoreSeries: TimePoint[] = db.audit
      .list({ tenantId, clientId: clientId ?? undefined, limit: 30 })
      .map((item) => ({ date: String(item.finishedAt ?? item.createdAt).slice(0, 10), value: Number(item.score ?? 0) }))
      .reverse();

    const botTrafficSeries = ((botScan?.series ?? []) as { date: string; human: number; bots: number; suspicious: number; ai: number }[]).slice(-30);

    const alerts: DashboardSummary['alerts'] = [];
    if (audit && Number(audit.summary?.critical ?? 0) > 0) {
      alerts.push({
        title: 'Критичные проблемы на сайте',
        detail: `Аудит нашёл ${audit.summary?.critical ?? 0} критичных замечаний — исправьте первым делом.`,
        severity: 'critical',
        at: String(audit.finishedAt ?? audit.createdAt),
      });
    }
    for (const account of accounts.filter((item) => item.status === 'invalid')) {
      alerts.push({
        title: `Подключение «${account.label}» не работает`,
        detail: String(account.lastError ?? 'Проверка не пройдена — обновите токен.'),
        severity: 'high',
        at: String(account.lastCheckedAt ?? account.updatedAt),
      });
    }
    for (const rule of rules.filter((item) => item.lastResult && /ошибк/i.test(String(item.lastResult)))) {
      alerts.push({ title: `Правило «${rule.name}» завершилось ошибкой`, detail: String(rule.lastResult), severity: 'medium', at: String(rule.lastRunAt ?? rule.updatedAt) });
    }
    if (wastedMoney > 1000) {
      alerts.push({
        title: 'Боты съедают бюджет и трафик',
        detail: `Потери: ≈ ${Math.round(wastedMoney).toLocaleString('ru-RU')} ₽. Примените правила BotShield.`,
        severity: 'high',
        at: String(botScan?.finishedAt ?? botScan?.createdAt ?? new Date().toISOString()),
      });
    }

    const summary: DashboardSummary = {
      kpis: [
        { label: 'Расход за 30 дней', value: `${Math.round(spend).toLocaleString('ru-RU')} ₽` },
        { label: 'Клики', value: clicks.toLocaleString('ru-RU') },
        { label: 'Конверсии', value: conversions.toLocaleString('ru-RU') },
        { label: 'CPA', value: conversions ? `${Math.round(spend / conversions).toLocaleString('ru-RU')} ₽` : '—' },
        { label: 'SEO-балл', value: audit ? `${audit.score}/100` : sites[0]?.seoScore ? `${sites[0].seoScore}/100` : '—' },
        { label: 'Чистота трафика', value: botScan ? `${botScan.cleanlinessScore}/100` : '—' },
        { label: 'Клиентов', value: String(clients.length) },
        { label: 'Активных гипотез', value: String(hypotheses.filter((item) => item.status === 'running').length) },
      ],
      seoScoreSeries,
      budget: { used: Math.round(spend), planned: clients.reduce((acc, client) => acc + Number(client.monthlyBudget ?? 0), 0), currency: 'RUB' },
      botTrafficSeries,
      hypotheses: {
        total: hypotheses.length,
        running: hypotheses.filter((item) => item.status === 'running').length,
        done: hypotheses.filter((item) => item.status === 'done').length,
        avgLift: hypotheses.filter((item) => item.status === 'done').length
          ? Math.round(hypotheses.filter((item) => item.status === 'done').reduce((acc, item) => acc + item.expectedEffectPct, 0) / hypotheses.filter((item) => item.status === 'done').length)
          : 0,
      },
      audit: audit
        ? {
            score: Number(audit.score ?? 0),
            grade: String(audit.grade ?? '—'),
            critical: Number(audit.summary?.critical ?? 0),
            high: Number(audit.summary?.high ?? 0),
            lastRunAt: String(audit.finishedAt ?? audit.createdAt),
            autoFixable: Number(audit.summary?.autoFixable ?? 0),
          }
        : null,
      geo: geo
        ? {
            regions: (geo.demandByRegion ?? []).length,
            demand: Number(geo.totalDemand ?? 0),
            topRegion: geo.demandByRegion?.[0]?.regionName,
          }
        : null,
      market: market
        ? { niche: String(market.niche ?? ''), nicheCpc: Number(market.nicheCpc ?? 0), yourCpc: market.yourCpc ?? null, verdict: String(market.verdict ?? '') }
        : null,
      alerts: alerts.slice(0, 8),
      accounts: {
        total: accounts.length,
        valid: accounts.filter((item) => item.status === 'valid').length,
        expiring: accounts.filter((item) => item.status === 'expired').length,
        broken: accounts.filter((item) => item.status === 'invalid').length,
      },
      recentRuns: runs.slice(0, 8).map((run) => ({
        id: run.id,
        type: 'schedule',
        label: String(run.ruleName ?? 'правило'),
        status: String(run.status ?? ''),
        at: String(run.startedAt ?? run.createdAt),
        result: String(run.summary ?? '').slice(0, 160),
      })),
      scheduled: rules.map((rule) => ({ id: rule.id, name: rule.name, nextRunAt: null, enabled: rule.enabled, ruleType: ruleLabel(rule) })),
    };

    ok(res, {
      summary,
      recent: {
        reports: reports.slice(0, 5).map((report) => ({ id: report.id, title: report.title, status: report.status, at: report.createdAt })),
        events: events.slice(0, 12),
        sites: sites.slice(0, 8).map((site) => ({ id: site.id, name: site.name, url: site.url, platform: site.platform, seoScore: site.seoScore })),
      },
    });
  }),
);

/* -------------------------------- События -------------------------------- */

apiRouter.get(
  '/events/stream',
  (req, res) => {
    const channel = String(req.query.channel ?? 'activity');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ channel })}\n\n`);
    const unsubscribe = hub.subscribeSse((event) => {
      if (channel !== '*' && event.channel !== channel) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  },
);

apiRouter.get(
  '/events/:channel',
  ah(async (req, res) => {
    ok(res, hub.buffer(req.params.channel!, Number(req.query.limit ?? 50)));
  }),
);

apiRouter.get(
  '/events',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, db.events.list(tenantId, Number(req.query.limit ?? 50)));
  }),
);

/* ------------------------------ Утилиты ------------------------------ */

apiRouter.post(
  '/cron/validate',
  ah(async (req, res) => {
    const expression = String(req.body?.cron ?? '');
    const result = validateCron(expression);
    if (!result.valid) throw new ApiError(422, `Некорректное cron-выражение: ${expression}`);
    ok(res, result);
  }),
);

apiRouter.get(
  '/system/status',
  ah(async (_req, res) => {
    const db = await repos();
    res.json({
      ok: true,
      data: {
        version: MARK_VERSION,
        uptimeSec: Math.round(process.uptime()),
        dataDir: config.dataDir,
        demoMode: config.demoMode,
        allowOutbound: config.allowOutbound,
        dryRunAlways: config.dryRunAlways,
        hub: hub.stats(),
        counts: {
          clients: db.client.count({}),
          sites: db.siteProject.count({}),
          accounts: db.account.count({}),
          campaigns: db.campaign.count({}),
          hypotheses: db.hypothesis.count({}),
          reports: db.report.count({}),
          rules: db.scheduleRule.count({}),
        },
      },
    });
  }),
);

export { log };
