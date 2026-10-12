"""Telegram-бот: /start, кнопка WebApp и уведомления.

Вся логика и расчёты живут в движке (engine/) и API — бот только показывает
кнопку приложения и доставляет сообщения, чтобы у пользователя был один
понятный вход в продукт.
"""

from bot.proxy_session import ProxyConfigurationError, create_bot, create_session

__all__ = ["ProxyConfigurationError", "create_bot", "create_session"]
