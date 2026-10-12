"""
Обработчики бота. Главная функция — отправить кнопку, которая открывает Mini App.

Mini App — это продукт: кнопка web_app=WebAppInfo(url=HTTPS_URL) открывает
приложение внутри Telegram на телефоне. Telegram принимает только HTTPS,
поэтому URL берётся из Cloudflare Tunnel (tunnel.url).
"""
import logging

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

from app.config import settings

log = logging.getLogger("app.bot")

router = Router(name="main")


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """Приветствие + кнопка открытия Mini App (HTTPS от Cloudflare Tunnel)."""
    webapp_url = settings.WEBAPP_URL

    text = (
        "<b>AI Маркетолог</b>\n\n"
        "Умное управление контекстной рекламой.\n"
        "Детекция ботов, оптимизация ставок, A/B тесты.\n\n"
        "Нажми кнопку ниже, чтобы открыть приложение:"
    )

    if not webapp_url:
        # Tunnel не поднят: кнопка с web_app без HTTPS-URL Telegram не примет
        log.warning("/start: нет HTTPS URL для Mini App (tunnel.url пуст)")
        await message.answer(
            "<b>AI Маркетолог</b>\n\n"
            "Приложение временно недоступно: не получен HTTPS-адрес.\n"
            "Перезапусти start.bat и попробуй снова."
        )
        return

    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Открыть приложение",
                    web_app=WebAppInfo(url=webapp_url),
                )
            ],
        ]
    )

    await message.answer(text, reply_markup=kb)


@router.message(Command("help"))
async def cmd_help(message: Message) -> None:
    await message.answer(
        "<b>Команды:</b>\n"
        "/start — открыть приложение\n"
        "/help — эта справка"
    )
