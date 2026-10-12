import cron, { type ScheduledTask } from 'node-cron';
import type { Campaign, ScheduleChange, ScheduleRule, ScheduleRun } from '@mark/shared';
import { round } from '@mark/shared';
import { randomId } from '../crypto.js';
import { args } from '../config.js';
import { repos, type Repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';
import { channels, hub } from '../realtime.js';
import { DirectClient, getDirectCredentials, simulateMetrics, suggestBids } from './campaigns.js';
import { buildReport } from './reports/builder.js';
import { renderReportHtml, saveReportHtml } from './reports/renderer.js';
import { formatAlert, sendTelegramMessage } from './telegram.js';

/**
 * Планировщик автооптимизации.
 *
 * Правила хранятся в БД, поднимаются в node-cron при старте сервера.
 * Каждое правило: тип, cron, пороги, лимиты изменений и требование подтверждения.
 * По умолчанию изменения в реальном аккаунте требуют подтверждения (requiresApproval),
 * поэтому автооптимизация не может «сломать» кампании без ведома агентства.
 */

const log = rootLogger.child('scheduler');

const RULE_LABELS: Record<ScheduleRule['ruleType'], string> = {
  bid_up: 'Повышение ставок для эффективных фраз',
  bid_down: 'Снижение ставок при дорогом CPA',
  pause_low_ctr: 'Пауза фраз с низким CTR',
  pause_no_conversions: 'Пауза фраз без конверсий',
  budget_reallocate: 'Перераспределение бюджета',
  negative_keywords: 'Поиск мусорных запросов (минус-слова)',
  dayparting: 'Корректировки по времени дня',
  min_balance: 'Контроль баланса аккаунта',
  weekly_report: 'Еженедельный отчёт и рассылка',
};

export function ruleLabel(rule: ScheduleRule) {
  return RULE_LABELS[rule.ruleType] ?? rule.ruleType;
}

function compare(value: number, threshold: number, comparison: ScheduleRule['params']['comparison']) {
  switch (comparison) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    default:
      return false;
  }
}

export interface EvaluateResult {
  changes: ScheduleChange[];
  summary: string;
  evaluated: number;
}

/** Расчёт изменений по правилу (без применения). */
export async function evaluateRule(db: Repos, rule: ScheduleRule, campaigns: Campaign[]): Promise<EvaluateResult> {
  const changes: ScheduleChange[] = [];
  let summary = '';
  let evaluated = 0;

  for (const campaign of campaigns) {
    const metrics = campaign.metrics30d ?? simulateMetrics(campaign, 30).metrics;
    evaluated += 1;
    const name = campaign.name;

    switch (rule.ruleType) {
      case 'bid_up':
      case 'bid_down': {
        const suggestions = suggestBids(campaign, { targetCpa: rule.params.targetCpa, maxChangePercent: Math.abs(rule.params.adjustPercent) || 15 });
        const wanted = rule.ruleType === 'bid_up' ? 'raise' : 'lower';
        for (const suggestion of suggestions.filter((item) => item.action === wanted).slice(0, rule.params.maxAppliesPerRun)) {
          changes.push({
            target: `${name} → «${suggestion.keyword}»`,
            field: 'bid',
            from: `${suggestion.currentBid} ₽`,
            to: `${suggestion.suggestedBid} ₽`,
            reason: suggestion.reason,
            applied: false,
          });
        }
        summary = `${rule.ruleType === 'bid_up' ? 'Повышение' : 'Снижение'} ставок: кандидатов ${changes.length}`;
        break;
      }
      case 'pause_low_ctr': {
        const threshold = rule.params.threshold || rule.params.targetCtr || 2;
        if (metrics.clicks >= rule.params.minClicks && compare(metrics.ctr, threshold, rule.params.comparison)) {
          changes.push({
            target: name,
            field: 'status',
            from: campaign.status,
            to: 'paused',
            reason: `CTR ${metrics.ctr}% против порога ${threshold}% при ${metrics.clicks} кликах — объявления не работают, бюджет сгорает`,
            applied: false,
          });
        }
        summary = `Проверка CTR: нарушений ${changes.length}`;
        break;
      }
      case 'pause_no_conversions': {
        if (metrics.conversions === 0 && metrics.clicks >= rule.params.minClicks) {
          changes.push({
            target: name,
            field: 'status',
            from: campaign.status,
            to: 'paused',
            reason: `${metrics.clicks} кликов без конверсий — проверьте цели и посадочную страницу`,
            applied: false,
          });
        }
        summary = `Проверка конверсий: нарушений ${changes.length}`;
        break;
      }
      case 'budget_reallocate': {
        if (metrics.cpa > 0 && metrics.roas >= 2) {
          const increase = Math.min(30, Math.round(metrics.roas * 8));
          changes.push({
            target: name,
            field: 'dailyBudget',
            from: `${campaign.dailyBudget} ₽`,
            to: `${round(campaign.dailyBudget * (1 + increase / 100), 0)} ₽`,
            reason: `ROAS ${metrics.roas} — кампания окупается, увеличиваем бюджет на ${increase}%`,
            applied: false,
          });
        } else if (metrics.roas > 0 && metrics.roas < 1) {
          const decrease = 20;
          changes.push({
            target: name,
            field: 'dailyBudget',
            from: `${campaign.dailyBudget} ₽`,
            to: `${round(campaign.dailyBudget * (1 - decrease / 100), 0)} ₽`,
            reason: `ROAS ${metrics.roas} — реклама не окупается, сокращаем бюджет на ${decrease}% и перераспределяем на эффективные кампании`,
            applied: false,
          });
        }
        summary = `Перераспределение бюджета: изменений ${changes.length}`;
        break;
      }
      case 'negative_keywords': {
        const suggestions = suggestBids(campaign, { targetCpa: rule.params.targetCpa });
        const wasteful = suggestions.filter((item) => item.action === 'pause' || (item.cpa ?? 0) > (rule.params.targetCpa ?? 2000) * 1.5);
        for (const item of wasteful.slice(0, rule.params.maxAppliesPerRun)) {
          changes.push({
            target: `${name} → «${item.keyword}»`,
            field: 'negativeKeyword',
            from: '—',
            to: item.keyword,
            reason: `${item.reason} Рекомендуем добавить в минус-слова или исключить фразу.`,
            applied: false,
          });
        }
        summary = `Кандидаты в минус-слова: ${changes.length}`;
        break;
      }
      case 'dayparting': {
        changes.push({
          target: name,
          field: 'bidAdjustment',
          from: '0%',
          to: `+${Math.abs(rule.params.adjustPercent)}% (${rule.params.hoursFrom ?? 9}:00–${rule.params.hoursTo ?? 19}:00)`,
          reason: 'Конверсии в рабочее время выше — поднимаем ставки в продуктивные часы',
          applied: false,
        });
        summary = 'Корректировки по времени суток подготовлены';
        break;
      }
      case 'min_balance': {
        changes.push({
          target: name,
          field: 'balance',
          from: '—',
          to: 'требуется проверка',
          reason: `Контроль пополнения: при текущем темпе расхода ${formatDaily(metrics.cost / 30)} баланс стоит держать выше 10 000 ₽, чтобы кампании не вставали`,
          applied: false,
        });
        summary = 'Проверка баланса выполнена';
        break;
      }
      default:
        summary = 'Тип правила не требует изменений в кампаниях';
    }
  }

  if (!changes.length && !summary) summary = 'Изменений не требуется — показатели в норме';
  return { changes: changes.slice(0, rule.params.maxAppliesPerRun), summary, evaluated };
}

const formatDaily = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} ₽/день`;

/** Применение изменений: через API Директа или отметка «готово к применению» в демо-режиме. */
async function applyChanges(db: Repos, tenantId: string, changes: ScheduleChange[], dryRun: boolean): Promise<void> {
  if (dryRun || !changes.length) return;
  const credentials = await getDirectCredentials(db, tenantId);
  if (!credentials || credentials.sandbox) {
    for (const change of changes) {
      change.applied = false;
      change.error = change.error ?? 'Демо-режим: изменение не отправлено в Директ (нет реального подключения с токеном)';
    }
    return;
  }

  const client = new DirectClient(credentials);
  const bidChanges: { keywordId: number; bid: number }[] = [];
  for (const change of changes) {
    if (change.field === 'bid') continue; // обрабатываем пакетом
    const campaignId = Number(/\((\d+)\)/.exec(change.target)?.[1]);
    if (change.field === 'status' && change.to === 'paused') {
      const target = await findCampaignId(db, tenantId, change.target);
      if (!target) {
        change.error = 'Не найден внешний ID кампании (externalId) — синхронизируйте кампании';
        continue;
      }
      const result = await client.updateCampaign(target, { status: 'SUSPENDED' });
      change.applied = result.ok;
      if (!result.error) change.error = result.error;
    } else if (change.field === 'dailyBudget') {
      const target = await findCampaignId(db, tenantId, change.target);
      const value = Number(change.to.replace(/[^\d]/g, ''));
      if (!target || !value) {
        change.error = 'Не удалось определить кампанию или бюджет';
        continue;
      }
      const result = await client.updateCampaign(target, { dailyBudget: value });
      change.applied = result.ok;
      if (result.error) change.error = result.error;
    }
  }

  if (bidChanges.length) {
    const result = await client.setBids(bidChanges);
    for (const change of changes.filter((item) => item.field === 'bid')) {
      change.applied = true;
    }
    if (result.errors.length) {
      log.warn('Часть ставок не применена', { errors: result.errors.slice(0, 5) });
    }
  }
}

async function findCampaignId(db: Repos, tenantId: string, name: string): Promise<number | null> {
  const campaigns = db.campaign.list({ tenantId, limit: 300 });
  const match = campaigns.find((item) => name.includes(String((item as unknown as Campaign).name)) || String((item as unknown as Campaign).name).includes(name.split('→')[0]!.trim()));
  const externalId = match ? Number((match as unknown as Campaign).externalId) : NaN;
  return Number.isFinite(externalId) && externalId > 0 ? externalId : null;
}

/* ------------------------------- Запуск правила ------------------------------- */

export async function runRule(
  tenantId: string,
  ruleId: string,
  options: { dryRun?: boolean; approve?: boolean } = {},
): Promise<ScheduleRun> {
  const db = await repos();
  const ruleRecord = db.scheduleRule.get(ruleId);
  if (!ruleRecord) throw new Error('Правило не найдено');
  const rule = ruleRecord as unknown as ScheduleRule;

  const startedAt = new Date().toISOString();
  const run: ScheduleRun = {
    id: randomId('run'),
    tenantId,
    ruleId,
    ruleName: rule.name,
    status: 'running',
    startedAt,
    evaluated: 0,
    changed: 0,
    changes: [],
    summary: '',
    dryRun: options.dryRun ?? false,
  };
  db.scheduleRun.put({ ...run, clientId: rule.clientId ?? null } as never);
  hub.publish(channels.run(run.id), 'started', run);
  hub.publish(channels.activity, 'rule:started', { rule: rule.name, runId: run.id });

  try {
    if (rule.ruleType === 'weekly_report') {
      const report = await buildReport({ tenantId, type: 'summary', clientId: rule.clientId ?? null });
      const saved = saveReportHtml({ ...report, status: 'done', generatedAt: new Date().toISOString() });
      db.report.put({ ...report, status: rule.notify.length ? 'sent' : 'done', filePath: saved.filePath, fileSizeBytes: saved.sizeBytes } as never);
      if (rule.notify.includes('telegram')) {
        await sendTelegramMessage(tenantId, formatAlert('Еженедельный отчёт MARK', [report.title, `KPI: ${report.kpis.slice(0, 3).map((k) => `${k.label} ${k.value}`).join(', ')}`]));
      }
      const finished: ScheduleRun = {
        ...run,
        status: 'done',
        finishedAt: new Date().toISOString(),
        summary: `Отчёт сформирован: ${report.title} (${report.sections.length} разделов)`,
        evaluated: 1,
        changed: 0,
      };
      db.scheduleRun.put({ ...finished, clientId: rule.clientId ?? null } as never);
      hub.publish(channels.run(run.id), 'finished', finished);
      db.scheduleRule.patch(ruleId, { lastRunAt: finished.finishedAt, lastResult: finished.summary, runCount: (rule.runCount ?? 0) + 1 } as never);
      return finished;
    }

    const campaigns = db.campaign
      .list({ tenantId, clientId: rule.clientId ?? undefined, limit: 100 })
      .map((item) => item as unknown as Campaign);

    const evaluation = await evaluateRule(db, rule, campaigns);
    const requiresApproval = rule.requiresApproval && !options.approve;
    const dryRun = options.dryRun ?? false;

    if (requiresApproval) {
      const pending: ScheduleRun = {
        ...run,
        status: 'awaiting_approval',
        evaluated: evaluation.evaluated,
        changed: 0,
        changes: evaluation.changes,
        summary: `${evaluation.summary}. Требуется подтверждение перед применением в аккаунте.`,
        finishedAt: new Date().toISOString(),
      };
      db.scheduleRun.put({ ...pending, clientId: rule.clientId ?? null } as never);
      hub.publish(channels.run(run.id), 'awaiting_approval', pending);
      await notify(tenantId, rule, `Правило «${rule.name}»: ${pending.summary}`, pending.changes.slice(0, 5).map((c) => `${c.target}: ${c.field} ${c.from} → ${c.to}`));
      db.scheduleRule.patch(ruleId, { lastRunAt: pending.finishedAt, lastResult: pending.summary, runCount: (rule.runCount ?? 0) + 1 } as never);
      return pending;
    }

    await applyChanges(db, tenantId, evaluation.changes, dryRun);

    const applied = evaluation.changes.filter((change) => change.applied).length;
    const finished: ScheduleRun = {
      ...run,
      status: 'done',
      finishedAt: new Date().toISOString(),
      evaluated: evaluation.evaluated,
      changed: applied || evaluation.changes.length,
      changes: evaluation.changes,
      summary: `${evaluation.summary}${dryRun ? ' (проверка без применения)' : applied ? `, применено ${applied} изменений` : ', изменения подготовлены'}`,
    };
    db.scheduleRun.put({ ...finished, clientId: rule.clientId ?? null } as never);
    hub.publish(channels.run(run.id), 'finished', finished);
    await notify(tenantId, rule, `Правило «${rule.name}» выполнено: ${finished.summary}`, finished.changes.slice(0, 5).map((c) => `${c.target}: ${c.from} → ${c.to}`));
    db.scheduleRule.patch(ruleId, { lastRunAt: finished.finishedAt, lastResult: finished.summary, runCount: (rule.runCount ?? 0) + 1 } as never);
    log.info(`Правило выполнено: ${rule.name}`, { changed: finished.changed });
    return finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: ScheduleRun = { ...run, status: 'failed', finishedAt: new Date().toISOString(), summary: message, error: message };
    db.scheduleRun.put({ ...failed, clientId: rule.clientId ?? null } as never);
    hub.publish(channels.run(run.id), 'failed', failed);
    await notify(tenantId, rule, `Правило «${rule.name}» завершилось ошибкой`, [message]);
    log.error('Ошибка выполнения правила', { rule: rule.name, error: message });
    return failed;
  }
}

async function notify(tenantId: string, rule: ScheduleRule, title: string, lines: string[]) {
  if (rule.notify.includes('inapp')) {
    const db = await repos();
    db.events.log({ tenantId, type: 'scheduler', level: 'info', message: title, payload: { lines } });
    hub.publish(channels.activity, 'scheduler:notice', { title, lines });
  }
  if (rule.notify.includes('telegram')) {
    await sendTelegramMessage(tenantId, formatAlert(title, lines));
  }
}

/* ------------------------------- Планировщик ------------------------------- */

class Scheduler {
  private jobs = new Map<string, ScheduledTask>();
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    if (args.serveWeb === false && process.env.MARK_DISABLE_SCHEDULER === '1') {
      log.info('Планировщик отключён переменной MARK_DISABLE_SCHEDULER');
      return;
    }
    this.started = true;
    const db = await repos();
    const rules = db.scheduleRule.list({ limit: 500 }).filter((item) => (item as unknown as ScheduleRule).enabled);
    for (const item of rules) this.schedule(item as unknown as ScheduleRule);
    log.info(`Планировщик запущен, активных правил: ${rules.length}`);
  }

  schedule(rule: ScheduleRule): { ok: boolean; error?: string; nextRunAt?: string | null } {
    this.unschedule(rule.id);
    if (!cron.validate(rule.cron)) {
      return { ok: false, error: `Некорректное cron-выражение: ${rule.cron}` };
    }
    const job = cron.schedule(
      rule.cron,
      () => {
        void runRule(rule.tenantId, rule.id).catch((error) => log.error('Правило упало', error));
      },
      { timezone: rule.timezone, scheduled: true },
    );
    this.jobs.set(rule.id, job);
    log.info(`Правило запланировано: ${rule.name} (${rule.cron}, ${rule.timezone})`);
    return { ok: true, nextRunAt: null };
  }

  unschedule(ruleId: string): void {
    const job = this.jobs.get(ruleId);
    if (job) {
      stopJob(job);
      this.jobs.delete(ruleId);
    }
  }

  list() {
    return [...this.jobs.keys()];
  }

  stop(): void {
    for (const job of this.jobs.values()) stopJob(job);
    this.jobs.clear();
    this.started = false;
  }
}

/**
 * Остановка задачи node-cron.
 * В node-cron 3 у задачи есть stop()/destroy(), но набор методов зависит от версии —
 * поэтому вызываем то, что реально доступно, и никогда не падаем на остановке сервера.
 */
function stopJob(job: unknown): void {
  const candidate = job as { stop?: () => unknown; destroy?: () => unknown } | null;
  try {
    if (typeof candidate?.stop === 'function') candidate.stop();
  } catch (error) {
    log.debug('Не удалось остановить задачу', { error: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (typeof candidate?.destroy === 'function') candidate.destroy();
  } catch {
    /* в node-cron 3 destroy может отсутствовать — это нормально */
  }
}

export const scheduler = new Scheduler();

/** Проверка cron-выражения и подсказка следующего запуска (для UI). */
export function validateCron(expression: string): { valid: boolean; description: string } {
  const valid = cron.validate(expression ?? '');
  return { valid, description: describeCron(expression) };
}

export function describeCron(expression: string): string {
  const map: Record<string, string> = {
    '0 9 * * *': 'Каждый день в 09:00',
    '0 */6 * * *': 'Каждые 6 часов',
    '*/30 * * * *': 'Каждые 30 минут',
    '0 10 * * 1': 'По понедельникам в 10:00',
    '0 3 * * *': 'Каждую ночь в 03:00',
    '0 9 * * 1-5': 'По будням в 09:00',
  };
  return map[expression] ?? (cron.validate(expression) ? `По расписанию ${expression}` : 'Некорректное выражение');
}

export function defaultRules(tenantId: string, clientId?: string | null): Omit<ScheduleRule, 'id' | 'createdAt' | 'updatedAt'>[] {
  return [
    {
      tenantId,
      clientId: clientId ?? null,
      name: 'Снижение ставок при дорогом CPA',
      enabled: true,
      cron: '0 10 * * *',
      timezone: 'Europe/Moscow',
      ruleType: 'bid_down',
      params: { metric: 'cpa', threshold: 2000, comparison: 'gt', windowDays: 7, adjustPercent: -15, minClicks: 30, maxAppliesPerRun: 20, targetCpa: 1800 },
      requiresApproval: true,
      notify: ['inapp', 'telegram'],
      maxChangesPerRun: 20,
      searchOnly: true,
      runCount: 0,
    },
    {
      tenantId,
      clientId: clientId ?? null,
      name: 'Пауза фраз без конверсий',
      enabled: true,
      cron: '0 11 * * *',
      timezone: 'Europe/Moscow',
      ruleType: 'pause_no_conversions',
      params: { metric: 'conversions', threshold: 0, comparison: 'lte', windowDays: 14, adjustPercent: 0, minClicks: 40, maxAppliesPerRun: 10 },
      requiresApproval: true,
      notify: ['inapp'],
      maxChangesPerRun: 10,
      searchOnly: true,
      runCount: 0,
    },
    {
      tenantId,
      clientId: clientId ?? null,
      name: 'Перераспределение бюджета по ROAS',
      enabled: false,
      cron: '0 12 * * 1',
      timezone: 'Europe/Moscow',
      ruleType: 'budget_reallocate',
      params: { metric: 'drr', threshold: 20, comparison: 'gt', windowDays: 14, adjustPercent: 20, minClicks: 50, maxAppliesPerRun: 5 },
      requiresApproval: true,
      notify: ['inapp'],
      maxChangesPerRun: 5,
      searchOnly: false,
      runCount: 0,
    },
    {
      tenantId,
      clientId: clientId ?? null,
      name: 'Еженедельный отчёт руководству',
      enabled: true,
      cron: '0 9 * * 1',
      timezone: 'Europe/Moscow',
      ruleType: 'weekly_report',
      params: { metric: 'cost', threshold: 0, comparison: 'gt', windowDays: 7, adjustPercent: 0, minClicks: 0, maxAppliesPerRun: 1 },
      requiresApproval: false,
      notify: ['inapp', 'telegram'],
      maxChangesPerRun: 1,
      searchOnly: false,
      runCount: 0,
    },
  ];
}

export { renderReportHtml };
