"""Баланс: пополнение через QR (ST00012 / СБП), подтверждение администратором, история."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session, require_admin
from app.bot import notifications
from app.config import settings as app_settings
from app.models import Transaction, User, utcnow
from app.payments import sbp

router = APIRouter(prefix="/balance", tags=["balance"])


class TopupIn(BaseModel):
    amount_rub: int = Field(ge=1, le=1_000_000)


def _tx(t: Transaction) -> dict:
    return {"id": t.id, "kind": t.kind, "amount_kop": t.amount_kop, "status": t.status,
            "comment": t.comment, "created_at": t.created_at.isoformat(),
            "paid_at": t.paid_at.isoformat() if t.paid_at else None}


@router.get("")
async def balance(user: User = Depends(get_current_user),
                  session: AsyncSession = Depends(get_session)) -> dict:
    items = (await session.execute(select(Transaction).where(Transaction.user_id == user.id)
                                   .order_by(Transaction.id.desc()).limit(30))).scalars().all()
    return {
        "balance_kop": user.balance_kop,
        "transactions": [_tx(t) for t in items],
        "sbp_configured": sbp.is_configured(),
        "min_topup_rub": app_settings.MIN_TOPUP_RUB,
        "ai_charge_kop": app_settings.AI_CHARGE_KOP,
    }


@router.post("/topup")
async def topup(body: TopupIn, user: User = Depends(get_current_user),
                session: AsyncSession = Depends(get_session)) -> dict:
    if body.amount_rub < app_settings.MIN_TOPUP_RUB:
        raise HTTPException(status_code=400,
                            detail=f"Минимальное пополнение {app_settings.MIN_TOPUP_RUB} ₽")
    tx = Transaction(user_id=user.id, kind="topup", amount_kop=body.amount_rub * 100, status="pending")
    session.add(tx)
    await session.flush()
    tx.comment = f"AIM{tx.id}"
    await session.commit()

    payment = None
    if sbp.is_configured():
        payment = sbp.make_payment(tx.amount_kop, f"Пополнение баланса {tx.comment}")
    return {"transaction": _tx(tx), "payment": payment,
            "message": None if payment else
            "Реквизиты для оплаты не настроены: заполни SBP_MERCHANT_ID и SBP_ACCOUNT в secrets.env"}


@router.get("/admin/pending")
async def pending(_: User = Depends(require_admin),
                  session: AsyncSession = Depends(get_session)) -> list[dict]:
    items = (await session.execute(select(Transaction).where(
        Transaction.kind == "topup", Transaction.status == "pending")
        .order_by(Transaction.id))).scalars().all()
    return [{**_tx(t), "user_id": t.user_id} for t in items]


@router.post("/admin/confirm/{tx_id}")
async def confirm(tx_id: int, _: User = Depends(require_admin),
                  session: AsyncSession = Depends(get_session)) -> dict:
    tx = await session.get(Transaction, tx_id)
    if tx is None or tx.kind != "topup":
        raise HTTPException(status_code=404, detail="Пополнение не найдено")
    if tx.status == "paid":
        raise HTTPException(status_code=400, detail="Уже подтверждено")
    user = await session.get(User, tx.user_id)
    tx.status = "paid"
    tx.paid_at = utcnow()
    user.balance_kop += tx.amount_kop
    await session.commit()
    await notifications.notify(user.tg_id, f"Баланс пополнен на {tx.amount_kop / 100:.0f} ₽")
    return {"ok": True, "balance_kop": user.balance_kop}
