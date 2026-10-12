"""Доставка уведомлений из очереди Redis в Telegram.

Как это работает:
  1. API или движок вызывает notify(...) — задание уходит в очередь Redis;
  2. бот (единственный, кто говорит с Telegram) разбирает очередь и
     отправляет сообщение нужному пользователю;
  3. если пользователь заблокировал бота, он помечается is_blocked и больше
     не получает рассылок.

Если Redis недоступен, notify() не падает: пишет предупреждение в лог и
возвращает False — продукт продолжает работать.
"""

from __future__ import annotations

import asyncio
from typing import Any

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from sqlalchemy import update

from bot.keyboards import KIND_ICONS, back_to_app_keyboard
from core.database import session_scope
from core.logger import get_logger
from core.models import User
from core.redis_client import push_notification, queue_size, take_notification

log = get_logger(__name__)


async def notify(
    tg_id: int,
    text: str,
    *,
    kind: str = "info",
    reply_markup: dict[str, Any] | None = None,
    silence: bool = False,
) -> bool:
    """Ставит уведомление в очередь. Отправит его бот-процесс."""
    return await push_notification(tg_id, text, kind=kind, reply_markup=reply_markup, silence=silence)


async def _mark_blocked(tg_id: int) -> None:
    """Пользователь заблокировал бота — фиксируем, чтобы не долбиться."""
    try:
        async with session_scope() as session:
            await session.execute(update(User).where(User.tg_id == tg_id).values(is_blocked=True))
        log.info("Пользователь заблокировал бота", tg_id=tg_id)
    except Exception as error:  # noqa: BLE001 — фоновая задача не должна падать
        log.warning("Не удалось отметить блокировку", tg_id=tg_id, error=str(error))


def _render(payload: dict[str, Any]) -> str:
    """Добавляет иконку по типу уведомления."""
    icon = KIND_ICONS.get(str(payload.get("kind", "info")), "ℹ️")
    return f"{icon} {payload.get('text', '')}"


async def send_payload(bot: Bot, payload: dict[str, Any]) -> bool:
    """Отправляет одно уведомление. Возвращает True при успехе."""
    tg_id = payload.get("tg_id")
    text = str(payload.get("text") or "").strip()
    if not isinstance(tg_id, int) or not text:
        log.warning("Некорректное уведомление в очереди — пропускаю", payload=list(payload.keys()))
        return False

    try:
        await bot.send_message(
            chat_id=tg_id,
            text=_render(payload)[:4096],
            reply_markup=back_to_app_keyboard(),
            disable_notification=bool(payload.get("silence")),
        )
        log.info("Уведомление доставлено", tg_id=tg_id, kind=payload.get("kind"))
        return True
    except TelegramForbiddenError:
        await _mark_blocked(tg_id)
        return False
    except TelegramRetryAfter as error:
        # Telegram просит подождать — уважаем лимит и пробуем ещё раз
        log.warning("Telegram просит паузу", seconds=error.retry_after, tg_id=tg_id)
        await asyncio.sleep(error.retry_after)
        return await send_payload(bot, payload)
    except Exception as error:  # noqa: BLE001 — сеть, прокси, разметка
        log.error("Не удалось отправить уведомление", tg_id=tg_id, error=str(error))
        return False


async def run_consumer(bot: Bot, stop_event: asyncio.Event, poll_timeout: int = 5) -> None:
    """Бесконечный цикл разбора очереди. Останавливается по stop_event.

    Если Redis недоступен, цикл ждёт с нарастающей паузой (1, 2, 4… до 30
    секунд) и возвращается к обычному режиму, как только очередь ответила.
    Без этого пауза берётся из BRPOP, а при лежащем Redis запросы падают
    мгновенно — бот забивал бы лог тысячами строк в секунду.
    """
    log.info("Слушаю очередь уведомлений")
    backoff = 1.0
    while not stop_event.is_set():
        try:
            # Отдаём управление событийному циклу: без этого итерации без
            # ввода-вывода не дают хода другим задачам и сторожу остановки.
            await asyncio.sleep(0)
            payload, redis_ok = await take_notification(timeout_seconds=poll_timeout)
            if not redis_ok:
                if backoff == 1.0:
                    log.warning("Очередь уведомлений недоступна — жду восстановления Redis")
                if await _sleep_or_stop(stop_event, backoff):
                    break
                backoff = min(backoff * 2, 30.0)
                continue
            if backoff != 1.0:
                log.info("Очередь уведомлений снова доступна")
                backoff = 1.0
            if payload is None:
                continue
            await send_payload(bot, payload)
        except asyncio.CancelledError:
            log.info("Разбор очереди остановлен")
            raise
        except Exception as error:  # noqa: BLE001 — цикл не должен умирать
            log.error("Ошибка в разборе очереди уведомлений", error=str(error))
            if await _sleep_or_stop(stop_event, 3):
                break


async def _sleep_or_stop(stop_event: asyncio.Event, seconds: float) -> bool:
    """Ждёт паузу, но просыпается сразу при остановке. True — пора выходить."""
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
        return True
    except asyncio.TimeoutError:
        return False


async def stats() -> dict[str, int]:
    """Сколько уведомлений ждёт отправки — для /health и диагностики."""
    return {"pending": await queue_size()}


__all__ = ["notify", "run_consumer", "send_payload", "stats"]
