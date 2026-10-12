"""Подключение бота к Telegram через прокси-сервер.

Прямые вызовы api.telegram.org запрещены — весь обмен идёт через
TELEGRAM_PROXY_URL из secrets.env. Здесь собирается aiogram-сессия так,
что прокси подставляется и для методов, и для скачивания файлов:

    base  = {proxy}/bot{token}/{method}
    file  = {proxy}/file/bot{token}/{path}
"""

from __future__ import annotations

from typing import Optional

from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ParseMode

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

# Таймауты: большие выгрузки статистики иногда идут долго, но не бесконечно
DEFAULT_TIMEOUT_SECONDS = 60


class ProxyConfigurationError(RuntimeError):
    """Понятная ошибка вместо «неверный URL» из глубины aiohttp."""


def build_api_server(proxy_url: Optional[str] = None) -> TelegramAPIServer:
    """Готовит описание Bot API через прокси.

    proxy_url — адрес Cloudflare Worker (например
    https://tg-proxy.example.workers.dev). Хвостовой слэш убираем: иначе
    получается «//bot…» и часть прокси отвечает ошибкой.
    """
    raw = (proxy_url or settings.TELEGRAM_PROXY_URL or "").strip().rstrip("/")
    if not raw:
        raise ProxyConfigurationError(
            "Пустой TELEGRAM_PROXY_URL в secrets.env — бот не сможет работать из РФ. "
            "Укажите адрес прокси, например https://tg-proxy.lammusiic01.workers.dev",
        )
    if not raw.startswith(("http://", "https://")):
        raise ProxyConfigurationError(
            f"TELEGRAM_PROXY_URL должен начинаться с https:// (сейчас: {raw[:20]}…)",
        )

    return TelegramAPIServer(
        base=f"{raw}/bot{{token}}/{{method}}",
        file=f"{raw}/file/bot{{token}}/{{path}}",
    )


def create_session(proxy_url: Optional[str] = None, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> AiohttpSession:
    """Создаёт HTTP-сессию aiogram, направленную на прокси."""
    api = build_api_server(proxy_url)
    session = AiohttpSession(api=api, timeout=timeout)
    # Логируем только адрес прокси: токен в логи не попадает
    log.info("Сессия Telegram настроена через прокси", proxy=api.base.split("/bot")[0], timeout=timeout)
    return session


def create_bot(
    token: Optional[str] = None,
    proxy_url: Optional[str] = None,
    *,
    session: Optional[AiohttpSession] = None,
) -> Bot:
    """Собирает Bot с прокси-сессией, HTML-разметкой и отключённым превью ссылок.

    Вызывается один раз при старте процесса: бот в проекте единственный,
    кто обращается к Telegram.
    """
    bot_token = (token or settings.BOT_TOKEN or "").strip()
    if ":" not in bot_token:
        raise ProxyConfigurationError(
            "BOT_TOKEN не заполнен в secrets.env. Получите токен у @BotFather командой /newbot.",
        )

    http_session = session or create_session(proxy_url)
    bot = Bot(
        token=bot_token,
        session=http_session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML, link_preview_is_disabled=True),
    )
    log.info("Бот собран", token=_safe_token(bot_token), proxy=bot.session.api.base.split("/bot")[0])
    return bot


async def check_connection(bot: Bot) -> dict[str, str | bool]:
    """Проверяет, что прокси и токен работают: getMe через прокси.

    Возвращает словарь для логов и диагностики. Ошибку не выбрасывает —
    вызывающий сам решает, останавливаться ли.
    """
    try:
        me = await bot.get_me()
    except Exception as error:  # noqa: BLE001 — любая сетевая/авторизационная проблема
        log.error("Не удалось получить данные бота через прокси", error=str(error))
        return {"ok": False, "error": str(error)}

    log.info("Бот на связи", username=me.username, id=me.id)
    return {"ok": True, "id": me.id, "username": me.username or "", "name": me.full_name}


def _safe_token(token: str) -> str:
    """Вид токена для логов: 1234567890:AA…<скрыто>."""
    if ":" not in token:
        return "<некорректный>"
    head = token.split(":", 1)[0]
    return f"{head}:***"


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "ProxyConfigurationError",
    "build_api_server",
    "check_connection",
    "create_bot",
    "create_session",
]
