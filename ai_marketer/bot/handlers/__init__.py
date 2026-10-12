"""Роутеры бота: вход и оплата.

Порядок важен: сначала общие команды (/start, /help), затем оплата —
иначе FSM-состояние ожидания суммы перехватит чужие сообщения.
"""

from aiogram import Router

from bot.handlers import payment, start

ROUTERS: tuple[Router, ...] = (start.router, payment.router)


def register(dispatcher_router: Router) -> None:
    """Подключает все роутеры бота к диспетчеру (или к родительскому роутеру)."""
    for router in ROUTERS:
        dispatcher_router.include_router(router)


__all__ = ["ROUTERS", "payment", "register", "start"]
