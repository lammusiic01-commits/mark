/**
 * Мок Telegram Bot API для локальной проверки бота без выхода в интернет.
 *
 * Запуск:  node apps/server/tmp/mock-telegram.mjs 8899
 * Затем:   MARK_TELEGRAM_BOT_TOKEN=1:test MARK_TELEGRAM_API_BASE=http://127.0.0.1:8899 npx tsx apps/server/src/server.ts
 *
 * Мок принимает те же пути, что и настоящий Bot API (/bot<token>/<method>),
 * складывает входящие сообщения в файл и отдаёт заранее подготовленные
 * обновления из очереди (см. POST /__push).
 */
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] ?? 8899);
const inbox = process.argv[3] ?? '/tmp/mock-telegram-inbox.jsonl';
fs.writeFileSync(inbox, '');

/** Очередь обновлений: сюда кладём message/callback_query как от Telegram. */
let queue = [];
/** Идентификатор последнего сообщения, чтобы editMessageText было что править. */
const sent = new Map();
let messageId = 1000;

const me = { id: 1, is_bot: true, first_name: 'MARK Test', username: 'mark_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  // Служебный эндпоинт: положить обновление в очередь
  if (req.method === 'POST' && url.pathname === '/__push') {
    queue.push(JSON.parse(body));
    res.writeHead(200).end('{"ok":true}');
    return;
  }
  // Служебный эндпоинт: что бот отправил
  if (url.pathname === '/__inbox') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(fs.readFileSync(inbox, 'utf8'));
    return;
  }

  const method = url.pathname.replace(/^\/bot[^/]+\//, '');
  const params = body ? (JSON.parse(body) || {}) : {};

  fs.appendFileSync(inbox, `${JSON.stringify({ method, params, at: new Date().toISOString() })}\n`);

  const json = (payload) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));

  switch (method) {
    case 'getMe':
      return json({ ok: true, result: me });
    case 'setMyCommands':
    case 'setChatMenuButton':
    case 'deleteMessage':
    case 'setChatMenuButtonCommands':
      return json({ ok: true, result: true });
    case 'sendMessage': {
      const id = ++messageId;
      sent.set(id, String(params.text ?? ''));
      return json({ ok: true, result: { message_id: id, chat: { id: params.chat_id }, text: params.text } });
    }
    case 'editMessageText': {
      const id = params.message_id ?? ++messageId;
      sent.set(id, String(params.text ?? ''));
      return json({ ok: true, result: { message_id: id, text: params.text } });
    }
    case 'answerCallbackQuery':
    case 'sendChatAction':
    case 'sendDocument':
      return json({ ok: true, result: true });
    case 'getUpdates': {
      if (!queue.length) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const updates = queue;
      queue = [];
      return json({ ok: true, result: updates });
    }
    default:
      return json({ ok: true, result: true });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Мок Telegram Bot API слушает 127.0.0.1:${port}, входящие пишутся в ${inbox}`);
});
