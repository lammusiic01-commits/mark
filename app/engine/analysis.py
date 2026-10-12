"""
Единый сбор контекста аналитики для дашборда, отчётов и AI-советника.
Все цифры считаются здесь скриптом; AI их только комментирует.
"""
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.engine import bid_optimizer, bot_detector, campaign_manager as cm, funnel_analyzer
from app.models import User


async def build_context(session: AsyncSession, user: User, date_from: date, date_to: date) -> dict:
    rows = await cm.load_window(session, user.id, date_from, date_to)
    groups = cm.group_campaigns(rows)
    summary = cm.summarize(rows)
    visits = await cm.load_site_visits(session, user.id, date_from, date_to)
    totals = cm.site_totals(visits)
    funnel = funnel_analyzer.build(summary["impressions"], summary["clicks"],
                                   totals["visits"], summary["conversions"])
    return {
        "rows": rows,
        "groups": groups,
        "summary": summary,
        "series": cm.daily_series(rows),
        "visits": visits,
        "funnel": funnel,
        "risk": bot_detector.analyze(groups),
        "recommendations": bid_optimizer.recommend(groups, user.target_cpa_kop),
    }
