import { httpJson } from '../http/client.js';
import { repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';
import { decryptJson } from '../crypto.js';

/** Уведомления в Telegram: алерты планировщика, статусы отчётов, находки BotShield. */

const log = rootLogger.child('telegram');

export interface TelegramConfig {
  botToken: string;
  chatId?: string;
}

export async function getTelegramConfig(tenantId: string): Promise<TelegramConfig | null> {
  const { account, secrets } = await repos();
  const accounts = account.list({ tenantId, limit: 200 }).filter((item) => item.serviceId === 'telegram');
  for (const item of accounts) {
    const payload = secrets.load(item.id);
    if (!payload) continue;
    try {
      const data = decryptJson<{ botToken?: string; chatId?: string }>(payload);
      if (data.botToken) return { botToken: data.botToken, chatId: data.chatId };
    } catch {
      continue;
    }
  }
  return null;
}

export async function sendTelegramMessage(
  tenantId: string,
  text: string,
  options: { parseMode?: 'HTML' | 'Markdown' | 'none'; chatIdOverride?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const config = await getTelegramConfig(tenantId);
  const chatId = options.chatIdOverride ?? config?.chatId;
  if (!config?.botToken || !chatId) {
    log.debug('Telegram не настроен — уведомление пропущено');
    return { ok: false, error: 'Telegram-бот или chat_id не настроены' };
  }
  const result = await httpJson<{ ok?: boolean; description?: string }>(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    body: {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: options.parseMode === 'none' ? undefined : options.parseMode ?? 'HTML',
      disable_web_page_preview: true,
    },
  });
  if (!result.data?.ok) {
    const error = result.data?.description ?? `HTTP ${result.status}`;
    log.warn('Не удалось отправить сообщение в Telegram', { error });
    return { ok: false, error };
  }
  return { ok: true };
}

export function formatAlert(title: string, lines: string[]): string {
  return `<b>${escape(title)}</b>\n${lines.map((line) => `• ${escape(line)}`).join('\n')}`;
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
