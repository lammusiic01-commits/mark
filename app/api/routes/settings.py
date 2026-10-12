"""Настройки пользователя и секреты (токены шифруются Fernet)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.config import settings as app_settings
from app.models import User
from app.payments import sbp
from app.security import SecretError, encrypt_text, mask_secret, decrypt_text
from app.services.url_guard import UnsafeUrlError, normalize_url

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsIn(BaseModel):
    site_url: str | None = Field(default=None, max_length=512)
    metrika_counter_id: str | None = Field(default=None, max_length=32)
    metrika_goal_id: str | None = Field(default=None, max_length=32)
    target_cpa_rub: float | None = Field(default=None, ge=0, le=1_000_000)
    daily_budget_rub: float | None = Field(default=None, ge=0, le=100_000_000)
    ai_enabled: bool | None = None
    onboarded: bool | None = None
    yandex_token: str | None = Field(default=None, max_length=512)
    openrouter_key: str | None = Field(default=None, max_length=256)


def _serialize(user: User) -> dict:
    own_key = None
    if user.openrouter_key_enc:
        try:
            own_key = decrypt_text(user.openrouter_key_enc)
        except SecretError:
            own_key = None
    yandex = None
    if user.yandex_token_enc:
        try:
            yandex = decrypt_text(user.yandex_token_enc)
        except SecretError:
            yandex = None
    return {
        "onboarded": user.onboarded,
        "ai_enabled": user.ai_enabled,
        "site_url": user.site_url or "",
        "metrika_counter_id": user.metrika_counter_id or "",
        "metrika_goal_id": user.metrika_goal_id or "",
        "target_cpa_rub": round(user.target_cpa_kop / 100, 2),
        "daily_budget_rub": round(user.daily_budget_kop / 100, 2),
        "has_yandex_token": bool(user.yandex_token_enc),
        "yandex_token_hint": mask_secret(yandex),
        "has_openrouter_key": bool(user.openrouter_key_enc),
        "openrouter_key_hint": mask_secret(own_key),
        "global_ai_available": bool(app_settings.OPENROUTER_API_KEY),
        "is_admin": user.tg_id in app_settings.admin_ids,
        "sbp_configured": sbp.is_configured(),
    }


@router.get("")
async def get_settings(user: User = Depends(get_current_user)) -> dict:
    return _serialize(user)


@router.put("")
async def update_settings(body: SettingsIn, user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)) -> dict:
    sent = body.model_fields_set
    try:
        if "site_url" in sent:
            user.site_url = normalize_url(body.site_url) if body.site_url else None
    except UnsafeUrlError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if "metrika_counter_id" in sent:
        user.metrika_counter_id = (body.metrika_counter_id or "").strip() or None
    if "metrika_goal_id" in sent:
        user.metrika_goal_id = (body.metrika_goal_id or "").strip() or None
    if "target_cpa_rub" in sent and body.target_cpa_rub is not None:
        user.target_cpa_kop = round(body.target_cpa_rub * 100)
    if "daily_budget_rub" in sent and body.daily_budget_rub is not None:
        user.daily_budget_kop = round(body.daily_budget_rub * 100)
    if "ai_enabled" in sent and body.ai_enabled is not None:
        user.ai_enabled = body.ai_enabled
    if "onboarded" in sent and body.onboarded is not None:
        user.onboarded = body.onboarded
    try:
        if "yandex_token" in sent:
            token = (body.yandex_token or "").strip()
            user.yandex_token_enc = encrypt_text(token) if token else None
        if "openrouter_key" in sent:
            key = (body.openrouter_key or "").strip()
            user.openrouter_key_enc = encrypt_text(key) if key else None
    except SecretError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    await session.commit()
    return _serialize(user)
