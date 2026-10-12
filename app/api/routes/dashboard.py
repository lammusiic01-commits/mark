"""Главный экран: KPI, график, топ кампаний, риски, рекомендации, AI-совет."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.advisor import build_advice
from app.api.deps import get_current_user, get_session
from app.config import settings
from app.engine import campaign_manager as cm
from app.engine.analysis import build_context
from app.models import Transaction, User, utcnow
from app.security import SecretError, decrypt_text

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class AdviceIn(BaseModel):
    days: int = 14


@router.get("")
async def dashboard(days: int = 14, user: User = Depends(get_current_user),
                    session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(days)
    ctx = await build_context(session, user, date_from, date_to)
    return {
        "period": {"from": date_from.isoformat(), "to": date_to.isoformat(), "days": days},
        "summary": ctx["summary"],
        "series": ctx["series"],
        "top_campaigns": [cm.public_group(g) for g in ctx["groups"][:5]],
        "risk": {"risk_count": ctx["risk"]["risk_count"], "wasted_kop": ctx["risk"]["wasted_kop"],
                 "top": ctx["risk"]["items"][:3]},
        "recommendations": [r for r in ctx["recommendations"] if r["action"] != "keep"][:5],
        "funnel": ctx["funnel"],
        "connected": bool(user.yandex_token_enc),
        "last_sync_at": user.last_sync_at.isoformat() if user.last_sync_at else None,
        "balance_kop": user.balance_kop,
        "target_cpa_kop": user.target_cpa_kop,
    }


@router.post("/advice")
async def advice(body: AdviceIn, user: User = Depends(get_current_user),
                 session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(body.days)
    ctx = await build_context(session, user, date_from, date_to)

    own_key = None
    if user.openrouter_key_enc:
        try:
            own_key = decrypt_text(user.openrouter_key_enc)
        except SecretError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    # Решаем, будет ли AI-вызов и нужно ли списание:
    #   свой ключ пользователя → без списания;
    #   общий ключ сервиса → списываем AI_CHARGE_KOP, если хватает баланса.
    charge = 0
    use_ai = bool(user.ai_enabled)
    if use_ai and own_key:
        pass
    elif use_ai and settings.OPENROUTER_API_KEY:
        if user.balance_kop >= settings.AI_CHARGE_KOP:
            charge = settings.AI_CHARGE_KOP
        else:
            use_ai = False
    else:
        use_ai = False
    api_key = own_key or settings.OPENROUTER_API_KEY

    result = await build_advice(ctx["summary"], ctx["recommendations"], ctx["risk"],
                                ctx["funnel"], api_key if use_ai else None, use_ai)

    if result["ai_used"] and charge:
        user.balance_kop -= charge
        session.add(Transaction(user_id=user.id, kind="ai", amount_kop=-charge, status="paid",
                                comment="AI-совет", paid_at=utcnow()))
        await session.commit()

    if not result["ai_used"] and result.get("ai_error") is None and user.ai_enabled:
        if not own_key and not settings.OPENROUTER_API_KEY:
            result["ai_error"] = "AI не подключён: добавь свой ключ OpenRouter в настройках"
        elif not own_key and charge == 0:
            result["ai_error"] = "Недостаточно средств на балансе для AI-совета"

    result["charged_kop"] = charge if result["ai_used"] else 0
    result["balance_kop"] = user.balance_kop
    return result
