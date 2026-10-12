import { Router } from 'express';
import { MARK_VERSION, type TelegramBotStatus, type TelegramLink } from '@mark/shared';
import { config } from '../config.js';
import { repos } from '../db/repos.js';
import { ApiError, ah, currentTenantId, ok } from '../http/helpers.js';
import { rootLogger } from '../logger.js';
import { telegramBots, BOT_COMMANDS } from '../services/telegram/bot.js';
import { TelegramBotApi } from '../services/telegram/api.js';

/**
 * Управление Telegram-ботом из большого интерфейса: /api/telegram/*
 *
 * Отсюда владелец агентства может посмотреть статус, отправить тестовое
 * сообщение, перезапустить бота после смены токена и управлять доступами
 * к приложению (кто из сотрудников видит данные).
 */

const log = rootLogger.child('routes.telegram-admin');
export const telegramAdminRouter = Router();

/** Статус бота: запущен ли, какой бот, сколько чатов привязано. */
telegramAdminRouter.get(
  '/status',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const manager = telegramBots.get(tenantId);
    const links = db.telegramLink.list({ tenantId, limit: 200 }) as unknown as TelegramLink[];
    const account = db.account.list({ tenantId, limit: 300 }).find((item) => item.serviceId === 'telegram');
    const settings = db.kv.get<{ publicUrl?: string; telegramWebAppUrl?: string; telegramBotUsername?: string }>(`settings:${tenantId}`) ?? {};

    const status: TelegramBotStatus = {
      enabled: Boolean(manager) || Boolean(account) || Boolean(config.telegramBotToken),
      running: manager?.status.running ?? false,
      username: manager?.status.username ?? settings.telegramBotUsername ?? null,
      botName: manager?.status.botName ?? null,
      webAppUrl: manager?.status.webAppUrl ?? settings.telegramWebAppUrl ?? (config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/#/tg` : null),
      tokenSource: config.telegramBotToken ? 'env' : account ? 'account' : 'none',
      chats: links.length,
      commands: BOT_COMMANDS,
      hint: manager
        ? undefined
        : config.telegramBotDisabled
          ? 'Бот отключён переменной MARK_TELEGRAM_DISABLED'
          : 'Токен не задан: укажите MARK_TELEGRAM_BOT_TOKEN или подключите сервис Telegram в разделе «Подключения»',
    };

    ok(res, {
      status,
      publicUrl: config.publicUrl ?? settings.publicUrl ?? null,
      proxyBase: process.env.MARK_TELEGRAM_API_BASE ?? null,
      chats: links.map((link) => ({
        id: link.id,
        chatId: link.chatId,
        title: [link.firstName, link.lastName].filter(Boolean).join(' ') || link.username || String(link.chatId),
        role: link.role,
        notifications: link.notifications,
        linkedAt: link.linkedAt,
        lastSeenAt: link.lastSeenAt ?? null,
      })),
      version: MARK_VERSION,
    });
  }),
);

/** Тестовое сообщение: проверяем, что токен живой, а бот нас слышит. */
telegramAdminRouter.post(
  '/test',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const text = String(req.body?.text ?? '').slice(0, 600) || '✅ MARK на связи: бот работает, приложение готово к открытию.';

    const manager = telegramBots.get(tenantId);
    if (manager) {
      const result = await manager.sendTest(text, typeof req.body?.chatId === 'string' ? req.body.chatId : undefined);
      if (!result.ok) throw new ApiError(502, result.error ?? 'Telegram не принял сообщение');
      ok(res, { sent: true, chatId: result.chatId, source: 'bot' });
      return;
    }

    // Бот ещё не запущен: проверяем токен напрямую через Bot API
    const token = await resolveToken(db, tenantId);
    if (!token) throw new ApiError(422, 'Токен бота не найден: задайте MARK_TELEGRAM_BOT_TOKEN или подключите сервис Telegram');
    const api = new TelegramBotApi(token);
    const me = await api.getMe();
    if (!me.ok) throw new ApiError(502, me.error ?? 'Токен не принят Telegram');
    const links = db.telegramLink.list({ tenantId, limit: 200 }) as unknown as TelegramLink[];
    const chatId = links[0]?.chatId ?? config.telegramAdminChatId;
    if (!chatId) {
      ok(res, { sent: false, username: me.result?.username, message: 'Токен верный, но ни один чат ещё не привязан: отправьте боту /start в Telegram.' });
      return;
    }
    const sent = await api.sendMessage(chatId, text);
    if (!sent.ok) throw new ApiError(502, sent.error ?? 'Не удалось отправить сообщение');
    ok(res, { sent: true, chatId, username: me.result?.username, source: 'direct' });
  }),
);

/** Перезапуск бота после смены токена или публичного адреса. */
telegramAdminRouter.post(
  '/restart',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    telegramBots.stopAll();
    const result = await telegramBots.startFromConfig();
    log.info(`Перезапуск бота по запросу: ${result.started ? 'запущен' : result.reason ?? 'нет токена'}`);
    ok(res, { started: result.started, results: result.results, reason: result.reason ?? null });
  }),
);

/** Доступы сотрудников: роль и уведомления по каждому чату. */
telegramAdminRouter.patch(
  '/chats/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const link = db.telegramLink.get(req.params.id!) as unknown as TelegramLink | undefined;
    if (!link || link.tenantId !== tenantId) throw new ApiError(404, 'Чат не найден');
    const patch: Record<string, unknown> = {};
    if (['owner', 'manager', 'viewer'].includes(String(req.body?.role))) patch.role = req.body.role;
    if (typeof req.body?.notifications === 'boolean') patch.notifications = req.body.notifications;
    const updated = db.telegramLink.patch(link.id, patch as never);
    ok(res, updated);
  }),
);

telegramAdminRouter.delete(
  '/chats/:id',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const db = await repos();
    const link = db.telegramLink.get(req.params.id!) as unknown as TelegramLink | undefined;
    if (!link || link.tenantId !== tenantId) throw new ApiError(404, 'Чат не найден');
    db.telegramLink.delete(link.id);
    log.info(`Доступ чата ${link.chatId} отозван`);
    ok(res, { deleted: true });
  }),
);

/** Текст-приглашение: что отправить сотруднику, чтобы он подключил приложение. */
telegramAdminRouter.get(
  '/invite',
  ah(async (req, res) => {
    const tenantId = await currentTenantId(req);
    const manager = telegramBots.get(tenantId);
    const username = manager?.status.username ?? (await repos()).kv.get<{ telegramBotUsername?: string }>(`settings:${tenantId}`)?.telegramBotUsername ?? null;
    ok(res, {
      botUsername: username,
      link: username ? `https://t.me/${username}` : null,
      text: username
        ? `Откройте @${username} в Telegram, отправьте /start — и получите доступ к приложению AI Маркетолог: сводка, аудит, ставки и защита от ботов прямо в телефоне.`
        : 'Сначала задайте токен бота, затем здесь появится ссылка-приглашение.',
    });
  }),
);

async function resolveToken(db: Awaited<ReturnType<typeof repos>>, tenantId: string): Promise<string | null> {
  if (config.telegramBotToken) return config.telegramBotToken;
  const account = db.account.list({ tenantId, limit: 300 }).find((item) => item.serviceId === 'telegram');
  if (!account) return null;
  const payload = db.secrets.load(account.id);
  if (!payload) return null;
  try {
    const { decryptJson } = await import('../crypto.js');
    const data = decryptJson<{ botToken?: string }>(payload);
    return data.botToken ?? null;
  } catch {
    return null;
  }
}
