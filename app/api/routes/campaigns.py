"""Кампании: список, детализация, пауза и запуск через API Директа."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import bid_optimizer
from app.engine import campaign_manager as cm
from app.models import Campaign, User
from app.security import SecretError, decrypt_text
from app.services.yandex_direct import DirectClient, DirectError

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


async def _own_campaign(session: AsyncSession, user: User, campaign_id: int) -> Campaign:
    campaign = (await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id)
    )).scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=404, detail="Кампания не найдена")
    return campaign


@router.get("")
async def list_campaigns(days: int = 14, user: User = Depends(get_current_user),
                         session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(days)
    rows = await cm.load_window(session, user.id, date_from, date_to)
    groups = cm.group_campaigns(rows)
    recs = {r["campaign_id"]: r for r in bid_optimizer.recommend(groups, user.target_cpa_kop)}

    known = {g["campaign_id"] for g in groups}
    all_campaigns = (await session.execute(
        select(Campaign).where(Campaign.user_id == user.id).order_by(Campaign.name)
    )).scalars().all()
    items = []
    for g in groups:
        items.append({**cm.public_group(g), "recommendation": recs[g["campaign_id"]]})
    for c in all_campaigns:  # кампании без статистики за период
        if c.id not in known:
            items.append({"campaign_id": c.id, "external_id": c.external_id, "name": c.name,
                          "status": c.status, "summary": cm.summarize([]),
                          "recommendation": {"action": "keep", "bid_change_pct": 0,
                                             "reason": "Нет статистики за период"}})
    return {"period": {"from": date_from.isoformat(), "to": date_to.isoformat()}, "items": items}


@router.get("/{campaign_id}")
async def campaign_detail(campaign_id: int, days: int = 14, user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)) -> dict:
    campaign = await _own_campaign(session, user, campaign_id)
    date_from, date_to = cm.days_window(days)
    rows = [r for r in await cm.load_window(session, user.id, date_from, date_to)
            if r["campaign_id"] == campaign.id]
    groups = cm.group_campaigns(rows)
    group = groups[0] if groups else {
        "campaign_id": campaign.id, "external_id": campaign.external_id, "name": campaign.name,
        "status": campaign.status, "rows": [], "summary": cm.summarize([]),
    }
    rec = bid_optimizer.recommend_group(group, user.target_cpa_kop)
    return {
        "campaign": {"id": campaign.id, "external_id": campaign.external_id, "name": campaign.name,
                     "status": campaign.status, "daily_budget_kop": campaign.daily_budget_kop},
        "summary": group["summary"],
        "series": cm.daily_series(rows),
        "recommendation": rec,
        "target_cpa_kop": user.target_cpa_kop,
    }


async def _set_state(campaign_id: int, action: str, user: User, session: AsyncSession) -> dict:
    campaign = await _own_campaign(session, user, campaign_id)
    if not user.yandex_token_enc:
        raise HTTPException(status_code=400, detail="Подключи Яндекс Директ в настройках")
    try:
        token = decrypt_text(user.yandex_token_enc)
        await DirectClient(token).set_state(campaign.external_id, action)
    except (SecretError, DirectError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    campaign.status = "SUSPENDED" if action == "suspend" else "ON"
    await session.commit()
    return {"ok": True, "status": campaign.status}


@router.post("/{campaign_id}/suspend")
async def suspend(campaign_id: int, user: User = Depends(get_current_user),
                  session: AsyncSession = Depends(get_session)) -> dict:
    return await _set_state(campaign_id, "suspend", user, session)


@router.post("/{campaign_id}/resume")
async def resume(campaign_id: int, user: User = Depends(get_current_user),
                 session: AsyncSession = Depends(get_session)) -> dict:
    return await _set_state(campaign_id, "resume", user, session)
