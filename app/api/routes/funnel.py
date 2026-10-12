"""Воронка: показы → клики → визиты (Метрика) → конверсии, с графиком по дням."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import campaign_manager as cm
from app.engine import funnel_analyzer
from app.models import User

router = APIRouter(prefix="/funnel", tags=["funnel"])


@router.get("")
async def funnel(days: int = 14, user: User = Depends(get_current_user),
                 session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(days)
    rows = await cm.load_window(session, user.id, date_from, date_to)
    visits = await cm.load_site_visits(session, user.id, date_from, date_to)
    summary = cm.summarize(rows)
    totals = cm.site_totals(visits)
    result = funnel_analyzer.build(summary["impressions"], summary["clicks"],
                                   totals["visits"], summary["conversions"])
    by_day = {d["date"]: d for d in cm.daily_series(rows)}
    daily = []
    for v in visits:
        key = v["date"].isoformat()
        day = by_day.get(key, {"clicks": 0})
        daily.append({"date": key, "clicks": day["clicks"], "visits": v["visits"],
                      "bounce_rate": v["bounce_rate"]})
    return {**result, "period": {"from": date_from.isoformat(), "to": date_to.isoformat()},
            "daily": daily, "has_metrika": bool(user.metrika_counter_id)}
