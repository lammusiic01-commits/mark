"""Асинхронная работа с PostgreSQL (SQLAlchemy 2.0 + asyncpg).

Отсюда берут сессии все, кому нужна база: API, бот, движок, планировщик.
Никаких синхронных вызовов — весь проект работает на async/await.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from core.config import settings
from core.logger import get_logger
from core.models import Base

log = get_logger(__name__)

# Пул соединений: размеры подобраны под один небольшой сервер агентства
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_recycle=1800,
    future=True,
)

# Сессии «на запрос»: expire_on_commit=False — можно читать поля после commit
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI-зависимость: одна сессия на HTTP-запрос с гарантией закрытия."""
    async with SessionLocal() as session:
        try:
            yield session
        except SQLAlchemyError:
            await session.rollback()
            raise


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Сессия для фоновых задач и бота: коммит при успехе, откат при ошибке."""
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def ping() -> bool:
    """Проверка живости базы — используется /health и start-скриптами."""
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return True
    except Exception as error:  # noqa: BLE001 — нужен любой сбой сети/базы
        log.warning("База данных недоступна", error=str(error))
        return False


async def wait_for_database(timeout_seconds: int = 60, interval_seconds: float = 2.0) -> bool:
    """Ждёт готовности PostgreSQL: контейнеры стартуют не одновременно."""
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    attempt = 0
    while asyncio.get_event_loop().time() < deadline:
        attempt += 1
        if await ping():
            log.info("База данных готова", attempt=attempt)
            return True
        await asyncio.sleep(interval_seconds)
    log.error("База данных не ответила за отведённое время", timeout=timeout_seconds)
    return False


async def create_all() -> None:
    """Создаёт таблицы напрямую (только для разработки и тестов).

    В боевом режиме схему меняет только alembic upgrade head.
    """
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    log.info("Схема БД создана (create_all)")


async def drop_all() -> None:
    """Полная очистка схемы — используется в тестах."""
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)


async def dispose() -> None:
    """Закрывает пул соединений при остановке приложения."""
    await engine.dispose()
    log.info("Соединения с базой закрыты")


def make_isolated_engine(database_url: str):
    """Отдельный движок без пула — для тестов и скриптов миграций.

    NullPool не держит соединения между вызовами и корректно закрывает
    их при завершении процесса (важно для одноразовых задач).
    """
    return create_async_engine(database_url, echo=False, poolclass=NullPool, future=True)


__all__ = [
    "Base",
    "SessionLocal",
    "create_all",
    "dispose",
    "drop_all",
    "engine",
    "get_session",
    "make_isolated_engine",
    "ping",
    "session_scope",
    "wait_for_database",
]
