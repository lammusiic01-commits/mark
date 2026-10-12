"""Мониторинг доступности сайтов пользователей. Уведомляет в Telegram при падении и восстановлении."""
import asyncio
import logging
import time

import aiohttp
from sqlalchemy import select

from app.bot import notifications
from app.config import settings
from app.database import SessionLocal
from app.models import User
from app.services.url_guard import UnsafeUrlError, assert_public_url

log = logging.getLogger("app.monitor")
_last_state: dict[int, bool] = {}


async def check_site(url: str, timeout: int = 15) -> dict:
    try:
        safe = await assert_public_url(url)
    except UnsafeUrlError as e:
        return {"ok": False, "status": 0, "ms": 0, "error": str(e)}
    start = time.monotonic()
    try:
        async with aiohttp.ClientSession(headers={"User-Agent": "AIMarketerMonitor/4.0"}) as session:
            async with session.get(safe, timeout=aiohttp.ClientTimeout(total=timeout),
                                   allow_redirects=True) as resp:
                ms = int((time.monotonic() - start) * 1000)
                return {"ok": resp.status < 400, "status": resp.status, "ms": ms, "error": None}
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        return {"ok": False, "status": 0, "ms": int((time.monotonic() - start) * 1000),
                "error": type(e).__name__}


async def _check_all_once() -> None:
    async with SessionLocal() as session:
        users = (await session.execute(select(User).where(User.site_url.is_not(None)))).scalars().all()
    for user in users:
        result = await check_site(user.site_url)
        previous = _last_state.get(user.tg_id)
        _last_state[user.tg_id] = result["ok"]
        if previous is None or previous == result["ok"]:
            continue
        if result["ok"]:
            text = f"Сайт снова доступен: {user.site_url} (HTTP {result['status']})"
        else:
            text = f"Сайт недоступен: {user.site_url} ({result['error'] or 'HTTP ' + str(result['status'])})"
        await notifications.notify(user.tg_id, text)


async def monitor_loop() -> None:
    """Фоновая задача: проверка сайтов каждые MONITOR_INTERVAL_SEC секунд."""
    while True:
        try:
            await _check_all_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Ошибка мониторинга сайтов")
        await asyncio.sleep(settings.MONITOR_INTERVAL_SEC)
