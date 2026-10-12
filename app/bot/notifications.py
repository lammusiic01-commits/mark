"""Отправка уведомлений пользователям из фоновых задач. Бот регистрируется в main.py."""
import logging

from aiogram import Bot

log = logging.getLogger("app.notify")
_bot: Bot | None = None


def set_bot(bot: Bot | None) -> None:
    global _bot
    _bot = bot


async def notify(tg_id: int, text: str) -> bool:
    if _bot is None:
        return False
    try:
        await _bot.send_message(tg_id, text)
        return True
    except Exception:
        log.warning("Не удалось отправить уведомление %s", tg_id, exc_info=True)
        return False
