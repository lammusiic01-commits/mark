import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Корень репозитория (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function envNum(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const argv = process.argv.slice(2);
export const args = {
  serveWeb: argv.includes('--serve-web'),
  port: (() => {
    const idx = argv.indexOf('--port');
    return idx >= 0 ? Number(argv[idx + 1]) : undefined;
  })(),
  dataDir: (() => {
    const idx = argv.indexOf('--data-dir');
    return idx >= 0 ? argv[idx + 1] : undefined;
  })(),
};

/** Каталог данных (БД, отчёты, секреты). Вне git. */
export function resolveDataDir(): string {
  const explicit = args.dataDir ?? process.env.MARK_DATA_DIR;
  const dir = explicit ? path.resolve(explicit) : path.join(REPO_ROOT, '.data');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

export const config = {
  get dataDir() {
    return resolveDataDir();
  },
  get dbFile() {
    return path.join(this.dataDir, 'mark.sqlite');
  },
  get vaultKeyFile() {
    return path.join(this.dataDir, 'vault.key');
  },
  get reportsDir() {
    return path.join(this.dataDir, 'reports');
  },
  get uploadsDir() {
    return path.join(this.dataDir, 'uploads');
  },
  get sessionsDir() {
    return path.join(this.dataDir, 'sessions');
  },
  host: envStr('MARK_HOST', '0.0.0.0'),
  port: args.port ?? envNum('MARK_PORT', 8787),
  nodeEnv: envStr('NODE_ENV', 'development'),
  logLevel: envStr('MARK_LOG_LEVEL', 'info'),
  /** Демо-режим: сетевые вызовы к внешним сервисам заменяются детерминированной симуляцией */
  demoMode: envBool('MARK_DEMO_MODE', false),
  /** Разрешить исходящие сетевые запросы (можно отключить в закрытом контуре) */
  allowOutbound: envBool('MARK_ALLOW_OUTBOUND', true),
  /** Отключить автоматические записи на реальные сайты (безопасность) */
  dryRunAlways: envBool('MARK_DRY_RUN', false),
  httpTimeoutMs: envNum('MARK_HTTP_TIMEOUT_MS', 20_000),
  httpUserAgent: `MARK/${'1.0.0'} (+${envStr('MARK_SITE_URL', 'https://mark.local')})`,
  maxCrawlPages: envNum('MARK_MAX_CRAWL_PAGES', 60),
  /** Telegram-бот: токен и админский чат (иначе берутся из подключённого сервиса Telegram) */
  telegramBotToken: envStr('MARK_TELEGRAM_BOT_TOKEN', ''),
  telegramAdminChatId: envStr('MARK_TELEGRAM_ADMIN_CHAT_ID', ''),
  /** Публичный HTTPS-адрес MARK — из него собирается ссылка Mini App для Telegram */
  publicUrl: envStr('MARK_PUBLIC_URL', ''),
  /** Отключить запуск бота (например, в тестах или при работе через webhook) */
  telegramBotDisabled: envBool('MARK_TELEGRAM_DISABLED', false),
  webDir: path.join(REPO_ROOT, 'apps', 'web', 'dist'),
  /** Ключ подписи файлов отчётов (для проверки целостности) */
  get platform() {
    return `${os.platform()}-${os.arch()}`;
  },
};

export type Config = typeof config;
