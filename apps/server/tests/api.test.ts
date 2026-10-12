import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Интеграционные тесты API MARK.
 *
 * Проверяют «сквозные» сценарии, на которых держится интерфейс:
 *   - справочники и состояние системы;
 *   - подключение сервиса с валидацией токена;
 *   - сайт → детект платформы → аудит → автофикс (preview);
 *   - GEO-анализ и маркет-анализ;
 *   - BotShield: разбор логов и классификация;
 *   - гипотезы: генерация, старт теста, статистическая оценка;
 *   - кампании, правила автооптимизации (cron) и отчёты (HTML/CSV/PDF);
 *   - белая метка и настройки.
 */

let app: Express;

beforeAll(async () => {
  const { config } = await import('../src/config.js');
  expect(config.demoMode).toBe(true);

  const { repos } = await import('../src/db/repos.js');
  await repos();
  const { ensureDemoData } = await import('../src/seed.js');
  await ensureDemoData();

  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(async () => {
  const { closeDb } = await import('../src/db/database.js');
  closeDb();
});

const body = <T>(response: request.Response): T => {
  expect(response.body?.ok, JSON.stringify(response.body).slice(0, 400)).toBe(true);
  return response.body.data as T;
};

describe('служебные эндпоинты', () => {
  it('отдаёт здоровье и версию', async () => {
    const response = await request(app).get('/api/health').expect(200);
    const data = body<{ status: string; version: string }>(response);
    expect(data.status).toBe('ok');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('отдаёт справочники: сервисы, платформы, регионы, ниши', async () => {
    const response = await request(app).get('/api/meta').expect(200);
    const meta = body<{ services: unknown[]; platforms: unknown[]; regions: unknown[]; niches: unknown[]; ruleTypes: unknown[] }>(response);
    expect(meta.services.length).toBeGreaterThanOrEqual(20);
    expect(meta.platforms.length).toBeGreaterThanOrEqual(10);
    expect(meta.regions.length).toBeGreaterThanOrEqual(20);
    expect(meta.niches.length).toBeGreaterThanOrEqual(5);
    expect(meta.ruleTypes.length).toBeGreaterThanOrEqual(5);
  });

  it('описывает сервис с подсказкой по авторизации', async () => {
    const response = await request(app).get('/api/services/yandex-direct').expect(200);
    const service = body<{ id: string; authModes: { id: string }[] }>(response);
    expect(service.id).toBe('yandex-direct');
    expect(service.authModes.map((mode) => mode.id)).toContain('oauth2');
  });

  it('404 на неизвестном сервисе', async () => {
    const response = await request(app).get('/api/services/unknown-service').expect(404);
    expect(response.body.ok).toBe(false);
  });
});

describe('подключение сервиса', () => {
  it('валидирует токен и сохраняет подключение', async () => {
    const sync = await request(app)
      .post('/api/validate/sync')
      .send({ serviceId: 'yandex-webmaster', authMode: 'api_token', fields: { token: 'demo-token-123456', hostId: 'example.ru' }, sandbox: true })
      .expect(200);
    const payload = body<{ result: { status: string; checks: { key: string; status: string }[]; mode: string }; events: { type: string }[] }>(sync);
    expect(['pass', 'warn']).toContain(payload.result.status);
    expect(payload.result.mode).toBe('sandbox');
    expect(payload.result.checks.length).toBeGreaterThan(0);
    expect(payload.events.some((event) => event.type === 'finished')).toBe(true);

    const created = await request(app)
      .post('/api/accounts')
      .send({
        serviceId: 'yandex-webmaster',
        authMode: 'api_token',
        label: 'Тестовый Вебмастер',
        fields: { token: 'demo-token-123456', hostId: 'example.ru' },
        sandbox: true,
      })
      .expect(201);
    const createdPayload = body<{ account: { id: string; status: string; secretPreview?: string | null }; result: { status: string } }>(created);
    const account = createdPayload.account;
    expect(account.id).toMatch(/^acc_/);
    expect(account.status).toBe('valid');
    expect(account.secretPreview).not.toContain('demo-token-123456');

    const list = body<{ id: string }[]>(await request(app).get('/api/accounts').expect(200));
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);

    await request(app).delete(`/api/accounts/${account.id}`).expect(200);
  });

  it('отклоняет пустой токен', async () => {
    await request(app)
      .post('/api/validate/sync')
      .send({ serviceId: 'yandex-webmaster', authMode: 'api_token', fields: {} })
      .expect(200);
    const payload = body<{ result: { status: string; checks: { key: string; status: string }[] } }>(
      await request(app).post('/api/validate/sync').send({ serviceId: 'yandex-webmaster', authMode: 'api_token', fields: { token: '' } }).expect(200),
    );
    expect(payload.result.checks.some((check) => check.status === 'fail' || check.status === 'warn')).toBe(true);
  });

  it('создаёт сессию входа и принимает cookies', async () => {
    const created = await request(app).post('/api/sessions').send({ serviceId: 'yandex-direct', mode: 'manual' }).expect(201);
    const session = body<{ id: string; url: string; channel: string }>(created);
    expect(session.id).toMatch(/^login_/);
    expect(session.url).toMatch(/^https?:\/\//);
    expect(session.channel).toBe(`login:${session.id}`);

    const saved = await request(app)
      .post(`/api/sessions/${session.id}/cookies`)
      .send({ cookieHeader: 'Session_id=abc123; yandexuid=42; i=token' })
      .expect(200);
    const result = body<{ cookiesCount: number; account?: { id: string } }>(saved);
    expect(result.cookiesCount).toBeGreaterThanOrEqual(2);
  });
});

describe('сайт: детект платформы, аудит и автофикс', () => {
  it('определяет платформу по адресу и разметке', async () => {
    const response = await request(app).post('/api/sites/detect').send({ url: 'https://client.tilda.ws' }).expect(200);
    const detection = body<{ platform: string; confidence: number; evidence: string[]; recommendedConnectors: string[] }>(response);
    expect(typeof detection.platform).toBe('string');
    expect(detection.platform.length).toBeGreaterThan(0);
    expect(detection.confidence).toBeGreaterThan(0);
    expect(Array.isArray(detection.evidence)).toBe(true);
    expect(detection.recommendedConnectors.length).toBeGreaterThan(0);
  });

  it('запускает аудит демо-сайта и находит проблемы', async () => {
    const sites = body<{ items: { id: string; url: string }[] }>(await request(app).get('/api/sites').expect(200));
    const site = sites.items[0];
    expect(site).toBeTruthy();

    const started = await request(app).post(`/api/sites/${site!.id}/audit`).send({ siteProjectId: site!.id, maxPages: 5, runPsi: false }).expect(202);
    const queued = body<{ auditRunId: string; channel: string }>(started);
    expect(queued.channel).toBe(`audit:${queued.auditRunId}`);

    interface AuditPayload {
      id: string;
      status: string;
      score: number;
      grade: string;
      simulated?: boolean;
      findings: { code: string; severity: string; autoFixable: boolean; category: string }[];
      summary: { critical: number; high: number; medium: number; low: number; info: number; autoFixable: number };
      categoryScores: Record<string, number>;
    }

    // Аудит выполняется в фоне: дожидаемся результата
    let audit: AuditPayload | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const fetched = await request(app).get(`/api/audits/${queued.auditRunId}`).expect(200);
      const candidate = body<AuditPayload>(fetched);
      if (candidate && candidate.status === 'done') {
        audit = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(audit, 'аудит должен завершиться').toBeTruthy();
    expect(audit!.score).toBeGreaterThanOrEqual(0);
    expect(audit!.score).toBeLessThanOrEqual(100);
    expect(audit!.findings.length).toBeGreaterThan(5);
    const { critical, high, medium, low, info } = audit!.summary;
    expect(critical + high + medium + low + info).toBe(audit!.findings.length);
    expect(audit!.findings.some((finding) => finding.autoFixable)).toBe(true);
    expect(Object.keys(audit!.categoryScores ?? {}).length).toBeGreaterThan(0);

    const autoFixable = audit!.findings.filter((finding) => finding.autoFixable).map((finding) => finding.code);
    expect(autoFixable.length).toBeGreaterThan(0);

    const preview = await request(app)
      .post(`/api/sites/${site!.id}/autofix`)
      .send({ siteProjectId: site!.id, auditRunId: audit!.id, findingCodes: autoFixable, mode: 'preview' })
      .expect(200);
    const autofix = body<{ bundle: { id: string; files: { path: string; content: string }[] }; summary: Record<string, unknown>; plan: { connectorId: string; steps: string[] }; hint: string }>(preview);
    expect(autofix.bundle.files.length).toBeGreaterThan(0);
    expect(autofix.bundle.files.every((file) => typeof file.content === 'string')).toBe(true);
    expect(autofix.plan.steps.length).toBeGreaterThan(0);
    expect(typeof autofix.hint).toBe('string');
  });
});

describe('GEO и рынок', () => {
  it('считает спрос по регионам и строит план страниц', async () => {
    const analysis = body<{ id: string; totalDemand: number; demandByRegion: { regionId: number }[]; source: string }>(
      await request(app)
        .post('/api/geo/analyze')
        .send({ keywords: ['ремонт квартир', 'отделка под ключ'], regionIds: [213, 2, 54], useLive: false })
        .expect(201),
    );
    expect(analysis.totalDemand).toBeGreaterThan(0);
    expect(analysis.demandByRegion.map((item) => item.regionId)).toEqual([213, 2, 54]);

    const sites = body<{ items: { id: string }[] }>(await request(app).get('/api/sites').expect(200));
    const plan = body<{ id: string; pages: { url: string; h1: string }[]; tasks: unknown[]; structure: string }>(
      await request(app)
        .post('/api/geo/plan')
        .send({ siteProjectId: sites.items[0]!.id, structure: 'subfolders', regionIds: [213, 2, 54], keywords: ['ремонт квартир'] })
        .expect(201),
    );
    expect(plan.pages.length).toBeGreaterThan(0);
    expect(plan.pages[0]!.url).toContain('/');
    expect(plan.tasks.length).toBeGreaterThan(0);
  });

  it('сравнивает CPC ниши с бенчмарками', async () => {
    const analysis = body<{ niche: string; nicheCpc: number; yourCpc: number | null; gapPercent: number | null; verdict: string; budgetPlan: unknown[]; insights: string[] }>(
      await request(app)
        .post('/api/market/analyze')
        .send({ niche: 'стоматология', regionId: 213, yourCpc: 90, budget: 150000 })
        .expect(201),
    );
    expect(analysis.nicheCpc).toBeGreaterThan(0);
    expect(analysis.yourCpc).toBe(90);
    expect(analysis.gapPercent).not.toBeNull();
    expect(analysis.budgetPlan.length).toBeGreaterThanOrEqual(3);
    expect(analysis.insights.length).toBeGreaterThan(0);
  });
});

describe('BotShield', () => {
  const log = [
    '192.168.1.5 - - [01/Oct/2025:10:00:00 +0300] "GET / HTTP/1.1" 200 15400 "-" "Mozilla/5.0 (Windows NT 10.0) Chrome/120"',
    '66.249.66.1 - - [01/Oct/2025:10:00:01 +0300] "GET /catalog HTTP/1.1" 200 22000 "-" "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"',
    '185.220.101.5 - - [01/Oct/2025:10:00:02 +0300] "GET /admin HTTP/1.1" 404 120 "-" "python-requests/2.31"',
    '91.219.238.14 - - [01/Oct/2025:10:00:03 +0300] "POST /wp-login.php HTTP/1.1" 200 800 "http://spam.example" "Mozilla/5.0"',
    '45.155.205.233 - - [01/Oct/2025:10:00:04 +0300] "GET /?p=1%20UNION%20SELECT HTTP/1.1" 500 60 "-" "sqlmap/1.7"',
  ].join('\n');

  it('разбирает лог, считает чистоту и потери', async () => {
    const response = await request(app).post('/api/bots/scan').send({ source: 'upload', format: 'auto', logContent: log, siteProjectId: null }).expect(201);
    const scan = body<{
      id: string;
      totals: { requests: number; suspiciousRequests: number; wastedMoneyEstimate: number };
      cleanlinessScore: number;
      topIps: { ip: string; classification: string }[];
      recommendations: unknown[];
    }>(response);

    expect(scan.totals.requests).toBe(5);
    expect(scan.totals.suspiciousRequests).toBeGreaterThanOrEqual(2);
    expect(scan.cleanlinessScore).toBeLessThan(100);
    expect(scan.totals.wastedMoneyEstimate).toBeGreaterThan(0);
    expect(scan.recommendations.length).toBeGreaterThan(0);

    const googlebot = scan.topIps.find((verdict) => verdict.ip === '66.249.66.1');
    expect(googlebot?.classification).toBe('good_bot');
    const attacker = scan.topIps.find((verdict) => verdict.ip === '45.155.205.233');
    expect(['attack', 'spam']).toContain(attacker?.classification);
  });

  it('классифицирует произвольный user-agent', async () => {
    const response = await request(app)
      .post('/api/bots/classify')
      .send({ userAgent: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', ip: '213.180.203.7', path: '/catalog' })
      .expect(200);
    const verdict = body<{ classification: string; humanScore: number; reasons: string[] }>(response);
    expect(verdict.classification).toBe('good_bot');
    expect(verdict.humanScore).toBeGreaterThan(50); // высокий балл = трафик настоящий, а не подделка
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});

describe('гипотезы и эксперименты', () => {
  it('генерирует гипотезы, запускает тест и оценивает результат', async () => {
    const generated = await request(app).post('/api/hypotheses/generate').send({ count: 5 }).expect(201);
    const created = body<{ created: { id: string; status: string; ice: number; testPlan: { minSamplePerVariant: number } }[]; drafts: number }>(generated).created;
    expect(created.length).toBeGreaterThan(0);
    expect(created.length).toBeLessThanOrEqual(5);
    expect(created.every((item) => item.ice > 0)).toBe(true);

    const hypothesis = created[0]!;
    const started = body<{ status: string }>(await request(app).post(`/api/hypotheses/${hypothesis.id}/start-test`).send({}).expect(200));
    expect(started.status).toBe('running');

    const evaluated = body<{ status: string; pValue: number; liftPercent: number; requiredSample: number; recommendations: string[] }>(
      await request(app)
        .post(`/api/hypotheses/${hypothesis.id}/evaluate`)
        .send({
          observations: [
            { variant: 'control', visitors: 4000, conversions: 120 },
            { variant: 'variant', visitors: 4000, conversions: 182 },
          ],
          baselineRate: 0.03,
        })
        .expect(200),
    );
    expect(evaluated.pValue).toBeLessThan(0.05);
    expect(evaluated.liftPercent).toBeGreaterThan(20);
    expect(evaluated.recommendations.length).toBeGreaterThan(0);

    const list = body<{ items: { id: string; status: string }[] }>(await request(app).get('/api/hypotheses').expect(200));
    expect(list.items.find((item) => item.id === hypothesis.id)?.status).toBe('done');
  });
});

describe('кампании и автооптимизация', () => {
  it('отдаёт список кампаний с итогами и рекомендациями по ставкам', async () => {
    const payload = body<{ items: { id: string; dailyBudget: number }[]; totals: { cost: number; clicks: number; ctr: number } }>(
      await request(app).get('/api/campaigns').expect(200),
    );
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.totals.cost).toBeGreaterThan(0);

    const bids = body<{ suggestions: { keyword: string; action: string }[]; summary: { keep: number; potentialSaving: number } }>(
      await request(app).get(`/api/campaigns/${payload.items[0]!.id}/bids`).expect(200),
    );
    expect(Array.isArray(bids.suggestions)).toBe(true);
  });

  it('устанавливает правила автооптимизации и выполняет прогон', async () => {
    const presets = await request(app).post('/api/schedules/presets').send({}).expect(201);
    const rules = body<{ id: string; name: string; cron: string; enabled: boolean }[]>(presets);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(rules.some((rule) => rule.cron.includes('*'))).toBe(true);

    const cron = body<{ valid: boolean; description: string }>(await request(app).post('/api/cron/validate').send({ cron: '0 9 * * 1-5' }).expect(200));
    expect(cron.valid).toBe(true);
    expect(typeof cron.description).toBe('string');

    const bad = await request(app).post('/api/cron/validate').send({ cron: 'не cron' }).expect(422);
    expect(String(bad.body?.error ?? '')).toContain('cron');

    const run = body<{ id: string; status: string; evaluated: number; summary: string }>(
      await request(app).post(`/api/schedules/${rules[0]!.id}/run`).send({ dryRun: true }).expect(200),
    );
    expect(run.id).toMatch(/^run_/);
    expect(['done', 'awaiting_approval', 'partial', 'failed']).toContain(run.status);
    expect(typeof run.summary).toBe('string');
  });
});

describe('отчёты', () => {
  it('собирает отчёт, отдаёт HTML/CSV/PDF и удаляет его', async () => {
    const clients = body<{ id: string; name: string }[]>(await request(app).get('/api/clients').expect(200));
    const client = clients[0];

    const periodTo = new Date();
    const periodFrom = new Date(periodTo.getTime() - 30 * 86_400_000);
    const created = await request(app)
      .post('/api/reports')
      .send({
        type: 'summary',
        clientId: client?.id ?? null,
        periodFrom: periodFrom.toISOString().slice(0, 10),
        periodTo: periodTo.toISOString().slice(0, 10),
        includeCharts: true,
        brand: true,
        delivery: ['download'],
      })
      .expect(201);
    const report = body<{ id: string; status: string; title: string; filePath?: string }>(created);
    expect(report.status).toBe('done');
    expect(report.id).toMatch(/^rep_/);

    const html = await request(app).get(`/api/reports/${report.id}/html`).expect(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(String(html.text)).toContain('<html');

    const csv = await request(app).get(`/api/reports/${report.id}/csv`).expect(200);
    expect(String(csv.text)).toContain(';');

    // PDF: настоящий файл, если есть Chromium; иначе сервер отдаёт печатный HTML
    const pdf = await request(app).get(`/api/reports/${report.id}/pdf`).expect(200);
    const pdfType = String(pdf.headers['content-type'] ?? '');
    if (pdfType.includes('pdf')) {
      expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');
    } else {
      expect(pdfType).toContain('html');
      expect(String(pdf.text)).toContain('window.print');
    }

    await request(app).delete(`/api/reports/${report.id}`).expect(200);
  });
});

describe('белая метка, настройки и дашборд', () => {
  it('сохраняет брендинг агентства и применяет его в отчётах', async () => {
    const updated = await request(app)
      .put('/api/branding')
      .send({ agencyName: 'Ромашка Digital', brandColor: '#7c3aed', supportEmail: 'hi@romashka.ru', hideMarkBranding: true })
      .expect(200);
    const branding = body<{ agencyName: string; brandColor: string; hideMarkBranding: boolean }>(updated);
    expect(branding.agencyName).toBe('Ромашка Digital');
    expect(branding.brandColor).toBe('#7c3aed');
    expect(branding.hideMarkBranding).toBe(true);
  });

  it('обновляет настройки и отдаёт их вместе с окружением', async () => {
    await request(app).patch('/api/settings').send({ reportEmail: 'reports@agency.ru', autoOptimizationEnabled: true }).expect(200);
    const payload = body<{ settings: { reportEmail?: string }; env: { demoMode: boolean; dataDir: string } }>(await request(app).get('/api/settings').expect(200));
    expect(payload.settings.reportEmail).toBe('reports@agency.ru');
    expect(payload.env.demoMode).toBe(true);
    expect(payload.env.dataDir).toBeTruthy();
  });

  it('собирает сводку дашборда', async () => {
    const payload = body<{ summary: { kpis: { label: string; value: string }[]; alerts: unknown[]; budget: { used: number; planned: number }; hypotheses: { total: number }; seoScoreSeries: unknown[] }; recent: { events: unknown[] } }>(
      await request(app).get('/api/dashboard').expect(200),
    );
    expect(payload.summary.kpis.length).toBeGreaterThan(2);
    expect(payload.summary.hypotheses.total).toBeGreaterThan(0);
    expect(payload.summary.budget.planned).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(payload.recent.events)).toBe(true);
  });

  it('отдаёт статус системы со счётчиками', async () => {
    const status = body<{ counts: Record<string, number>; hub: { clients: number } }>(await request(app).get('/api/system/status').expect(200));
    expect(status.counts.clients).toBeGreaterThan(0);
    expect(status.counts.sites).toBeGreaterThan(0);
    expect(status.hub.clients).toBeGreaterThanOrEqual(0);
  });
});

describe('оркестратор', () => {
  it('выполняет цепочку задач и возвращает шаги', async () => {
    const clients = body<{ id: string; tenantId?: string }[]>(await request(app).get('/api/clients').expect(200));
    const started = await request(app)
      .post('/api/orchestrate')
      .send({ clientId: clients[0]!.id, tasks: [{ type: 'audit', params: { maxPages: 3 } }, { type: 'hypotheses', params: { count: 3 } }], dryRun: true })
      .expect(202);
    const payload = body<{ runId: string; channel: string }>(started);
    expect(payload.runId).toMatch(/^orch_/);
    expect(payload.channel).toBe(`run:${payload.runId}`);

    // Ждём завершения цепочки в фоне и проверяем, что шаги записаны в журнал событий
    const { repos } = await import('../src/db/repos.js');
    const db = await repos();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const tenantId = String(clients[0]!.tenantId ?? '');
    const events = db.events.list(tenantId, 50).filter((event) => event.type === 'orchestrator');
    expect(events.length).toBeGreaterThan(0);
  });
});
