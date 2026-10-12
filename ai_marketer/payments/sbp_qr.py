"""Приём оплаты по СБП: счёт, QR-код, проверка поступления.

Как устроено:
  • create_payment() создаёт запись в payments (статус pending) и картинку QR;
  • пользователь платит в приложении банка (QR или ссылка);
  • check_payment_status() смотрит статус: у платёжной кассы — запросом,
    без кассы — по отметке о подтверждении (локальный режим для проверки);
  • confirm_payment() зачисляет деньги на баланс ровно один раз.

Название «ссылка для банка» (sbp_url) формируется из реквизитов в secrets.env.
Точный формат ссылки выдаёт банк-эквайер: если он отличается от шаблона ниже,
достаточно поправить одну функцию build_sbp_link() — остальной код не меняется.
"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.logger import get_logger
from core.models import Payment, User
from payments.balance import STATUS_FAILED, STATUS_PAID, STATUS_PENDING, format_money

log = get_logger(__name__)

# Границы суммы: ниже — не имеет смысла из-за комиссий, выше — только через поддержку
PRESET_AMOUNTS: tuple[int, ...] = (500, 1000, 3000, 10000)
MIN_AMOUNT = 300.0
MAX_AMOUNT = 100_000.0

# Сколько живёт счёт (после этого он помечается failed, деньги всё равно зачислим при поступлении)
PAYMENT_TTL_MINUTES = 60

# База Национальной системы платёжных карт для ссылок СБП
NSPK_QR_BASE = "https://qr.nspk.ru"


class PaymentError(RuntimeError):
    """Ошибка платежа, которую можно показать пользователю."""


@dataclass(frozen=True, slots=True)
class PaymentQR:
    """Готовый к отправке счёт: номер, сумма, QR-картинка и ссылка."""

    payment_id: str
    amount: float
    payload: str
    qr_image_bytes: bytes
    sbp_url: str | None
    expires_at: datetime | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _kopecks(amount: float) -> int:
    return int(round(float(amount) * 100))


def validate_amount(amount: float) -> float:
    """Проверяет сумму и возвращает её с копейками (без лишних дробей)."""
    try:
        value = round(float(amount), 2)
    except (TypeError, ValueError) as error:
        raise PaymentError("Сумма должна быть числом") from error

    if value < MIN_AMOUNT:
        raise PaymentError(f"Минимальная сумма пополнения — {int(MIN_AMOUNT)} ₽")
    if value > MAX_AMOUNT:
        raise PaymentError(f"Максимальная сумма за один платёж — {int(MAX_AMOUNT)} ₽. Для большей суммы напишите в поддержку.")
    return value


def build_sbp_link(payment_id: str, amount: float, account: str | None = None) -> str | None:
    """Ссылка на оплату в приложении банка.

    Возвращаем None, если реквизиты не настроены — тогда пользователь платит
    переводом по QR/реквизитам, и подтверждение приходит вручную.
    """
    if not settings.SBP_MERCHANT_ID and not account:
        return None

    merchant = settings.SBP_MERCHANT_ID or "transfer"
    query = [f"sum={_kopecks(amount)}", f"order={payment_id}"]
    if account:
        query.append(f"account={account}")
    return f"{NSPK_QR_BASE}/{merchant}?" + "&".join(query)


def build_payload(payment_id: str, amount: float) -> tuple[str, str | None]:
    """Что кодируем в QR-код и какую ссылку даём кнопкой.

    Полноценная ссылка СБП требует идентификатора и счёта от банка. Если их нет,
    QR содержит текстовые реквизиты перевода — такой код банковское приложение
    не откроет, но сотрудник поддержки/клиент видит номер счёта и сумму,
    а подтверждение оплаты в этом режиме делает подтверждение из приложения
    (кнопка «Проверить оплату» → /api/payments/{id}/confirm).
    """
    account = (settings.SBP_ACCOUNT or "").strip()
    link = build_sbp_link(payment_id, amount, account or None)

    if link and account:
        return link, link

    if account:
        payload = (
            "СБП перевод\n"
            f"Счёт: {account}\n"
            f"Сумма: {format_money(amount)}\n"
            f"Назначение: {payment_id}"
        )
        return payload, None

    payload = (
        "AI Маркетолог — тестовый режим оплаты\n"
        f"Сумма: {format_money(amount)}\n"
        f"Номер платежа: {payment_id}\n"
        "Добавьте SBP_MERCHANT_ID и SBP_ACCOUNT в secrets.env, чтобы принимать СБП."
    )
    return payload, None


def render_qr(payload: str) -> bytes:
    """PNG с QR-кодом. Чёрное на белом — максимальная читаемость сканерами."""
    code = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=10, border=2)
    code.add_data(payload)
    code.make(fit=True)

    image = code.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def new_payment_id() -> str:
    """Номер платежа: SBP-20261012-141530-3f2ab19c (понятно и уникально)."""
    stamp = _now().strftime("%Y%m%d-%H%M%S")
    return f"SBP-{stamp}-{uuid.uuid4().hex[:8]}"


async def create_payment(session: AsyncSession, user: User, amount: float) -> PaymentQR:
    """Создаёт счёт и картинку QR. Деньги зачисляются только после подтверждения."""
    value = validate_amount(amount)
    payment_id = new_payment_id()
    payload, sbp_url = build_payload(payment_id, value)
    expires_at = _now() + timedelta(minutes=PAYMENT_TTL_MINUTES)

    payment = Payment(
        user_id=user.id,
        payment_id=payment_id,
        amount=value,
        status=STATUS_PENDING,
        sbp_url=sbp_url or "",
        qr_payload=payload,
    )
    session.add(payment)
    await session.flush()

    log.info(
        "Счёт создан",
        user_id=user.id,
        payment_id=payment_id,
        amount=value,
        sbp_configured=settings.sbp_enabled,
    )
    return PaymentQR(
        payment_id=payment_id,
        amount=value,
        payload=payload,
        qr_image_bytes=render_qr(payload),
        sbp_url=sbp_url,
        expires_at=expires_at,
    )


async def get_payment(session: AsyncSession, payment_id: str) -> Payment | None:
    """Платёж по номеру."""
    result = await session.execute(select(Payment).where(Payment.payment_id == payment_id))
    return result.scalar_one_or_none()


async def confirm_payment(
    session: AsyncSession,
    payment_id: str,
    *,
    provider_payload: str | None = None,
) -> tuple[Payment | None, bool]:
    """Зачисляет оплату на баланс. Возвращает платёж и признак «зачислено сейчас».

    Повторный вызов ничего не меняет — деньги не задваиваются.
    """
    payment = await get_payment(session, payment_id)
    if payment is None:
        log.warning("Платёж не найден", payment_id=payment_id)
        return None, False

    if payment.status == STATUS_PAID:
        return payment, False

    user_result = await session.execute(select(User).where(User.id == payment.user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        log.error("У платежа нет владельца — зачисление невозможно", payment_id=payment_id)
        return payment, False

    payment.status = STATUS_PAID
    payment.paid_at = _now()
    if provider_payload:
        payment.qr_payload = f"{payment.qr_payload or ''}\nprovider: {provider_payload}"[:4000]

    user.balance = float(user.balance or 0.0) + float(payment.amount)
    await session.flush()

    log.info(
        "Платёж зачислен",
        payment_id=payment_id,
        user_id=user.id,
        amount=payment.amount,
        balance=user.balance,
    )
    return payment, True


async def check_payment_status(session: AsyncSession, payment_id: str) -> str:
    """Статус платежа: pending | paid | failed.

    Порядок проверки:
      1. статус в базе (подтверждён ли платёж);
      2. сверка с банком-эквайером, если настроены реквизиты (см. query_provider);
      3. истёк ли срок счёта — тогда failed, но поступившие деньги всё равно зачтутся.
    """
    payment = await get_payment(session, payment_id)
    if payment is None:
        return STATUS_FAILED
    if payment.status == STATUS_PAID:
        return STATUS_PAID
    if payment.status == STATUS_CHARGE:
        return STATUS_FAILED

    provider_status = await query_provider(payment)
    if provider_status == STATUS_PAID:
        await confirm_payment(session, payment_id, provider_payload="provider-query")
        return STATUS_PAID

    created = payment.created_at or _now()
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if _now() - created > timedelta(minutes=PAYMENT_TTL_MINUTES):
        payment.status = STATUS_FAILED
        await session.flush()
        return STATUS_FAILED

    return STATUS_PENDING


async def query_provider(payment: Payment) -> str:
    """Запрос статуса в платёжной кассе.

    Сейчас возвращает pending: конкретный банк-эквайер в secrets.env не задан
    (есть только идентификатор и счёт СБП), поэтому подтверждение приходит
    либо вебхуком кассы на /api/payments/callback, либо вручную.
    Здесь единственное место, которое нужно заменить на реальный вызов кассы.
    """
    if not settings.sbp_enabled:
        return STATUS_PENDING
    log.debug("Проверка статуса у кассы не настроена — ждём подтверждения", payment_id=payment.payment_id)
    return STATUS_PENDING


async def poll_pending_payments(limit: int = 25) -> list[dict[str, object]]:
    """Проверяет неоплаченные счета и возвращает список зачисленных.

    Используется фоновой задачей бота: как только оплата подтверждена,
    пользователь получает уведомление в Telegram.
    """
    from core.database import session_scope

    credited: list[dict[str, object]] = []
    async with session_scope() as session:
        result = await session.execute(
            select(Payment).where(Payment.status == STATUS_PENDING).order_by(Payment.created_at.desc()).limit(limit),
        )
        pending = list(result.scalars().all())

        for payment in pending:
            status = await check_payment_status(session, payment.payment_id)
            if status != STATUS_PAID:
                continue

            user_result = await session.execute(select(User).where(User.id == payment.user_id))
            user = user_result.scalar_one_or_none()
            credited.append(
                {
                    "tg_id": user.tg_id if user else 0,
                    "payment_id": payment.payment_id,
                    "amount": float(payment.amount),
                    "amount_text": format_money(payment.amount),
                    "balance_text": format_money(user.balance if user else 0),
                },
            )

    if credited:
        log.info("Оплаты подтверждены", count=len(credited))
    return credited


__all__ = [
    "MAX_AMOUNT",
    "MIN_AMOUNT",
    "PAYMENT_TTL_MINUTES",
    "PRESET_AMOUNTS",
    "PaymentError",
    "PaymentQR",
    "build_payload",
    "build_sbp_link",
    "check_payment_status",
    "confirm_payment",
    "create_payment",
    "get_payment",
    "new_payment_id",
    "poll_pending_payments",
    "query_provider",
    "render_qr",
    "validate_amount",
]
