"""Запуск API для проверки в браузере (только локально, в разработке).

Поднимает SQLite вместо PostgreSQL, создаёт таблицы и запускает сервер на
порту 8000. Так вёрстку и сценарии можно смотреть без Docker и без Telegram.

Запуск: python3 dev_server.py   (внутри каталога проекта)
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# База — файл SQLite рядом с проектом: ничего ставить и запускать не нужно
DB_PATH = ROOT / "dev.db"
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{DB_PATH}")
os.environ.setdefault("ENV", "development")
os.environ.setdefault("LOG_LEVEL", "INFO")


async def prepare() -> None:
    """Создаёт таблицы, если их ещё нет."""
    from core.database import create_all, ping

    await create_all()
    ok = await ping()
    print(f"База готова: {DB_PATH} (доступна: {ok})")


def main() -> None:
    asyncio.run(prepare())

    import uvicorn

    port = int(os.environ.get("API_PORT", "8000"))
    reload = os.environ.get("DEV_RELOAD", "1") not in {"0", "false", "no"}
    print(f"API: http://0.0.0.0:{port}  ·  документация: http://0.0.0.0:{port}/docs")
    uvicorn.run(
        "api.server:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        reload=reload,           # правки в коде применяются сразу
        reload_dirs=[str(ROOT)] if reload else None,
    )


if __name__ == "__main__":
    main()
