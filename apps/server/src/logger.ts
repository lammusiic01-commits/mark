import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, `mark-${new Date().toISOString().slice(0, 10)}.log`), { flags: 'a' });
    return stream;
  } catch {
    return null;
  }
}

const minLevel = (): number => LEVELS[(process.env.MARK_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function write(level: Level, scope: string, message: string, meta?: unknown) {
  if (LEVELS[level] < minLevel()) return;
  const ts = new Date().toISOString();
  const metaText = meta === undefined ? '' : ` ${safeJson(meta)}`;
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}${metaText}`;
  const colored = `${COLORS[level]}${line}${RESET}`;
  if (level === 'error') process.stderr.write(`${colored}\n`);
  else process.stdout.write(`${colored}\n`);
  const fs2 = fileStream();
  if (fs2) fs2.write(`${line}\n`);
}

function safeJson(value: unknown): string {
  try {
    if (value instanceof Error) return JSON.stringify({ message: value.message, name: value.name });
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: unknown) => write('debug', scope, message, meta),
    info: (message: string, meta?: unknown) => write('info', scope, message, meta),
    warn: (message: string, meta?: unknown) => write('warn', scope, message, meta),
    error: (message: string, meta?: unknown) => write('error', scope, message, meta),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
export const rootLogger = createLogger('mark');
