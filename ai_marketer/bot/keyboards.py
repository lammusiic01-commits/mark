"""Клавиатуры бота: кнопка приложения, меню оплаты, «назад».

Одно место для всех клавиатур — сообщения в хендлерах остаются читаемыми.
"""

from __future__ import annotations

from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    WebAppInfo,
)

from core.config import settings
from payments.sbp_qr import PRESET_AMOUNTS

# Иконки статусов уведомлений
KIND_ICONS = {"info": "ℹ️", "success": "✅", "warning": "⚠️", "error": "❌"}


def webapp_url() -> str:
    """Адрес Mini App из secrets.env (без хвостового слэша)."""
    return settings.WEBAPP_URL.rstrip("/")


def main_reply_keyboard() -> ReplyKeyboardMarkup:
    """Постоянная клавиатура: приложение, баланс, помощь."""
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🚀 Открыть приложение", web_app=WebAppInfo(url=webapp_url()))],
            [KeyboardButton(text="💳 Баланс"), KeyboardButton(text="❓ Помощь")],
        ],
        resize_keyboard=True,
        is_persistent=True,
        input_field_placeholder="Откройте приложение кнопкой ниже",
    )


def open_app_inline(text: str = "🚀 Открыть приложение") -> InlineKeyboardMarkup:
    """Inline-кнопка WebApp — работает в личных чатах."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=text, web_app=WebAppInfo(url=webapp_url()))],
            [InlineKeyboardButton(text="💳 Пополнить баланс", callback_data="pay:start")],
        ],
    )


def amounts_keyboard(presets: tuple[int, ...] = PRESET_AMOUNTS) -> InlineKeyboardMarkup:
    """Суммы пополнения: два ряда пресетов и своя сумма."""
    rows: list[list[InlineKeyboardButton]] = []
    chunk = list(presets)
    while chunk:
        pairs, chunk = chunk[:2], chunk[2:]
        rows.append(
            [InlineKeyboardButton(text=f"{amount} ₽", callback_data=f"pay:amount:{amount}") for amount in pairs],
        )
    rows.append([InlineKeyboardButton(text="✏️ Своя сумма", callback_data="pay:custom")])
    rows.append([InlineKeyboardButton(text="← Назад", callback_data="pay:cancel")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def payment_keyboard(payment_id: str, sbp_url: str | None = None) -> InlineKeyboardMarkup:
    """Кнопки под QR: проверить оплату, открыть банк, отменить."""
    rows: list[list[InlineKeyboardButton]] = []
    if sbp_url:
        rows.append([InlineKeyboardButton(text="🏦 Открыть в банке", url=sbp_url)])
    rows.append([InlineKeyboardButton(text="🔄 Проверить оплату", callback_data=f"pay:check:{payment_id}")])
    rows.append([InlineKeyboardButton(text="✖️ Отменить", callback_data=f"pay:cancel")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def back_to_app_keyboard() -> InlineKeyboardMarkup:
    """Кнопка возврата в приложение — под текстовыми ответами."""
    return open_app_inline("📊 Вернуться в приложение")


__all__ = [
    "KIND_ICONS",
    "amounts_keyboard",
    "back_to_app_keyboard",
    "main_reply_keyboard",
    "open_app_inline",
    "payment_keyboard",
    "webapp_url",
]
