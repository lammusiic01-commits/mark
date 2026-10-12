"""Кампании: список, синхронизация с Директом, управление ставками и бюджетом.

Здесь живёт обмен данными с Яндекс.Директом. Решения (что менять и почему)
принимает движок: роут только показывает их и, по нажатию кнопки, применяет.

Синхронизация кладёт статистику в campaigns.stats_cache, чтобы дашборд
открывался мгновенно и не зависел от скорости Директа.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from api.deps import CurrentUser, DbSession, DirectClientDep, OptionalDirectClientDep
from core.logger import get_logger
from core.models import Campaign, User
from engine import bid_optimizer, budget_allocator, campaign_manager
from engine.campaign_manager import STATUS_ACTIVE, STATUS_PAUSED
from services.yandex_direct import DirectError

log = get_logger(__name__)

router = APIRouter(prefix="/campaigns", tags=["кампании"])

# За какой период берём статистику по умолчанию
DEFAULT_PERIOD_DAYS = 30


def _report_period(days: int = DEFAULT_PERIOD_DAYS) -> tuple[str, str]:
    """Даты отчёта: от сегодня минус период до сегодня."""
    today = date.today()
    return (today - timedelta(days=days - 1)).isoformat(), today.isoformat()


def _empty_stats(period_days: int = DEFAULT_PERIOD_DAYS) -> dict[str, Any]:
    """Пустая структура статистики: одинаковая для всех кампаний."""
    return {
        "period_days": period_days,
        "clicks": 0,
        "impressions": 0,
        "cost_rub": 0.0,
        "conversions": 0.0,
        "cpa_rub": 0.0,
        "ctr": 0.0,
        "cpc_rub": 0.0,
        "daily": [],
    }


async def refresh_campaign_stats(
    session: DbSession,
    user: User,
    client: Any,
    *,
    days: int = DEFAULT_PERIOD_DAYS,
) -> dict[str, Any]:
    """Забирает кампании и статистику из Директа и обновляет базу.

    Возвращает короткий отчёт о том, что обновилось, — его показывает
    приложение после кнопки «Обновить данные».
    """
    date_from, date_to = _report_period(days)

    campaigns = await client.get_campaigns()
    synced = await campaign_manager.sync_campaigns(session, user, campaigns)

    try:
        stats_rows = await client.campaign_statistics(date_from=date_from, date_to=date_to)
    except DirectError as error:
        log.warning("Статистика кампаний не получена", reason=str(error)[:160])
        stats_rows = []

    by_id = {str(row.get("campaign_id") or ""): row for row in stats_rows}
    updated = 0
    for campaign in synced:
        row = by_id.get(str(campaign.external_id))
        if row is None:
            continue
        cache = {
            **_empty_stats(days),
            "clicks": int(row.get("clicks") or 0),
            "impressions": int(row.get("impressions") or 0),
            "cost_rub": round(float(row.get("cost_rub") or 0.0), 2),
            "conversions": round(float(row.get("conversions") or 0.0), 2),
            "ctr": round(float(row.get("ctr") or 0.0), 2),
            "cpc_rub": round(float(row.get("cpc_rub") or 0.0), 2),
            "cpa_rub": round(float(row.get("cpa_rub") or 0.0), 2),
            "impression_share": row.get("impression_share"),
            "updated_at": date_to,
        }
        campaign.stats_cache = cache
        campaign.stats_updated_at = datetime.now(timezone.utc)
        updated += 1

    await session.commit()

    total_cost = sum(float(row.stats_cache.get("cost_rub") or 0.0) for row in synced)
    total_conversions = sum(float(row.stats_cache.get("conversions") or 0.0) for row in synced)
    log.info("Кампании обновлены", user_id=user.id, campaigns=len(synced), with_stats=updated, cost=total_cost)

    return {
        "campaigns": len(synced),
        "with_stats": updated,
        "period_from": date_from,
        "period_to": date_to,
        "total_cost_rub": round(total_cost, 2),
        "total_conversions": round(total_conversions, 2),
        "average_cpa_rub": round(total_cost / total_conversions, 2) if total_conversions else 0.0,
    }


def _campaign_view(campaign: Campaign) -> dict[str, Any]:
    """Кампания для списка в приложении."""
    cache = dict(campaign.stats_cache or {})
    return {
        "id": campaign.id,
        "external_id": campaign.external_id,
        "name": campaign.name,
        "status": campaign.status,
        "is_active": campaign.status == STATUS_ACTIVE,
        "daily_budget": round(float(campaign.daily_budget or 0.0), 2),
        "target_cpa": round(float(campaign.target_cpa or 0.0), 2),
        "stats": cache,
        "stats_updated_at": campaign.stats_updated_at.isoformat() if campaign.stats_updated_at else None,
    }


async def _user_campaigns(session: DbSession, user: CurrentUser) -> list[Campaign]:
    """Все кампании пользователя, свежие — первыми."""
    result = await session.execute(
        select(Campaign).where(Campaign.user_id == user.id).order_by(Campaign.updated_at.desc()),
    )
    return list(result.scalars().all())


@router.get("", summary="Список кампаний")
async def list_campaigns(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Кампании с сохранённой статистикой и сводкой для экрана."""
    campaigns = await _user_campaigns(session, user)
    views = [_campaign_view(campaign) for campaign in campaigns]

    total_cost = sum(view["stats"].get("cost_rub", 0.0) for view in views)
    total_conversions = sum(view["stats"].get("conversions", 0.0) for view in views)
    total_clicks = sum(view["stats"].get("clicks", 0) for view in views)

    return {
        "campaigns": views,
        "count": len(views),
        "active_count": sum(1 for view in views if view["is_active"]),
        "summary": {
            "total_cost_rub": round(total_cost, 2),
            "total_conversions": round(total_conversions, 2),
            "total_clicks": total_clicks,
            "average_cpa_rub": round(total_cost / total_conversions, 2) if total_conversions else 0.0,
            "daily_budget_rub": round(sum(view["daily_budget"] for view in views), 2),
        },
        "needs_sync": not views or all(not view["stats_updated_at"] for view in views),
    }


@router.post("/sync", summary="Обновить данные из Директа")
async def sync_campaigns(session: DbSession, user: CurrentUser, client: DirectClientDep) -> dict[str, Any]:
    """Тянет кампании и статистику из Директа — кнопка «Обновить данные»."""
    try:
        result = await refresh_campaign_stats(session, user, client)
    except DirectError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error

    campaigns = await _user_campaigns(session, user)
    return {
        "ok": True,
        "message": f"Обновлено кампаний: {result['campaigns']}, со статистикой: {result['with_stats']}",
        "result": result,
        "campaigns": [_campaign_view(campaign) for campaign in campaigns],
    }


@router.get("/{campaign_id}", summary="Кампания, фразы и рекомендации")
async def campaign_details(
    campaign_id: int,
    session: DbSession,
    user: CurrentUser,
    client: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Карточка кампании: статистика, фразы и что предлагает движок."""
    result = await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id),
    )
    campaign = result.scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Кампания не найдена")

    view: dict[str, Any] = {"campaign": _campaign_view(campaign), "keywords": [], "bid_plan": None, "note": None}

    if client is None:
        view["note"] = "Директ не подключён — детали и рекомендации недоступны"
        return view

    date_from, date_to = _report_period()
    try:
        keywords = await client.keyword_statistics(date_from=date_from, date_to=date_to, target_cpa_rub=campaign.target_cpa)
    except DirectError as error:
        view["note"] = f"Статистика по фразам недоступна: {error}"
        return view

    own = [row for row in keywords if str(row.get("campaign_id") or "") == str(campaign.external_id)]
    view["keywords"] = own[:100]

    target = float(campaign.target_cpa or 0.0)
    if own and target > 0:
        plan = bid_optimizer.optimize_bids(own, target_cpa_rub=target, monthly_budget_rub=float(campaign.daily_budget or 0) * 30)
        view["bid_plan"] = plan.to_dict()
    elif own:
        view["note"] = "Укажите целевую цену заявки — движок предложит ставки"

    return view


class CampaignUpdate(BaseModel):
    """Что можно поменять в кампании из приложения."""

    status: str | None = Field(default=None, description="active | paused")
    daily_budget_rub: float | None = Field(default=None, gt=0, description="Новый дневной бюджет")
    target_cpa_rub: float | None = Field(default=None, ge=0, description="Целевая цена заявки")


@router.patch("/{campaign_id}", summary="Изменить статус, бюджет или цель")
async def update_campaign(
    campaign_id: int,
    payload: CampaignUpdate,
    session: DbSession,
    user: CurrentUser,
    client: DirectClientDep,
) -> dict[str, Any]:
    """Применяет изменение в Директе и сохраняет его у себя.

    Сначала Директ, потом база: если Директ не принял команду, интерфейс
    не должен показывать, что всё получилось.
    """
    result = await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id),
    )
    campaign = result.scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Кампания не найдена")

    applied: list[str] = []
    try:
        if payload.status is not None:
            wanted = STATUS_ACTIVE if payload.status == "active" else STATUS_PAUSED
            await client.update_campaign_status(campaign.external_id, wanted)
            campaign.status = wanted
            applied.append("статус")

        if payload.daily_budget_rub is not None:
            await client.update_campaign_budget(campaign.external_id, payload.daily_budget_rub)
            campaign.daily_budget = float(payload.daily_budget_rub)
            applied.append("бюджет")

        if payload.target_cpa_rub is not None:
            campaign.target_cpa = float(payload.target_cpa_rub)
            applied.append("цель по заявке")
    except DirectError as error:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Директ не принял изменение: {error}") from error

    if not applied:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нечего менять: заполните status, бюджет или цель")

    await session.commit()
    log.info("Кампания изменена", user_id=user.id, campaign=campaign.external_id, applied=applied)
    return {
        "ok": True,
        "message": "Обновлено: " + ", ".join(applied),
        "campaign": _campaign_view(campaign),
    }


@router.post("/{campaign_id}/toggle", summary="Включить или остановить кампанию")
async def toggle_campaign(
    campaign_id: int,
    session: DbSession,
    user: CurrentUser,
    client: DirectClientDep,
) -> dict[str, Any]:
    """Быстрое переключение статуса — то самое, что нужно каждый день."""
    result = await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id),
    )
    campaign = result.scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Кампания не найдена")

    wanted = STATUS_PAUSED if campaign.status == STATUS_ACTIVE else STATUS_ACTIVE
    try:
        await client.update_campaign_status(campaign.external_id, wanted)
    except DirectError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Директ не принял команду: {error}") from error

    campaign.status = wanted
    await session.commit()
    log.info("Статус кампании переключён", user_id=user.id, campaign=campaign.external_id, status=wanted)
    return {
        "ok": True,
        "message": "Кампания включена" if wanted == STATUS_ACTIVE else "Кампания остановлена",
        "campaign": _campaign_view(campaign),
    }


@router.post("/{campaign_id}/plan", summary="Что движок предлагает по кампании")
async def campaign_plan(
    campaign_id: int,
    session: DbSession,
    user: CurrentUser,
    client: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Показывает рекомендации по бюджету и ставкам, ничего не меняя в Директе."""
    result = await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id),
    )
    campaign = result.scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Кампания не найдена")

    cache = dict(campaign.stats_cache or {})
    target = float(campaign.target_cpa or 0.0)

    channel = budget_allocator.ChannelStat(
        channel_id=str(campaign.external_id),
        name=campaign.name,
        current_daily_budget_rub=float(campaign.daily_budget or 0.0),
        clicks=int(cache.get("clicks") or 0),
        impressions=int(cache.get("impressions") or 0),
        cost_rub=float(cache.get("cost_rub") or 0.0),
        conversions=float(cache.get("conversions") or 0.0),
    )
    allocation = budget_allocator.allocate_budget([channel], target_cpa_rub=target or 1000.0, period_days=int(cache.get("period_days") or 30))

    response: dict[str, Any] = {
        "allocation": allocation.to_dict(),
        "bid_plan": None,
        "note": None,
    }

    if client is not None and target > 0:
        date_from, date_to = _report_period()
        try:
            keywords = await client.keyword_statistics(date_from=date_from, date_to=date_to, target_cpa_rub=target)
        except DirectError as error:
            response["note"] = f"Ставки недоступны: {error}"
            keywords = []
        own = [row for row in keywords if str(row.get("campaign_id") or "") == str(campaign.external_id)]
        if own:
            response["bid_plan"] = bid_optimizer.optimize_bids(own, target_cpa_rub=target).to_dict()
    elif target <= 0:
        response["note"] = "Укажите целевую цену заявки в карточке кампании — тогда появятся рекомендации по ставкам"

    return response


__all__ = ["refresh_campaign_stats", "router"]
