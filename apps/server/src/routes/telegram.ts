import { Router, type Request, type Response } from 'express';
import type { AuditRun, BotScan, Campaign, Client, ConnectedAccount, GeoAnalysis, Hypothesis, ReportRecord, SiteProject, TelegramBotStatus } from '@mark/shared';
import { SERVICES, getService, regionName } from '@mark/shared';
import { config } from '../config.js';
import { repos } from '../db/repos.js';
import { ApiError, ah, ok, parseBody } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { evaluateExperiment, generateHypotheses, toHypothesis } from '../services/hypotheses.js';
import { suggestBids } from '../services/campaigns.js';
import { runAudit } from '../services/site/audit.js';
import { detectPlatform } from '../services/site/detect.js';
import { analyzeGeo, buildGeoPlan } from '../services/geo/analyzer.js';
import { analyzeMarket } from '../services/market/analyzer.js';
import { scanLogs } from '../services/bots/scan.js';
import { buildReport } from '../services/reports/builder.js';
import { renderReportPdf, saveReportHtml } from '../services/reports/renderer.js';
import { validateInitData } from '../services/telegram/auth.js';
import { telegramBots } from '../services/telegram/bot.js';
import { advise, aiStatus, fallbackAdvice } from '../services/ai/advisor.js';
import { PAYMENT_PLANS, activatePlan, checkPayment, confirmPayment, createPayment, getBalance, listPayments, listTransactions, spendSummary } from '../services/payments/sbp.js';
import { paymentConfirmSchema, paymentCreateSchema, planActivateSchema } from '@mark/shared';

/**
 * API мини-приложения «AI Маркетолог» (Telegram WebApp).
 *
 * Отличие от «большого» интерфейса: сюда приходят только те данные, которые
 * нужны на экране телефона — сводка, метрики, списки и действия. Авторизация —
 * по подписи Telegram initData (заголовок X-Telegram-Init-Data); в локальном
 * режиме без токена бота подпись не проверяется, но приложение помечает это.
 *
 * Все вычисления выполняет движок (скрипты) — AI только комментирует результат.
 */

const log = rootLogger.child('routes.telegram');
export const telegramRouter = Router();

/* ------------------------------ Авторизация ------------------------------ */

interface TgSession {
  tenantId: string;
  verified: boolean;
  userId?: number;
  firstName?: string;
  username?: string;
  role: 'owner' | 'manager' | 'viewer';
  chatId?: string;
}

/** Проверка initData + привязка к агентству и роли по чату. */
async function currentSession(req: Request): Promise<TgSession> {
  const initData = String(req.header('x-telegram-init-data') ?? req.header('x-telegram-initdata') ?? '').trim();
  const db = await repos();
  const tenants = db.tenant.list({ limit: 20 });
  if (!tenants.length) throw new ApiError(500, 'Агентство не найдено — перезапустите сервер');

  const botToken = config.telegramBotToken || (await botTokenFromAccount(tenants[0]!.id));
  const check = validateInitData(initData, botToken || null);
  // Подпись есть, но не сошлась или сессия старше суток — доступа нет
  if (!check.ok) throw new ApiError(401, check.reason ?? 'Приложение открыто не из Telegram');

  // Агентство: из привязанного чата, иначе первое
  let tenantId = tenants[0]!.id;
  let role: TgSession['role'] = 'owner';
  const links = db.telegramLink.list({ limit: 500 });
  const tgUser = check.user;
  const tgUserId = tgUser?.id;
  const link = tgUserId ? links.find((item) => String(item.userId) === String(tgUserId)) : undefined;
  if (link) {
    tenantId = String(link.tenantId);
    role = (link.role as TgSession['role']) ?? 'manager';
  } else if (check.verified) {
    // Первый вход из Telegram: привязываем чат как владельца агентства
    const existing = links.filter((item) => String(item.tenantId) === tenantId);
    if (!existing.length && tgUserId) {
      db.telegramLink.put({
        id: `tg_${tgUserId}`,
        tenantId,
        chatId: String(tgUserId),
        userId: String(tgUserId),
        username: tgUser?.username ?? null,
        firstName: tgUser?.first_name ?? null,
        lastName: tgUser?.last_name ?? null,
        role: 'owner',
        notifications: true,
        linkedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      } as never);
      role = 'owner';
    }
  }

  return {
    tenantId,
    verified: check.verified,
    userId: tgUserId,
    firstName: check.user?.first_name,
    username: check.user?.username,
    role,
    chatId: check.user?.id ? String(check.user.id) : undefined,
  };
}

async function botTokenFromAccount(tenantId: string): Promise<string | null> {
  const db = await repos();
  const account = db.account.list({ tenantId, limit: 200 }).find((item) => item.serviceId === 'telegram');
  if (!account) return null;
  const payload = db.secrets.load(account.id);
  if (!payload) return null;
  try {
    const { decryptJson } = await import('../crypto.js');
    const data = decryptJson<{ botToken?: string }>(payload);
    return data.botToken ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------ Сводка ------------------------------ */

telegramRouter.get(
  '/me',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const tenant = db.tenant.get(session.tenantId);
    const bot = telegramBots.get(session.tenantId);
    ok(res, {
      session: {
        verified: session.verified,
        role: session.role,
        firstName: session.firstName ?? 'коллега',
        username: session.username ?? null,
      },
      tenant: {
        id: session.tenantId,
        agencyName: tenant?.agencyName ?? 'AI Маркетолог',
        brandColor: tenant?.brandColor ?? '#0A84FF',
        hideMarkBranding: tenant?.hideMarkBranding ?? false,
      },
      bot: {
        enabled: Boolean(bot),
        running: bot?.status.running ?? false,
        username: process.env.MARK_TELEGRAM_BOT_USERNAME ?? null,
      },
      env: { demoMode: config.demoMode, version: '1.0.0' },
      onboarding: Boolean((db.kv.get<{ done?: boolean }>(`onboarding:${session.tenantId}`) ?? {}).done),
    });
  }),
);

telegramRouter.post(
  '/onboarding/complete',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    db.kv.set(`onboarding:${session.tenantId}`, { done: true, at: new Date().toISOString() });
    ok(res, { done: true });
  }),
);

telegramRouter.get(
  '/dashboard/summary',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const tenantId = session.tenantId;

    const sites = db.siteProject.list({ tenantId, limit: 200 }) as unknown as SiteProject[];
    const campaigns = db.campaign.list({ tenantId, limit: 200 }) as unknown as Campaign[];
    const hypotheses = db.hypothesis.list({ tenantId, limit: 300 }) as unknown as Hypothesis[];
    const audit = db.audit.list({ tenantId, limit: 5 })[0] as unknown as AuditRun | undefined;
    const scan = db.botScan.list({ tenantId, limit: 5 })[0] as unknown as BotScan | undefined;
    const balance = await getBalance(tenantId);
    const spend = await spendSummary(tenantId);

    const clicks = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics7d?.clicks ?? 0), 0);
    const spent = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics7d?.cost ?? 0), 0);
    const conversions = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics7d?.conversions ?? 0), 0);
    const botPercent = Number(scan?.totals?.suspiciousRequests && scan.totals.requests ? (scan.totals.suspiciousRequests / scan.totals.requests) * 100 : 0);
    const botSaved = Number(scan?.totals?.wastedMoneyEstimate ?? 0);

    // Динамика: сравниваем 7 дней с предыдущими 7 по trend кампаний
    const previousClicks = campaigns.reduce((acc, campaign) => {
      const trend = campaign.trend ?? [];
      const tail = trend.slice(-14, -7).reduce((sum, point) => sum + Number(point.value ?? 0), 0);
      return acc + tail;
    }, 0);
    const change = (current: number, previous: number): number => (previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : 0);

    ok(res, {
      balance: balance.balance,
      plan: balance.plan ?? null,
      planUntil: balance.planUntil ?? null,
      metrics: {
        clicks,
        clicks_change: change(clicks, previousClicks),
        spent: Math.round(spent),
        spent_change: 0,
        conversions,
        conv_change: 0,
        bot_pct: Math.round(botPercent * 10) / 10,
        bot_change: 0,
        bot_saved: Math.round(botSaved),
        seo_score: Number(audit?.score ?? 0),
      },
      hypotheses_count: hypotheses.filter((item) => item.status === 'backlog' || item.status === 'planned').length,
      campaigns_count: campaigns.filter((item) => item.status === 'active').length,
      sites_count: sites.length,
      charged30d: spend.charged30d,
      ai_tip: (db.kv.get<{ text?: string }>(`advice:${tenantId}:dashboard:auto`) ?? {}).text ?? fallbackAdvice('dashboard', { seoScore: Number(audit?.score ?? 0), botPercentage: botPercent, balance: balance.balance }),
      alerts: buildAlerts({ sites, audit, scan, hypotheses, balance: balance.balance }),
    });
  }),
);

function buildAlerts(input: { sites: SiteProject[]; audit?: AuditRun; scan?: BotScan; hypotheses: Hypothesis[]; balance: number }) {
  const alerts: { code: string; severity: 'critical' | 'high' | 'medium'; title: string; detail: string; action?: string }[] = [];
  if (input.audit && Number(input.audit.summary?.critical ?? 0) > 0) {
    alerts.push({ code: 'audit-critical', severity: 'critical', title: 'Критичные ошибки на сайте', detail: `Аудит нашёл ${input.audit.summary?.critical} критичных замечаний. Движок готов исправить ${input.audit.summary?.autoFixable ?? 0} автоматически.`, action: 'autofix' });
  }
  const wasted = Number(input.scan?.totals?.wastedMoneyEstimate ?? 0);
  if (wasted > 1000) {
    alerts.push({ code: 'bot-losses', severity: 'high', title: 'Боты съедают бюджет', detail: `Потери из-за подозрительного трафика — около ${Math.round(wasted).toLocaleString('ru-RU')} ₽. Включите защиту.`, action: 'bot-shield' });
  }
  if (input.balance < 1000) {
    alerts.push({ code: 'low-balance', severity: input.balance <= 0 ? 'critical' : 'medium', title: 'Мало средств на балансе', detail: 'Пополните баланс, чтобы проверки и автооптимизация не останавливались.', action: 'balance' });
  }
  if (input.hypotheses.filter((item) => item.status === 'running').length === 0 && input.hypotheses.length > 2) {
    alerts.push({ code: 'no-tests', severity: 'medium', title: 'Гипотезы ждут запуска', detail: 'Есть готовые гипотезы роста — запустите тест, чтобы найти дешёвые конверсии.', action: 'hypotheses' });
  }
  return alerts;
}

/* -------------------------- AI-советник -------------------------- */

telegramRouter.post(
  '/advisor',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const topic = (['dashboard', 'bots', 'campaigns', 'geo', 'report'] as const).find((item) => item === req.body?.topic) ?? 'dashboard';
    const question = typeof req.body?.question === 'string' ? req.body.question.slice(0, 600) : undefined;
    const data = (req.body?.data && typeof req.body.data === 'object' ? req.body.data : {}) as Record<string, unknown>;
    const answer = await advise({ tenantId: session.tenantId, topic, data, question });
    ok(res, answer);
  }),
);

telegramRouter.get(
  '/advisor/status',
  ah(async (req, res) => {
    const session = await currentSession(req);
    ok(res, await aiStatus(session.tenantId));
  }),
);

/* -------------------------- Подключение сервисов -------------------------- */

telegramRouter.get(
  '/services',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const accounts = db.account.list({ tenantId: session.tenantId, limit: 300 });
    const items = SERVICES.map((service) => {
      const account = accounts.find((item) => item.serviceId === service.id);
      return {
        id: service.id,
        name: service.name,
        vendor: service.vendor,
        category: service.category,
        docsUrl: service.docsUrl,
        capabilities: service.capabilities,
        supportsSandbox: service.supportsSandbox,
        notes: service.notes ?? [],
        color: service.color ?? null,
        authModes: service.authModes.map((mode) => ({ id: mode.id, label: mode.label, automation: mode.automation, needsInAppLogin: Boolean(mode.needsInAppLogin), fields: mode.fields.map((field) => ({ key: field.key, label: field.label, type: field.type, required: field.required, placeholder: field.placeholder ?? null, help: field.help ?? null, secret: Boolean(field.secret) })) })),
        validationPlan: service.validationPlan,
        status: account ? account.status : 'disconnected',
        account: account
          ? { id: account.id, label: account.label, status: account.status, sandbox: account.sandbox, lastCheckedAt: account.lastCheckedAt ?? null, lastError: account.lastError ?? null, secretPreview: account.secretPreview ?? null }
          : null,
      };
    });
    ok(res, { items, connected: items.filter((item) => item.account).length });
  }),
);

telegramRouter.get(
  '/services/:id',
  ah(async (req, res) => {
    const service = getService(req.params.id!);
    if (!service) throw new ApiError(404, 'Сервис не найден');
    ok(res, { ...service, browserLoginUrl: null });
  }),
);

/** Валидация токена: движок реально проверяет его в сервисе. */
telegramRouter.post(
  '/services/validate',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const serviceId = String(req.body?.serviceId ?? '');
    const authMode = String(req.body?.authMode ?? 'api_token');
    const fields = (req.body?.fields ?? {}) as Record<string, unknown>;
    const sandbox = req.body?.sandbox !== false;
    const { validateSchema, connectSchema } = await import('@mark/shared');
    const db = await repos();
    const { runValidation } = await import('../services/validation/index.js');

    const service = getService(serviceId);
    if (!service) throw new ApiError(404, `Сервис «${serviceId}» не найден`);

    const normalised: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      normalised[key] = typeof value === 'string' ? value : String(value);
    }

    const checks: { key: string; title: string; status: string; message?: string }[] = [];
    const result = await runValidation({
      serviceId,
      authMode: authMode as never,
      fields: normalised,
      sandbox,
      cookiesHeader: null,
      emit: (type, payload) => {
        const data = payload as { key?: string; title?: string; status?: string; message?: string };
        if (type === 'step' && data.key) {
          const existing = checks.find((check) => check.key === data.key);
          if (existing) Object.assign(existing, data);
          else checks.push({ key: data.key, title: data.title ?? data.key, status: data.status ?? 'running', message: data.message });
        }
      },
    });

    if (req.body?.persist !== false) {
      const input = parseBody(connectSchema, { serviceId, authMode, fields, sandbox, label: req.body?.label });
      const existing = db.account.list({ tenantId: session.tenantId, limit: 300 }).find((item) => item.serviceId === serviceId);
      const { encryptJson, maskSecret, randomId } = await import('../crypto.js');
      const id = existing?.id ?? randomId('acc');
      db.account.put({
        id,
        tenantId: session.tenantId,
        clientId: existing?.clientId ?? null,
        serviceId,
        authMode,
        label: input.label ?? existing?.label ?? service.name,
        status: result.status === 'fail' ? 'invalid' : 'valid',
        secretPreview: maskSecret(normalised.token ?? normalised.apiKey ?? null),
        scopes: [],
        meta: { accountInfo: result.accountInfo ?? {}, checks: result.checks.map((check) => check.message).filter(Boolean).slice(0, 6) },
        sandbox,
        lastCheckedAt: new Date().toISOString(),
        lastError: result.status === 'fail' ? result.checks.find((check) => check.status === 'fail')?.message ?? 'Проверка не пройдена' : null,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never);
      db.secrets.save(id, encryptJson(normalised));
      log.info(`Мини-приложение подключило сервис ${serviceId} (${authMode}) — ${result.status}`);
    }
    void validateSchema;
    ok(res, { result, checks });
  }),
);

telegramRouter.delete(
  '/services/:id',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const accounts = db.account.list({ tenantId: session.tenantId, limit: 300 }).filter((item) => item.serviceId === req.params.id!);
    for (const account of accounts) {
      db.secrets.delete(account.id);
      db.account.delete(account.id);
    }
    ok(res, { deleted: accounts.length });
  }),
);

/* ------------------------------ Сайты и аудит ------------------------------ */

telegramRouter.get(
  '/sites',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const items = (db.siteProject.list({ tenantId: session.tenantId, limit: 100 }) as unknown as SiteProject[]).map((site) => ({
      id: site.id,
      name: site.name,
      url: site.url,
      platform: site.platform,
      seoScore: site.seoScore ?? null,
      lastAuditAt: site.lastAuditAt ?? null,
      geoStatus: site.geoStatus ?? null,
      keywords: site.keywords ?? [],
      regions: (site.regions ?? []).map((id) => ({ id, name: regionName(id) })),
    }));
    ok(res, { items });
  }),
);

telegramRouter.post(
  '/sites',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const { siteProjectSchema } = await import('@mark/shared');
    const input = parseBody(siteProjectSchema, req.body);
    const db = await repos();
    const id = `site_${Math.random().toString(36).slice(2, 12)}`;
    let platform = input.platform ?? 'unknown';
    let detection: { platformName?: string; confidence?: number } | null = null;
    if (!input.platform) {
      try {
        const detected = await detectPlatform(input.url);
        platform = detected.platform;
        detection = { platformName: detected.platformName, confidence: detected.confidence };
      } catch {
        detection = null;
      }
    }
    const site = db.siteProject.put({
      id,
      tenantId: session.tenantId,
      clientId: input.clientId ?? null,
      name: input.name,
      url: input.url,
      platform,
      connectorId: input.connectorId ?? null,
      accountId: input.accountId ?? null,
      goals: input.goals ?? [],
      regions: input.regions ?? [213],
      keywords: input.keywords ?? [],
      notes: input.notes ?? null,
      seoScore: null,
      lastAuditAt: null,
      geoStatus: 'not_started',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    ok(res, { site, detection }, 201);
  }),
);

/** Аудит: движок обходит сайт и возвращает балл, замечания и автоисправления. */
telegramRouter.post(
  '/sites/:id/audit',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!) as unknown as SiteProject | undefined;
    if (!site || site.tenantId !== session.tenantId) throw new ApiError(404, 'Сайт не найден');

    const audit = await runAudit({
      url: site.url,
      maxPages: Math.min(Number(req.body?.maxPages ?? 20), 40),
      keywords: site.keywords ?? [],
      regions: site.regions ?? [],
      runPsi: Boolean(req.body?.runPsi),
    });
    const saved = db.audit.put({ ...audit, tenantId: session.tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never) as unknown as AuditRun;
    db.siteProject.patch(site.id, { seoScore: audit.score, lastAuditId: saved.id, lastAuditAt: audit.finishedAt } as never);
    db.events.log({ tenantId: session.tenantId, type: 'audit', level: audit.summary.critical ? 'warn' : 'info', message: `Аудит ${site.name}: ${audit.score}/100 (${audit.grade})`, payload: { auditId: saved.id } });

    ok(res, {
      audit: {
        id: saved.id,
        score: audit.score,
        grade: audit.grade,
        summary: audit.summary,
        categoryScores: audit.categoryScores,
        pagesCrawled: audit.pagesCrawled,
        simulated: Boolean((audit as unknown as { simulated?: boolean }).simulated),
        findings: audit.findings.map((finding) => ({
          id: finding.id,
          code: finding.code,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          evidence: finding.evidence,
          recommendation: finding.recommendation,
          autoFixable: finding.autoFixable,
          impact: finding.impact,
          url: finding.url,
        })),
      },
    });
  }),
);

/** Автоисправления: движок готовит файлы и (по кнопке) применяет их на сайте. */
telegramRouter.post(
  '/sites/:id/autofix',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const { autofixSchema } = await import('@mark/shared');
    const db = await repos();
    const site = db.siteProject.get(req.params.id!) as unknown as SiteProject | undefined;
    if (!site || site.tenantId !== session.tenantId) throw new ApiError(404, 'Сайт не найден');

    const body = { ...req.body, siteProjectId: site.id };
    const input = parseBody(autofixSchema, body);
    const audit = input.auditRunId ? (db.audit.get(input.auditRunId) as unknown as AuditRun) : (db.audit.list({ tenantId: session.tenantId, limit: 10 }).find((run) => run.siteProjectId === site.id) as unknown as AuditRun | undefined);
    if (!audit) throw new ApiError(422, 'Сначала выполните аудит сайта');

    const findings = (audit.findings ?? []).filter((finding) => input.findingCodes.includes(finding.code));
    if (!findings.length) throw new ApiError(422, 'Выбранные проблемы не найдены в аудите');

    const { buildPatchBundle, summarizeAutofix } = await import('../services/site/autofix.js');
    const bundle = buildPatchBundle({
      siteUrl: site.url,
      siteName: site.name,
      findings,
      pages: [],
      geoPlan: null,
      keywords: site.keywords ?? [],
      regions: [],
      niche: site.keywords?.[0],
      contact: {},
    });
    const saved = db.patchBundle.put({ ...bundle, tenantId: session.tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);

    ok(res, {
      bundle: {
        id: saved.id,
        files: bundle.files.map((file) => ({ path: file.path, action: file.action, target: file.target, contentType: file.contentType, content: file.content })),
      },
      summary: summarizeAutofix(findings),
    });
  }),
);

/* ------------------------------ GEO и рынок ------------------------------ */

telegramRouter.post(
  '/geo/analyze',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const keywords = Array.isArray(req.body?.keywords) ? (req.body.keywords as string[]).slice(0, 30) : [];
    const regionIds = Array.isArray(req.body?.regionIds) ? (req.body.regionIds as number[]).slice(0, 20) : [213, 2];
    const site = req.body?.siteId ? (db.siteProject.get(String(req.body.siteId)) as unknown as SiteProject | undefined) : undefined;

    const analysis = await analyzeGeo({
      keywords: keywords.length ? keywords : site?.keywords ?? [],
      regionIds,
      siteUrl: site?.url,
      useLive: Boolean(req.body?.useLive),
    });
    const saved = db.geoAnalysis.put({ ...analysis, tenantId: session.tenantId, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null } as never) as unknown as GeoAnalysis;
    ok(res, {
      analysis: {
        id: saved.id,
        totalDemand: analysis.totalDemand,
        source: analysis.source,
        regionName: regionName(regionIds[0] ?? 213),
        demandByRegion: analysis.demandByRegion.map((row) => ({ regionId: row.regionId, regionName: row.regionName, demand: row.demand, cpc: row.cpc ?? 0, competition: row.competition, priority: row.priority })),
        seasonality: analysis.seasonality ?? [],
        topCities: analysis.topCities ?? [],
        recommendations: analysis.recommendations ?? [],
      },
    });
  }),
);

telegramRouter.post(
  '/geo/plan',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const site = db.siteProject.get(String(req.body?.siteId ?? '')) as unknown as SiteProject | undefined;
    const analysis = db.geoAnalysis.get(String(req.body?.analysisId ?? '')) as unknown as GeoAnalysis | undefined;
    if (!site || !analysis) throw new ApiError(422, 'Нужны сайт и результат GEO-анализа');

    const structure = (['subfolders', 'subdomains', 'single'] as const).find((item) => item === req.body?.structure) ?? 'subfolders';
    const plan = buildGeoPlan({ analysis, siteUrl: site.url, siteName: site.name, structure });
    const saved = db.geoPlan.put({ ...plan, tenantId: session.tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never) as unknown as { id: string };
    ok(res, { plan: { id: saved.id, structure, pages: plan.pages, tasks: plan.tasks, hreflang: plan.hreflang, schemaOrg: plan.schemaOrg, robotsAdditions: plan.robotsAdditions } }, 201);
  }),
);

telegramRouter.post(
  '/market/analyze',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const analysis = await analyzeMarket({
      niche: typeof req.body?.niche === 'string' ? req.body.niche : undefined,
      keywords: Array.isArray(req.body?.keywords) ? (req.body.keywords as string[]) : [],
      regionId: Number(req.body?.regionId ?? 213),
      yourCpc: req.body?.yourCpc === undefined || req.body?.yourCpc === null ? null : Number(req.body.yourCpc),
      budget: req.body?.budget ? Number(req.body.budget) : null,
    });
    const saved = db.marketAnalysis.put({ ...analysis, tenantId: session.tenantId, clientId: null, siteProjectId: null } as never) as unknown as { id: string };
    // Приводим ответ к тому, что рисует приложение: цена клика, конкуренция, бюджет и выводы
    const benchmarks = analysis.benchmarks ?? [];
    const competition = benchmarks.length ? benchmarks.filter((item) => item.cpc >= analysis.nicheCpc).length / benchmarks.length : 0.5;
    const bestScenario = [...(analysis.budgetPlan ?? [])].sort((a, b) => a.cpa - b.cpa)[0];
    ok(
      res,
      {
        id: saved.id,
        niche: analysis.niche,
        regionName: analysis.regionName,
        source: analysis.source,
        simulated: analysis.simulated ?? false,
        averageCpc: analysis.nicheCpc,
        yourCpc: analysis.yourCpc ?? null,
        gapPercent: analysis.gapPercent ?? null,
        competition,
        verdict: analysis.verdict,
        competitors: (analysis.competitors ?? []).map((item) => ({ name: item.name, domain: item.domain, cpc: analysis.nicheCpc, share: item.adShare ?? 0, note: item.note })),
        budgetPlan: analysis.budgetPlan ?? [],
        bestScenario: bestScenario ?? null,
        advice: [analysis.verdict, ...(analysis.insights ?? [])].filter(Boolean),
        benchmarks: benchmarks.slice(0, 8),
      },
      201,
    );
  }),
);

/* ------------------------------ BotShield ------------------------------ */

telegramRouter.post(
  '/bots/scan',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const { botScanSchema } = await import('@mark/shared');
    const db = await repos();
    const input = parseBody(botScanSchema, req.body);
    if (!input.logContent) throw new ApiError(422, 'Передайте содержимое лога (logContent)');

    const scan = await scanLogs({ content: input.logContent, format: input.format, verifyDns: false });
    const saved = db.botScan.put({
      ...scan,
      tenantId: session.tenantId,
      clientId: null,
      siteProjectId: input.siteProjectId ?? null,
      source: input.source,
      format: input.format,
    } as never) as unknown as BotScan;

    ok(res, {
      scan: {
        id: saved.id,
        cleanlinessScore: scan.cleanlinessScore,
        totals: scan.totals,
        topIps: scan.topIps.slice(0, 25),
        topBots: scan.topBots.slice(0, 10),
        countries: scan.countries.slice(0, 10),
        asnList: scan.asnList.slice(0, 8),
        topPaths: scan.topPaths.slice(0, 10),
        series: scan.series,
        recommendations: scan.recommendations,
        actions: (scan as unknown as { actions?: unknown[] }).actions ?? [],
        errors: scan.errors,
      },
    }, 201);
  }),
);

telegramRouter.get(
  '/bots/scans',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const items = (db.botScan.list({ tenantId: session.tenantId, limit: 20 }) as unknown as BotScan[]).map((scan) => ({
      id: scan.id,
      startedAt: scan.startedAt,
      source: scan.source,
      cleanlinessScore: scan.cleanlinessScore,
      requests: scan.totals?.requests ?? 0,
      suspicious: scan.totals?.suspiciousRequests ?? 0,
      wastedMoney: scan.totals?.wastedMoneyEstimate ?? 0,
    }));
    ok(res, { items });
  }),
);

/* ------------------------------ Кампании и ставки ------------------------------ */

telegramRouter.get(
  '/campaigns',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const items = (db.campaign.list({ tenantId: session.tenantId, limit: 100 }) as unknown as Campaign[]).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      channel: campaign.channel,
      status: campaign.status,
      strategy: campaign.strategy,
      dailyBudget: campaign.dailyBudget,
      metrics: {
        clicks: campaign.metrics30d?.clicks ?? 0,
        cost: Math.round(campaign.metrics30d?.cost ?? 0),
        conversions: campaign.metrics30d?.conversions ?? 0,
        cpa: Math.round(campaign.metrics30d?.cpa ?? 0),
        ctr: Number((campaign.metrics30d?.ctr ?? 0).toFixed(2)),
      },
      trend: (campaign.trend ?? []).slice(-14),
      warnings: campaign.warnings ?? [],
    }));
    const totals = items.reduce(
      (acc, item) => ({ clicks: acc.clicks + item.metrics.clicks, cost: acc.cost + item.metrics.cost, conversions: acc.conversions + item.metrics.conversions }),
      { clicks: 0, cost: 0, conversions: 0 },
    );
    ok(res, { items, totals: { ...totals, cpa: totals.conversions ? Math.round(totals.cost / totals.conversions) : 0 } });
  }),
);

/** Рекомендации по ставкам: чистый скрипт, без AI. */
telegramRouter.get(
  '/campaigns/:id/bids',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const campaign = db.campaign.get(req.params.id!) as unknown as Campaign | undefined;
    if (!campaign || campaign.tenantId !== session.tenantId) throw new ApiError(404, 'Кампания не найдена');
    const targetCpa = Number(req.body?.targetCpa ?? req.query.targetCpa ?? 0) || undefined;
    const suggestions = suggestBids(campaign, { targetCpa, maxChangePercent: Number(req.query.maxChangePercent ?? 25) });
    ok(res, {
      campaign: campaign.name,
      suggestions: suggestions.map((suggestion) => ({
        keyword: suggestion.keyword,
        currentBid: suggestion.currentBid,
        suggestedBid: suggestion.suggestedBid,
        deltaPercent: suggestion.deltaPercent,
        action: suggestion.action,
        reason: suggestion.reason,
        confidence: suggestion.confidence,
      })),
      summary: {
        raise: suggestions.filter((item) => item.action === 'raise').length,
        lower: suggestions.filter((item) => item.action === 'lower').length,
        pause: suggestions.filter((item) => item.action === 'pause').length,
        keep: suggestions.filter((item) => item.action === 'keep').length,
        potentialSaving: Math.round(suggestions.filter((item) => item.action === 'lower').reduce((acc, item) => acc + (item.currentBid - item.suggestedBid) * 20, 0)),
      },
    });
  }),
);

telegramRouter.post(
  '/campaigns/:id/apply-bids',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const campaign = db.campaign.get(req.params.id!) as unknown as Campaign | undefined;
    if (!campaign || campaign.tenantId !== session.tenantId) throw new ApiError(404, 'Кампания не найдена');
    const suggestions = suggestBids(campaign, { targetCpa: Number(req.body?.targetCpa ?? 0) || undefined }).filter((item) => item.action !== 'keep');
    const { getDirectCredentials } = await import('../services/campaigns.js');
    const credentials = await getDirectCredentials(db, session.tenantId);
    if (!credentials || credentials.sandbox) {
      ok(res, { applied: 0, planned: suggestions.length, mode: 'preview', message: 'Изменения подготовлены: нужен боевой токен Директа, чтобы отправить их в аккаунт.' });
      return;
    }
    ok(res, { applied: 0, planned: suggestions.length, mode: 'queued', message: `Ставки подготовлены: ${suggestions.length}. Отправка выполнится в ближайшем прогоне автооптимизации.` });
  }),
);

/* ------------------------------ Гипотезы ------------------------------ */

telegramRouter.get(
  '/hypotheses',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const items = (db.hypothesis.list({ tenantId: session.tenantId, limit: 200 }) as unknown as Hypothesis[]).map((hypothesis) => ({
      id: hypothesis.id,
      title: hypothesis.title,
      statement: hypothesis.statement,
      status: hypothesis.status,
      ice: hypothesis.ice,
      metric: hypothesis.metric,
      expectedEffectPct: hypothesis.expectedEffectPct,
      source: hypothesis.source,
      tags: hypothesis.tags ?? [],
      testPlan: hypothesis.testPlan,
      result: (hypothesis as unknown as { result?: unknown }).result ?? null,
      createdAt: hypothesis.createdAt,
    }));
    ok(res, {
      items,
      stats: {
        total: items.length,
        backlog: items.filter((item) => item.status === 'backlog').length,
        running: items.filter((item) => item.status === 'running').length,
        done: items.filter((item) => item.status === 'done').length,
      },
    });
  }),
);

/** Генерация гипотез: движок берёт данные аудита, ботов, GEO и рынка. */
telegramRouter.post(
  '/hypotheses/generate',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const count = Math.min(Number(req.body?.count ?? 6), 20);
    const audit = db.audit.list({ tenantId: session.tenantId, limit: 1 })[0] as unknown as AuditRun | undefined;
    const botScan = db.botScan.list({ tenantId: session.tenantId, limit: 1 })[0] as unknown as BotScan | undefined;
    const geo = db.geoAnalysis.list({ tenantId: session.tenantId, limit: 1 })[0] as unknown as GeoAnalysis | undefined;
    const market = db.marketAnalysis.list({ tenantId: session.tenantId, limit: 1 })[0] as unknown as never;
    const site = db.siteProject.list({ tenantId: session.tenantId, limit: 1 })[0] as unknown as SiteProject | undefined;

    const drafts = generateHypotheses({ audit, botScan, geo, market, count, niche: site?.keywords?.[0], siteName: site?.name });
    const created = drafts.map((draft) => db.hypothesis.put(toHypothesis(draft, { tenantId: session.tenantId, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null }) as never) as unknown as Hypothesis);
    ok(res, { created, drafts: drafts.length }, 201);
  }),
);

telegramRouter.post(
  '/hypotheses/:id/start',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const hypothesis = db.hypothesis.get(req.params.id!) as unknown as Hypothesis | undefined;
    if (!hypothesis || hypothesis.tenantId !== session.tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    db.hypothesis.patch(hypothesis.id, { status: 'running', testPlan: { ...hypothesis.testPlan, startedAt: new Date().toISOString() } } as never);
    ok(res, { started: true, hypothesisId: hypothesis.id });
  }),
);

/** Итог теста: статистика движка (z-тест/тест Уэлча), без AI. */
telegramRouter.post(
  '/hypotheses/:id/result',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const hypothesis = db.hypothesis.get(req.params.id!) as unknown as Hypothesis | undefined;
    if (!hypothesis || hypothesis.tenantId !== session.tenantId) throw new ApiError(404, 'Гипотеза не найдена');
    const observations = Array.isArray(req.body?.observations)
      ? (req.body.observations as { variant: string; visitors: number; conversions: number }[])
      : [];
    if (observations.length < 2) throw new ApiError(422, 'Нужны данные по двум вариантам');
    const result = evaluateExperiment(observations, { expectedLiftPercent: hypothesis.expectedEffectPct, baselineRate: 0.03 });
    db.experiment.put({
      id: `exp_${Math.random().toString(36).slice(2, 10)}`,
      tenantId: session.tenantId,
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
    if (result.status === 'winner') db.hypothesis.patch(hypothesis.id, { status: 'done' } as never);
    if (result.status === 'no_difference' && result.sampleReached) db.hypothesis.patch(hypothesis.id, { status: 'rejected' } as never);
    ok(res, result);
  }),
);

/* ------------------------------ Отчёты ------------------------------ */

telegramRouter.get(
  '/reports',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const items = (db.report.list({ tenantId: session.tenantId, limit: 30 }) as unknown as ReportRecord[]).map((report) => ({
      id: report.id,
      title: report.title,
      type: report.type,
      status: report.status,
      period: `${report.periodFrom} — ${report.periodTo}`,
      createdAt: report.createdAt,
      kpis: (report.kpis ?? []).slice(0, 4),
    }));
    ok(res, { items });
  }),
);

telegramRouter.post(
  '/reports',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const { reportRequestSchema } = await import('@mark/shared');
    const input = parseBody(reportRequestSchema, { ...req.body, clientId: req.body?.clientId ?? null });
    const db = await repos();
    const tenant = db.tenant.get(session.tenantId);
    const report = await buildReport({ tenantId: session.tenantId, type: input.type, clientId: input.clientId ?? null, siteProjectId: input.siteProjectId ?? null, brand: tenant as never });
    const saved = saveReportHtml({ ...report, status: 'done', generatedAt: new Date().toISOString() });
    const stored = db.report.put({ ...report, status: 'done', generatedAt: new Date().toISOString(), filePath: saved.filePath, fileSizeBytes: saved.sizeBytes } as never) as unknown as ReportRecord;
    ok(res, { report: { id: stored.id, title: report.title, type: report.type, kpis: report.kpis, sections: (report.sections ?? []).map((section) => ({ id: section.id, title: section.title, paragraphs: section.paragraphs, bullets: section.bullets, kpis: section.kpis })) } }, 201);
  }),
);

telegramRouter.get(
  '/reports/:id/pdf',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const report = db.report.get(req.params.id!) as unknown as ReportRecord | undefined;
    if (!report || report.tenantId !== session.tenantId) throw new ApiError(404, 'Отчёт не найден');
    const pdf = await renderReportPdf(report);
    if (pdf) {
      res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${report.id}.pdf"`).send(pdf);
      return;
    }
    res.type('html').send('<p>PDF недоступен на этом сервере — установите Chromium или скачайте HTML-версию.</p>');
  }),
);

telegramRouter.get(
  '/reports/:id/html',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const report = db.report.get(req.params.id!) as unknown as ReportRecord | undefined;
    if (!report || report.tenantId !== session.tenantId) throw new ApiError(404, 'Отчёт не найден');
    if (report.filePath && (await import('node:fs')).existsSync(report.filePath)) {
      res.type('text/html').send((await import('node:fs')).readFileSync(report.filePath));
      return;
    }
    const { renderReportHtml } = await import('../services/reports/renderer.js');
    res.type('text/html').send(renderReportHtml(report));
  }),
);

/* ------------------------------ Баланс и СБП ------------------------------ */

telegramRouter.get(
  '/balance',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const balance = await getBalance(session.tenantId);
    const [transactions, payments, spend] = await Promise.all([listTransactions(session.tenantId), listPayments(session.tenantId, 10), spendSummary(session.tenantId)]);
    ok(res, {
      ...balance,
      transactions,
      payments,
      plans: PAYMENT_PLANS,
      spend,
      limits: { min: 500, max: 500_000 },
    });
  }),
);

telegramRouter.post(
  '/payments/create',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const input = parseBody(paymentCreateSchema, req.body);
    const payment = await createPayment(session.tenantId, input.amount, { comment: input.comment });
    ok(res, payment, 201);
  }),
);

telegramRouter.get(
  '/payments/:id/status',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const payment = await checkPayment(session.tenantId, req.params.id!);
    const balance = await getBalance(session.tenantId);
    ok(res, { status: payment.status, payment, balance: balance.balance });
  }),
);

/** Подтверждение платежа: в тестовом режиме — владельцем, в боевом — вебхуком банка. */
telegramRouter.post(
  '/payments/confirm',
  ah(async (req, res) => {
    const session = await currentSession(req);
    if (session.role === 'viewer') throw new ApiError(403, 'Недостаточно прав');
    const input = parseBody(paymentConfirmSchema, req.body);
    const payment = await confirmPayment(session.tenantId, input.paymentId, `подтверждено ${session.firstName ?? 'пользователем'}`);
    const balance = await getBalance(session.tenantId);
    ok(res, { payment, balance: balance.balance });
  }),
);

telegramRouter.post(
  '/plans/activate',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const input = parseBody(planActivateSchema, req.body);
    const result = await activatePlan(session.tenantId, input.planId, input.months);
    if (!result.ok) throw new ApiError(422, result.error ?? 'Не удалось активировать тариф');
    ok(res, result);
  }),
);

/* ------------------------------ Настройки ------------------------------ */

telegramRouter.get(
  '/settings',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const tenant = db.tenant.get(session.tenantId);
    const settings = db.kv.get<Record<string, unknown>>(`settings:${session.tenantId}`) ?? {};
    ok(res, {
      tenant: { id: session.tenantId, agencyName: tenant?.agencyName ?? 'AI Маркетолог', brandColor: tenant?.brandColor ?? '#0A84FF', logoDataUrl: tenant?.logoDataUrl ?? null, hideMarkBranding: Boolean(tenant?.hideMarkBranding) },
      settings,
      role: session.role,
      verified: session.verified,
      bot: ((): TelegramBotStatus => {
        const manager = telegramBots.get(session.tenantId);
        return {
          enabled: Boolean(manager),
          running: manager?.status.running ?? false,
          username: manager?.status.username ?? process.env.MARK_TELEGRAM_BOT_USERNAME ?? null,
          botName: manager?.status.botName ?? null,
          webAppUrl: process.env.MARK_PUBLIC_URL ? `${process.env.MARK_PUBLIC_URL.replace(/\/$/, '')}/app/` : null,
          tokenSource: manager?.status.tokenSource ?? 'none',
          chats: manager?.status.chats ?? 0,
          commands: manager?.status.commands ?? [],
        };
      })(),
      ai: await aiStatus(session.tenantId),
      notifications: { enabled: true },
      env: { demoMode: config.demoMode, dataDir: config.dataDir, version: '1.0.0' },
    });
  }),
);

telegramRouter.patch(
  '/settings',
  ah(async (req, res) => {
    const session = await currentSession(req);
    if (session.role === 'viewer') throw new ApiError(403, 'Недостаточно прав');
    const db = await repos();
    const patch: Record<string, unknown> = {};
    for (const key of ['reportEmail', 'telegramChatId', 'appName'] as const) {
      if (typeof req.body?.[key] === 'string') patch[key] = req.body[key];
    }
    for (const key of ['autoOptimizationEnabled', 'botProtectionEnabled', 'geoEnabled'] as const) {
      if (typeof req.body?.[key] === 'boolean') patch[key] = req.body[key];
    }
    const current = db.kv.get<Record<string, unknown>>(`settings:${session.tenantId}`) ?? {};
    const next = { ...current, ...patch, tenantId: session.tenantId, updatedAt: new Date().toISOString() };
    db.kv.set(`settings:${session.tenantId}`, next);
    if (typeof req.body?.agencyName === 'string' && req.body.agencyName.trim().length > 1) {
      db.tenant.patch(session.tenantId, { agencyName: req.body.agencyName.trim().slice(0, 120) } as never);
    }
    ok(res, next);
  }),
);

/** Диагностика приложения: что подключено и что работает. */
telegramRouter.get(
  '/diagnostics',
  ah(async (req, res) => {
    const session = await currentSession(req);
    const db = await repos();
    const accounts = db.account.list({ tenantId: session.tenantId, limit: 300 }) as unknown as ConnectedAccount[];
    const clients = db.client.list({ tenantId: session.tenantId, limit: 100 }) as unknown as Client[];
    ok(res, {
      counts: {
        clients: clients.length,
        accounts: accounts.length,
        sites: db.siteProject.count({ tenantId: session.tenantId }),
        campaigns: db.campaign.count({ tenantId: session.tenantId }),
        hypotheses: db.hypothesis.count({ tenantId: session.tenantId }),
        reports: db.report.count({ tenantId: session.tenantId }),
        scans: db.botScan.count({ tenantId: session.tenantId }),
      },
      connections: accounts.map((account) => ({ serviceId: account.serviceId, label: account.label, status: account.status, sandbox: account.sandbox, lastError: account.lastError ?? null })),
      bot: { running: Boolean(telegramBots.get(session.tenantId)), publicUrl: process.env.MARK_PUBLIC_URL ?? null },
      env: { demoMode: config.demoMode, allowOutbound: config.allowOutbound, dryRunAlways: config.dryRunAlways },
    });
  }),
);
