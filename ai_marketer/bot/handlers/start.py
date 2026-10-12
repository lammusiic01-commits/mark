"""Хендлеры входа: /start, /app, /help, /balance.

Задача бота в этом продукте простая и важная: показать человеку кнопку
приложения и коротко объяснить, что он получит. Всё остальное — в Mini App.
"""

from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message

from bot.keyboards import back_to_app_keyboard, main_reply_keyboard, open_app_inline, webapp_url
from core.database import session_scope
from core.logger import get_logger
from core.models import display_name, get_or_create_user

log = get_logger(__name__)

router = Router(name="start")

# Приветствие: коротко, по делу, с обещанием конкретной пользы
WELCOME = """<b>{name}, добро пожаловать в AI Маркетолог</b> 🤖

Это не «ещё один кабинет Яндекс.Директа». Это команда специалистов в кармане:

📊 <b>Аналитика каждое утро</b> — клики, расход, конверсии, CPA. Без выгрузок и таблиц.
🤖 <b>Детектор ботов</b> — находит слив бюджета на фейковые переходы и предлагает, что отключить.
💡 <b>Гипотезы роста</b> с расчётом в рублях: сколько добавить, что отключить, что проверить.
🛡 <b>Проверка сайта и ставок</b> — движок считает сам, без «мнений» и наугад.

<b>С чего начать:</b> откройте приложение, подключите Директ и Метрику — доступы хранятся зашифрованными на вашем сервере, приложению они нужны только для расчётов.

Хотите, чтобы реклама начала экономить уже на этой неделе? 👇"""

HELP_TEXT = """<b>Как этим пользоваться</b>

1️⃣ <b>Откройте приложение</b> кнопкой ниже — это основной интерфейс.
2️⃣ <b>Подключите сервисы:</b> Яндекс.Директ (обязательно) и Яндекс.Метрику (для точных конверсий).
3️⃣ <b>Запустите проверку:</b> приложение покажет, где утекает бюджет и что делать дальше.

<b>Что я буду присылать сам:</b>
• отчёт по ботам, когда найду аномальный трафик;
• напоминание, когда гипотеза набрала статистику;
• уведомление о зачислении баланса.

<b>Команды:</b>
/app — открыть приложение
/balance — баланс и пополнение
/help — эта справка

Поддержка: пишите в приложение → Настройки → Поддержка."""


async def _touch_user(message: Message) -> tuple[str, bool]:
    """Создаёт/обновляет пользователя и возвращает его имя и признак «новый»."""
    from_user = message.from_user
    if from_user is None:  # служебные сообщения без автора
        return "друг", False

    async with session_scope() as session:
        user, created = await get_or_create_user(
            session,
            from_user.id,
            username=from_user.username,
            first_name=from_user.first_name,
            last_name=from_user.last_name,
            language_code=from_user.language_code,
        )
        name = display_name(user)
    if created:
        log.info("Новый пользователь бота", tg_id=from_user.id, username=from_user.username)
    return name, created


@router.message(CommandStart())
async def handle_start(message: Message) -> None:
    """Приветствие + кнопка приложения. Работает и для новых, и для старых."""
    name, _created = await _touch_user(message)
    await message.answer(
        WELCOME.format(name=name),
        reply_markup=main_reply_keyboard(),
    )
    await message.answer(
        "Приложение открывается кнопкой ниже 👇",
        reply_markup=open_app_inline(),
    )


@router.message(Command("app"))
async def handle_app(message: Message) -> None:
    """Быстрое открытие приложения."""
    await _touch_user(message)
    await message.answer("Ваш маркетолог на связи 👇", reply_markup=open_app_inline())


@router.message(Command("help"))
@router.message(F.text == "❓ Помощь")
async def handle_help(message: Message) -> None:
    """Справка: что умеет продукт и как начать."""
    await message.answer(HELP_TEXT, reply_markup=main_reply_keyboard())


@router.callback_query(F.data == "menu:help")
async def handle_help_button(callback: CallbackQuery) -> None:
    """Кнопка «Помощь» из inline-меню."""
    message = callback.message
    if isinstance(message, Message):
        await message.answer(HELP_TEXT, reply_markup=main_reply_keyboard())
    await callback.answer()


@router.callback_query(F.data == "menu:app")
async def handle_app_button(callback: CallbackQuery) -> None:
    """Инлайн-кнопка «Открыть приложение»: подтверждаем нажатие."""
    await callback.answer("Открываю приложение…", show_alert=False)
    message = callback.message
    if isinstance(message, Message):
        await message.answer("Приложение открывается кнопкой ниже 👇", reply_markup=open_app_inline())


@router.message(F.web_app_data)
async def handle_webapp_data(message: Message) -> None:
    """Данные, которые приложение отправляет боту (например, «оплатил»)."""
    log.info("Данные из WebApp", tg_id=message.from_user.id if message.from_user else None, payload=(message.web_app_data.data if message.web_app_data else "")[:120])
    await message.answer(
        "Получил данные из приложения. Если это про оплату — проверяю поступление в течение минуты.",
        reply_markup=back_to_app_keyboard(),
    )


def describe() -> dict[str, str]:
    """Справка о роутере — используется в логах старта."""
    return {"router": "start", "commands": "/start, /app, /help", "webapp_url": webapp_url()}


__all__ = ["WELCOME", "HELP_TEXT", "router"]
