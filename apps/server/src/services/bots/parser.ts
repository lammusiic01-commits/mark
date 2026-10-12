import type { BotScan } from '@mark/shared';
import { randomId } from '../../crypto.js';

/**
 * Разбор логов веб-сервера в события.
 *
 * Поддерживаются форматы:
 *  - nginx / apache combined (`ip - - [date] "GET /path HTTP/1.1" 200 1234 "referer" "ua"`);
 *  - Cloudflare Logpush (NDJSON с полями ClientIP, ClientRequestURI, EdgeResponseStatus…);
 *  - JSON (массив объектов с ip/uri/status/bytes/ua);
 *  - auto — определяем по первым строкам.
 */

export interface LogRecord {
  ip: string;
  time: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  referer: string;
  userAgent: string;
}

export interface ParseResult {
  format: BotScan['format'];
  records: LogRecord[];
  lines: number;
  skipped: number;
  errors: string[];
  firstAt?: string;
  lastAt?: string;
}

const COMBINED = /^(?<ip>\S+)\s+\S+\s+\S+\s+\[(?<time>[^\]]+)\]\s+"(?<req>[^"]*)"\s+(?<status>\d{3}|-)\s+(?<bytes>\d+|-)(?:\s+"(?<ref>[^"]*)"\s+"(?<ua>[^"]*)")?/;
const NCSA = /^(?<ip>\S+)\s+\S+\s+\S+\s+\[(?<time>[^\]]+)\]\s+"(?<req>[^"]*)"\s+(?<status>\d{3}|-)\s+(?<bytes>\d+|-)/;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const BOT_PATHS = [
  '/.env', '/.git', '/wp-login.php', '/wp-admin', '/xmlrpc.php', '/phpmyadmin', '/admin', '/administrator',
  '/vendor/phpunit', '/cgi-bin', '/.aws/credentials', '/config.json', '/docker-compose.yml', '/.ssh',
];

export function detectFormat(content: string): BotScan['format'] {
  const sample = content.slice(0, 4000).split('\n').slice(0, 5).join('\n');
  if (/^\s*[\[{]/m.test(sample) && /"(ClientIP|clientIP|ip|remote_addr)"/.test(sample)) {
    return /"ClientIP"|"EdgeResponseStatus"|"ClientRequestURI"/.test(sample) ? 'cloudflare' : 'json';
  }
  if (/\[[^\]]+\]\s+"[A-Z]+\s+\S+\s+HTTP\/[\d.]+"\s+\d{3}/.test(sample)) return 'nginx';
  if (/^\S+\s+\S+\s+\S+\s+\[/.test(sample)) return 'apache';
  return 'auto';
}

export function parseLogContent(content: string, formatInput: BotScan['format'] = 'auto', limit = 400_000): ParseResult {
  const format = formatInput === 'auto' ? detectFormat(content) : formatInput;
  const errors: string[] = [];
  const records: LogRecord[] = [];
  let lines = 0;
  let skipped = 0;

  if (format === 'json' || format === 'cloudflare') {
    const parsed = parseJsonLogs(content);
    return { format, ...parsed };
  }

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    lines += 1;
    if (records.length >= limit) {
      skipped += 1;
      continue;
    }
    const match = (format === 'nginx' ? COMBINED : NCSA).exec(raw) ?? NCSA.exec(raw);
    if (!match || !match.groups) {
      skipped += 1;
      if (errors.length < 5) errors.push(`Строка ${lines} не разобрана: ${raw.slice(0, 120)}`);
      continue;
    }
    const groups = match.groups;
    const [method = 'GET', path = '/'] = String(groups.req ?? '').split(' ');
    records.push({
      ip: String(groups.ip ?? '').trim(),
      time: parseApacheDate(String(groups.time ?? '')),
      method: method.toUpperCase(),
      path: normalizePath(path),
      status: Number(groups.status ?? 0) || 0,
      bytes: Number(groups.bytes ?? 0) || 0,
      referer: String(groups.ref ?? ''),
      userAgent: String(groups.ua ?? ''),
    });
  }

  const stats = timeRange(records);
  return { format, records, lines, skipped, errors, ...stats };
}

/** Быстрая сводка по «сырым» логам: сколько запросов, ботов и подозрительных. */
export function quickSummary(records: LogRecord[]): {
  requests: number;
  uniqueIps: number;
  bandwidthBytes: number;
  botPaths: number;
  errors4xx: number;
  errors5xx: number;
} {
  const ips = new Set<string>();
  let bandwidthBytes = 0;
  let botPaths = 0;
  let errors4xx = 0;
  let errors5xx = 0;
  for (const record of records) {
    ips.add(record.ip);
    bandwidthBytes += record.bytes;
    if (BOT_PATHS.some((prefix) => record.path.toLowerCase().startsWith(prefix))) botPaths += 1;
    if (record.status >= 400 && record.status < 500) errors4xx += 1;
    if (record.status >= 500) errors5xx += 1;
  }
  return { requests: records.length, uniqueIps: ips.size, bandwidthBytes, botPaths, errors4xx, errors5xx };
}

function parseJsonLogs(content: string): {
  records: LogRecord[];
  lines: number;
  skipped: number;
  errors: string[];
  firstAt?: string;
  lastAt?: string;
} {
  const records: LogRecord[] = [];
  const errors: string[] = [];
  let lines = 0;
  let skipped = 0;

  const push = (entry: Record<string, unknown>) => {
    const ip = String(entry.ClientIP ?? entry.clientIP ?? entry.ip ?? entry.remote_addr ?? entry.client_ip ?? '');
    if (!ip) {
      skipped += 1;
      return;
    }
    records.push({
      ip,
      time: toIso(String(entry.EdgeStartTimestamp ?? entry.timestamp ?? entry.time ?? entry['@timestamp'] ?? new Date().toISOString())),
      method: String(entry.ClientRequestMethod ?? entry.method ?? 'GET').toUpperCase(),
      path: normalizePath(String(entry.ClientRequestURI ?? entry.uri ?? entry.path ?? entry.request_uri ?? '/')),
      status: Number(entry.EdgeResponseStatus ?? entry.status ?? 0) || 0,
      bytes: Number(entry.EdgeResponseBytes ?? entry.bytes ?? entry.body_bytes_sent ?? 0) || 0,
      referer: String(entry.ClientRequestReferer ?? entry.referer ?? ''),
      userAgent: String(entry.ClientRequestUserAgent ?? entry.user_agent ?? entry.ua ?? ''),
    });
  };

  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const array = JSON.parse(trimmed) as Record<string, unknown>[];
      for (const entry of array) {
        lines += 1;
        push(entry);
      }
      return { records, lines, skipped, ...timeRange(records), errors };
    } catch (error) {
      errors.push(`Не удалось разобрать JSON-лог: ${error instanceof Error ? error.message : String(error)}`);
      return { records, lines, skipped, errors };
    }
  }

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    lines += 1;
    try {
      push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      skipped += 1;
      if (errors.length < 5) errors.push(`Строка ${lines} не является JSON`);
    }
  }
  return { records, lines, skipped, ...timeRange(records), errors: errors.length ? errors : [] };
}

function parseApacheDate(value: string): string {
  // 10/Oct/2026:03:12:11 +0300
  const match = /(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/.exec(value);
  if (!match) return new Date().toISOString();
  const [, day, mon, year, hour, minute, second, tz] = match;
  const month = MONTHS[String(mon).toLowerCase()] ?? 0;
  const offset = String(tz ?? '+0000');
  const date = new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)));
  const offsetMinutes = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) * (offset.startsWith('-') ? -1 : 1);
  return new Date(date.getTime() - offsetMinutes * 60_000).toISOString();
}

function toIso(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '/';
  return withoutQuery.length > 200 ? withoutQuery.slice(0, 200) : withoutQuery || '/';
}

function timeRange(records: LogRecord[]): { firstAt?: string; lastAt?: string } {
  if (!records.length) return {};
  const times = records.map((record) => record.time).sort();
  return { firstAt: times[0], lastAt: times[times.length - 1] };
}

export function newScanId(): string {
  return randomId('scan');
}
