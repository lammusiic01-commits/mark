"""Единое логирование проекта на structlog.

Правила:
  • в production — JSON-строки (их удобно собирать в Grafana/Loki);
  • в development — цветной вывод для чтения глазами;
  • секреты в логи не попадают: фильтр вырезает значения из secrets.env.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from core.config import settings

_CONFIGURED = False

# Слова, по которым узнаём секрет: если ключ такой — значение маскируем
_SECRET_KEYS = (
    "token",
    "password",
    "secret",
    "api_key",
    "apikey",
    "encryption_key",
    "authorization",
    "init_data",
    "cookie",
    "sbp_",
)


def _hide_secrets(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """Убирает из логов значения, похожие на секреты."""
    for key in list(event_dict.keys()):
        lowered = key.lower()
        if any(marker in lowered for marker in _SECRET_KEYS):
            value = event_dict[key]
            if isinstance(value, str) and value:
                event_dict[key] = f"{value[:6]}…<скрыто>" if len(value) > 8 else "<скрыто>"
            elif value is not None:
                event_dict[key] = "<скрыто>"
    return event_dict


def configure_logging(level: str | None = None) -> None:
    """Настраивает structlog и стандартный logging. Повторный вызов безопасен."""
    global _CONFIGURED

    log_level = (level or settings.LOG_LEVEL).upper()
    if _CONFIGURED:
        logging.getLogger().setLevel(log_level)
        return

    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        _hide_secrets,
    ]

    renderer: Any = (
        structlog.processors.JSONRenderer(ensure_ascii=False)
        if settings.is_production
        else structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())
    )

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(log_level)),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=log_level,
        force=True,
    )

    # Библиотеки не должны заливать логи в наш stdout
    for noisy in ("aiogram.event", "aiogram.dispatcher", "sqlalchemy.engine.Engine", "httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, logging.getLevelName(log_level)))

    _CONFIGURED = True


def get_logger(name: str | None = None) -> Any:
    """Логгер с именем модуля: get_logger(__name__).

    Имя передаём через bind: вывод идёт напрямую в stdout (PrintLogger),
    поэтому у логгера нет атрибута name — так строка выглядит одинаково
    и в JSON, и в консольном режиме.
    """
    configure_logging()
    return structlog.get_logger().bind(logger=name or "ai_marketer")
