"""Мониторинг конкурентов: добавление, проверка статуса и изменений страницы."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine.competitor_tracker import check_competitor, serialize
from app.models import Competitor, User
from app.services.url_guard import UnsafeUrlError, assert_public_url

router = APIRouter(prefix="/competitors", tags=["competitors"])


class CompetitorIn(BaseModel):
    name: str = Field(default="", max_length=200)
    url: str = Field(min_length=3, max_length=512)


async def _own(session: AsyncSession, user: User, cid: int) -> Competitor:
    c = (await session.execute(select(Competitor).where(
        Competitor.id == cid, Competitor.user_id == user.id))).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Конкурент не найден")
    return c


@router.get("")
async def list_competitors(user: User = Depends(get_current_user),
                           session: AsyncSession = Depends(get_session)) -> list[dict]:
    items = (await session.execute(select(Competitor).where(Competitor.user_id == user.id)
                                   .order_by(Competitor.id))).scalars().all()
    return [serialize(c) for c in items]


@router.post("")
async def add_competitor(body: CompetitorIn, user: User = Depends(get_current_user),
                         session: AsyncSession = Depends(get_session)) -> dict:
    try:
        url = await assert_public_url(body.url)
    except UnsafeUrlError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    comp = Competitor(user_id=user.id, name=body.name.strip() or url, url=url)
    session.add(comp)
    await session.flush()
    check = await check_competitor(comp)
    await session.commit()
    return {**serialize(comp), "check": check}


@router.post("/{cid}/check")
async def recheck(cid: int, user: User = Depends(get_current_user),
                  session: AsyncSession = Depends(get_session)) -> dict:
    comp = await _own(session, user, cid)
    check = await check_competitor(comp)
    await session.commit()
    return {**serialize(comp), "check": check}


@router.delete("/{cid}")
async def delete_competitor(cid: int, user: User = Depends(get_current_user),
                            session: AsyncSession = Depends(get_session)) -> dict:
    comp = await _own(session, user, cid)
    await session.delete(comp)
    await session.commit()
    return {"ok": True}
