"""Пополнение баланса по СБП прямо в чате с ботом.

Сценарий: пользователь выбирает сумму → бот создаёт платёж и отправляет QR
(картинкой) → пользователь платит в своём банке → бот проверяет статус и
сообщает о зачислении. Никаких «оплатите на сайте и вернитесь» — всё в чате.
"""

from __future__ import annotations

import html
from decimal import Decimal, InvalidOperation

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import BufferedInputFile, CallbackQuery, Message

from bot.keyboards import amounts_keyboard, back_to_app_keyboard, main_reply_keyboard, payment_keyboard
from core.database import session_scope
from core.logger import get_logger
from core.models import display_name, get_or_create_user
from payments.balance import format_money, get_balance, history
from payments.sbp_qr import (
    MAX_AMOUNT,
    MIN_AMOUNT,
    PRESET_AMOUNTS,
    PaymentError,
    check_payment_status,
    create_payment,
)

log = get_logger(__name__)

router = Router(name="payment")


class PaymentFlow(StatesGroup):
    """Состояния диалога пополнения."""

    waiting_amount = State()


def _parse_amount(raw: str) -> float | None:
    """Разбирает сумму из текста: «1 500», «1500,50», «1500 ₽» → 1500.5."""
    cleaned = (
        raw.replace("₽", "")
        .replace("руб", "")
        .replace("рублей", "")
        .replace(" ", "")
        .replace("\u00a0", "")
        .replace(",", ".")
        .strip()
    )
    try:
        value = Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return None
    if value <= 0:
        return None
    return float(value)


async def _balance_text(tg_id: int) -> str:
    """Текст со балансом и последними операциями."""
    async with session_scope() as session:
        user, _created = await get_or_create_user(session, tg_id)
        balance = await get_balance(session, user)
        operations = await history(session, user, limit=3)

    lines = [f"💳 <b>Баланс: {format_money(balance)}</b>", ""]
    if operations:
        lines.append("<b>Последние операции</b>")
        for item in operations:
            sign = "＋" if item["kind"] == "topup" else "−"
            lines.append(
                f"{sign} {format_money(abs(item['amount']))} · {html.escape(str(item['title']))} · {item['created_at']}",
            )
    else:
        lines.append("Операций пока нет — пополните баланс, чтобы запустить гипотезы и отчёты.")
    if balance <= 0:
        lines.append("")
        lines.append("Баланс используется для платных действий: запуск гипотез, глубокие отчёты, автооптимизация ставок.")
    return "\n".join(lines)


async def _send_amounts(message: Message, state: FSMContext | None = None) -> None:
    """Показывает пресеты сумм."""
    if state is not None:
        await state.clear()
    await message.answer(
        "На какую сумму пополнить баланс?\n\n"
        "Оплата по СБП: отсканируйте QR или откройте ссылку в приложении банка. "
        "Зачисление — автоматически, обычно в течение минуты.",
        reply_markup=amounts_keyboard(),
    )


@router.message(Command("balance"))
@router.message(F.text == "💳 Баланс")
async def handle_balance(message: Message, state: FSMContext) -> None:
    """Баланс и кнопка пополнения."""
    await state.clear()
    tg_id = message.from_user.id if message.from_user else 0
    await message.answer(await _balance_text(tg_id), reply_markup=main_reply_keyboard())
    await _send_amounts(message)


@router.callback_query(F.data == "pay:start")
async def handle_pay_start(callback: CallbackQuery, state: FSMContext) -> None:
    """Кнопка «Пополнить баланс» из любого меню."""
    await callback.answer()
    await state.clear()
    message = callback.message
    if isinstance(message, Message):
        await _send_amounts(message)


@router.callback_query(F.data == "pay:cancel")
async def handle_pay_cancel(callback: CallbackQuery, state: FSMContext) -> None:
    """Отмена: убираем клавиатуру с суммами."""
    await callback.answer("Отменено")
    await state.clear()
    message = callback.message
    if isinstance(message, Message):
        try:
            await message.edit_reply_markup(reply_markup=None)
        except Exception:  # noqa: BLE001 — сообщение могло быть уже удалено
            pass
        await message.answer("Хорошо, отменил. Вернётесь к оплате — команда /balance.", reply_markup=back_to_app_keyboard())


@router.callback_query(F.data == "pay:custom")
async def handle_pay_custom(callback: CallbackQuery, state: FSMContext) -> None:
    """Просим ввести сумму текстом."""
    await callback.answer()
    await state.set_state(PaymentFlow.waiting_amount)
    message = callback.message
    if isinstance(message, Message):
        await message.answer(
            f"Напишите сумму числом — от {int(MIN_AMOUNT)} до {int(MAX_AMOUNT)} ₽.\n"
            "Например: <code>2500</code>",
            reply_markup=back_to_app_keyboard(),
        )


async def _create_and_send_qr(target: Message, tg_id: int, amount: float) -> None:
    """Создаёт платёж, отправляет QR и инструкцию."""
    async with session_scope() as session:
        user, _created = await get_or_create_user(session, tg_id)
        try:
            payment_qr = await create_payment(session, user, amount)
        except PaymentError as error:
            await target.answer(f"⚠️ {html.escape(str(error))}", reply_markup=back_to_app_keyboard())
            return

    caption = (
        f"🧾 <b>Счёт на {format_money(amount)}</b>\n"
        f"Номер платежа: <code>{payment_qr.payment_id}</code>\n\n"
        "1. Откройте приложение банка и отсканируйте QR (или нажмите «Открыть в банке»).\n"
        "2. Подтвердите перевод.\n"
        "3. Вернитесь сюда — я проверю поступление сам и сообщу.\n\n"
        "<i>Если оплатили, а сообщения нет — нажмите «Проверить оплату».</i>"
    )
    await target.answer_photo(
        BufferedInputFile(payment_qr.qr_image_bytes, filename=f"sbp-{payment_qr.payment_id}.png"),
        caption=caption,
        reply_markup=payment_keyboard(payment_qr.payment_id, payment_qr.sbp_url),
    )


@router.callback_query(F.data.startswith("pay:amount:"))
async def handle_pay_amount(callback: CallbackQuery, state: FSMContext) -> None:
    """Пользователь выбрал сумму из пресетов."""
    amount = _parse_amount(callback.data.split(":")[-1] if callback.data else "")
    await state.clear()
    if amount is None:
        await callback.answer("Не понял сумму — выберите ещё раз", show_alert=True)
        return
    await callback.answer(f"Готовлю счёт на {format_money(amount)}")
    message = callback.message
    if isinstance(message, Message):
        await _create_and_send_qr(message, callback.from_user.id, amount)


@router.message(PaymentFlow.waiting_amount)
async def handle_custom_amount(message: Message, state: FSMContext) -> None:
    """Своя сумма: проверяем диапазон и создаём счёт."""
    amount = _parse_amount(message.text or "")
    if amount is None:
        await message.answer(
            "Не разобрал сумму 🤔 Напишите только число, например <code>1500</code>",
            reply_markup=back_to_app_keyboard(),
        )
        return
    if amount < MIN_AMOUNT:
        await message.answer(f"Минимальная сумма — {int(MIN_AMOUNT)} ₽", reply_markup=back_to_app_keyboard())
        return
    if amount > MAX_AMOUNT:
        await message.answer(
            f"Максимум за один раз — {int(MAX_AMOUNT)} ₽. Для более крупной суммы напишите в поддержку.",
            reply_markup=back_to_app_keyboard(),
        )
        return

    await state.clear()
    await _create_and_send_qr(message, message.from_user.id if message.from_user else 0, amount)


@router.callback_query(F.data.startswith("pay:check:"))
async def handle_pay_check(callback: CallbackQuery) -> None:
    """Ручная проверка оплаты — на случай, если пользователь поторопился."""
    payment_id = (callback.data or "").split(":")[-1]
    async with session_scope() as session:
        status = await check_payment_status(session, payment_id)

    if status == "paid":
        await callback.answer("Оплата получена, баланс пополнен ✅", show_alert=True)
    elif status == "failed":
        await callback.answer("Платёж не прошёл. Попробуйте создать новый счёт.", show_alert=True)
    else:
        await callback.answer("Оплата пока не видна. Если только что перевели — подождите минуту.", show_alert=True)


@router.message(Command("presets"))
async def handle_presets(message: Message) -> None:
    """Показать доступные суммы — полезно для проверки настройки."""
    await message.answer(
        "Доступные суммы: " + ", ".join(f"{amount} ₽" for amount in PRESET_AMOUNTS),
        reply_markup=amounts_keyboard(),
    )


__all__ = ["PaymentFlow", "router"]
