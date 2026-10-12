/**
 * Тонкий клиент API MARK.
 *
 * Все ответы сервера имеют вид { ok: true, data } либо { ok: false, error }.
 * Здесь это превращается в обычные промисы с выбросом MarkApiError,
 * чтобы в компонентах не было повторяющейся обработки.
 */

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

export class MarkApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MarkApiError';
  }
}

const BASE = import.meta.env.VITE_MARK_API ?? '';

function tenantHeader(): Record<string, string> {
  const tenant = localStorage.getItem('mark.tenantId');
  return tenant ? { 'x-mark-tenant': tenant } : {};
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...tenantHeader(),
      ...(init?.headers ?? {}),
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });

  const text = await response.text();
  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || (payload && payload.ok === false)) {
    throw new MarkApiError(payload?.error ?? `Ошибка запроса (${response.status})`, response.status, payload?.details);
  }
  if (payload && payload.ok && 'data' in payload) return payload.data as T;
  return payload as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** Прямая ссылка на файл (отчёт, CSV) — открывается в новой вкладке. */
  fileUrl: (path: string) => `${BASE}${path}`,
};

/** Скачивание файла с сервера (без открытия вкладки). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new MarkApiError(`Не удалось скачать файл (${response.status})`, response.status);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Пагинация в стиле «страница + размер». */
export function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}
