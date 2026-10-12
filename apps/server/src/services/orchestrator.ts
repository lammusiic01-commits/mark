import type { BotScan, Campaign, SiteProject } from '@mark/shared';
import { randomId } from '../crypto.js';
import { repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';
import { buildPatchBundle } from './site/autofix.js';
import { runAudit } from './site/audit.js';
import { scanLogs } from './bots/scan.js';
import { analyzeGeo, buildGeoPlan } from './geo/analyzer.js';
import { analyzeMarket } from './market/analyzer.js';
import { generateHypotheses, toHypothesis } from './hypotheses.js';
import { buildReport } from './reports/builder.js';
import { renderReportHtml, saveReportHtml } from './reports/renderer.js';
import { getDirectCredentials } from './campaigns.js';
import { runRule } from './scheduler.js';

/**
 * Оркестратор: выполняет цепочку задач «одной кнопкой».
 *
 * Типовой полный цикл агентства:
 *   audit → autofix (preview) → geo → market → hypotheses → bot_scan → report.
 *
 * Каждый шаг публикует прогресс в канал run:<id>, поэтому UI показывает
 * живую ленту, а результаты складываются в базу.
 */

const log = rootLogger.child('orchestrator');

export type TaskType = 'audit' | 'bot_scan' | 'geo_analysis' | 'market_analysis' | 'hypotheses' | 'report' | 'autofix' | 'schedule_run';

export interface OrchestrateTask {
  type: TaskType;
  params?: Record<string, unknown>;
}

export interface OrchestrateOptions {
  tenantId: string;
  clientId: string;
  tasks: OrchestrateTask[];
  dryRun?: boolean;
  /** Внешний идентификатор прогона (нужен, чтобы UI заранее знал канал run:<id>). */
  runId?: string;
}

export interface OrchestrateStep {
  task: TaskType;
  status: 'done' | 'failed' | 'skipped';
  summary: string;
  entityId?: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface OrchestrateResult {
  id: string;
  steps: OrchestrateStep[];
  status: 'done' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string;
}

export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const db = await repos();
  const runId = options.runId ?? randomId('orch');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const steps: OrchestrateStep[] = [];
  const emit = (type: string, payload: unknown) => hub.publish(channels.run(runId), type, payload);

  const client = db.client.get(options.clientId);
  const siteProjects = db.siteProject.list({ tenantId: options.tenantId, clientId: options.clientId, limit: 20 }).map((item) => item as unknown as SiteProject);
  const site = (options.tasks.find((task) => task.params?.siteProjectId)?.params?.siteProjectId as string | undefined)
    ? siteProjects.find((item) => item.id === options.tasks.find((task) => task.params?.siteProjectId)?.params?.siteProjectId)
    : siteProjects[0];

  emit('started', { runId, tasks: options.tasks.map((task) => task.type), client: client?.name ?? null, site: site?.name ?? null });

  let auditResult: Awaited<ReturnType<typeof runAudit>> | null = null;
  let geoResult: Awaited<ReturnType<typeof analyzeGeo>> | null = null;
  let marketResult: Awaited<ReturnType<typeof analyzeMarket>> | null = null;
  let botResult: Awaited<ReturnType<typeof scanLogs>> | null = null;

  for (const task of options.tasks) {
    const stepStart = Date.now();
    emit('step', { task: task.type, status: 'running' });
    try {
      switch (task.type) {
        case 'audit': {
          if (!site) throw new Error('Не найден проект сайта для аудита');
          auditResult = await runAudit({
            url: site.url,
            maxPages: Number(task.params?.maxPages ?? 25),
            keywords: site.keywords ?? [],
            regions: site.regions ?? [],
            emit: (type, payload) => emit('progress', { task: 'audit', type, payload }),
          });
          const saved = db.audit.put({
            ...auditResult,
            tenantId: options.tenantId,
            clientId: options.clientId,
            siteProjectId: site.id,
          } as never);
          db.siteProject.patch(site.id, { seoScore: auditResult.score, lastAuditId: saved.id, lastAuditAt: auditResult.finishedAt } as never);
          steps.push({
            task: 'audit',
            status: 'done',
            entityId: saved.id,
            summary: `Аудит ${site.url}: балл ${auditResult.score}/100 (${auditResult.grade}), замечаний ${auditResult.findings.length}`,
            details: { score: auditResult.score, findings: auditResult.findings.length, pages: auditResult.pagesCrawled },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'autofix': {
          if (!site) throw new Error('Не найден проект сайта для автоисправлений');
          if (!auditResult) {
            const latest = db.audit.list({ tenantId: options.tenantId, clientId: options.clientId, limit: 1 })[0];
            auditResult = latest ? (latest as never) : null;
          }
          if (!auditResult) throw new Error('Сначала нужен аудит: автоисправления строятся на его замечаниях');
          const bundle = buildPatchBundle({
            siteUrl: site.url,
            siteName: site.name,
            findings: auditResult.findings,
            keywords: site.keywords ?? [],
            regions: (site.regions ?? []).map((id) => ({ id, name: String(id) })),
          });
          const saved = db.patchBundle.put({ ...bundle, tenantId: options.tenantId, clientId: options.clientId, siteProjectId: site.id } as never);
          steps.push({
            task: 'autofix',
            status: 'done',
            entityId: saved.id,
            summary: `Пакет исправлений: ${bundle.files.length} файлов, ${bundle.connectorPlan.length} шагов применения`,
            details: { files: bundle.files.length, steps: bundle.connectorPlan.length },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'geo_analysis': {
          const credentials = await getDirectCredentials(db, options.tenantId);
          const keywords = (task.params?.keywords as string[] | undefined) ?? site?.keywords ?? [];
          if (!keywords.length) throw new Error('Нужны ключевые слова: добавьте их в проект сайта или передайте в задаче');
          geoResult = await analyzeGeo({
            keywords,
            regionIds: (task.params?.regionIds as number[] | undefined) ?? site?.regions ?? [213],
            niche: client?.name,
            token: credentials?.token,
            login: credentials?.login,
            useLive: Boolean(credentials && !credentials.sandbox) && !options.dryRun,
            siteUrl: site?.url,
          });
          const saved = db.geoAnalysis.put({
            ...geoResult,
            tenantId: options.tenantId,
            clientId: options.clientId,
            siteProjectId: site?.id ?? null,
          } as never);
          steps.push({
            task: 'geo_analysis',
            status: 'done',
            entityId: saved.id,
            summary: `GEO-анализ: ${geoResult.demandByRegion.length} регионов, спрос ${geoResult.totalDemand.toLocaleString('ru-RU')}/мес`,
            details: { regions: geoResult.demandByRegion.length, demand: geoResult.totalDemand, simulated: geoResult.simulated },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'market_analysis': {
          const credentials = await getDirectCredentials(db, options.tenantId);
          marketResult = await analyzeMarket({
            niche: (task.params?.niche as string | undefined) ?? client?.name,
            keywords: (task.params?.keywords as string[] | undefined) ?? site?.keywords ?? [],
            regionId: (task.params?.regionId as number | undefined) ?? (site?.regions?.[0] ?? 213),
            yourCpc: (task.params?.yourCpc as number | undefined) ?? null,
            budget: (task.params?.budget as number | undefined) ?? client?.monthlyBudget ?? null,
            token: credentials?.token,
            login: credentials?.login,
            useLive: Boolean(credentials && !credentials.sandbox) && !options.dryRun,
          });
          const saved = db.marketAnalysis.put({
            ...marketResult,
            tenantId: options.tenantId,
            clientId: options.clientId,
            siteProjectId: site?.id ?? null,
          } as never);
          steps.push({
            task: 'market_analysis',
            status: 'done',
            entityId: saved.id,
            summary: `Market: ниша ${marketResult.niche}, CPC ${marketResult.nicheCpc} ₽${marketResult.gapPercent !== null ? `, отклонение ${marketResult.gapPercent}%` : ''}`,
            details: { nicheCpc: marketResult.nicheCpc, gapPercent: marketResult.gapPercent },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'hypotheses': {
          const drafts = generateHypotheses({
            audit: auditResult ?? undefined,
            geo: geoResult ?? undefined,
            market: marketResult ?? undefined,
            botScan: (botResult ?? undefined) as BotScan | undefined,
            count: Number(task.params?.count ?? 8),
            niche: client?.name,
            siteName: site?.name,
          });
          const created = drafts.map((draft) =>
            db.hypothesis.put(
              toHypothesis(draft, {
                tenantId: options.tenantId,
                clientId: options.clientId,
                siteProjectId: site?.id ?? null,
              }) as never,
            ),
          );
          steps.push({
            task: 'hypotheses',
            status: 'done',
            summary: `Создано гипотез: ${created.length} (средний ICE ${(created.reduce((acc, item) => acc + Number((item as { ice?: number }).ice ?? 0), 0) / Math.max(created.length, 1)).toFixed(1)})`,
            details: { created: created.map((item) => item.id) },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'bot_scan': {
          const logContent = task.params?.logContent as string | undefined;
          if (!logContent) {
            throw new Error(
              'Для бот-анализа нужен файл логов: передайте logContent (или загрузите его в разделе BotShield). Автоматическая выгрузка логов с хостинга появится при подключённом FTP/SFTP-коннекторе.',
            );
          }
          botResult = await scanLogs({
            content: logContent,
            format: (task.params?.format as 'nginx' | 'apache' | 'json' | 'cloudflare' | 'auto') ?? 'auto',
            costPerGb: Number(task.params?.costPerGb ?? 6),
            valuePerVisit: Number(task.params?.valuePerVisit ?? 22),
            verifyDns: Boolean(task.params?.verifyDns ?? false),
            emit: (type, payload) => emit('progress', { task: 'bot_scan', type, payload }),
          });
          const saved = db.botScan.put({
            ...botResult,
            tenantId: options.tenantId,
            clientId: options.clientId,
            siteProjectId: site?.id ?? null,
          } as never);
          steps.push({
            task: 'bot_scan',
            status: 'done',
            entityId: saved.id,
            summary: `BotShield: чистота ${botResult.cleanlinessScore}/100, подозрительных запросов ${botResult.totals.suspiciousRequests.toLocaleString('ru-RU')}`,
            details: { cleanliness: botResult.cleanlinessScore, wasted: botResult.totals.wastedMoneyEstimate },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'report': {
          const type = (task.params?.type as 'summary' | 'seo' | 'geo' | 'bot' | 'market' | 'campaigns' | 'hypotheses' | undefined) ?? 'summary';
          const report = await buildReport({
            tenantId: options.tenantId,
            type,
            clientId: options.clientId,
            siteProjectId: site?.id ?? null,
          });
          const saved = saveReportHtml({ ...report, status: 'done', generatedAt: new Date().toISOString() });
          const stored = db.report.put({ ...report, status: 'done', generatedAt: new Date().toISOString(), filePath: saved.filePath, fileSizeBytes: saved.sizeBytes } as never);
          steps.push({
            task: 'report',
            status: 'done',
            entityId: stored.id,
            summary: `Отчёт «${report.title}» готов (${report.sections.length} разделов)`,
            details: { file: saved.filePath, sizeBytes: saved.sizeBytes },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        case 'schedule_run': {
          const ruleId = task.params?.ruleId as string | undefined;
          if (!ruleId) {
            const rule = db.scheduleRule.list({ tenantId: options.tenantId, clientId: options.clientId, limit: 5 })[0];
            if (!rule) throw new Error('Нет настроенных правил автооптимизации');
            const result = await runRule(options.tenantId, rule.id, { dryRun: options.dryRun });
            steps.push({
              task: 'schedule_run',
              status: 'done',
              entityId: String(rule.id),
              summary: `Правило «${rule.name}»: ${result.summary}`,
              details: { changed: result.changed, status: result.status },
              durationMs: Date.now() - stepStart,
            });
            break;
          }
          const result = await runRule(options.tenantId, ruleId, { dryRun: options.dryRun });
          steps.push({
            task: 'schedule_run',
            status: 'done',
            summary: `Правило выполнено: ${result.summary}`,
            details: { changed: result.changed, status: result.status },
            durationMs: Date.now() - stepStart,
          });
          break;
        }
        default:
          steps.push({ task: task.type, status: 'skipped', summary: 'Задача пропущена', durationMs: Date.now() - stepStart });
      }
      emit('step', { task: task.type, status: 'done', summary: steps[steps.length - 1]?.summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ task: task.type, status: 'failed', summary: message, durationMs: Date.now() - stepStart });
      emit('step', { task: task.type, status: 'failed', summary: message });
      if (options.dryRun) continue;
      // Продолжаем цепочку: падение одного шага не должно ломать остальные
      log.warn(`Шаг ${task.type} не выполнен`, { error: message });
    }
  }

  const failed = steps.filter((step) => step.status === 'failed').length;
  const result: OrchestrateResult = {
    id: runId,
    steps,
    status: failed === 0 ? 'done' : failed === steps.length ? 'failed' : 'partial',
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  db.events.log({
    tenantId: options.tenantId,
    type: 'orchestrator',
    level: result.status === 'done' ? 'info' : 'warn',
    message: `Цепочка задач завершена: ${steps.length} шагов, выполнено ${steps.length - failed}, ошибок ${failed}`,
    payload: { runId, steps: steps.map((step) => ({ task: step.task, status: step.status })), ms: Date.now() - started },
  });
  emit('finished', result);
  hub.publish(channels.activity, 'run:finished', result);
  log.info(`Оркестратор завершён: ${result.status}`, { runId, steps: steps.length, ms: Date.now() - started });
  return result;
}

export { renderReportHtml, Campaign };
