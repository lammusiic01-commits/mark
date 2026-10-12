"""Точка входа бота: python -m bot.main

Что происходит при запуске:
  1. настраиваются логи и проверяются настройки из secrets.env;
  2. бот собирается с прокси-сессией и проверяет связь (getMe);
  3. регистрируются роутеры, команды и кнопка меню с WebApp;
  4. в фоне работают: разбор очереди уведомлений и наблюдатель за платежами;
  5. по SIGTERM/SIGINT всё аккуратно останавливается (Docker шлёт именно их).
"""

from __future__ import annotations

import asyncio
import signal
import sys

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo

from bot.handlers import register
from bot.keyboards import webapp_url
from bot.notifications import notify, run_consumer
from bot.proxy_session import ProxyConfigurationError, check_connection, create_bot
from core.config import settings
from core.database import dispose, wait_for_database
from core.logger import configure_logging, get_logger
from core.redis_client import close_client, ping as redis_ping

log = get_logger(__name__)

# Как часто проверять неоплаченные счета (секунды)
PAYMENT_POLL_INTERVAL = 30

COMMANDS = [
    BotCommand(command="start", description="Запустить бота"),
    BotCommand(command="app", description="Открыть приложение"),
    BotCommand(command="balance", description="Баланс и пополнение"),
    BotCommand(command="help", description="Как это работает"),
]


async def setup_bot_ui(bot: Bot) -> None:
    """Команды в меню и большая кнопка WebApp слева от поля ввода."""
    try:
        await bot.set_my_commands(COMMANDS)
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="Маркетолог", web_app=WebAppInfo(url=webapp_url())),
        )
        log.info("Меню бота настроено", commands=len(COMMANDS), webapp=webapp_url())
    except Exception as error:  # noqa: BLE001 — отсутствие меню не мешает работать
        log.warning("Не удалось настроить меню бота", error=str(error))


async def watch_payments(bot: Bot, stop_event: asyncio.Event) -> None:
    """Следит за счетами: как только банк подтвердил оплату — пишет пользователю."""
    from payments.sbp_qr import poll_pending_payments

    log.info("Наблюдаю за оплатами", interval_seconds=PAYMENT_POLL_INTERVAL)
    while not stop_event.is_set():
        try:
            credited = await poll_pending_payments()
            for item in credited:
                await notify(
                    item["tg_id"],
                    (
                        f"Оплата получена ✅\n"
                        f"Зачислено {item['amount_text']} — баланс {item['balance_text']}.\n"
                        "Можно запускать гипотезы и глубокие отчёты в приложении."
                    ),
                    kind="success",
                )
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 — наблюдатель не должен умирать
            log.error("Ошибка при проверке платежей", error=str(error))

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=PAYMENT_POLL_INTERVAL)
        except asyncio.TimeoutError:
            continue


def install_signal_handlers(stop_event: asyncio.Event) -> None:
    """Останавливает бота по SIGTERM/SIGINT (в Windows обработчиков нет — не страшно)."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, RuntimeError):  # pragma: no cover — Windows/ProactorEventLoop
            log.debug("Сигнал не перехватывается в этой системе", signal=str(sig))


async def main() -> int:
    """Запускает бота и держит его до остановки."""
    configure_logging()
    log.info("Запуск бота", env=settings.ENV, proxy=settings.proxy_url_normalized)
    for note in settings.warnings():
        log.warning("Замечание к настройкам", text=note)

    if not await wait_for_database(timeout_seconds=60):
        log.error("База данных недоступна — бот не сможет создавать пользователей")
        return 1

    if not await redis_ping():
        log.warning("Redis недоступен — уведомления из очереди работать не будут")

    try:
        bot = create_bot()
    except ProxyConfigurationError as error:
        log.error("Бот не настроен", error=str(error))
        return 1

    connection = await check_connection(bot)
    if not connection.get("ok"):
        log.error("Нет связи с Telegram через прокси — выхожу, чтобы Docker перезапустил позже")
        await bot.session.close()
        return 1

    dispatcher = Dispatcher(storage=MemoryStorage())
    register(dispatcher)
    await setup_bot_ui(bot)

    stop_event = asyncio.Event()
    install_signal_handlers(stop_event)

    background = [
        asyncio.create_task(run_consumer(bot, stop_event), name="notifications"),
        asyncio.create_task(watch_payments(bot, stop_event), name="payments"),
    ]
    polling = asyncio.create_task(
        dispatcher.start_polling(
            bot,
            handle_signals=False,
            close_bot_session=False,
            allowed_updates=dispatcher.resolve_used_update_types(),
        ),
        name="polling",
    )

    log.info("Бот работает и ждёт сообщения")
    try:
        await stop_event.wait()
    finally:
        log.info("Останавливаюсь…")
        await dispatcher.stop_polling()
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        polling.cancel()
        await asyncio.gather(polling, return_exceptions=True)
        await bot.session.close()
        await close_client()
        await dispose()
        log.info("Бот остановлен")

    return 0


def run() -> None:
    """Синхронная обёртка для запуска из Docker и скриптов."""
    try:
        exit_code = asyncio.run(main())
    except KeyboardInterrupt:  # pragma: no cover — ручная остановка
        exit_code = 0
    sys.exit(exit_code)


if __name__ == "__main__":
    run()
