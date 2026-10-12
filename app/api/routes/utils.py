"""Публичные эндпоинты без авторизации (проверка работоспособности)."""
from fastapi import APIRouter

from app.config import settings

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "webapp_url": settings.WEBAPP_URL or None}
