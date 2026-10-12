"""Агрегация статистики кампаний: выборки из БД и сводки. Без AI."""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Campaign, DailyStat


def days_window(days: int, today: date | None = None) -> tuple[date, date]:
    """Окно из `days` дней, заканчивающееся сегодня (включительно)."""
    days = max(1, min(int(days), 365))
    end = today or date.today()
    return end - timedelta(days=days - 1), end


def summarize(rows: list[dict]) -> dict:
    impressions = sum(r["impressions"] for r in rows)
    clicks = sum(r["clicks"] for r in rows)
    cost_kop = sum(r["cost_kop"] for r in rows)
    conversions = sum(r["conversions"] for r in rows)
    return {
        "impressions": impressions,
        "clicks": clicks,
        "cost_kop": cost_kop,
        "conversions": conversions,
        "ctr": round(clicks / impressions * 100, 2) if impressions else 0.0,
        "cpc_kop": round(cost_kop / clicks) if clicks else 0,
        "cr": round(conversions / clicks * 100, 2) if clicks else 0.0,
        "cpa_kop": round(cost_kop / conversions) if conversions else None,
    }


def group_campaigns(rows: list[dict]) -> list[dict]:
    """Группирует строки по кампании, сортирует по расходу (больше — выше)."""
    buckets: dict[int, list[dict]] = defaultdict(list)
    meta: dict[int, dict] = {}
    for r in rows:
        buckets[r["campaign_id"]].append(r)
        meta.setdefault(r["campaign_id"], {"name": r["name"], "status": r["status"],
                                           "external_id": r["external_id"]})
    groups = []
    for cid, items in buckets.items():
        items.sort(key=lambda x: x["date"])
        groups.append({
            "campaign_id": cid,
            "external_id": meta[cid]["external_id"],
            "name": meta[cid]["name"],
            "status": meta[cid]["status"],
            "rows": items,
            "summary": summarize(items),
        })
    groups.sort(key=lambda g: g["summary"]["cost_kop"], reverse=True)
    return groups


def daily_series(rows: list[dict]) -> list[dict]:
    by_day: dict[date, dict] = {}
    for r in rows:
        d = by_day.setdefault(r["date"], {"date": r["date"].isoformat(), "impressions": 0,
                                          "clicks": 0, "cost_kop": 0, "conversions": 0})
        d["impressions"] += r["impressions"]
        d["clicks"] += r["clicks"]
        d["cost_kop"] += r["cost_kop"]
        d["conversions"] += r["conversions"]
    return [by_day[k] for k in sorted(by_day)]


async def load_window(session: AsyncSession, user_id: int, date_from: date, date_to: date) -> list[dict]:
    stmt = (
        select(DailyStat, Campaign)
        .join(Campaign, DailyStat.campaign_id == Campaign.id)
        .where(Campaign.user_id == user_id,
               DailyStat.date >= date_from,
               DailyStat.date <= date_to)
    )
    result = await session.execute(stmt)
    return [
        {
            "campaign_id": c.id,
            "external_id": c.external_id,
            "name": c.name,
            "status": c.status,
            "date": s.date,
            "impressions": s.impressions,
            "clicks": s.clicks,
            "cost_kop": s.cost_kop,
            "conversions": s.conversions,
        }
        for s, c in result.all()
    ]


def kop_to_rub(kop: int | float | None) -> float | None:
    return None if kop is None else round(kop / 100, 2)


def public_group(group: dict) -> dict:
    """Группа без сырых строк — для ответа API."""
    return {
        "campaign_id": group["campaign_id"],
        "external_id": group["external_id"],
        "name": group["name"],
        "status": group["status"],
        "summary": group["summary"],
    }


async def load_site_visits(session: AsyncSession, user_id: int, date_from: date, date_to: date) -> list[dict]:
    from app.models import SiteStat

    stmt = (select(SiteStat)
            .where(SiteStat.user_id == user_id, SiteStat.date >= date_from, SiteStat.date <= date_to)
            .order_by(SiteStat.date))
    result = await session.execute(stmt)
    return [{"date": s.date, "visits": s.visits, "users": s.users, "bounce_rate": s.bounce_rate}
            for s in result.scalars().all()]


def site_totals(visits: list[dict]) -> dict:
    return {"visits": sum(v["visits"] for v in visits), "users": sum(v["users"] for v in visits)}
