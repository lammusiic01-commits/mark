"""Интеграции: проверка подключения и синхронизация данных из Директа и Метрики."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session

from app.engine import campaign_manager as cm
from app.models import Campaign, DailyStat, SiteStat, User, utcnow
from app.security import SecretError, decrypt_text
from app.services.yandex_direct import DirectClient, DirectError
from app.services.yandex_metrika import MetrikaError, daily_site_stats

router = APIRouter(prefix="/services", tags=["services"])


class SyncIn(BaseModel):
    days: int = Field(default=14, ge=1, le=90)


def _token(user: User) -> str:
    if not user.yandex_token_enc:
        raise HTTPException(status_code=400, detail="Добавь токен Яндекс Директа в настройках")
    try:
        return decrypt_text(user.yandex_token_enc)
    except SecretError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/status")
async def status(user: User = Depends(get_current_user)) -> dict:
    return {
        "yandex_direct": {"connected": bool(user.yandex_token_enc)},
        "metrika": {"connected": bool(user.metrika_counter_id and user.yandex_token_enc),
                    "counter_id": user.metrika_counter_id or "",
                    "goal_id": user.metrika_goal_id or ""},
        "last_sync_at": user.last_sync_at.isoformat() if user.last_sync_at else None,
    }


@router.post("/yandex/test")
async def yandex_test(user: User = Depends(get_current_user)) -> dict:
    client = DirectClient(_token(user))
    try:
        campaigns = await client.campaigns()
    except DirectError as e:
        raise HTTPException(status_code=400, detail=f"Директ: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Директ недоступен: {e}") from e
    return {"ok": True, "campaigns": len(campaigns)}


@router.post("/metrika/test")
async def metrika_test(user: User = Depends(get_current_user)) -> dict:
    if not user.metrika_counter_id:
        raise HTTPException(status_code=400, detail="Укажи номер счётчика Метрики")
    token = _token(user)
    today = cm.days_window(2)[1]
    try:
        rows = await daily_site_stats(token, user.metrika_counter_id, today - timedelta(days=2), today)
    except (MetrikaError, DirectError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Метрика недоступна: {e}") from e
    return {"ok": True, "days_received": len(rows)}


@router.post("/sync")
async def sync(body: SyncIn, user: User = Depends(get_current_user),
               session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(body.days)
    token = _token(user)
    client = DirectClient(token)
    try:
        directory = await client.campaigns()
        report = await client.campaign_report(date_from, date_to, goal_id=user.metrika_goal_id or None)
    except DirectError as e:
        raise HTTPException(status_code=400, detail=f"Директ: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Директ недоступен: {e}") from e

    campaigns_by_ext: dict[int, Campaign] = {}
    existing = (await session.execute(select(Campaign).where(Campaign.user_id == user.id))).scalars().all()
    for c in existing:
        campaigns_by_ext[c.external_id] = c
    for item in directory:
        camp = campaigns_by_ext.get(item["id"])
        if camp is None:
            camp = Campaign(user_id=user.id, external_id=item["id"])
            session.add(camp)
            campaigns_by_ext[item["id"]] = camp
        camp.name = item["name"][:256]
        camp.status = item["status"]
        camp.daily_budget_kop = item["daily_budget_kop"]
    await session.flush()

    stats_index = {(s.campaign_id, s.date): s for s in (await session.execute(
        select(DailyStat).join(Campaign, DailyStat.campaign_id == Campaign.id)
        .where(Campaign.user_id == user.id, DailyStat.date >= date_from, DailyStat.date <= date_to)
    )).scalars().all()}

    stored = 0
    for row in report:
        camp = campaigns_by_ext.get(row["campaign_id"])
        if camp is None:
            camp = Campaign(user_id=user.id, external_id=row["campaign_id"], name=row["name"][:256])
            session.add(camp)
            await session.flush()
            campaigns_by_ext[row["campaign_id"]] = camp
        stat = stats_index.get((camp.id, row["date"]))
        if stat is None:
            stat = DailyStat(campaign_id=camp.id, date=row["date"])
            session.add(stat)
            stats_index[(camp.id, row["date"])] = stat
        stat.impressions = row["impressions"]
        stat.clicks = row["clicks"]
        stat.cost_kop = row["cost_kop"]
        stat.conversions = row["conversions"]
        stored += 1

    metrika_days = 0
    if user.metrika_counter_id:
        try:
            visits = await daily_site_stats(token, user.metrika_counter_id, date_from, date_to)
        except Exception as e:
            await session.commit()
            raise HTTPException(status_code=400, detail=f"Директ синхронизирован, Метрика: {e}") from e
        site_index = {s.date: s for s in (await session.execute(
            select(SiteStat).where(SiteStat.user_id == user.id, SiteStat.date >= date_from,
                                   SiteStat.date <= date_to))).scalars().all()}
        for v in visits:
            s = site_index.get(v["date"])
            if s is None:
                s = SiteStat(user_id=user.id, date=v["date"])
                session.add(s)
            s.visits, s.users, s.bounce_rate = v["visits"], v["users"], v["bounce_rate"]
            metrika_days += 1

    user.last_sync_at = utcnow()
    await session.commit()
    return {"ok": True, "campaigns": len(directory), "stat_rows": stored,
            "metrika_days": metrika_days, "conversions_enabled": bool(user.metrika_goal_id),
            "period": {"from": date_from.isoformat(), "to": date_to.isoformat()}}
