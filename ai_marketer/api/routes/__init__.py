"""Роуты API. Собираются в словарь ROUTERS — его читает api/server.py.

Каждый роут отвечает за один экран или одну сущность: так проще проверять и
менять код. Все роуты подключаются префиксом /api, то есть итоговые адреса
выглядят как /api/dashboard, /api/reports/bots и так далее.

Базовые, не зависящие от внешних сервисов роуты (онбординг, сервисы,
дашборд, кампании, отчёты, платежи) подключаются всегда: даже если один
модуль не импортировался, приложение поднимется и остальные экраны будут
работать — об ошибке сообщит лог.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from core.logger import get_logger

log = get_logger(__name__)

ROUTERS: dict[str, APIRouter] = {}


def _add(name: str, module: str, attribute: str = "router") -> None:
    """Подключает роут из модуля и не роняет приложение при ошибке в нём."""
    try:
        imported = __import__(module, fromlist=[attribute])
        router: Any = getattr(imported, attribute)
        if isinstance(router, APIRouter):
            ROUTERS[name] = router
        else:
            log.error("В модуле роута нет объекта APIRouter", module=module, name=name)
    except Exception as error:  # noqa: BLE001 — импорт не должен ломать сервер
        log.error("Роут не подключён", name=name, module=module, error=str(error)[:200])


_add("onboarding", "api.routes.onboarding")
_add("services", "api.routes.services")
_add("dashboard", "api.routes.dashboard")
_add("campaigns", "api.routes.campaigns")
_add("reports", "api.routes.reports")
_add("payments", "api.routes.payments")

__all__ = ["ROUTERS"]
