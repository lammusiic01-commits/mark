import type { AuthModeId, Capability, ConnectedAccount, ValidationCheck, ValidationResult } from '@mark/shared';
import { getService } from '@mark/shared';
import { config } from '../../config.js';

/**
 * Контекст проверки подключения: выполняет шаги плана валидации,
 * публикует события в реальном времени и собирает итоговый отчёт.
 */

export interface ValidationContext {
  serviceId: string;
  authMode: AuthModeId;
  fields: Record<string, string>;
  sandbox: boolean;
  /** Публикация события в канал test:<id> */
  emit: (type: string, payload: unknown) => void;
  account?: ConnectedAccount | null;
  cookiesHeader?: string | null;
  /** Позволяет ограничить скорость запросов (передаётся в HTTP-клиент) */
  allowNetwork?: boolean;
}

export function field(ctx: ValidationContext, key: string): string {
  const value = ctx.fields[key];
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

export function requireFields(ctx: ValidationContext, keys: string[]): void {
  const missing = keys.filter((key) => !field(ctx, key));
  if (missing.length) {
    const labels = missing.map((key) => key);
    throw new Error(`Не заполнены обязательные поля: ${labels.join(', ')}`);
  }
}

export class CheckRunner {
  private checks: ValidationCheck[] = [];
  private startedAt = new Date();

  constructor(private ctx: ValidationContext) {}

  get list(): ValidationCheck[] {
    return this.checks;
  }

  /** Добавить шаг плана, которого не было в проверке (например, при раннем выходе). */
  skip(key: string, title: string, message: string): void {
    const check: ValidationCheck = { key, title, status: 'warn', message };
    this.checks.push(check);
    this.ctx.emit('check', check);
  }

  async step(
    key: string,
    title: string,
    fn: () => Promise<{ status?: ValidationCheck['status']; message?: string; details?: Record<string, unknown> } | void>,
    hint?: string,
  ): Promise<ValidationCheck> {
    const running: ValidationCheck = { key, title, status: 'running', message: hint };
    this.ctx.emit('check', running);
    const t0 = Date.now();
    try {
      const result = (await fn()) ?? {};
      const check: ValidationCheck = {
        key,
        title,
        status: result.status ?? 'pass',
        message: result.message ?? 'OK',
        details: result.details,
        durationMs: Date.now() - t0,
      };
      this.checks.push(check);
      this.ctx.emit('check', check);
      return check;
    } catch (error) {
      const check: ValidationCheck = {
        key,
        title,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - t0,
      };
      this.checks.push(check);
      this.ctx.emit('check', check);
      return check;
    }
  }

  build(accountInfo?: Record<string, unknown>, capabilities?: Capability[]): ValidationResult {
    const statuses = this.checks.map((c) => c.status);
    const hasFail = statuses.includes('fail');
    const hasWarn = statuses.includes('warn');
    const service = getService(this.ctx.serviceId);
    return {
      serviceId: this.ctx.serviceId,
      authMode: this.ctx.authMode,
      mode: this.ctx.sandbox ? 'sandbox' : 'live',
      status: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
      checks: this.checks,
      accountInfo,
      capabilities: capabilities ?? service?.capabilities ?? [],
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

/** Единая проверка «демо-режим» (когда сеть запрещена или включена песочница). */
export function isSandboxLike(ctx: ValidationContext): boolean {
  if (!config.allowOutbound) return true;
  const token = field(ctx, 'token').toLowerCase();
  const keys = Object.values(ctx.fields).map((v) => String(v).toLowerCase());
  return (
    ctx.sandbox ||
    config.demoMode ||
    token === 'sandbox' ||
    token === 'demo' ||
    keys.some((v) => v === 'sandbox' || v === 'demo')
  );
}

export const describeFieldValue = (value: string) =>
  value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '••••';
