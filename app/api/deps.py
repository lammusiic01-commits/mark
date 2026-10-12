"""Зависимости FastAPI: сессия БД, текущий пользователь (по initData), админ."""
from collections.abc import AsyncIterator

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import AuthError, validate_init_data
from app.config import settings
from app.database import SessionLocal
from app.models import User, utcnow

INIT_DATA_HEADER = "X-Telegram-Init-Data"


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def get_current_user(
    x_telegram_init_data: str | None = Header(default=None, alias=INIT_DATA_HEADER),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not x_telegram_init_data:
        if not settings.DEV_MODE:
            raise HTTPException(status_code=401, detail="Открой приложение из Telegram")
        tg_user = {"id": 1, "first_name": "Dev", "username": "dev"}
    else:
        try:
            tg_user = validate_init_data(x_telegram_init_data, settings.BOT_TOKEN)
        except AuthError as e:
            raise HTTPException(status_code=401, detail=str(e)) from e

    tg_id = int(tg_user["id"])
    result = await session.execute(select(User).where(User.tg_id == tg_id))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(tg_id=tg_id, created_at=utcnow())
        session.add(user)
    user.username = tg_user.get("username")
    user.first_name = (tg_user.get("first_name") or "")[:128]
    await session.commit()
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.tg_id not in settings.admin_ids:
        raise HTTPException(status_code=403, detail="Только для администраторов")
    return user
