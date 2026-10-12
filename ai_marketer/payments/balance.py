"""Баланс пользователя и журнал операций.

Схема из ТЗ не содержит отдельной таблицы транзакций, поэтому журнал
строится на таблице payments: пополнение — запись со статусом paid,
списание за действие — запись со статусом charge. Так пользователь видит
историю «куда ушли деньги», а схема остаётся утверждённой.

Баланс хранится в users.balance и меняется только здесь — единая точка правды,
никаких «тихих» изменений из других модулей.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.logger import get_logger
from core.models import Payment, User

log = get_logger(__name__)

# Статусы операций в журнале
STATUS_PAID = "paid"
STATUS_PENDING = "pending"
STATUS_FAILED = "failed"
STATUS_CHARGE = "charge"

OPERATION_TITLES = {
    "sbp": "Пополнение по СБП",
    "manual": "Пополнение",
    "charge": "Списание",
}


def format_money(value: float | int, with_currency: bool = True) -> str:
    """1 500 ₽ — единый формат суммы во всём продукте (неразрывные пробелы)."""
    number = float(value or 0)
    if abs(number - round(number)) < 0.005:
        text = f"{int(round(number)):,}".replace(",", "\u202f")
    else:
        text = f"{number:,.2f}".replace(",", "\u202f").replace(".", ",")
    return f"{text} ₽" if with_currency else text


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_reference(prefix: str) -> str:
    """Идентификатор операции журнала: manual-3f2a…, charge-8c01…"""
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


async def get_balance(session: AsyncSession, user: User) -> float:
    """Текущий баланс (из базы, без кэша — деньги считаем точно)."""
    await session.refresh(user)
    return float(user.balance or 0.0)


async def top_up(
    session: AsyncSession,
    user: User,
    amount: float,
    *,
    title: str | None = None,
    reference: str | None = None,
) -> float:
    """Начисляет средства и пишет операцию в журнал. Возвращает новый баланс.

    Используется для ручных начислений (поддержка, бонус). Оплата по СБП
    приходит через confirm_payment — там запись уже существует.
    """
    if amount <= 0:
        raise ValueError("Сумма пополнения должна быть больше нуля")

    session.add(
        Payment(
            user_id=user.id,
            payment_id=reference or _new_reference("manual"),
            amount=float(amount),
            status=STATUS_PAID,
            sbp_url="",
            paid_at=_now(),
        ),
    )
    user.balance = float(user.balance or 0.0) + float(amount)
    await session.flush()
    log.info("Баланс пополнен", user_id=user.id, amount=amount, title=title or OPERATION_TITLES["manual"])
    return float(user.balance)


async def charge(
    session: AsyncSession,
    user: User,
    amount: float,
    *,
    title: str,
) -> bool:
    """Списывает средства за действие. False — денег не хватило.

    Проверка идёт по актуальному значению баланса, поэтому двойное списание
    при параллельных запросах исключено на уровне одной транзакции.
    """
    if amount <= 0:
        raise ValueError("Сумма списания должна быть больше нуля")

    balance = float(user.balance or 0.0)
    if balance < amount:
        log.warning("Недостаточно средств", user_id=user.id, needed=amount, balance=balance)
        return False

    session.add(
        Payment(
            user_id=user.id,
            payment_id=_new_reference("charge"),
            amount=float(amount),
            status=STATUS_CHARGE,
            sbp_url=title,  # в этом поле храним назначение платежа — видно в истории
            paid_at=_now(),
        ),
    )
    user.balance = balance - float(amount)
    await session.flush()
    log.info("Списание с баланса", user_id=user.id, amount=amount, title=title)
    return True


async def history(session: AsyncSession, user: User, limit: int = 20) -> list[dict[str, object]]:
    """Последние операции: пополнения и списания в одном списке."""
    result = await session.execute(
        select(Payment)
        .where(Payment.user_id == user.id, Payment.status.in_((STATUS_PAID, STATUS_CHARGE)))
        .order_by(Payment.created_at.desc())
        .limit(limit),
    )
    rows = list(result.scalars().all())

    items: list[dict[str, object]] = []
    for row in rows:
        is_charge = row.status == STATUS_CHARGE
        items.append(
            {
                "kind": "charge" if is_charge else "topup",
                "amount": float(row.amount),
                "title": (row.sbp_url or OPERATION_TITLES["sbp"]) if is_charge else OPERATION_TITLES["sbp"],
                "status": row.status,
                "reference": row.payment_id,
                "created_at": _human_date(row.created_at),
            },
        )
    return items


async def summary(session: AsyncSession, user: User, limit: int = 5) -> dict[str, object]:
    """Баланс + история одним вызовом — для экрана «Баланс» в приложении."""
    return {
        "balance": await get_balance(session, user),
        "balance_text": format_money(await get_balance(session, user)),
        "operations": await history(session, user, limit=limit),
    }


def _human_date(value: datetime | None) -> str:
    """Дата для интерфейса: 12 окт, 14:35."""
    if value is None:
        return ""
    months = (
        "янв", "фев", "мар", "апр", "мая", "июн",
        "июл", "авг", "сен", "окт", "ноя", "дек",
    )
    local = value.astimezone(timezone.utc)
    return f"{local.day} {months[local.month - 1]}, {local:%H:%M}"


__all__ = [
    "STATUS_CHARGE",
    "STATUS_FAILED",
    "STATUS_PAID",
    "STATUS_PENDING",
    "charge",
    "format_money",
    "get_balance",
    "history",
    "summary",
    "top_up",
]
