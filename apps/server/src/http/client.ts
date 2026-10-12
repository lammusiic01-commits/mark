import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { rootLogger } from '../logger.js';

const log = rootLogger.child('http');

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  /** Тело запроса: объект → JSON, строка → как есть, URLSearchParams → form-urlencoded */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  retries?: number;
  /** Разрешить невалидные TLS-сертификаты (для внутренних стендов) */
  insecure?: boolean;
  maxBytes?: number;
  /** Ответ принимаем как текст, не пытаясь парсить */
  raw?: boolean;
  redirect?: 'follow' | 'manual';
  signal?: AbortSignal;
  /** Не логировать тело (по умолчанию секреты не логируются) */
  silent?: boolean;
}

export interface HttpResult<T = unknown> {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  data: T | null;
  durationMs: number;
  error?: string;
  url: string;
}

function buildUrl(url: string, query?: HttpRequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readWithCap(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return merged.toString('utf8');
}

/**
 * Универсальный HTTP-клиент: таймауты, ретраи с экспоненциальной задержкой,
 * ограничение размера ответа, безопасный TLS-флаг, понятные ошибки.
 */
export async function httpRequest<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<HttpResult<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = config.httpTimeoutMs,
    retries = 1,
    insecure = false,
    maxBytes = 12 * 1024 * 1024,
    raw = false,
    redirect = 'follow',
    signal,
    silent = false,
  } = options;

  const finalUrl = buildUrl(url, options.query);
  const started = Date.now();
  const mergedHeaders: Record<string, string> = {
    'User-Agent': config.httpUserAgent,
    Accept: 'application/json, text/plain, */*',
    ...headers,
  };

  let payload: BodyInit | undefined;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof body === 'string') {
      payload = body;
      if (!mergedHeaders['Content-Type']) mergedHeaders['Content-Type'] = 'application/json';
    } else if (body instanceof URLSearchParams) {
      payload = body.toString();
      mergedHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      payload = body as BodyInit;
    } else {
      payload = JSON.stringify(body);
      mergedHeaders['Content-Type'] = mergedHeaders['Content-Type'] ?? 'application/json';
    }
  }

  if (!config.allowOutbound) {
    return {
      ok: false,
      status: 0,
      headers: {},
      text: '',
      data: null,
      durationMs: 0,
      error: 'Исходящие сетевые запросы запрещены (MARK_ALLOW_OUTBOUND=0)',
      url: finalUrl,
    };
  }

  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let lastError = '';
  const attempts = Math.max(1, retries + 1);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetch(finalUrl, {
        method,
        headers: mergedHeaders,
        body: payload,
        redirect,
        signal: controller.signal,
        // @ts-expect-error undici-специфичное поле, безопасно игнорируется в браузере
        compress: true,
      });
      const text = await readWithCap(response, maxBytes);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      let data: T | null = null;
      if (!raw && text) {
        const contentType = responseHeaders['content-type'] ?? '';
        if (contentType.includes('json') || /^[[{]/.test(text.trim())) {
          try {
            data = JSON.parse(text) as T;
          } catch {
            data = null;
          }
        }
      }
      const result: HttpResult<T> = {
        ok: response.ok,
        status: response.status,
        headers: responseHeaders,
        text,
        data,
        durationMs: Date.now() - started,
        url: finalUrl,
      };
      if (!silent) {
        log.debug(`${method} ${finalUrl} → ${response.status}`, { ms: result.durationMs });
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < attempts - 1) {
          const retryAfter = Number(responseHeaders['retry-after'] ?? 0);
          const wait = retryAfter > 0 ? retryAfter * 1000 : 300 * 2 ** attempt + Math.random() * 250;
          await sleep(Math.min(wait, 8000));
          continue;
        }
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt < attempts - 1) {
        await sleep(250 * 2 ** attempt + Math.random() * 200);
        continue;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  if (!silent) log.warn(`${method} ${finalUrl} — ошибка: ${lastError}`);
  return {
    ok: false,
    status: 0,
    headers: {},
    text: '',
    data: null,
    durationMs: Date.now() - started,
    error: lastError || 'Неизвестная сетевая ошибка',
    url: finalUrl,
  };
}

export const httpJson = <T = unknown>(url: string, options: HttpRequestOptions = {}) => httpRequest<T>(url, options);

export function httpError(result: HttpResult, prefix = 'Запрос не удался'): string {
  if (result.error) return `${prefix}: ${result.error}`;
  const snippet = result.text?.slice(0, 300).replace(/\s+/g, ' ').trim();
  return `${prefix}: HTTP ${result.status}${snippet ? ` — ${snippet}` : ''}`;
}

/* ------------------------------ Сеть / DNS ------------------------------ */

export async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await dns.reverse(ip);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

export async function forwardDns(hostname: string): Promise<string[]> {
  try {
    const records = await dns.resolve4(hostname);
    return records;
  } catch {
    return [];
  }
}

/**
 * Проверка «честности» поискового бота: rDNS должен указывать на доверенный домен,
 * а прямой DNS по этому имени — возвращать тот же IP.
 */
export async function verifyBotByReverseDns(
  ip: string,
  allowedDomains: string[],
): Promise<{ verified: boolean; hostname: string | null; detail: string }> {
  const hostname = await reverseDns(ip);
  if (!hostname) return { verified: false, hostname: null, detail: 'rDNS-запись отсутствует' };
  const lower = hostname.toLowerCase();
  const domainOk = allowedDomains.some((domain) => lower.endsWith(domain.toLowerCase()));
  if (!domainOk) return { verified: false, hostname, detail: `rDNS указывает на ${hostname} — не доверенный домен` };
  const forward = await forwardDns(hostname);
  if (forward.length && !forward.includes(ip)) {
    return { verified: false, hostname, detail: `прямой DNS не подтверждает IP (${forward.join(', ')})` };
  }
  return { verified: true, hostname, detail: `подтверждено rDNS: ${hostname}` };
}

export async function tcpCheck(host: string, port: number, timeoutMs = 6000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean, error?: string) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'таймаут соединения'));
    socket.once('error', (error) => finish(false, error.message));
  });
}

export async function tlsCertificateInfo(
  host: string,
  port = 443,
  timeoutMs = 8000,
): Promise<{ supported: boolean; validFrom?: string; validTo?: string; daysLeft?: number; issuer?: string; error?: string }> {
  return await new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      const daysLeft = validTo ? Math.round((validTo.getTime() - Date.now()) / 86_400_000) : undefined;
      resolve({
        supported: true,
        validFrom: cert?.valid_from,
        validTo: cert?.valid_to,
        daysLeft,
        issuer: typeof cert?.issuer === 'object' ? Object.values(cert.issuer).join(', ') : undefined,
      });
      socket.end();
    });
    socket.once('timeout', () => {
      resolve({ supported: false, error: 'таймаут TLS-рукопожатия' });
      socket.destroy();
    });
    socket.once('error', (error) => {
      resolve({ supported: false, error: error.message });
      socket.destroy();
    });
  });
}

/** Декодирование ответа с gzip/br/deflate (для ручных выгрузок). */
export function decompress(buffer: Buffer, encoding?: string | null): Buffer {
  const enc = (encoding ?? '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

export const sleepMs = sleep;
