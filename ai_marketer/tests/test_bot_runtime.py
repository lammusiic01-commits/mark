"""Проверки устойчивости бота: цикл уведомлений и защита от шторма запросов.

Отдельный файл, потому что это не про разметку и не про API, а про поведение
фоновых задач бота: недоступный Redis не должен превращаться в поток
повторных запросов и спам в лог.
"""

from __future__ import annotations

import asyncio

import pytest

from bot import notifications as notifications_module
from core import redis_client


@pytest.mark.asyncio
async def test_consumer_waits_when_redis_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """Redis лежит → повторы идут с паузой, а не сплошным потоком."""
    calls = 0

    async def fake_take(timeout_seconds: int = 5):  # noqa: ARG001 — сигнатура как у настоящей
        nonlocal calls
        calls += 1
        return None, False

    monkeypatch.setattr(notifications_module, "take_notification", fake_take)
    stop_event = asyncio.Event()
    task = asyncio.create_task(notifications_module.run_consumer(None, stop_event, poll_timeout=1))  # type: ignore[arg-type]

    await asyncio.sleep(0.4)
    stop_event.set()
    await asyncio.wait_for(task, timeout=2)

    # За 0,4 секунды допустим ровно один заход: следующий — не раньше секунды
    assert calls == 1, f"цикл не выдерживает паузу: {calls} запросов за 0,4 с"


@pytest.mark.asyncio
async def test_consumer_returns_to_fast_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Redis ответил — цикл сразу возвращается к обычной работе."""
    answers = [(None, False)] + [(None, True)] * 5

    async def fake_take(timeout_seconds: int = 5):  # noqa: ARG001
        return answers.pop(0) if answers else (None, True)

    monkeypatch.setattr(notifications_module, "take_notification", fake_take)
    stop_event = asyncio.Event()
    task = asyncio.create_task(notifications_module.run_consumer(None, stop_event, poll_timeout=0))  # type: ignore[arg-type]

    # Первый сбой — пауза в секунду; дальше цикл должен идти без задержек
    await asyncio.sleep(1.8)
    stop_event.set()
    await asyncio.wait_for(task, timeout=3)

    assert not answers, f"цикл не вернулся к обычному режиму, осталось заходов: {len(answers)}"


@pytest.mark.asyncio
async def test_take_notification_reports_unavailable_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без клиента Redis функция честно говорит, что очередь недоступна."""
    monkeypatch.setattr(redis_client, "get_client", lambda: None)
    payload, redis_ok = await redis_client.take_notification(timeout_seconds=1)
    assert payload is None
    assert redis_ok is False


@pytest.mark.asyncio
async def test_pop_notification_keeps_old_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """Старый вызов pop_notification продолжает отдавать только данные."""
    async def fake_take(timeout_seconds: int = 5):  # noqa: ARG001
        return {"tg_id": 1, "text": "привет"}, True

    monkeypatch.setattr(redis_client, "take_notification", fake_take)
    payload = await redis_client.pop_notification(timeout_seconds=1)
    assert payload == {"tg_id": 1, "text": "привет"}


@pytest.mark.asyncio
async def test_warning_is_throttled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Одинаковые предупреждения о Redis пишутся не чаще раза в минуту."""
    writes: list[tuple] = []

    class FakeLog:
        def warning(self, *args, **kwargs) -> None:
            writes.append((args, kwargs))

    monkeypatch.setattr(redis_client, "log", FakeLog())
    monkeypatch.setattr(redis_client, "_last_warn", {})
    for _ in range(50):
        redis_client._warn_throttled("pop", "Очередь недоступна", error="нет связи")
    assert len(writes) == 1, f"предупреждение повторилось {len(writes)} раз"


@pytest.mark.asyncio
async def test_bot_creates_schema_in_development(monkeypatch: pytest.MonkeyPatch) -> None:
    """В режиме разработки бот сам готовит схему — старт не зависит от миграций."""
    source = (__import__("pathlib").Path(__file__).resolve().parents[1] / "bot" / "main.py").read_text(
        encoding="utf-8",
    )
    assert 'if settings.ENV == "development"' in source
    assert "create_all" in source
