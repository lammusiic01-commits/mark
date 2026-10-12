"""A/B-тесты (гипотезы): ввод данных по вариантам и статистический вывод."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import hypothesis_engine as he
from app.models import Hypothesis, User

router = APIRouter(prefix="/hypotheses", tags=["hypotheses"])


class HypothesisIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    a_visitors: int = Field(ge=0)
    a_conversions: int = Field(ge=0)
    b_visitors: int = Field(ge=0)
    b_conversions: int = Field(ge=0)


def _serialize(h: Hypothesis) -> dict:
    result = he.evaluate(h.a_visitors, h.a_conversions, h.b_visitors, h.b_conversions)
    return {"id": h.id, "name": h.name, "a_visitors": h.a_visitors, "a_conversions": h.a_conversions,
            "b_visitors": h.b_visitors, "b_conversions": h.b_conversions,
            "created_at": h.created_at.isoformat(), "result": result}


def _validate(body: HypothesisIn) -> None:
    if body.a_conversions > body.a_visitors or body.b_conversions > body.b_visitors:
        raise HTTPException(status_code=400, detail="Конверсий не может быть больше посетителей")


@router.get("")
async def list_hypotheses(user: User = Depends(get_current_user),
                          session: AsyncSession = Depends(get_session)) -> list[dict]:
    items = (await session.execute(
        select(Hypothesis).where(Hypothesis.user_id == user.id).order_by(Hypothesis.id.desc())
    )).scalars().all()
    return [_serialize(h) for h in items]


@router.post("")
async def create_hypothesis(body: HypothesisIn, user: User = Depends(get_current_user),
                            session: AsyncSession = Depends(get_session)) -> dict:
    _validate(body)
    h = Hypothesis(user_id=user.id, **body.model_dump())
    session.add(h)
    await session.commit()
    return _serialize(h)


async def _own(session: AsyncSession, user: User, hid: int) -> Hypothesis:
    h = (await session.execute(select(Hypothesis).where(
        Hypothesis.id == hid, Hypothesis.user_id == user.id))).scalar_one_or_none()
    if h is None:
        raise HTTPException(status_code=404, detail="Тест не найден")
    return h


@router.put("/{hid}")
async def update_hypothesis(hid: int, body: HypothesisIn, user: User = Depends(get_current_user),
                            session: AsyncSession = Depends(get_session)) -> dict:
    _validate(body)
    h = await _own(session, user, hid)
    for key, value in body.model_dump().items():
        setattr(h, key, value)
    await session.commit()
    return _serialize(h)


@router.delete("/{hid}")
async def delete_hypothesis(hid: int, user: User = Depends(get_current_user),
                            session: AsyncSession = Depends(get_session)) -> dict:
    h = await _own(session, user, hid)
    await session.delete(h)
    await session.commit()
    return {"ok": True}
