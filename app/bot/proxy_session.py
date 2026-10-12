"""
Все запросы к Telegram Bot API идут через Cloudflare Worker (TELEGRAM_PROXY_URL).

Без прокси бот в России не работает: api.telegram.org заблокирован,
поэтому здесь НЕТ фолбэка на прямое подключение — если прокси не задан,
бросаем исключение, и бот не стартует с понятной ошибкой.

Worker должен пробрасывать:
  {proxy}/bot<token>/<method>   → https://api.telegram.org/bot<token>/<method>
  {proxy}/file/bot<token>/<path> → https://api.telegram.org/file/bot<token>/<path>
"""
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

from app.config import settings


def build_proxy_session() -> AiohttpSession:
    proxy = settings.TELEGRAM_PROXY_URL.strip().rstrip("/")

    if not proxy:
        raise RuntimeError(
            "TELEGRAM_PROXY_URL пуст. Заполни secrets.env (Cloudflare Worker для api.telegram.org)."
        )
    if not proxy.startswith("https://"):
        raise RuntimeError(
            f"TELEGRAM_PROXY_URL должен начинаться с https://, сейчас: {proxy}"
        )

    # aiogram подставляет {token} и {method} / {path} сам.
    # В f-строке двойные фигурные скобки дают одинарные в итоговом шаблоне.
    api_server = TelegramAPIServer(
        base=f"{proxy}/bot{{token}}/{{method}}",
        file=f"{proxy}/file/bot{{token}}/{{path}}",
    )
    return AiohttpSession(api=api_server)
