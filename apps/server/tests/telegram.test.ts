import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Тесты Telegram-бота: подпись initData, хелперы разметки и живой прогон
 * long-polling против локального мок-сервера Bot API.
 *
 * Мок поднимается в этом же процессе на свободном порту, поэтому тест
 * проверяет настоящий цикл: getMe → setMyCommands → кнопка приложения →
 * приём обновления → привязка чата → ответ пользователю.
 */

const TOKEN = '111:TEST-TOKEN';
let server: http.Server;
let base: string;
const sent: { method: string; params: Record<string, unknown> }[] = [];
let queue: unknown[] = [];

/** Собираем initData так же, как это делает Telegram. */
function buildInitData(user: Record<string, unknown>, token: string, authDate: number): string {
  const params = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: String(authDate),
    query_id: 'AAF-test',
  });
  const checkString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

beforeAll(async () => {
  process.env.MARK_TELEGRAM_API_BASE = '';
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const method = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/bot[^/]+\//, '');
      sent.push({ method, params });
      const json = (payload: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      if (method === 'getMe') {
        json({ ok: true, result: { id: 1, is_bot: true, first_name: 'MARK Test', username: 'mark_test_bot' } });
        return;
      }
      if (method === 'getUpdates') {
        const updates = queue;
        queue = [];
        setTimeout(() => json({ ok: true, result: updates }), 50);
        return;
      }
      json({ ok: true, result: { message_id: 500 + sent.length, text: params.text ?? '' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Демо-данные нужны для проверки привязки чатов к агентству
  const { repos } = await import('../src/db/repos.js');
  await repos();
  const { ensureDemoData } = await import('../src/seed.js');
  await ensureDemoData();
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.MARK_TELEGRAM_API_BASE = base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('проверка подписи Telegram (validateInitData)', () => {
  it('принимает корректную подпись и возвращает пользователя', async () => {
    const { validateInitData } = await import('../src/services/telegram/auth.js');
    const initData = buildInitData({ id: 42, first_name: 'Иван', username: 'ivan' }, TOKEN, Math.floor(Date.now() / 1000));
    const result = validateInitData(initData, TOKEN);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.user?.id).toBe(42);
    expect(result.user?.first_name).toBe('Иван');
  });

  it('отклоняет подделанные данные и просроченную подпись', async () => {
    const { validateInitData } = await import('../src/services/telegram/auth.js');
    const fresh = buildInitData({ id: 42, first_name: 'Иван', username: 'ivan' }, TOKEN, Math.floor(Date.now() / 1000));
    const tampered = fresh.replace('ivan', 'hacker');
    expect(tampered).not.toBe(fresh);
    expect(validateInitData(tampered, TOKEN).verified).toBe(false);

    // Подпись верная, но сессия старше суток — приложение должно отказать
    const old = buildInitData({ id: 42, first_name: 'Иван' }, TOKEN, Math.floor(Date.now() / 1000) - 60 * 60 * 30);
    const stale = validateInitData(old, TOKEN);
    expect(stale.verified).toBe(true);
    expect(stale.ok).toBe(false);
    expect(String(stale.reason)).toContain('устарела');

    // Другой токен — другая подпись
    expect(validateInitData(fresh, '999:OTHER').verified).toBe(false);
  });

  it('без токена бота помечает сессию как непроверенную, но не падает', async () => {
    const { validateInitData } = await import('../src/services/telegram/auth.js');
    const initData = buildInitData({ id: 7, first_name: 'Без подписи' }, TOKEN, Math.floor(Date.now() / 1000));
    const result = validateInitData(initData, null);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
  });
});

describe('разметка сообщений бота', () => {
  it('экранирует HTML и собирает клавиатуры', async () => {
    const { b, i, code, tgEscape, progressBar, scoreIcon } = await import('../src/services/telegram/api.js');
    expect(tgEscape('ООО «Ромашка» <b>')).toBe('ООО «Ромашка» &lt;b&gt;');
    expect(b('жирный')).toBe('<b>жирный</b>');
    expect(i('курсив')).toBe('<i>курсив</i>');
    expect(code('getMe')).toContain('<code>');
    expect(progressBar(50, 10)).toContain('█');
    expect(scoreIcon(95)).not.toBe(scoreIcon(10));
  });
});

describe('бот в режиме long-polling (мок Bot API)', () => {
  it('запускается, настраивает меню и кнопку приложения', async () => {
    const { MarkTelegramBot } = await import('../src/services/telegram/bot.js');
    const { repos } = await import('../src/db/repos.js');
    await repos();
    const tenants = (await repos()).tenant.list({ limit: 1 });
    expect(tenants.length).toBeGreaterThan(0);

    const bot = new MarkTelegramBot({
      tenantId: tenants[0]!.id,
      botToken: TOKEN,
      publicUrl: 'https://mark.example.com',
      tokenSource: 'env',
    });

    sent.length = 0;
    queue = [];
    const started = await bot.start();
    expect(started.ok).toBe(true);
    expect(started.username).toBe('mark_test_bot');
    expect(bot.status.running).toBe(true);
    expect(bot.webAppUrl).toBe('https://mark.example.com/#/tg');

    const methods = sent.map((item) => item.method);
    expect(methods).toContain('getMe');
    expect(methods).toContain('setMyCommands');

    const menu = sent.find((item) => item.method === 'setChatMenuButton');
    expect(JSON.stringify(menu?.params)).toContain('https://mark.example.com/#/tg');

    // Первое сообщение нового чата привязывает его как владельца
    queue.push({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 700001, type: 'private', first_name: 'Пётр' },
        from: { id: 700001, first_name: 'Пётр', username: 'petr' },
        text: '/start',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const answers = sent.filter((item) => item.method === 'sendMessage');
    expect(answers.length).toBeGreaterThan(0);
    expect(String(answers[0]!.params.text)).toContain('Пётр');

    const db = await repos();
    const link = db.telegramLink.list({ tenantId: tenants[0]!.id, limit: 50 }).find((item) => String(item.chatId) === '700001');
    expect(link?.role).toBe('owner');

    bot.stop();
    expect(bot.status.running).toBe(false);
  }, 20_000);
});
