"""Платежи: баланс, пополнение по СБП и журнал операций.

Как это работает для пользователя:
  1. выбирает сумму (или вводит свою) → получает QR-код СБП;
  2. платит в приложении банка;
  3. статус подтверждается либо колбэком от кассы (продакшен), либо
     кнопкой «Я оплатил» — для локальной проверки;
  4. баланс пополняется, операция попадает в журнал.

Все суммы — в рублях. Отрицательный баланс невозможен: списания проверяют
остаток, а повторное подтверждение не задваивает деньги.
"""

from __future__ import annotations

import base64
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from api.deps import CurrentUser, DbSession
from core.config import settings
from core.logger import get_logger
from core.models import Payment
from payments.balance import format_money, get_balance, history
from payments.sbp_qr import (
    MAX_AMOUNT,
    MIN_AMOUNT,
    PAYMENT_TTL_MINUTES,
    PRESET_AMOUNTS,
    STATUS_PAID,
    STATUS_PENDING,
    PaymentError,
    PaymentQR,
    check_payment_status,
    confirm_payment,
    create_payment,
    get_payment,
)

log = get_logger(__name__)

router = APIRouter(prefix="/payments", tags=["платежи"])


class TopUpRequest(BaseModel):
    """Сумма пополнения в рублях."""

    amount: float = Field(gt=0, description="Сумма пополнения в рублях")


class WebhookRequest(BaseModel):
    """Уведомление кассы об оплате."""

    payment_id: str = Field(min_length=3)
    status: str = Field(default="paid", description="paid | failed")
    signature: str = Field(default="", description="Подпись кассы (если настроена)")
    provider_payload: str = Field(default="", description="Сырой ответ кассы для истории")


def _qr_base64(qr: PaymentQR) -> str:
    """QR-картинка в base64: <img> в браузере не умеет передавать заголовки."""
    return base64.b64encode(qr.qr_image_bytes).decode("ascii")


def _payment_view(payment: Payment) -> dict[str, Any]:
    """Представление платежа для интерфейса."""
    return {
        "payment_id": payment.payment_id,
        "amount": round(float(payment.amount), 2),
        "amount_text": format_money(float(payment.amount)),
        "status": payment.status,
        "sbp_url": payment.sbp_url or "",
        "created_at": payment.created_at.isoformat() if payment.created_at else None,
        "paid_at": payment.paid_at.isoformat() if payment.paid_at else None,
    }


async def _user_payment(session: DbSession, user: CurrentUser, payment_id: str) -> Payment:
    """Платёж пользователя по номеру — чужой счёт вернёт 404, а не 403."""
    payment = await get_payment(session, payment_id)
    if payment is None or payment.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Платёж не найден")
    return payment


@router.get("/balance", summary="Баланс и итоги операций")
async def balance(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Сколько денег на счету и сколько пополнено/потрачено за всё время."""
    total = await get_balance(session, user)
    entries = await history(session, user, limit=100)
    topped_up = sum(float(item["amount"]) for item in entries if item["kind"] == "topup")
    spent = sum(float(item["amount"]) for item in entries if item["kind"] == "charge")
    return {
        "balance": round(total, 2),
        "balance_text": format_money(total),
        "topped_up_total": round(topped_up, 2),
        "spent_total": round(spent, 2),
        "currency": "RUB",
        "presets": list(PRESET_AMOUNTS),
        "min_amount": MIN_AMOUNT,
        "max_amount": MAX_AMOUNT,
        "ttl_minutes": PAYMENT_TTL_MINUTES,
        "sbp_configured": settings.sbp_enabled,
    }


@router.get("/history", summary="Журнал операций")
async def payments_history(session: DbSession, user: CurrentUser, limit: int = 20) -> dict[str, Any]:
    """Пополнения и списания по времени — для экрана «Баланс»."""
    entries = await history(session, user, limit=min(max(limit, 1), 100))
    for item in entries:
        item["amount_text"] = format_money(float(item["amount"]))
    return {"entries": entries, "count": len(entries)}


@router.post("/topup", summary="Создать счёт и QR-код СБП")
async def top_up(payload: TopUpRequest, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Создаёт счёт по СБП и отдаёт QR-код картинкой в base64."""
    try:
        qr = await create_payment(session, user, amount=payload.amount)
    except PaymentError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    await session.commit()
    view = {
        "payment_id": qr.payment_id,
        "amount": round(qr.amount, 2),
        "amount_text": format_money(qr.amount),
        "status": STATUS_PENDING,
        "sbp_url": qr.sbp_url or "",
        "qr_png_base64": _qr_base64(qr),
        "expires_at": qr.expires_at.isoformat() if qr.expires_at else None,
        "expires_in_minutes": PAYMENT_TTL_MINUTES,
        "created_at": None,
        "paid_at": None,
        "sbp_configured": settings.sbp_enabled,
    }
    view["hint"] = (
        "Отсканируйте QR в приложении банка и нажмите «Проверить оплату» — "
        "баланс пополнится сразу после подтверждения."
        if settings.sbp_enabled
        else "Реквизиты СБП не заполнены: счёт создан в тестовом режиме, оплату подтверждает кнопка «Проверить оплату»."
    )
    log.info("Создан счёт", user_id=user.id, amount=qr.amount, payment_id=qr.payment_id)
    return view


@router.get("/{payment_id}", summary="Статус платежа")
async def payment_status(payment_id: str, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Проверяет статус счёта: экран «Баланс» опрашивает его после оплаты."""
    payment = await _user_payment(session, user, payment_id)
    before = payment.status
    state = await check_payment_status(session, payment_id)
    await session.commit()

    fresh = await _user_payment(session, user, payment_id)
    view = _payment_view(fresh)
    view["status"] = state
    view["changed"] = before != state
    view["balance_text"] = format_money(await get_balance(session, user))
    view["balance"] = round(await get_balance(session, user), 2)
    if state == STATUS_PAID:
        view["message"] = "Оплата получена — баланс пополнен"
    elif state == "failed":
        view["message"] = "Счёт истёк — создайте новый, если оплата не прошла"
    return view


@router.post("/{payment_id}/confirm", summary="Подтвердить оплату вручную")
async def confirm(payment_id: str, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Отмечает счёт оплаченным — кнопка «Я оплатил» для локальной проверки.

    В боевом режиме с настроенной кассой оплату подтверждает банк, поэтому
    ручное подтверждение отключено: иначе баланс можно было бы нарисовать.
    """
    payment = await _user_payment(session, user, payment_id)

    if settings.is_production and settings.sbp_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Оплату подтверждает банк — в боевом режиме ручная проверка отключена",
        )

    if payment.status == STATUS_PAID:
        # Повторное нажатие «Я оплатил» — не ошибка, но и не новое зачисление
        view = _payment_view(payment)
        view["credited"] = False
        view["balance_text"] = format_money(await get_balance(session, user))
        view["message"] = "Оплата уже зачтена — баланс в порядке"
        return view

    payment, credited = await confirm_payment(session, payment_id)
    await session.commit()
    log.info("Счёт подтверждён вручную", user_id=user.id, payment_id=payment_id, credited=credited)

    view = _payment_view(payment) if payment else {"payment_id": payment_id, "status": STATUS_PAID}
    view["credited"] = credited
    view["balance_text"] = format_money(await get_balance(session, user))
    view["message"] = "Баланс пополнен" if credited else "Оплата уже была зачтена"
    return view


@router.post("/pending/check", summary="Проверить незавершённые счета")
async def check_pending(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Проходит по открытым счетам пользователя — нужно экрану «Баланс»."""
    result = await session.execute(
        select(Payment)
        .where(Payment.user_id == user.id, Payment.status == STATUS_PENDING)
        .order_by(Payment.created_at.desc())
        .limit(10),
    )
    pending = list(result.scalars().all())

    updated: list[dict[str, Any]] = []
    for payment in pending:
        state = await check_payment_status(session, payment.payment_id)
        if state == STATUS_PAID:
            fresh = await get_payment(session, payment.payment_id)
            if fresh is not None:
                updated.append(_payment_view(fresh))
    await session.commit()

    return {
        "checked": len(pending),
        "updated": updated,
        "balance_text": format_money(await get_balance(session, user)),
    }


@router.post("/webhook/sbp", summary="Уведомление кассы об оплате")
async def sbp_webhook(payload: WebhookRequest, request: Request, session: DbSession) -> dict[str, Any]:
    """Приём уведомления от банка или платёжной кассы.

    Подпись проверяется ключом SBP_SECRET_KEY (HMAC-SHA256 тела запроса).
    Если ключ не задан, колбэк принимается только в режиме разработки:
    в боевом режиме отвечаем 503 — касса должна быть настроена.
    """
    body = await request.body()
    if not _verify_signature(body, payload.signature):
        log.warning("Колбэк СБП отклонён", reason="подпись не совпала или ключ не задан")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE if settings.is_production else status.HTTP_401_UNAUTHORIZED,
            detail="Подпись колбэка не проверена — заполните SBP_SECRET_KEY в secrets.env",
        )

    payment = await get_payment(session, payload.payment_id)
    if payment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Платёж не найден")

    if payload.status == STATUS_PAID:
        payment, credited = await confirm_payment(session, payload.payment_id, provider_payload=payload.provider_payload or None)
        await session.commit()
        log.info("Колбэк кассы: оплата зачтена", payment_id=payload.payment_id, credited=credited)
        return {"ok": True, "credited": credited, "status": payment.status if payment else STATUS_PAID}

    payment.status = "failed"
    await session.commit()
    return {"ok": True, "credited": False, "status": payment.status}


def _verify_signature(body: bytes, signature: str) -> bool:
    """Сравнивает подпись кассы с HMAC-SHA256 тела запроса."""
    import hashlib
    import hmac

    secret = (settings.SBP_SECRET_KEY or "").strip()
    if not secret:
        return not settings.is_production
    if not signature:
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())


__all__ = ["router"]
