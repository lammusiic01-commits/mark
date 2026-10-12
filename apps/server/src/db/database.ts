import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { config } from '../config.js';
import { rootLogger } from '../logger.js';

const log = rootLogger.child('db');
const require = createRequire(import.meta.url);

/**
 * Лёгкая встраиваемая БД на sql.js (SQLite, скомпилированный в WASM).
 *
 * Почему так: не нужны нативные сборки (работает на Windows/macOS/Linux
 * без node-gyp), а данные лежат в обычном .sqlite-файле в .data/.
 * Запись — с дебаунсом, чтобы не тормозить на каждый INSERT.
 */

let SQL: SqlJsStatic | null = null;

function locateWasm(): string {
  const candidates = [
    (() => {
      try {
        return path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
      } catch {
        return '';
      }
    })(),
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(config.dataDir, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Не найден файл sql-wasm.wasm (пакет sql.js). Выполните npm install в корне проекта.',
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  tenant_id   TEXT,
  client_id   TEXT,
  status      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_objects_kind_tenant ON objects (kind, tenant_id);
CREATE INDEX IF NOT EXISTS idx_objects_kind_client ON objects (kind, client_id);
CREATE INDEX IF NOT EXISTS idx_objects_kind_status ON objects (kind, status);

CREATE TABLE IF NOT EXISTS secrets (
  account_id TEXT PRIMARY KEY,
  payload_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  scope      TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  date       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (scope, ref_id, date)
);
CREATE INDEX IF NOT EXISTS idx_metrics_ref ON metrics (scope, ref_id);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  type       TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export class MarkDatabase {
  private db: Database;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor(db: Database) {
    this.db = db;
  }

  static async open(file = config.dbFile): Promise<MarkDatabase> {
    if (!SQL) {
      SQL = await initSqlJs({ locateFile: () => locateWasm() });
    }
    let buffer: Uint8Array | undefined;
    if (fs.existsSync(file)) {
      try {
        buffer = new Uint8Array(fs.readFileSync(file));
      } catch (error) {
        log.error('Не удалось прочитать файл БД, создаю новый', error);
      }
    }
    const db = new SQL.Database(buffer);
    db.run('PRAGMA journal_mode = MEMORY;');
    db.run(SCHEMA);
    const instance = new MarkDatabase(db);
    instance.file = file;
    log.info('База данных готова', { file, exists: Boolean(buffer) });
    return instance;
  }

  file!: string;

  /* ------------------------------ Чтение ------------------------------ */

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const rows = this.all<T>(sql, params);
    return rows[0];
  }

  scalar(sql: string, params: unknown[] = []): unknown {
    const row = this.get<Record<string, unknown>>(sql, params);
    if (!row) return undefined;
    return Object.values(row)[0];
  }

  count(sql: string, params: unknown[] = []): number {
    const value = this.scalar(sql, params);
    return typeof value === 'number' ? value : 0;
  }

  /* ------------------------------ Запись ------------------------------ */

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never);
    this.markDirty();
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.markDirty();
  }

  /** Транзакция: при ошибке выполняется откат. */
  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.markDirty();
      return result;
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  private markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 350);
  }

  /** Немедленная запись на диск (атомарно, через временный файл). */
  persist(): void {
    if (!this.dirty) return;
    try {
      const data = this.db.export();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      log.error('Не удалось сохранить базу данных', error);
    }
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    try {
      this.persist();
    } finally {
      this.db.close();
    }
  }

  /** Полная очистка (используется тестами и командой сброса). */
  wipe(): void {
    const tables = ['objects', 'secrets', 'metrics', 'events', 'kv'];
    this.transaction(() => {
      for (const table of tables) this.db.run(`DELETE FROM ${table};`);
    });
  }
}

let instance: MarkDatabase | null = null;

export async function getDb(): Promise<MarkDatabase> {
  if (!instance) instance = await MarkDatabase.open();
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Для тестов: подменить БД. */
export function setDb(db: MarkDatabase | null): void {
  instance = db;
}
