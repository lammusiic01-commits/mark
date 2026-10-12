"""SEO-аудит страницы сайта пользователя (с защитой от SSRF)."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import seo_analyzer
from app.models import SeoCheck, User
from app.services.url_guard import UnsafeUrlError, assert_public_url

router = APIRouter(prefix="/seo", tags=["seo"])


class AuditIn(BaseModel):
    url: str = Field(min_length=3, max_length=512)


@router.post("/audit")
async def audit(body: AuditIn, user: User = Depends(get_current_user),
                session: AsyncSession = Depends(get_session)) -> dict:
    try:
        url = await assert_public_url(body.url)
    except UnsafeUrlError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        status, html, elapsed = await seo_analyzer.fetch_html(url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Не удалось загрузить страницу: {e}") from e
    if status >= 400:
        raise HTTPException(status_code=400, detail=f"Страница вернула HTTP {status}")

    result = seo_analyzer.audit(html, url)
    result["facts"]["load_ms"] = elapsed
    check = SeoCheck(user_id=user.id, url=url, score=result["score"],
                     issues_json=json.dumps(result["issues"], ensure_ascii=False))
    session.add(check)
    await session.commit()
    return {**result, "id": check.id}


@router.get("/history")
async def history(user: User = Depends(get_current_user),
                  session: AsyncSession = Depends(get_session)) -> list[dict]:
    items = (await session.execute(
        select(SeoCheck).where(SeoCheck.user_id == user.id).order_by(SeoCheck.id.desc()).limit(20)
    )).scalars().all()
    return [{"id": c.id, "url": c.url, "score": c.score, "created_at": c.created_at.isoformat()}
            for c in items]


@router.get("/{check_id}")
async def get_check(check_id: int, user: User = Depends(get_current_user),
                    session: AsyncSession = Depends(get_session)) -> dict:
    c = (await session.execute(select(SeoCheck).where(
        SeoCheck.id == check_id, SeoCheck.user_id == user.id))).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Проверка не найдена")
    return {"id": c.id, "url": c.url, "score": c.score, "issues": json.loads(c.issues_json),
            "created_at": c.created_at.isoformat()}
