from unittest.mock import AsyncMock, MagicMock

import pytest
from aiogram.types import InlineKeyboardMarkup

from app.bot import handlers
from app.config import settings
from app.bot.proxy_session import build_proxy_session


def _message():
    msg = MagicMock()
    msg.answer = AsyncMock()
    return msg


@pytest.mark.asyncio
async def test_start_sends_web_app_button_with_https_url(monkeypatch):
    monkeypatch.setenv("WEBAPP_URL", "https://abc-test.trycloudflare.com")
    msg = _message()
    await handlers.cmd_start(msg)
    kwargs = msg.answer.await_args.kwargs
    markup: InlineKeyboardMarkup = kwargs["reply_markup"]
    button = markup.inline_keyboard[0][0]
    assert button.web_app is not None
    assert button.web_app.url == "https://abc-test.trycloudflare.com"


@pytest.mark.asyncio
async def test_start_without_tunnel_does_not_send_broken_button(monkeypatch):
    monkeypatch.delenv("WEBAPP_URL", raising=False)
    monkeypatch.setattr(settings.__class__, "WEBAPP_URL", property(lambda self: ""))
    msg = _message()
    await handlers.cmd_start(msg)
    kwargs = msg.answer.await_args.kwargs
    assert "reply_markup" not in kwargs
    assert "HTTPS" in msg.answer.await_args.args[0]


def test_proxy_session_builds_worker_urls(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "https://tg-proxy.example.workers.dev/")
    session = build_proxy_session()
    assert session.api.api_url("1:AA", "getMe") == "https://tg-proxy.example.workers.dev/bot1:AA/getMe"


def test_proxy_session_refuses_empty_or_http(monkeypatch):
    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "")
    with pytest.raises(RuntimeError):
        build_proxy_session()
    monkeypatch.setattr(settings, "TELEGRAM_PROXY_URL", "http://insecure.example")
    with pytest.raises(RuntimeError):
        build_proxy_session()
