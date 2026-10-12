import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';

/** Общие хелперы маршрутов: обработка ошибок, tenant, валидация схем. */

const log = rootLogger.child('http');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Обёртка для async-обработчиков: ошибки уходят в error-middleware. */
export const ah =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

export function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ ok: true, data });
}

export function fail(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json({ ok: false, error: message, details });
}

/** Валидация тела запроса схемой zod с понятным сообщением об ошибке. */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  try {
    return schema.parse(body ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ApiError(422, `Проверьте параметры: ${details.map((d) => `${d.path || 'поле'} — ${d.message}`).join('; ')}`, details);
    }
    throw error;
  }
}

/** Текущий тенант: из заголовка x-mark-tenant (slug или id) либо первый в базе. */
export async function currentTenantId(req: Request): Promise<string> {
  const db = await repos();
  const requested = (req.header('x-mark-tenant') ?? '').trim();
  const tenants = db.tenant.list({ limit: 20 });
  if (requested) {
    const match = tenants.find((tenant) => tenant.id === requested || tenant.slug === requested);
    if (match) return match.id;
  }
  if (tenants[0]) return tenants[0].id;
  throw new ApiError(500, 'Тенант не найден. Перезапустите сервер: он создаёт демо-тенант автоматически.');
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ApiError) {
    fail(res, error.status, error.message, error.details);
    return;
  }
  if (error instanceof ZodError) {
    fail(res, 422, 'Некорректные данные', error.issues);
    return;
  }
  if (error instanceof SyntaxError) {
    fail(res, 400, 'Некорректный JSON в запросе');
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('Необработанная ошибка API', { error: message, stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : undefined });
  fail(res, 500, `Внутренняя ошибка: ${message}`);
}

export function notFound(_req: Request, res: Response) {
  fail(res, 404, 'Метод API не найден');
}

/** Единая точка логирования запросов API (без секретов в теле). */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level](`${req.method} ${req.originalUrl} → ${res.statusCode}`, { ms: Date.now() - started });
  });
  next();
}
