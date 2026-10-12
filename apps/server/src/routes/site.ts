import { Router } from 'express';
import {
  autofixSchema,
  auditRequestSchema,
  botScanSchema,
  detectPlatformSchema,
  geoAnalyzeSchema,
  geoPlanSchema,
  getService,
  marketAnalyzeSchema,
  patchApplySchema,
  siteProjectSchema,
  type AuditRun,
  type BotScan,
  type GeoAnalysis,
  type GeoPlan,
  type PageSnapshot,
  type PatchBundle,
  type PatchFile,
  type PlatformId,
  type SiteProject,
} from '@mark/shared';
import { randomId } from '../crypto.js';
import { repos } from '../db/repos.js';
import { ApiError, ah, currentTenantId, ok, parseBody } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';
import { scanLogs } from '../services/bots/scan.js';
import { analyzeGeo, buildGeoPlan } from '../services/geo/analyzer.js';
import { analyzeMarket } from '../services/market/analyzer.js';
import { buildPatchBundle, summarizeAutofix } from '../services/site/autofix.js';
import { runAudit } from '../services/site/audit.js';
import {
  cloudflareBotRules,
  cloudflareRedirects,
  connectorSecrets,
  exportBundleToDisk,
  githubCommitFiles,
  gscSubmitSitemap,
  indexNowSubmit,
  netlifyBuild,
  planForConnector,
  sftpUploadFiles,
  tildaApply,
  vercelRedeploy,
  wordpressApply,
  yandexWebmasterSubmit,
  type ApplyStep,
} from '../services/site/connectors.js';
import { crawlSite } from '../services/site/crawler.js';
import { detectPlatform } from '../services/site/detect.js';

/**
 * Сайт: определение платформы, краул, SEO-аудит, автоисправления,
 * GEO-анализ и план, Market Analyzer, BotShield, индексация.
 */

const log = rootLogger.child('routes.site');
export const siteRouter = Router();

/* ------------------------------- Проекты ------------------------------- */

siteRouter.get(
  '/sites',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const clientId = (req.query.clientId as string) || undefined;
    const items = db.siteProject.list({ tenantId, clientId, status: (req.query.status as string) || undefined, limit: 200 });
    ok(res, {
      items: items.map((site) => ({
        ...site,
        lastAuditAt: site.lastAuditAt ?? null,
        audits: db.audit.count({ tenantId, limit: 500 }),
      })),
      total: items.length,
    });
  }),
);

siteRouter.post(
  '/sites',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(siteProjectSchema, req.body);
    const db = await repos();
    const existing = db.siteProject.list({ tenantId, limit: 300 }).find((site) => site.url === input.url);
    if (existing) throw new ApiError(409, 'Такой сайт уже добавлен');

    let detection;
    try {
      detection = await detectPlatform(input.url);
    } catch {
      detection = null;
    }

    const project = db.siteProject.put({
      id: randomId('site'),
      tenantId,
      clientId: input.clientId ?? null,
      name: input.name,
      url: input.url,
      platform: (input.platform as PlatformId) ?? detection?.platform ?? 'custom',
      platformConfidence: detection?.confidence ?? 40,
      platformEvidence: detection?.evidence ?? ['Платформа не определена автоматически — выберите коннектор вручную'],
      connectorId: input.connectorId ?? detection?.recommendedConnectors[0] ?? 'manual-patch',
      accountId: input.accountId ?? null,
      goals: input.goals,
      regions: input.regions,
      keywords: input.keywords,
      seoScore: null,
      lastAuditId: null,
      lastAuditAt: null,
      geoStatus: 'none',
      status: 'active',
      notes: input.notes ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    db.events.log({ tenantId, type: 'site', level: 'info', message: `Добавлен сайт ${project.name} (${project.url})`, payload: { siteId: project.id } });
    ok(res, { site: project, detection }, 201);
  }),
);

siteRouter.get(
  '/sites/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');
    ok(res, {
      site,
      audits: db.audit.list({ tenantId, limit: 10 }).filter((run) => run.siteProjectId === site.id),
      geo: db.geoAnalysis.list({ tenantId, clientId: site.clientId ?? undefined, limit: 3 }),
      plans: db.geoPlan.list({ tenantId, limit: 3 }).filter((plan) => plan.siteProjectId === site.id),
      patches: db.patchBundle.list({ tenantId, limit: 10 }).filter((bundle) => bundle.siteProjectId === site.id),
      botScans: db.botScan.list({ tenantId, limit: 5 }).filter((scan) => scan.siteProjectId === site.id),
    });
  }),
);

siteRouter.patch(
  '/sites/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');
    const patch = parseBody(siteProjectSchema.partial(), req.body);
    ok(res, db.siteProject.patch(site.id, patch as never));
  }),
);

siteRouter.delete(
  '/sites/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');
    db.siteProject.delete(site.id);
    ok(res, { deleted: site.id });
  }),
);

/* --------------------------- Определение и краул --------------------------- */

siteRouter.post(
  '/sites/detect',
  ah(async (req, res) => {
    const input = parseBody(detectPlatformSchema, req.body);
    const detection = await detectPlatform(input.url);
    ok(res, detection);
  }),
);

siteRouter.post(
  '/sites/inspect',
  ah(async (req, res) => {
    const body = req.body as { url?: string; maxPages?: number };
    if (!body?.url) throw new ApiError(422, 'Укажите url сайта');
    const url = /^https?:\/\//i.test(body.url) ? body.url : `https://${body.url}`;
    const [detection, crawl] = await Promise.all([
      detectPlatform(url),
      crawlSite(url, { maxPages: Math.min(Number(body.maxPages ?? 12), 40) }),
    ]);
    ok(res, {
      detection,
      robots: crawl.robots,
      robotsTxtRaw: crawl.robotsTxtRaw,
      sitemaps: crawl.sitemaps,
      pages: crawl.pages.map((page) => ({
        url: page.url,
        status: page.status,
        title: page.title,
        description: page.description,
        h1: page.h1.length,
        words: page.wordCount,
        bytes: page.htmlBytes,
        ttfbMs: page.ttfbMs,
        isHttps: page.isHttps,
      })),
      errors: crawl.errors,
      blockedByRobots: crawl.blockedByRobots,
      durationMs: crawl.durationMs,
    });
  }),
);

/* --------------------------------- Аудит --------------------------------- */

siteRouter.post(
  '/sites/:id/audit',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(auditRequestSchema.omit({ siteProjectId: true }), req.body);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');

    const auditId = randomId('audit');
    ok(res, { auditRunId: auditId, channel: channels.audit(auditId) }, 202);

    void (async () => {
      try {
        const audit = await runAudit({
          url: site.url,
          maxPages: input.maxPages,
          includeSubdomains: input.includeSubdomains,
          runPsi: input.runPsi,
          keywords: site.keywords,
          regions: site.regions,
          emit: (type, payload) => {
            hub.publish(channels.audit(auditId), type, payload);
          },
        });
        const saved = db.audit.put({
          ...audit,
          id: auditId,
          tenantId,
          clientId: site.clientId ?? null,
          siteProjectId: site.id,
        } as never);
        db.siteProject.patch(site.id, { seoScore: audit.score, lastAuditId: auditId, lastAuditAt: audit.finishedAt ?? new Date().toISOString() } as never);
        db.events.log({
          tenantId,
          type: 'audit',
          level: audit.summary.critical ? 'warn' : 'info',
          message: `Аудит ${site.name}: ${audit.score}/100 (${audit.grade}), критичных ${audit.summary.critical}`,
          payload: { auditId, score: audit.score, findings: audit.findings.length },
        });
        hub.publish(channels.audit(auditId), 'done', { auditId, score: audit.score, grade: audit.grade, summary: audit.summary, runId: saved.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.audit.put({
          id: auditId,
          tenantId,
          clientId: site.clientId ?? null,
          siteProjectId: site.id,
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          baseUrl: site.url,
          error: message,
        } as never);
        hub.publish(channels.audit(auditId), 'failed', { auditId, error: message });
        log.error('Аудит упал', { site: site.url, error: message });
      }
    })();
  }),
);

siteRouter.get(
  '/audits',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const items = db.audit.list({ tenantId, clientId: (req.query.clientId as string) || undefined, limit: Number(req.query.limit ?? 50) });
    ok(res, {
      items: items.map((audit) => ({
        id: audit.id,
        siteProjectId: audit.siteProjectId,
        status: audit.status,
        score: audit.score,
        grade: audit.grade,
        baseUrl: audit.baseUrl,
        pagesCrawled: audit.pagesCrawled,
        summary: audit.summary,
        startedAt: audit.startedAt,
        finishedAt: audit.finishedAt,
      })),
    });
  }),
);

siteRouter.get(
  '/audits/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const audit = db.audit.get(req.params.id!);
    if (!audit || audit.tenantId !== tenantId) throw new ApiError(404, 'Аудит не найден');
    ok(res, audit);
  }),
);

/* ----------------------------- Автоисправления ----------------------------- */

siteRouter.post(
  '/sites/:id/autofix',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(autofixSchema, req.body);
    const db = await repos();
    const site = db.siteProject.get(req.params.id!);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');

    const audit = input.auditRunId
      ? db.audit.get(input.auditRunId)
      : db.audit.list({ tenantId, limit: 20 }).find((run) => run.siteProjectId === site.id);
    if (!audit) throw new ApiError(422, 'Сначала выполните аудит сайта — исправлять пока нечего');

    const findings = (audit.findings ?? []).filter((finding) => input.findingCodes.includes(finding.code));
    if (!findings.length) throw new ApiError(422, 'Ни одна из выбранных проблем не найдена в аудите');

    const geoPlan = db.geoPlan.list({ tenantId, limit: 10 }).find((plan) => plan.siteProjectId === site.id) as GeoPlan | undefined;
    const bundle = buildPatchBundle({
      siteUrl: site.url,
      siteName: site.name,
      findings,
      pages: (audit.pages ?? []) as PageSnapshot[],
      geoPlan: geoPlan ?? null,
      keywords: site.keywords,
      regions: [],
      niche: site.keywords[0],
      contact: {},
    });

    const saved = db.patchBundle.put({ ...bundle, tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
    const connectorId = input.connectorId ?? site.connectorId ?? 'manual-patch';
    const steps = planForConnector(connectorId, bundle);
    let exported: { dir: string; files: string[] } | null = null;

    if (input.mode === 'apply') {
      const account = input.accountId ? db.account.get(input.accountId) : site.accountId ? db.account.get(site.accountId) : undefined;
      const run = await applyBundle({
        tenantId,
        connectorId,
        bundle,
        account,
        dryRun: input.dryRunAlways || db.kv.get<{ demoMode?: boolean }>(`settings:${tenantId}`)?.demoMode === true,
        manualOnly: false,
      });
      exported = run.exported;
      db.autofixRun.put({
        id: randomId('fix'),
        tenantId,
        clientId: site.clientId ?? null,
        siteProjectId: site.id,
        bundleId: saved.id,
        steps: run.steps.map((step) => ({ id: randomId('step'), title: step.step, connectorId: step.connectorId, status: step.ok ? 'done' : 'failed', message: step.detail })),
        exported,
        summary: summarizeAutofix(findings),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never);
      db.siteProject.patch(site.id, { geoStatus: geoPlan ? 'applied' : site.geoStatus } as never);
      ok(res, { bundle: saved, plan: steps, applied: run, exported });
      return;
    }

    exported = exportBundleToDisk(bundle);
    ok(res, {
      bundle: saved,
      summary: summarizeAutofix(findings),
      plan: steps,
      exported,
      hint: 'Проверьте файлы и нажмите «Применить», чтобы MARK внёс изменения на сайт через коннектор.',
    });
  }),
);

interface ApplyBundleOptions {
  tenantId: string;
  connectorId: string;
  bundle: PatchBundle;
  account?: { id: string; serviceId: string } | undefined;
  dryRun?: boolean;
  manualOnly?: boolean;
  commitMessage?: string;
}

/** Применение набора правок через выбранный коннектор. */
async function applyBundle(options: ApplyBundleOptions): Promise<{ ok: boolean; steps: ApplyStep[]; filesWritten: string[]; exported: { dir: string; files: string[] } | null }> {
  const { bundle, connectorId } = options;
  const secrets = await connectorSecrets(options.account as never);
  const dryRun = Boolean(options.dryRun);
  const steps: ApplyStep[] = [];

  const files: PatchFile[] = bundle.files;
  const headInjections = (bundle as unknown as { headInjections?: Record<string, string> }).headInjections ?? {};
  const metaUpdates = (bundle as unknown as { metaUpdates?: { url: string; title?: string; description?: string; robots?: string }[] }).metaUpdates ?? [];

  try {
    if (options.manualOnly || connectorId === 'manual-patch') {
      steps.push({ step: 'Ручное применение', connectorId: 'manual-patch', ok: true, dryRun: true, detail: 'Файлы подготовлены и выгружены на диск вместе с README.md' });
    } else if (connectorId === 'github' || connectorId === 'vercel' || connectorId === 'netlify') {
      if (secrets.token && secrets.owner && secrets.repo) {
        steps.push(...(await githubCommitFiles({ token: secrets.token, owner: secrets.owner, repo: secrets.repo, branch: secrets.branch, files, message: options.commitMessage ?? `MARK: SEO/GEO-правки (${bundle.id})`, dryRun })));
      } else if (connectorId === 'netlify') {
        steps.push(...(await netlifyBuild({ token: secrets.token, siteId: secrets.siteId, buildHookUrl: secrets.buildHookUrl, dryRun })));
      } else if (connectorId === 'vercel') {
        steps.push(...(await vercelRedeploy({ token: secrets.token ?? '', teamId: secrets.teamId, projectId: secrets.projectId, deployHookUrl: secrets.deployHookUrl, dryRun })));
      } else {
        steps.push({ step: 'GitHub', connectorId: 'github', ok: false, dryRun, detail: 'Не заполнены token/owner/repo — правки выгружены на диск' });
      }
      if (secrets.token && secrets.owner && secrets.repo && connectorId === 'vercel') {
        steps.push(...(await vercelRedeploy({ token: secrets.vercelToken ?? '', teamId: secrets.teamId, projectId: secrets.projectId, deployHookUrl: secrets.deployHookUrl, dryRun })));
      }
      if (secrets.token && secrets.owner && secrets.repo && connectorId === 'netlify') {
        steps.push(...(await netlifyBuild({ token: secrets.netlifyToken, siteId: secrets.siteId, buildHookUrl: secrets.buildHookUrl, dryRun })));
      }
    } else if (connectorId === 'ftp' || connectorId === 'ftp-hosting') {
      const { ftpUploadFiles } = await import('../services/site/connectors.js');
      steps.push(...(await ftpUploadFiles({ host: secrets.host ?? '', port: Number(secrets.port ?? 21), user: secrets.user ?? '', password: secrets.password ?? '', root: secrets.root, files, dryRun })));
    } else if (connectorId === 'sftp' || connectorId === 'sftp-hosting') {
      steps.push(...(await sftpUploadFiles({ host: secrets.host ?? '', port: Number(secrets.port ?? 22), user: secrets.user ?? '', password: secrets.password, privateKey: secrets.privateKey, root: secrets.root, files, dryRun })));
    } else if (connectorId === 'wordpress-rest' || connectorId === 'wordpress') {
      steps.push(
        ...(await wordpressApply({
          siteUrl: secrets.siteUrl ?? secrets.baseUrl ?? '',
          username: secrets.user ?? secrets.username ?? '',
          appPassword: secrets.appPassword ?? secrets.password ?? '',
          metaUpdates,
          dryRun,
        })),
      );
    } else if (connectorId === 'tilda-browser' || connectorId === 'tilda') {
      steps.push(
        ...(await tildaApply({
          accountId: options.account?.id ?? '',
          projectId: secrets.projectId,
          metaUpdates,
          headHtml: Object.values(headInjections).join('\n'),
          dryRun,
        })),
      );
    } else if (connectorId === 'cloudflare') {
      const redirects = bundle.files.find((file) => file.path.toLowerCase().includes('redirect'));
      if (redirects && secrets.token && secrets.zoneId) {
        steps.push(...(await cloudflareRedirects({ token: secrets.token, zoneId: secrets.zoneId, redirects: parseRedirects(redirects.content), dryRun })));
      }
      const nginx = bundle.files.find((file) => file.path.includes('nginx') || file.path.includes('bots'));
      if (nginx && secrets.token && secrets.zoneId) {
        steps.push(...(await cloudflareBotRules({ token: secrets.token, zoneId: secrets.zoneId, expression: nginx.content, dryRun })));
      }
      if (!steps.length) steps.push({ step: 'Cloudflare', connectorId: 'cloudflare', ok: false, dryRun, detail: 'Не заполнены token/zoneId' });
    } else if (connectorId === 'indexnow') {
      steps.push(...(await indexNowSubmit({ key: secrets.key ?? secrets.token ?? '', host: secrets.host ?? '', urls: bundle.verification.slice(0, 10), dryRun })));
    } else if (connectorId === 'yandex-webmaster') {
      steps.push(
        ...(await yandexWebmasterSubmit({
          token: secrets.token ?? '',
          userId: Number(secrets.userId ?? 0),
          hostId: secrets.hostId ?? '',
          sitemapUrl: bundle.files.find((file) => file.path.endsWith('sitemap.xml'))?.path ?? 'sitemap.xml',
          urls: [],
          dryRun,
        })),
      );
    } else if (connectorId === 'google-search-console') {
      steps.push(...(await gscSubmitSitemap({ accessToken: secrets.accessToken ?? secrets.token ?? '', siteUrl: secrets.siteUrl ?? '', sitemapUrl: 'sitemap.xml', dryRun })));
    } else {
      steps.push({ step: `Коннектор ${connectorId}`, connectorId, ok: false, dryRun, detail: 'Для этого коннектора нет прямого применения — используйте план и файлы ниже' });
    }
  } catch (error) {
    steps.push({
      step: `Коннектор ${connectorId}`,
      connectorId,
      ok: false,
      dryRun,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const exported = exportBundleToDisk(bundle);
  const okAll = steps.every((step) => step.ok) || (steps.length > 0 && steps.some((step) => step.ok));
  return { ok: okAll, steps, filesWritten: exported.files, exported };
}

siteRouter.get(
  '/patches/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const bundle = db.patchBundle.get(req.params.id!);
    if (!bundle || bundle.tenantId !== tenantId) throw new ApiError(404, 'Набор правок не найден');
    ok(res, bundle);
  }),
);

siteRouter.post(
  '/patches/:id/apply',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(patchApplySchema.omit({ bundleId: true }), req.body);
    const db = await repos();
    const bundle = db.patchBundle.get(req.params.id!);
    if (!bundle || bundle.tenantId !== tenantId) throw new ApiError(404, 'Набор правок не найден');
    const account = input.accountId ? db.account.get(input.accountId) : undefined;
    const run = await applyBundle({
      tenantId,
      connectorId: input.connectorId,
      bundle,
      account,
      dryRun: input.mode === 'preview',
      commitMessage: input.commitMessage,
    });
    db.events.log({
      tenantId,
      type: 'autofix',
      level: run.steps.some((step) => step.ok) ? 'success' : 'warn',
      message: `Применение правок ${bundle.id} через ${input.connectorId}: ${run.steps.filter((s) => s.ok).length}/${run.steps.length} шагов`,
      payload: { bundleId: bundle.id },
    });
    ok(res, run);
  }),
);

/* --------------------------------- GEO --------------------------------- */

siteRouter.post(
  '/geo/analyze',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(geoAnalyzeSchema, req.body);
    const db = await repos();
    const site = input.siteProjectId ? db.siteProject.get(input.siteProjectId) : undefined;
    if (input.siteProjectId && (!site || site.tenantId !== tenantId)) throw new ApiError(404, 'Сайт не найден');

    const live = input.useLive && Boolean(site?.accountId);
    const account = site?.accountId ? db.account.get(site.accountId) : undefined;
    const secrets = await connectorSecrets(account);

    const analysis = await analyzeGeo({
      keywords: input.keywords ?? site?.keywords ?? [],
      regionIds: input.regionIds ?? site?.regions ?? [213],
      niche: site?.keywords[0],
      token: secrets.token,
      login: secrets.login,
      useLive: live,
      siteUrl: site?.url,
    });

    const saved = db.geoAnalysis.put({ ...analysis, tenantId, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null } as never);
    db.events.log({
      tenantId,
      type: 'geo',
      level: 'info',
      message: `GEO-анализ: ${analysis.demandByRegion.length} регионов, спрос ${analysis.totalDemand.toLocaleString('ru-RU')}/мес`,
      payload: { analysisId: saved.id, source: analysis.source },
    });
    ok(res, saved, 201);
  }),
);

siteRouter.get(
  '/geo/analyses',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, { items: db.geoAnalysis.list({ tenantId, clientId: (req.query.clientId as string) || undefined, limit: Number(req.query.limit ?? 30) }) });
  }),
);

siteRouter.get(
  '/geo/analyses/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const analysis = db.geoAnalysis.get(req.params.id!);
    if (!analysis || analysis.tenantId !== tenantId) throw new ApiError(404, 'GEO-анализ не найден');
    ok(res, analysis);
  }),
);

siteRouter.post(
  '/geo/plan',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(geoPlanSchema, req.body);
    const db = await repos();
    const site = db.siteProject.get(input.siteProjectId);
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');

    let analysis = db.geoAnalysis.list({ tenantId, limit: 20 }).find((item) => (item.siteProjectId ?? null) === site.id) as GeoAnalysis | undefined;
    if (input.regionIds?.length) {
      analysis = await analyzeGeo({ keywords: input.keywords ?? site.keywords, regionIds: input.regionIds, niche: site.keywords[0], useLive: false, siteUrl: site.url });
      analysis = db.geoAnalysis.put({ ...analysis, tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
    }
    if (!analysis) throw new ApiError(422, 'Сначала выполните GEO-анализ (POST /api/geo/analyze)');

    const plan = buildGeoPlan({
      siteUrl: site.url,
      siteName: site.name,
      structure: input.structure,
      analysis,
      keywords: input.keywords ?? site.keywords,
    });
    const saved = db.geoPlan.put({ ...plan, tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
    db.siteProject.patch(site.id, { geoStatus: 'planned' } as never);
    db.events.log({ tenantId, type: 'geo', level: 'info', message: `GEO-план для ${site.name}: ${plan.pages.length} страниц`, payload: { planId: saved.id } });
    ok(res, saved, 201);
  }),
);

siteRouter.get(
  '/geo/plans/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const plan = db.geoPlan.get(req.params.id!);
    if (!plan || plan.tenantId !== tenantId) throw new ApiError(404, 'GEO-план не найден');
    ok(res, plan);
  }),
);

/* -------------------------------- Market -------------------------------- */

siteRouter.post(
  '/market/analyze',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(marketAnalyzeSchema, req.body);
    const db = await repos();
    const site = input.siteProjectId ? db.siteProject.get(input.siteProjectId) : undefined;
    if (input.siteProjectId && (!site || site.tenantId !== tenantId)) throw new ApiError(404, 'Сайт не найден');

    const campaigns = db.campaign.list({ tenantId, clientId: site?.clientId ?? undefined, limit: 50 });
    const yourCpc =
      input.yourCpc ??
      (() => {
        const clicks = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics30d?.clicks ?? 0), 0);
        const cost = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics30d?.cost ?? 0), 0);
        return clicks > 0 ? Number((cost / clicks).toFixed(2)) : null;
      })();

    const account = db.account.list({ tenantId, limit: 100 }).find((item) => item.serviceId === 'yandex-direct');
    const secrets = await connectorSecrets(account);
    const analysis = await analyzeMarket({
      niche: input.niche ?? site?.keywords[0],
      keywords: input.keywords ?? site?.keywords ?? [],
      regionId: input.regionId,
      yourCpc,
      budget: input.budget ?? null,
      token: secrets.token,
      login: secrets.login,
      useLive: false,
      siteName: site?.name,
    });

    const saved = db.marketAnalysis.put({ ...analysis, tenantId, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null } as never);
    db.events.log({ tenantId, type: 'market', level: 'info', message: `Market: ${analysis.niche}, CPC рынка ${analysis.nicheCpc} ₽, вердикт «${analysis.verdict}»`, payload: { analysisId: saved.id } });
    ok(res, saved, 201);
  }),
);

siteRouter.get(
  '/market/analyses',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, { items: db.marketAnalysis.list({ tenantId, clientId: (req.query.clientId as string) || undefined, limit: Number(req.query.limit ?? 30) }) });
  }),
);

siteRouter.get(
  '/market/analyses/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const analysis = db.marketAnalysis.get(req.params.id!);
    if (!analysis || analysis.tenantId !== tenantId) throw new ApiError(404, 'Анализ не найден');
    ok(res, analysis);
  }),
);

/* ------------------------------- BotShield ------------------------------- */

siteRouter.post(
  '/bots/scan',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const input = parseBody(botScanSchema, req.body);
    const db = await repos();
    const site = input.siteProjectId ? db.siteProject.get(input.siteProjectId) : undefined;
    if (input.siteProjectId && (!site || site.tenantId !== tenantId)) throw new ApiError(404, 'Сайт не найден');

    let content = input.logContent ?? '';
    if (!content && input.logUrl) {
      const { httpRequest } = await import('../http/client.js');
      const downloaded = await httpRequest<string>(input.logUrl, { raw: true, timeoutMs: 60_000 });
      if (downloaded.ok) content = downloaded.text;
      else throw new ApiError(400, `Не удалось скачать лог: HTTP ${downloaded.status}`);
    }
    if (!content) throw new ApiError(422, 'Передайте logContent, logUrl или используйте демо-образец');

    const scan = await scanLogs({
      content,
      format: input.format,
      verifyDns: Boolean(req.body?.verifyDns),
      costPerGb: Number(req.body?.costPerGb ?? 6),
      valuePerVisit: Number(req.body?.valuePerVisit ?? 22),
    });

    const saved = db.botScan.put({ ...scan, tenantId, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null, source: input.source } as never);
    db.events.log({
      tenantId,
      type: 'botscan',
      level: scan.cleanlinessScore < 60 ? 'warn' : 'info',
      message: `BotShield: чистота трафика ${scan.cleanlinessScore}/100, подозрительных запросов ${scan.totals.suspiciousRequests.toLocaleString('ru-RU')}`,
      payload: { scanId: saved.id, wasted: scan.totals.wastedMoneyEstimate },
    });
    ok(res, saved, 201);
  }),
);

siteRouter.get(
  '/bots/scans',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    ok(res, {
      items: db.botScan.list({ tenantId, clientId: (req.query.clientId as string) || undefined, limit: Number(req.query.limit ?? 30) }).map((scan) => ({
        id: scan.id,
        siteProjectId: scan.siteProjectId,
        status: scan.status,
        cleanlinessScore: scan.cleanlinessScore,
        totals: scan.totals,
        startedAt: scan.startedAt,
        finishedAt: scan.finishedAt,
        source: scan.source,
      })),
    });
  }),
);

siteRouter.get(
  '/bots/scans/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const scan = db.botScan.get(req.params.id!);
    if (!scan || scan.tenantId !== tenantId) throw new ApiError(404, 'Отчёт BotShield не найден');
    ok(res, scan);
  }),
);

siteRouter.post(
  '/bots/classify',
  ah(async (req, res) => {
    const ip = String(req.body?.ip ?? '').trim();
    const userAgent = String(req.body?.userAgent ?? '').trim();
    if (!ip) throw new ApiError(422, 'Укажите IP');
    const { classifySingle } = await import('../services/bots/scan.js');
    ok(res, classifySingle(ip, userAgent));
  }),
);

/* ------------------------------ Индексация ------------------------------ */

siteRouter.post(
  '/indexing/indexnow',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const siteId = String(req.body?.siteProjectId ?? '');
    const site = siteId ? db.siteProject.get(siteId) : undefined;
    if (!site || site.tenantId !== tenantId) throw new ApiError(404, 'Сайт не найден');
    const key = String(req.body?.key ?? '');
    if (!key) throw new ApiError(422, 'Укажите ключ IndexNow (файл вида <key>.txt в корне сайта)');
    const urls: string[] = Array.isArray(req.body?.urls) && req.body.urls.length ? req.body.urls.map(String) : [site.url];
    const steps = await indexNowSubmit({ key, host: new URL(site.url).host, urls, dryRun: Boolean(req.body?.dryRun) });
    ok(res, { steps });
  }),
);

siteRouter.post(
  '/indexing/recrawl',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.list({ tenantId, limit: 100 }).find((item) => item.serviceId === 'yandex-webmaster');
    if (!account) throw new ApiError(422, 'Подключите Яндекс.Вебмастер в разделе «Подключения»');
    const secrets = await connectorSecrets(account);
    const urls: string[] = Array.isArray(req.body?.urls) ? req.body.urls.map(String).slice(0, 10) : [];
    if (!urls.length) throw new ApiError(422, 'Укажите до 10 URL для переобхода');
    const steps = await yandexWebmasterSubmit({
      token: secrets.token ?? '',
      userId: Number(secrets.userId ?? 0),
      hostId: secrets.hostId ?? '',
      sitemapUrl: '',
      urls,
      dryRun: Boolean(req.body?.dryRun),
    });
    ok(res, { steps });
  }),
);

siteRouter.post(
  '/indexing/gsc-sitemap',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const account = db.account.list({ tenantId, limit: 100 }).find((item) => item.serviceId === 'google-search-console');
    if (!account) throw new ApiError(422, 'Подключите Google Search Console в разделе «Подключения»');
    const secrets = await connectorSecrets(account);
    const siteUrl = String(req.body?.siteUrl ?? secrets.siteUrl ?? '');
    const sitemapUrl = String(req.body?.sitemapUrl ?? 'sitemap.xml');
    if (!siteUrl) throw new ApiError(422, 'Укажите siteUrl (например, sc-domain:example.ru)');
    const steps = await gscSubmitSitemap({ accessToken: secrets.accessToken ?? secrets.token ?? '', siteUrl, sitemapUrl, dryRun: Boolean(req.body?.dryRun) });
    ok(res, { steps });
  }),
);

/** Разбор файла редиректов вида «/старый /новый 301» в правила Cloudflare. */
function parseRedirects(content: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    const from = parts[0]?.startsWith('/') ? parts[0] : undefined;
    const to = parts[1] && /^https?:\/\//.test(parts[1]) ? parts[1] : parts[1]?.startsWith('/') ? new URL(parts[1], 'https://placeholder.local').pathname : undefined;
    if (from && to) out.push({ from, to });
    if (out.length >= 50) break;
  }
  return out;
}

/* ------------------------------ Диагностика ------------------------------ */

siteRouter.get(
  '/diagnostics/network',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const accounts = db.account.list({ tenantId, limit: 200 });
    const services = new Map<string, { serviceId: string; label: string; lastCheckedAt?: string | null; status: string; error?: string | null }>();
    for (const account of accounts) {
      if (services.has(account.serviceId)) continue;
      const service = getService(account.serviceId);
      services.set(account.serviceId, {
        serviceId: account.serviceId,
        label: service?.name ?? account.label,
        lastCheckedAt: account.lastCheckedAt,
        status: account.status,
        error: account.lastError,
      });
    }
    const { config } = await import('../config.js');
    ok(res, {
      allowOutbound: config.allowOutbound,
      demoMode: config.demoMode,
      dryRunAlways: config.dryRunAlways,
      nodeEnv: config.nodeEnv,
      connections: [...services.values()],
      hint: accounts.length
        ? 'Проверьте подключения в разделе «Подключения» — статус обновляется при каждой проверке.'
        : 'Подключений пока нет. Начните с «Подключения» → выберите сервис → войдите в окне приложения или вставьте токен.',
    });
  }),
);

export type { ApplyStep, AuditRun, BotScan, SiteProject };
