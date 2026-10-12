"""FastAPI-приложение: API между WebApp и движком.

На этом этапе поднимается рабочий каркас сервера:
  • /health — проверка живости (БД + Redis) для docker healthcheck;
  • /api/version — версия и режим работы;
  • статика WebApp, если фронтенд собран (webapp/dist);
  • подключение роутов из api.routes — как только они появятся (этап 7).

Секреты нигде не светятся: ни в ответах, ни в логах.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.routing import APIRouter

from core.config import settings
from core.database import dispose, ping as db_ping, wait_for_database
from core.logger import configure_logging, get_logger
from core.security import get_secret_box

VERSION = "0.1.0"  # версия фундамента; на финальном этапе — 1.0.0
STARTED_AT = time.time()
WEBAPP_DIST = Path(__file__).resolve().parent.parent / "webapp" / "dist"

log = get_logger(__name__)


async def redis_ping() -> tuple[bool, str | None]:
    """Проверка Redis. Если пакет не установлен — честно сообщаем об этом."""
    try:
        from redis.asyncio import Redis  # импорт внутри функции: Redis нужен не всегда
    except ImportError:  # pragma: no cover
        return False, "пакет redis не установлен"

    client = Redis.from_url(settings.REDIS_URL, socket_connect_timeout=3, socket_timeout=3)
    try:
        await client.ping()
        return True, None
    except Exception as error:  # noqa: BLE001 — сбой сети/сервера
        return False, str(error)
    finally:
        await client.aclose()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Старт: логи, ожидание базы, проверка ключа шифрования. Стоп: закрытие пулов."""
    configure_logging()
    log.info("Запуск API", version=VERSION, env=settings.ENV, https=settings.webapp_url_https)

    box = get_secret_box()
    log.info("Ключ шифрования загружен", fingerprint=box.key_fingerprint())

    for note in settings.warnings():
        log.warning("Замечание к настройкам", text=note)

    if not await wait_for_database(timeout_seconds=60):
        log.error("База данных недоступна — API поднимется, но запросы к данным будут падать")

    redis_ok, redis_error = await redis_ping()
    log.info("Redis проверен", ok=redis_ok, error=redis_error)

    try:
        yield
    finally:
        await dispose()
        log.info("API остановлен")


def _register_routers(app: FastAPI) -> list[str]:
    """Подключает роуты из api/routes, если они уже созданы (этапы 7+).

    Возвращает список имён подключённых роутеров — попадает в логи и /health.
    """
    connected: list[str] = []
    try:
        from api.routes import ROUTERS  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 — пакета ещё нет или он неполный
        return connected

    for name, router in ROUTERS.items():
        if isinstance(router, APIRouter):
            app.include_router(router, prefix="/api")
            connected.append(name)
            log.info("Роут подключён", router=name)
    return connected


def create_app() -> FastAPI:
    """Собирает приложение: middleware, служебные роуты, статика WebApp."""
    app = FastAPI(
        title="AI Маркетолог",
        description="Premium Telegram Mini App для управления Яндекс.Директом",
        version=VERSION,
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    # CORS: WebApp открывается с домена из WEBAPP_URL; в разработке — любые origin
    origins = [settings.WEBAPP_URL] if settings.is_production else ["*"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Telegram-Init-Data"],
    )

    connected = _register_routers(app)

    @app.get("/health", tags=["служебное"])
    async def health() -> JSONResponse:
        """Живость сервисов. 200 — всё в порядке, 503 — что-то недоступно."""
        db_ok = await db_ping()
        redis_ok, redis_error = await redis_ping()
        healthy = db_ok and redis_ok
        return JSONResponse(
            status_code=200 if healthy else 503,
            content={
                "status": "ok" if healthy else "degraded",
                "version": VERSION,
                "env": settings.ENV,
                "uptime_seconds": round(time.time() - STARTED_AT, 1),
                "checks": {
                    "database": "ok" if db_ok else "unavailable",
                    "redis": "ok" if redis_ok else f"unavailable: {redis_error}",
                },
                "routes": connected,
            },
        )

    @app.get("/api/version", tags=["служебное"])
    async def version() -> dict[str, Any]:
        """Версия сборки и подсказка для WebApp, куда обращаться."""
        return {
            "name": "AI Маркетолог",
            "version": VERSION,
            "env": settings.ENV,
            "webapp_url": settings.WEBAPP_URL,
            "proxy_configured": bool(settings.TELEGRAM_PROXY_URL),
            "sbp_enabled": settings.sbp_enabled,
            "routes": connected,
        }

    # Статика собранного WebApp: index.html и ассеты
    if WEBAPP_DIST.exists():
        app.mount("/", StaticFiles(directory=str(WEBAPP_DIST), html=True), name="webapp")
        log.info("WebApp подключён", path=str(WEBAPP_DIST))
    else:
        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, str]:
            return {
                "service": "AI Маркетолог API",
                "docs": "/docs",
                "hint": "WebApp ещё не собран — выполните сборку фронтенда (появится на этапе 8)",
            }

    @app.exception_handler(Exception)
    async def unhandled(_request: Request, error: Exception) -> JSONResponse:
        """Единый ответ на непойманные исключения: без стеков в теле ответа."""
        log.error("Необработанная ошибка API", error=str(error), exc_info=True)
        return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера"})

    return app


app = create_app()
