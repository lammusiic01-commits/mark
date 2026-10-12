import { MarkDatabase, getDb } from './database.js';
import { randomId } from '../crypto.js';
import type {
  AuditRun,
  BalanceTransaction,
  PaymentRecord,
  BotScan,
  Campaign,
  Client,
  ConnectedAccount,
  GeoAnalysis,
  GeoPlan,
  Hypothesis,
  LoginSession,
  MarketAnalysis,
  PatchBundle,
  ReportRecord,
  ScheduleRule,
  ScheduleRun,
  SiteProject,
  TelegramLink,
  User,
  WhiteLabel,
} from '@mark/shared';

/**
 * Универсальное документ-ориентированное хранилище поверх SQLite.
 *
 * Все доменные объекты лежат в таблице `objects` (kind + id + JSON payload).
 * Это даёт единый, предсказуемый CRUD без дублирования SQL для 15 сущностей,
 * а «горячие» вещи (секреты, метрики, события, kv) вынесены в отдельные таблицы.
 */

export interface BaseDoc {
  id: string;
  tenantId: string;
  clientId?: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ListFilter {
  tenantId?: string;
  clientId?: string | null;
  status?: string;
  search?: string;
  searchFields?: string[];
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at';
  direction?: 'asc' | 'desc';
}

interface ObjectRow {
  kind: string;
  id: string;
  tenant_id: string | null;
  client_id: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
  payload: string;
}

export class Repo<T extends BaseDoc> {
  constructor(
    private db: MarkDatabase,
    public readonly kind: string,
  ) {}

  list(filter: ListFilter = {}): T[] {
    const where: string[] = ['kind = ?'];
    const params: unknown[] = [this.kind];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.clientId !== undefined) {
      if (filter.clientId === null) where.push('(client_id IS NULL OR client_id = "")');
      else {
        where.push('client_id = ?');
        params.push(filter.clientId);
      }
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const orderBy = filter.orderBy ?? 'created_at';
    const direction = filter.direction ?? 'desc';
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const sql = `SELECT * FROM objects WHERE ${where.join(' AND ')} ORDER BY ${orderBy} ${direction.toUpperCase()} LIMIT ? OFFSET ?`;
    const rows = this.db.all<ObjectRow>(sql, [...params, limit, offset]);
    let items = rows.map((row) => this.fromRow(row));
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      const fields = filter.searchFields ?? ['name', 'title', 'label'];
      items = items.filter((item) =>
        fields.some((field) => String(item[field] ?? '').toLowerCase().includes(needle)),
      );
    }
    return items;
  }

  count(filter: ListFilter = {}): number {
    const where: string[] = ['kind = ?'];
    const params: unknown[] = [this.kind];
    if (filter.tenantId) {
      where.push('tenant_id = ?');
      params.push(filter.tenantId);
    }
    if (filter.clientId !== undefined) {
      if (filter.clientId === null) where.push('(client_id IS NULL OR client_id = "")');
      else {
        where.push('client_id = ?');
        params.push(filter.clientId);
      }
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    return this.db.count(`SELECT COUNT(*) FROM objects WHERE ${where.join(' AND ')}`, params);
  }

  get(id: string): T | undefined {
    const row = this.db.get<ObjectRow>('SELECT * FROM objects WHERE kind = ? AND id = ?', [this.kind, id]);
    return row ? this.fromRow(row) : undefined;
  }

  find(predicate: (item: T) => boolean, filter: ListFilter = { limit: 500 }): T | undefined {
    return this.list(filter).find(predicate);
  }

  put(doc: T): T {
    const now = new Date().toISOString();
    const normalized: T = {
      ...doc,
      id: doc.id || randomId(this.kind),
      createdAt: doc.createdAt || now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO objects (kind, id, tenant_id, client_id, status, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         client_id = excluded.client_id,
         status = excluded.status,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
      [
        this.kind,
        normalized.id,
        normalized.tenantId ?? null,
        (normalized.clientId as string | null | undefined) ?? null,
        String((normalized as Record<string, unknown>).status ?? ''),
        normalized.createdAt,
        normalized.updatedAt,
        JSON.stringify(normalized),
      ],
    );
    return normalized;
  }

  patch(id: string, patch: Partial<T>): T | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() } as T;
    this.db.run(
      `UPDATE objects SET tenant_id = ?, client_id = ?, status = ?, updated_at = ?, payload = ? WHERE kind = ? AND id = ?`,
      [
        next.tenantId ?? null,
        (next.clientId as string | null | undefined) ?? null,
        String((next as Record<string, unknown>).status ?? ''),
        next.updatedAt,
        JSON.stringify(next),
        this.kind,
        id,
      ],
    );
    return next;
  }

  delete(id: string): boolean {
    const existed = Boolean(this.get(id));
    this.db.run('DELETE FROM objects WHERE kind = ? AND id = ?', [this.kind, id]);
    return existed;
  }

  private fromRow(row: ObjectRow): T {
    try {
      const parsed = JSON.parse(row.payload) as T;
      return {
        ...parsed,
        id: row.id,
        tenantId: row.tenant_id ?? parsed.tenantId,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return {
        id: row.id,
        tenantId: row.tenant_id ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        _corrupted: true,
      } as unknown as T;
    }
  }
}

/* ------------------------------ Секреты ------------------------------ */

export class SecretsRepo {
  constructor(private db: MarkDatabase) {}

  save(accountId: string, encryptedPayload: string): void {
    this.db.run(
      `INSERT INTO secrets (account_id, payload_enc, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET payload_enc = excluded.payload_enc, updated_at = excluded.updated_at`,
      [accountId, encryptedPayload, new Date().toISOString()],
    );
  }

  load(accountId: string): string | null {
    const row = this.db.get<{ payload_enc: string }>('SELECT payload_enc FROM secrets WHERE account_id = ?', [accountId]);
    return row?.payload_enc ?? null;
  }

  delete(accountId: string): void {
    this.db.run('DELETE FROM secrets WHERE account_id = ?', [accountId]);
  }
}

/* ------------------------------ Метрики ------------------------------ */

export interface MetricPoint {
  date: string;
  value: number;
}

export class MetricsRepo {
  constructor(private db: MarkDatabase) {}

  save(scope: string, refId: string, date: string, payload: unknown): void {
    this.db.run(
      `INSERT INTO metrics (scope, ref_id, date, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, ref_id, date) DO UPDATE SET payload = excluded.payload`,
      [scope, refId, date, JSON.stringify(payload)],
    );
  }

  saveMany(scope: string, refId: string, items: { date: string; payload: unknown }[]): void {
    this.db.transaction(() => {
      for (const item of items) this.save(scope, refId, item.date, item.payload);
    });
  }

  range(scope: string, refId: string, from?: string, to?: string): { date: string; payload: Record<string, number> }[] {
    const rows = this.db.all<{ date: string; payload: string }>(
      `SELECT date, payload FROM metrics WHERE scope = ? AND ref_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
      [scope, refId, from ?? '0000-00-00', to ?? '9999-99-99'],
    );
    return rows.map((row) => {
      try {
        return { date: row.date, payload: JSON.parse(row.payload) as Record<string, number> };
      } catch {
        return { date: row.date, payload: {} };
      }
    });
  }

  series(scope: string, refId: string, field: string): MetricPoint[] {
    return this.range(scope, refId).map((row) => ({ date: row.date, value: Number(row.payload[field] ?? 0) }));
  }
}

/* ------------------------------ Журнал ------------------------------ */

export type EventLevel = 'info' | 'warn' | 'error' | 'success' | 'critical';

export interface EventRecord {
  id: string;
  tenantId: string;
  type: string;
  level: EventLevel;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export class EventsRepo {
  constructor(private db: MarkDatabase) {}

  log(event: Omit<EventRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): EventRecord {
    const record: EventRecord = {
      id: event.id ?? randomId('evt'),
      tenantId: event.tenantId,
      type: event.type,
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
      createdAt: event.createdAt ?? new Date().toISOString(),
    };
    this.db.run(
      `INSERT INTO events (id, tenant_id, type, level, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.tenantId,
        record.type,
        record.level,
        record.message,
        record.payload ? JSON.stringify(record.payload) : null,
        record.createdAt,
      ],
    );
    return record;
  }

  list(tenantId: string, limit = 60): EventRecord[] {
    const rows = this.db.all<{
      id: string;
      tenant_id: string;
      type: string;
      level: string;
      message: string;
      payload: string | null;
      created_at: string;
    }>(
      `SELECT * FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      [tenantId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      type: row.type,
      level: row.level as EventRecord['level'],
      message: row.message,
      payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
      createdAt: row.created_at,
    }));
  }

  prune(tenantId: string, keep = 500): void {
    this.db.run(
      `DELETE FROM events WHERE tenant_id = ? AND id NOT IN (
         SELECT id FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
      [tenantId, tenantId, keep],
    );
  }
}

/* ------------------------------ KV ------------------------------ */

export class KvRepo {
  constructor(private db: MarkDatabase) {}

  get<T>(key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value ?? null), new Date().toISOString()],
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
  }

  keys(prefix = ''): string[] {
    return this.db
      .all<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', [`${prefix}%`])
      .map((row) => row.key);
  }
}

/* ------------------------------ Фабрика ------------------------------ */

const cache = new Map<string, Repo<BaseDoc>>();

export function repo<T extends BaseDoc>(db: MarkDatabase, kind: string): Repo<T> {
  const key = `${(db as unknown as { file: string }).file ?? 'db'}:${kind}`;
  const existing = cache.get(key);
  if (existing) return existing as unknown as Repo<T>;
  const created = new Repo<T>(db, kind);
  cache.set(key, created as unknown as Repo<BaseDoc>);
  return created;
}

export const KINDS = {
  tenant: 'tenant',
  user: 'user',
  client: 'client',
  account: 'account',
  loginSession: 'login_session',
  siteProject: 'site_project',
  audit: 'audit',
  telegramLink: 'telegram_link',
  payment: 'payment',
  balanceTransaction: 'balance_transaction',
  geoAnalysis: 'geo_analysis',
  geoPlan: 'geo_plan',
  marketAnalysis: 'market_analysis',
  botScan: 'bot_scan',
  hypothesis: 'hypothesis',
  experiment: 'experiment',
  campaign: 'campaign',
  report: 'report',
  scheduleRule: 'schedule_rule',
  scheduleRun: 'schedule_run',
  patchBundle: 'patch_bundle',
  autofixRun: 'autofix_run',
  settings: 'settings',
} as const;

export type Kind = (typeof KINDS)[keyof typeof KINDS];

/* ---------------------- Типы документов хранилища ---------------------- */

/** Тенант (агентство) — он же владелец white-label оформления. */
export type TenantDoc = WhiteLabel & BaseDoc;

/** Окно входа в сервис: cookie-сессия, ожидающая подтверждения пользователя. */
export type LoginSessionDoc = LoginSession & BaseDoc;

/** Набор правок + план применения — всегда привязан к проекту сайта и тенанту. */
export type PatchBundleDoc = PatchBundle & BaseDoc;

/** Прогон автоисправления: что применили и куда выгрузили. */
export interface AutofixRunDoc extends BaseDoc {
  siteProjectId: string;
  bundleId: string;
  steps: { id: string; title: string; connectorId: string; status: string; message?: string; details?: unknown }[];
  exported?: { dir: string; files: string[] } | null;
  summary?: Record<string, unknown> | null;
}

/** Проведённый A/B-эксперимент по гипотезе. */
export interface ExperimentDoc extends BaseDoc {
  hypothesisId: string;
  status: 'running' | 'winner' | 'no_difference' | 'insufficient_data';
  startedAt?: string | null;
  finishedAt?: string | null;
  plan?: Hypothesis['testPlan'];
  observations?: unknown[];
  result?: unknown;
}

/** Тип документа в хранилище: доменная сущность + служебные поля (tenantId, createdAt, updatedAt). */
export type Stored<T> = T & BaseDoc;

export interface RepoSet {
  db: MarkDatabase;
  tenant: Repo<TenantDoc>;
  user: Repo<Stored<User>>;
  client: Repo<Stored<Client>>;
  account: Repo<Stored<ConnectedAccount>>;
  loginSession: Repo<LoginSessionDoc>;
  siteProject: Repo<Stored<SiteProject>>;
  audit: Repo<Stored<AuditRun>>;
  telegramLink: Repo<Stored<TelegramLink>>;
  payment: Repo<Stored<PaymentRecord>>;
  balanceTransaction: Repo<Stored<BalanceTransaction>>;
  geoAnalysis: Repo<Stored<GeoAnalysis>>;
  geoPlan: Repo<Stored<GeoPlan>>;
  marketAnalysis: Repo<Stored<MarketAnalysis>>;
  botScan: Repo<Stored<BotScan>>;
  hypothesis: Repo<Stored<Hypothesis>>;
  experiment: Repo<ExperimentDoc>;
  campaign: Repo<Stored<Campaign>>;
  report: Repo<Stored<ReportRecord>>;
  scheduleRule: Repo<Stored<ScheduleRule>>;
  scheduleRun: Repo<Stored<ScheduleRun>>;
  patchBundle: Repo<PatchBundleDoc>;
  autofixRun: Repo<AutofixRunDoc>;
  secrets: SecretsRepo;
  metrics: MetricsRepo;
  events: EventsRepo;
  kv: KvRepo;
}

/** Утилита: получить все репозитории для БД (с типизацией доменных сущностей). */
export async function repos(): Promise<RepoSet> {
  const db = await getDb();
  return {
    db,
    tenant: repo<TenantDoc>(db, KINDS.tenant),
    user: repo<Stored<User>>(db, KINDS.user),
    client: repo<Stored<Client>>(db, KINDS.client),
    account: repo<Stored<ConnectedAccount>>(db, KINDS.account),
    loginSession: repo<LoginSessionDoc>(db, KINDS.loginSession),
    siteProject: repo<Stored<SiteProject>>(db, KINDS.siteProject),
    audit: repo<Stored<AuditRun>>(db, KINDS.audit),
    telegramLink: repo<Stored<TelegramLink>>(db, KINDS.telegramLink),
    payment: repo<Stored<PaymentRecord>>(db, KINDS.payment),
    balanceTransaction: repo<Stored<BalanceTransaction>>(db, KINDS.balanceTransaction),
    geoAnalysis: repo<Stored<GeoAnalysis>>(db, KINDS.geoAnalysis),
    geoPlan: repo<Stored<GeoPlan>>(db, KINDS.geoPlan),
    marketAnalysis: repo<Stored<MarketAnalysis>>(db, KINDS.marketAnalysis),
    botScan: repo<Stored<BotScan>>(db, KINDS.botScan),
    hypothesis: repo<Stored<Hypothesis>>(db, KINDS.hypothesis),
    experiment: repo<ExperimentDoc>(db, KINDS.experiment),
    campaign: repo<Stored<Campaign>>(db, KINDS.campaign),
    report: repo<Stored<ReportRecord>>(db, KINDS.report),
    scheduleRule: repo<Stored<ScheduleRule>>(db, KINDS.scheduleRule),
    scheduleRun: repo<Stored<ScheduleRun>>(db, KINDS.scheduleRun),
    patchBundle: repo<PatchBundleDoc>(db, KINDS.patchBundle),
    autofixRun: repo<AutofixRunDoc>(db, KINDS.autofixRun),
    secrets: new SecretsRepo(db),
    metrics: new MetricsRepo(db),
    events: new EventsRepo(db),
    kv: new KvRepo(db),
  };
}

export type Repos = RepoSet;
