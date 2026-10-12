"""
Единая точка входа AI Маркетолог.

Один процесс Python (запускается из start.bat через `python -m app.main`):
  • FastAPI (uvicorn) на 127.0.0.1:PORT — REST /api/* и SPA Mini App из webapp/dist/
  • aiogram-бот как asyncio-задача — все запросы к Telegram через Worker-прокси
  • SQLite (data.db) — инициализируется в lifespan

Cloudflare Tunnel (cloudflared, запускает start.bat) пробрасывает HTTPS наружу
на этот же порт; URL берётся из tunnel.url и используется в кнопке Mini App.
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import init_db
from app.logger import setup_logging
from app.bot import notifications
from app.bot.proxy_session import build_proxy_session
from app.bot.handlers import router as bot_router
from app.api.server import api_router
from app.services.site_monitor import monitor_loop

setup_logging()
log = logging.getLogger("app")

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "webapp" / "dist"
DIST_INDEX = DIST / "index.html"


async def run_bot() -> None:
    """Telegram-бот. Все запросы идут через Cloudflare Worker (TELEGRAM_PROXY_URL)."""
    if not settings.BOT_TOKEN:
        log.warning("BOT_TOKEN пуст — бот не запущен. Заполни secrets.env")
        return

    try:
        session = build_proxy_session()
    except RuntimeError as e:
        # Без прокси бот в РФ не работает, поэтому не стартуем напрямую в api.telegram.org
        log.error(f"Бот не запущен: {e}")
        return

    bot = Bot(
        token=settings.BOT_TOKEN,
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(bot_router)
    notifications.set_bot(bot)

    try:
        me = await bot.get_me()
        log.info(f"Бот @{me.username} запущен через прокси {settings.TELEGRAM_PROXY_URL}")
        if settings.WEBAPP_URL:
            log.info(f"Mini App URL: {settings.WEBAPP_URL}")
        else:
            log.warning("Mini App URL не получен от Cloudflare Tunnel — кнопка Mini App недоступна")
        await dp.start_polling(bot, handle_signals=False)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("Ошибка бота")
    finally:
        notifications.set_bot(None)
        await bot.session.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    log.info("SQLite база готова")
    bot_task = asyncio.create_task(run_bot(), name="telegram-bot")
    monitor_task = asyncio.create_task(monitor_loop(), name="site-monitor")
    log.info("Все сервисы запущены")
    try:
        yield
    finally:
        for task in (bot_task, monitor_task):
            task.cancel()
        for task in (bot_task, monitor_task):
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="AI Маркетолог", version="4.0.0", lifespan=lifespan)
app.include_router(api_router, prefix="/api")

# Статика Mini App (пред-собранный webapp/dist)
if DIST_INDEX.exists():
    DIST_RESOLVED = DIST.resolve()
    assets_dir = DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        # Несуществующие API-пути не отдаём как index.html
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        # Защита от path traversal: файл должен лежать внутри DIST
        candidate = (DIST_RESOLVED / full_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(DIST_RESOLVED):
            return FileResponse(candidate)

        # SPA-маршрутизация: всё остальное → index.html
        return FileResponse(DIST_INDEX)
else:
    @app.get("/", include_in_schema=False)
    async def no_frontend():
        return {
            "status": "API работает",
            "webapp": "не собран (cd webapp && npm run build)",
        }


def main() -> None:
    # Слушаем только localhost: наружу трафик отдаёт Cloudflare Tunnel
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=settings.PORT,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
