import { httpJson } from '../../http/client.js';

/**
 * Клиент Telegram Bot API.
 *
 * Всё общение с Telegram проходит через этот модуль: сообщения, клавиатуры,
 * файлы (отчёты), ответы на нажатия кнопок и long-polling обновлений.
 * Токен передаётся явно — бот может быть подключён у разных агентств.
 */

export const TELEGRAM_API = process.env.MARK_TELEGRAM_API_BASE ?? 'https://api.telegram.org';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string };
  web_app_data?: { data: string; button_text?: string };
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Кнопка инлайн-клавиатуры (низкоуровневое представление). */
export type TelegramButton =
  | { text: string; url: string }
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

export interface SendOptions {
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  keyboard?: TelegramButton[][];
  inline?: boolean;
  disablePreview?: boolean;
  replyToMessageId?: number;
}

function body(text: string, options: SendOptions): Record<string, unknown> {
  const keyboard = options.keyboard?.length
    ? options.inline === false
      ? { keyboard: options.keyboard, resize_keyboard: true, is_persistent: true }
      : { inline_keyboard: options.keyboard }
    : undefined;
  return {
    text: text.slice(0, 4096),
    parse_mode: options.parseMode ?? 'HTML',
    disable_web_page_preview: options.disablePreview ?? true,
    reply_markup: keyboard,
    reply_to_message_id: options.replyToMessageId,
  };
}

export class TelegramBotApi {
  constructor(private readonly token: string) {}

  get configured(): boolean {
    return Boolean(this.token);
  }

  private url(method: string): string {
    return `${TELEGRAM_API}/bot${this.token}/${method}`;
  }

  async call<T>(method: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<{ ok: boolean; result?: T; error?: string }> {
    if (!this.token) return { ok: false, error: 'Токен бота не задан' };
    const response = await httpJson<{ ok?: boolean; result?: T; description?: string }>(this.url(method), {
      method: 'POST',
      body: payload,
      timeoutMs,
    });
    if (!response.ok || !response.data?.ok) {
      return { ok: false, error: response.data?.description ?? response.error ?? `HTTP ${response.status}` };
    }
    return { ok: true, result: response.data.result };
  }

  getMe() {
    return this.call<TelegramUser>('getMe');
  }

  sendMessage(chatId: string | number, text: string, options: SendOptions = {}) {
    return this.call<TelegramMessage>('sendMessage', { chat_id: chatId, ...body(text, options) });
  }

  editMessageText(chatId: string | number, messageId: number, text: string, options: SendOptions = {}) {
    return this.call<TelegramMessage>('editMessageText', { chat_id: chatId, message_id: messageId, ...body(text, options) });
  }

  deleteMessage(chatId: string | number, messageId: number) {
    return this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string, showAlert = false) {
    return this.call<boolean>('answerCallbackQuery', { callback_query_id: id, text: text?.slice(0, 200), show_alert: showAlert });
  }

  sendChatAction(chatId: string | number, action = 'typing') {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<boolean>('setMyCommands', { commands });
  }

  /** Кнопка меню чата: открывает приложение MARK прямо из Telegram. */
  setChatMenuButton(webAppUrl: string, text = 'Открыть MARK') {
    return this.call<boolean>('setChatMenuButton', {
      menu_button: { type: 'web_app', text, web_app: { url: webAppUrl } },
    });
  }

  setChatMenuButtonCommands() {
    return this.call<boolean>('setChatMenuButton', { menu_button: { type: 'commands' } });
  }

  getUpdates(offset: number, timeoutSec = 25) {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      (timeoutSec + 10) * 1000,
    );
  }

  /** Отправка файла (отчёт) — multipart, без внешних зависимостей. */
  async sendDocument(
    chatId: string | number,
    file: { filename: string; content: Buffer | string; contentType: string },
    options: { caption?: string; parseMode?: 'HTML'; keyboard?: TelegramButton[][] } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.token) return { ok: false, error: 'Токен бота не задан' };
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (options.caption) {
      form.set('caption', options.caption.slice(0, 1024));
      form.set('parse_mode', options.parseMode ?? 'HTML');
    }
    if (options.keyboard?.length) form.set('reply_markup', JSON.stringify({ inline_keyboard: options.keyboard }));
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    form.set('document', new Blob([new Uint8Array(bytes)], { type: file.contentType }), file.filename);

    try {
      const response = await fetch(this.url('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
      if (!response.ok || !payload?.ok) return { ok: false, error: payload?.description ?? `HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Экранирование под HTML-разметку Telegram. */
export function tgEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Жирный текст. */
export const b = (value: unknown): string => `<b>${tgEscape(value)}</b>`;
/** Курсив. */
export const i = (value: unknown): string => `<i>${tgEscape(value)}</i>`;
/** Код. */
export const code = (value: unknown): string => `<code>${tgEscape(value)}</code>`;

/** Оценка цвета прогресса для текстовых отчётов. */
export function scoreIcon(value: number, good = 80, warn = 60): string {
  if (value >= good) return '🟢';
  if (value >= warn) return '🟡';
  return '🔴';
}

export function money(value: number): string {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

/** Полоса прогресса из символов — работает в любом чате. */
export function progressBar(percent: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(percent)}%`;
}
