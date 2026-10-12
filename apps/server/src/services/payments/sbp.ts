import QRCode from 'qrcode';
import type { BalanceTransaction, PaymentPlan, PaymentRecord } from '@mark/shared';
import { config } from '../../config.js';
import { randomId } from '../../crypto.js';
import { repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';

/**
 * Баланс и оплата через СБП (Система быстрых платежей).
 *
 * Как это работает: приложение показывает сумму → сервис формирует платёжную
 * ссылку СБП и QR → пользователь платит в банковском приложении → MARK опрашивает
 * статус платежа и зачисляет баланс.
 *
 * Провайдер задаётся переменными окружения:
 *   MARK_SBP_MERCHANT_ID, MARK_SBP_ACCOUNT, MARK_SBP_PROVIDER_URL, MARK_SBP_QR_TEMPLATE
 * Если провайдер не подключён — работает встроенный «тестовый банк»: платёж
 * создаётся, QR строится, но зачисление подтверждается вручную менеджером
 * (или автоматически в демо-режиме) — так продукт можно показывать клиенту.
 */

const log = rootLogger.child('payments');

export const TOPUP_MIN = 500;
export const TOPUP_MAX = 500_000;

/** Тарифы подписки: что входит и сколько стоит. */
export const PAYMENT_PLANS: PaymentPlan[] = [
  {
    id: 'start',
    name: 'Старт',
    price: 2_900,
    period: 'месяц',
    description: 'Один сайт и один рекламный кабинет',
    features: [
      'Аудит сайта раз в неделю',
      'BotShield: проверка логов до 1 ГБ',
      'Гипотезы роста (10 в месяц)',
      'Отчёт клиенту раз в месяц',
    ],
  },
  {
    id: 'business',
    name: 'Бизнес',
    price: 7_900,
    period: 'месяц',
    description: 'До пяти сайтов, автооптимизация ставок',
    popular: true,
    features: [
      'До пяти сайтов и трёх кабинетов',
      'Автооптимизация ставок по расписанию',
      'GEO-план по регионам, Вордстат',
      'AI-советник по данным ваших кампаний',
      'Отчёты клиентам под белой меткой',
      'Поддержка в Telegram',
    ],
  },
  {
    id: 'agency',
    name: 'Агентство',
    price: 19_900,
    period: 'месяц',
    description: 'Белая метка и неограниченные проекты',
    features: [
      'Неограниченные сайты и кабинеты',
      'Белая метка: ваш логотип и цвета',
      'Доступ команды (роли и права)',
      'Автозапуск полного цикла по cron',
      'Персональный менеджер',
    ],
  },
];

/* ------------------------------ Хранилище ------------------------------ */

function balanceKey(tenantId: string): string {
  return `balance:${tenantId}`;
}

export async function getBalance(tenantId: string): Promise<{ balance: number; hold: number; currency: 'RUB'; plan?: string | null; planUntil?: string | null }> {
  const db = await repos();
  const stored = db.kv.get<{ balance: number; hold: number; currency: 'RUB'; plan?: string | null; planUntil?: string | null }>(balanceKey(tenantId));
  return {
    balance: Number(stored?.balance ?? 0),
    hold: Number(stored?.hold ?? 0),
    currency: 'RUB',
    plan: stored?.plan ?? null,
    planUntil: stored?.planUntil ?? null,
  };
}

async function writeBalance(tenantId: string, patch: { balance?: number; hold?: number; plan?: string | null; planUntil?: string | null }): Promise<void> {
  const db = await repos();
  const current = await getBalance(tenantId);
  db.kv.set(balanceKey(tenantId), { ...current, ...patch, updatedAt: new Date().toISOString() });
}

/** Списание за услугу (например, платный аудит сверх тарифа). */
export async function charge(tenantId: string, amount: number, reason: string): Promise<{ ok: boolean; balance: number; error?: string }> {
  const current = await getBalance(tenantId);
  if (amount <= 0) return { ok: false, balance: current.balance, error: 'Сумма должна быть больше нуля' };
  if (current.balance < amount) {
    return { ok: false, balance: current.balance, error: `Недостаточно средств: нужно ${amount} ₽, на балансе ${current.balance} ₽` };
  }
  const balance = current.balance - amount;
  await writeBalance(tenantId, { balance });
  await logTransaction(tenantId, { type: 'charge', amount: -amount, balanceAfter: balance, description: reason });
  return { ok: true, balance };
}

async function logTransaction(
  tenantId: string,
  data: { type: BalanceTransaction['type']; amount: number; balanceAfter: number; description: string; paymentId?: string | null },
): Promise<void> {
  const db = await repos();
  const transaction: BalanceTransaction = {
    id: randomId('tx'),
    tenantId,
    type: data.type,
    amount: data.amount,
    balanceAfter: data.balanceAfter,
    description: data.description,
    paymentId: data.paymentId ?? null,
    createdAt: new Date().toISOString(),
  };
  db.balanceTransaction.put(transaction as never);
}

export async function listTransactions(tenantId: string, limit = 30): Promise<BalanceTransaction[]> {
  const db = await repos();
  return db.balanceTransaction.list({ tenantId, limit }) as unknown as BalanceTransaction[];
}

/* ------------------------------- СБП ---------------------------------- */

interface SbpConfig {
  merchantId: string;
  account: string;
  providerUrl: string;
  qrTemplate: string;
  testMode: boolean;
}

function sbpConfig(): SbpConfig {
  const merchantId = process.env.MARK_SBP_MERCHANT_ID?.trim() ?? '';
  const account = process.env.MARK_SBP_ACCOUNT?.trim() ?? '';
  const providerUrl = process.env.MARK_SBP_PROVIDER_URL?.trim() ?? '';
  return {
    merchantId,
    account,
    providerUrl,
    qrTemplate: process.env.MARK_SBP_QR_TEMPLATE?.trim() || 'https://qr.nspk.ru/AS1A{id}?type=02&bank=100000000111&sum={sum}&cur=RUB&crc=0',
    testMode: !providerUrl,
  };
}

/**
 * Платёжная ссылка СБП.
 * Формат ссылки НСПК: банк открывает её как «оплатить по QR» — это то, что
 * сканируют камерой и то, что открывается кнопкой «Открыть банк».
 */
function sbpLinkFor(paymentId: string, amount: number): string {
  const cfg = sbpConfig();
  const sum = Math.round(amount * 100); // СБП ждёт сумму в копейках
  return cfg.qrTemplate.replace('{id}', paymentId.replace(/[^A-Za-z0-9]/g, '').slice(-20).toUpperCase()).replace('{sum}', String(sum));
}

export async function createPayment(tenantId: string, amount: number, options: { comment?: string } = {}): Promise<PaymentRecord & { sbpUrl: string; qrPngBase64: string }> {
  if (!Number.isFinite(amount) || amount < TOPUP_MIN) throw new Error(`Минимальная сумма пополнения — ${TOPUP_MIN} ₽`);
  if (amount > TOPUP_MAX) throw new Error(`Максимальная сумма — ${TOPUP_MAX.toLocaleString('ru-RU')} ₽`);

  const db = await repos();
  const id = randomId('pay');
  const cfg = sbpConfig();
  const sbpUrl = sbpLinkFor(id, amount);
  const payload = JSON.stringify({ id, sum: amount, merchant: cfg.merchantId || 'MARK' });

  // QR: в реальном СБП это ссылка платёжной системы, в тестовом режиме — ссылка+реквизиты
  const qrContent = cfg.testMode ? `СБП:${id}:${amount}:${cfg.account || 'TEST'}` : sbpUrl;
  const qrPngBase64 = await QRCode.toDataURL(qrContent, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#000000', light: '#FFFFFF' },
  }).then((dataUrl: string) => dataUrl.replace(/^data:image\/png;base64,/, ''));

  const payment: PaymentRecord = {
    id,
    tenantId,
    amount,
    status: 'pending',
    provider: cfg.testMode ? 'sbp_test' : 'sbp',
    sbpUrl,
    payload,
    comment: options.comment ?? 'Пополнение баланса',
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  db.payment.put(payment as never);
  await logTransaction(tenantId, { type: 'topup_pending', amount, balanceAfter: (await getBalance(tenantId)).balance, description: `Платёж создан: ${options.comment ?? 'пополнение'}`, paymentId: id });
  log.info(`Платёж создан: ${amount} ₽ (${id})${cfg.testMode ? ' — тестовый режим' : ''}`);
  return { ...payment, sbpUrl, qrPngBase64 };
}

/** Проверка статуса: у реального провайдера — запрос, в тестовом режиме — отметка времени. */
export async function checkPayment(tenantId: string, paymentId: string): Promise<PaymentRecord> {
  const db = await repos();
  const payment = db.payment.get(paymentId) as unknown as PaymentRecord | undefined;
  if (!payment || payment.tenantId !== tenantId) throw new Error('Платёж не найден');

  const cfg = sbpConfig();
  if (payment.status !== 'pending') return payment;

  if (!cfg.testMode && cfg.providerUrl) {
    try {
      const response = await fetch(`${cfg.providerUrl.replace(/\/$/, '')}/payments/${encodeURIComponent(paymentId)}`, {
        headers: cfg.merchantId ? { 'X-Merchant-Id': cfg.merchantId } : {},
        signal: AbortSignal.timeout(8000),
      });
      const payload = (await response.json().catch(() => null)) as { status?: string } | null;
      const status = payload?.status;
      if (status === 'paid') return confirmPayment(tenantId, paymentId, 'провайдер СБП');
      if (status === 'failed' || status === 'expired') {
        const updated = db.payment.patch(paymentId, { status: status === 'failed' ? 'failed' : 'expired' } as never);
        return updated as unknown as PaymentRecord;
      }
    } catch (error) {
      log.warn('Не удалось опросить провайдера СБП', { error: error instanceof Error ? error.message : String(error) });
    }
    return payment;
  }

  // Тестовый режим: платёж считается оплаченным, если владелец подтвердил вручную
  // (кнопка «Подтвердить» в интерфейсе) или включён автоплатёж в демо-режиме.
  if (config.demoMode && Date.now() - new Date(payment.createdAt).getTime() > 5000) {
    return confirmPayment(tenantId, paymentId, 'тестовый режим');
  }
  return payment;
}

/** Зачисление платежа на баланс (идемпотентно). */
export async function confirmPayment(tenantId: string, paymentId: string, source = 'вручную'): Promise<PaymentRecord> {
  const db = await repos();
  const payment = db.payment.get(paymentId) as unknown as PaymentRecord | undefined;
  if (!payment || payment.tenantId !== tenantId) throw new Error('Платёж не найден');
  if (payment.status === 'paid') return payment;

  const current = await getBalance(tenantId);
  const balance = current.balance + Number(payment.amount);
  await writeBalance(tenantId, { balance });
  const updated = db.payment.patch(paymentId, { status: 'paid', paidAt: new Date().toISOString(), confirmedBy: source } as never) as unknown as PaymentRecord;
  await logTransaction(tenantId, { type: 'topup', amount: Number(payment.amount), balanceAfter: balance, description: `Пополнение подтверждено (${source})`, paymentId });
  log.info(`Платёж зачислен: ${payment.amount} ₽ → баланс ${balance} ₽`);
  return updated;
}

export async function listPayments(tenantId: string, limit = 20): Promise<PaymentRecord[]> {
  const db = await repos();
  return db.payment.list({ tenantId, limit }) as unknown as PaymentRecord[];
}

/** Активация тарифа: списывает стоимость с баланса и продлевает подписку. */
export async function activatePlan(tenantId: string, planId: string, months = 1): Promise<{ ok: boolean; error?: string; balance: number; planUntil?: string }> {
  const plan = PAYMENT_PLANS.find((item) => item.id === planId);
  if (!plan) return { ok: false, error: 'Тариф не найден', balance: (await getBalance(tenantId)).balance };

  const price = plan.price * months;
  const result = await charge(tenantId, price, `Тариф «${plan.name}» на ${months} мес`);
  if (!result.ok) return { ok: false, error: result.error, balance: result.balance };

  const until = new Date();
  until.setMonth(until.getMonth() + months);
  await writeBalance(tenantId, { plan: plan.id, planUntil: until.toISOString() });
  return { ok: true, balance: result.balance, planUntil: until.toISOString() };
}

/** Расходы за период — для дашборда («сколько сэкономлено и сколько списано»). */
export async function spendSummary(tenantId: string): Promise<{ charged30d: number; toppedUp30d: number }> {
  const transactions = await listTransactions(tenantId, 200);
  const since = Date.now() - 30 * 86_400_000;
  let charged30d = 0;
  let toppedUp30d = 0;
  for (const transaction of transactions) {
    if (new Date(transaction.createdAt).getTime() < since) continue;
    if (transaction.type === 'charge') charged30d += Math.abs(transaction.amount);
    if (transaction.type === 'topup') toppedUp30d += Math.abs(transaction.amount);
  }
  return { charged30d: Math.round(charged30d), toppedUp30d: Math.round(toppedUp30d) };
}
