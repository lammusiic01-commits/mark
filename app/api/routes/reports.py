"""Отчёты: генерация за период с сравнением с предыдущим периодом."""
import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import campaign_manager as cm
from app.engine.analysis import build_context
from app.engine import report_generator
from app.models import Report, User

router = APIRouter(prefix="/reports", tags=["reports"])


class ReportIn(BaseModel):
    days: int = Field(default=14, ge=1, le=365)


@router.get("")
async def list_reports(user: User = Depends(get_current_user),
                       session: AsyncSession = Depends(get_session)) -> list[dict]:
    items = (await session.execute(select(Report).where(Report.user_id == user.id)
                                   .order_by(Report.id.desc()).limit(50))).scalars().all()
    return [{"id": r.id, "title": r.title, "days": r.days, "created_at": r.created_at.isoformat()}
            for r in items]


@router.post("")
async def create_report(body: ReportIn, user: User = Depends(get_current_user),
                        session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(body.days)
    ctx = await build_context(session, user, date_from, date_to)
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=body.days - 1)
    prev_rows = await cm.load_window(session, user.id, prev_from, prev_to)
    prev_summary = cm.summarize(prev_rows)

    body_data = report_generator.build(body.days, ctx["summary"], prev_summary,
                                       ctx["risk"], ctx["recommendations"], ctx["funnel"])
    title = f"Отчёт за {date_from.strftime('%d.%m')}–{date_to.strftime('%d.%m.%Y')}"
    report = Report(user_id=user.id, title=title, days=body.days,
                    body_json=json.dumps(body_data, ensure_ascii=False))
    session.add(report)
    await session.commit()
    return {"id": report.id, "title": title, **body_data}


@router.get("/{report_id}")
async def get_report(report_id: int, user: User = Depends(get_current_user),
                     session: AsyncSession = Depends(get_session)) -> dict:
    r = (await session.execute(select(Report).where(
        Report.id == report_id, Report.user_id == user.id))).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="Отчёт не найден")
    return {"id": r.id, "title": r.title, **json.loads(r.body_json)}
