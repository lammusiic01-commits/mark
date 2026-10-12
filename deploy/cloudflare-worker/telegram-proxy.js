/**
 * Cloudflare Worker — прокси к Telegram Bot API.
 *
 * Зачем: серверы в России не могут напрямую обращаться к api.telegram.org.
 * Воркер живёт на edge-сети Cloudflare, принимает путь вида
 *   https://ваш-воркер.workers.dev/bot<TOKEN>/sendMessage
 * и пересылает запрос на https://api.telegram.org/bot<TOKEN>/sendMessage,
 * сохраняя метод, тело и заголовки. Ответ возвращается как есть.
 *
 * Установка (5 минут):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker.
 *   2. Вставьте этот код, нажмите Deploy.
 *   3. Скопируйте адрес вида https://tg-proxy.<аккаунт>.workers.dev
 *   4. На сервере MARK задайте переменную:
 *        MARK_TELEGRAM_API_BASE=https://tg-proxy.<аккаунт>.workers.dev
 *   5. Перезапустите MARK — бот будет работать даже при закрытом прямом доступе.
 *
 * Безопасность: по умолчанию разрешены только пути /bot<token>/... и /file/bot<token>/...
 * Дополнительно можно задать секретный заголовок (см. SHARED_SECRET — добавьте
 * такую же переменную в настройки MARK, если хотите закрыть прокси от чужих).
 */

/** Необязательный секрет: если задан, воркер принимает только запросы с этим значением заголовка X-Proxy-Secret. */
const SHARED_SECRET = '';

/** Ограничение частоты не делаем: Telegram сам лимитирует, а воркер только пересылает. */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;

    // Разрешаем только обращения к Bot API — воркер нельзя использовать как открытый прокси
    if (!/^\/(file\/)?bot[^/]+\//.test(url.pathname)) {
      return new Response('MARK Telegram proxy: ожидается путь /bot<token>/<method>', { status: 404 });
    }

    if (SHARED_SECRET && request.headers.get('x-proxy-secret') !== SHARED_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('x-proxy-secret');

    const init = {
      method: request.method,
      headers,
      redirect: 'follow',
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      // Cloudflare Workers поддерживает стриминговое тело без дополнительных флагов
      init.duplex = 'half';
    }

    const response = await fetch(`https://api.telegram.org${path}`, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
