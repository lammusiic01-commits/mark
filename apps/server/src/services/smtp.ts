import net from 'node:net';
import tls from 'node:tls';
import { rootLogger } from '../logger.js';

/**
 * Минимальный, но полноценный SMTP-клиент (без внешних зависимостей).
 *
 * Поддерживает:
 *  - implicit TLS (465), STARTTLS (587/25), plain (для локальных релеев);
 *  - AUTH LOGIN / AUTH PLAIN;
 *  - отправку писем с HTML, текстом и вложениями (base64);
 *  - корректную MIME-кодировку тем и имён файлов (RFC 2047).
 *
 * Используется для проверки подключения «E-mail (SMTP)» и доставки отчётов.
 */

const log = rootLogger.child('smtp');

interface SmtpResponse {
  code: number;
  lines: string[];
}

export interface SmtpConnectOptions {
  host: string;
  port: number;
  secure: 'tls' | 'starttls' | 'none';
  user?: string;
  password?: string;
  from: string;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
}

export interface SmtpAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: SmtpAttachment[];
}

const encodeBase64Utf8 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

/** Кодирование заголовка по RFC 2047 (для кириллицы в теме/именах файлов). */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${encodeBase64Utf8(value)}?=`;
}

const wrap76 = (input: string) => input.replace(/(.{76})/g, '$1\r\n').trimEnd();

export class SmtpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private pending: { resolve: (value: SmtpResponse) => void; reject: (error: Error) => void } | null = null;
  private readonly timeoutMs: number;
  private readonly name = 'mark.local';

  constructor(private options: SmtpConnectOptions) {
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  get capabilities() {
    return this.capabilitiesList;
  }
  private capabilitiesList: string[] = [];
  private secured = false;

  connect(): Promise<SmtpResponse> {
    const { host, port, secure, rejectUnauthorized = true } = this.options;
    return new Promise<SmtpResponse>((resolve, reject) => {
      const onConnect = async () => {
        try {
          const greeting = await this.readResponse();
          if (greeting.code !== 220) {
            reject(new Error(`SMTP-сервер ответил ${greeting.code}: ${greeting.lines.join(' ')}`));
            return;
          }
          resolve(greeting);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const socket =
        secure === 'tls'
          ? tls.connect({ host, port, servername: host, rejectUnauthorized, timeout: this.timeoutMs }, onConnect)
          : net.connect({ host, port, timeout: this.timeoutMs }, onConnect);

      socket.setTimeout(this.timeoutMs);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('timeout', () => this.failAll(new Error('Таймаут SMTP-соединения')));
      socket.on('error', (error) => this.failAll(error));
      socket.on('close', () => this.failAll(new Error('SMTP-соединение закрыто')));
      this.socket = socket;
    });
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    const response = this.tryParse();
    if (response && this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(response);
    }
  }

  private tryParse(): SmtpResponse | null {
    const lines = this.buffer.split('\r\n');
    if (lines.length < 2) return null;
    const complete: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!line) continue;
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) continue;
      complete.push(match[3] ?? '');
      if (match[2] === ' ') {
        const code = Number(match[1]);
        this.buffer = lines.slice(i + 1).join('\r\n');
        return { code, lines: complete };
      }
    }
    return null;
  }

  private readResponse(): Promise<SmtpResponse> {
    const parsed = this.tryParse();
    if (parsed) return Promise.resolve(parsed);
    return new Promise<SmtpResponse>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private failAll(error: Error) {
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      reject(error);
    }
  }

  private write(line: string) {
    this.socket?.write(`${line}\r\n`);
  }

  async command(command: string, expected: number[]): Promise<SmtpResponse> {
    log.debug(`> ${command.startsWith('AUTH') || command.length > 20 ? command.slice(0, 8) + '…' : command}`);
    this.write(command);
    const response = await this.readResponse();
    if (!expected.includes(response.code)) {
      throw new Error(`Команда "${command.split(' ')[0]}" вернула ${response.code}: ${response.lines.join(' ')}`);
    }
    return response;
  }

  async ehlo(): Promise<SmtpResponse> {
    const response = await this.command(`EHLO ${this.name}`, [250]);
    this.capabilitiesList = response.lines.map((line) => line.toUpperCase());
    return response;
  }

  async helo(): Promise<SmtpResponse> {
    return this.command(`HELO ${this.name}`, [250]);
  }

  async startTls(): Promise<void> {
    await this.command('STARTTLS', [220]);
    const socket = this.socket;
    if (!socket) throw new Error('Нет соединения для STARTTLS');
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSocket = tls.connect(
        {
          socket,
          servername: this.options.host,
          rejectUnauthorized: this.options.rejectUnauthorized ?? true,
        },
        () => resolve(tlsSocket),
      );
      tlsSocket.once('error', reject);
    });
    secured.setTimeout(this.timeoutMs);
    this.socket = secured;
    this.buffer = '';
    this.secured = true;
    secured.on('data', (chunk: Buffer) => this.onData(chunk));
    secured.on('timeout', () => this.failAll(new Error('Таймаут SMTP-соединения')));
    secured.on('error', (error: Error) => this.failAll(error));
    secured.on('close', () => this.failAll(new Error('SMTP-соединение закрыто')));
    await this.ehlo();
  }

  /** Подготовка соединения: STARTTLS при необходимости + EHLO. */
  async prepare(): Promise<{ tls: boolean; capabilities: string[] }> {
    await this.ehlo();
    if (this.options.secure === 'starttls' && !this.secured) {
      if (!this.capabilitiesList.some((line) => line.includes('STARTTLS'))) {
        throw new Error('Сервер не поддерживает STARTTLS, но выбрано обязательное шифрование. Используйте порт 465 или отключите TLS.');
      }
      await this.startTls();
    }
    return { tls: this.secured || this.options.secure === 'tls', capabilities: this.capabilitiesList };
  }

  async authenticate(): Promise<void> {
    const { user, password } = this.options;
    if (!user || !password) return;
    const authLine = this.capabilitiesList.find((line) => line.startsWith('AUTH')) ?? '';
    if (authLine.includes('PLAIN')) {
      const token = encodeBase64Utf8(`\u0000${user}\u0000${password}`);
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    }
    await this.command('AUTH LOGIN', [334]);
    await this.command(encodeBase64Utf8(user), [334]);
    await this.command(encodeBase64Utf8(password), [235]);
  }

  /** Отправка письма. Проверяет ответы на каждом шаге протокола. */
  async sendMail(message: MailMessage): Promise<void> {
    await this.command(`MAIL FROM:<${this.options.from}>`, [250]);
    for (const recipient of message.to) {
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await this.command('DATA', [354]);
    const payload = this.buildMime(message);
    this.socket?.write(`${payload}\r\n.\r\n`);
    const response = await this.readResponse();
    if (response.code !== 250) {
      throw new Error(`Сервер не принял письмо: ${response.code} ${response.lines.join(' ')}`);
    }
  }

  buildMime(message: MailMessage): string {
    const boundary = `--mark_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const headers: string[] = [
      `From: ${encodeHeaderValue(this.options.from)}`,
      `To: ${message.to.map((t) => encodeHeaderValue(t)).join(', ')}`,
      `Subject: ${encodeHeaderValue(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
    ];

    const hasAttachments = Boolean(message.attachments?.length);
    const hasHtml = Boolean(message.html);
    const hasText = Boolean(message.text);

    if (hasAttachments || (hasHtml && hasText)) {
      headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    } else if (hasHtml) {
      headers.push('Content-Type: text/html; charset=UTF-8');
      headers.push('Content-Transfer-Encoding: base64');
    } else {
      headers.push('Content-Type: text/plain; charset=UTF-8');
      headers.push('Content-Transfer-Encoding: base64');
    }

    const parts: string[] = [headers.join('\r\n'), ''];

    const bodyPart = (content: string, type: string) =>
      [
        `Content-Type: ${type}; charset=UTF-8`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(encodeBase64Utf8(content)),
      ].join('\r\n');

    if (hasAttachments || (hasHtml && hasText)) {
      const alternativeBoundary = `${boundary}_alt`;
      const alternative = [
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
        '',
        `--${alternativeBoundary}`,
        bodyPart(message.text ?? '', 'text/plain'),
        `--${alternativeBoundary}`,
        bodyPart(message.html ?? message.text ?? '', 'text/html'),
        `--${alternativeBoundary}--`,
      ].join('\r\n');
      parts.push(`--${boundary}`, alternative);
      for (const attachment of message.attachments ?? []) {
        const content = Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content, 'utf8');
        parts.push(
          `--${boundary}`,
          `Content-Type: ${attachment.contentType ?? 'application/octet-stream'}; name="${encodeHeaderValue(attachment.filename)}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${encodeHeaderValue(attachment.filename)}"`,
          '',
          wrap76(content.toString('base64')),
        );
      }
      parts.push(`--${boundary}--`);
    } else if (hasHtml) {
      parts.push(wrap76(encodeBase64Utf8(message.html ?? '')));
    } else {
      parts.push(wrap76(encodeBase64Utf8(message.text ?? '')));
    }

    return parts.join('\r\n');
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT', [221]);
    } catch {
      /* сервер мог закрыть соединение сам */
    }
    this.close();
  }

  close() {
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

/** Высокоуровневая отправка письма «в один вызов». */
export async function sendMailWithOptions(options: SmtpConnectOptions, message: MailMessage): Promise<void> {
  const client = new SmtpClient(options);
  try {
    await client.connect();
    await client.prepare();
    await client.authenticate();
    await client.sendMail(message);
    await client.quit();
  } finally {
    client.close();
  }
}
