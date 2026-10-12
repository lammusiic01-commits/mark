"""Заглушка Telegram Bot API для проверки бота без реального токена.

Отвечает на те методы, которые вызывает aiogram при запуске и при команде
/start: getMe, getUpdates, sendMessage, setMyCommands, deleteWebhook.
Бот общается с Telegram через прокси из secrets.env — сюда мы этот адрес и
направим, поэтому проверка идёт ровно тем же путём, что и в бою.

Запуск: python3 tools/fake_telegram.py [порт]
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any

import asyncio

from fastapi import FastAPI, Request

app = FastAPI(title="Заглушка Telegram Bot API", docs_url=None, redoc_url=None)

BOT_ID = 7654321
BOT_NAME = "ai_marketer_check_bot"

# Что бот уже успел сделать — по этому журналу проверяется поведение
LOG: dict[str, Any] = {"calls": [], "messages": [], "commands": [], "updates": 0}


@app.api_route("/", methods=["GET", "POST"])
def root() -> dict[str, Any]:
    return {"ok": True, "service": "заглушка Bot API", "calls": len(LOG["calls"])}


@app.api_route("/log", methods=["GET", "POST"])
def log() -> dict[str, Any]:
    """Журнал вызовов: его читает проверка."""
    return LOG


@app.api_route("/bot{token}/getMe", methods=["GET", "POST"])
def get_me(token: str) -> dict[str, Any]:
    LOG["calls"].append("getMe")
    return {
        "ok": True,
        "result": {
            "id": BOT_ID,
            "is_bot": True,
            "first_name": "AI Маркетолог",
            "username": BOT_NAME,
            "can_join_groups": True,
            "can_read_all_group_messages": False,
            "supports_inline_queries": False,
        },
    }


@app.post("/bot{token}/getUpdates")
async def get_updates(token: str, request: Request) -> dict[str, Any]:
    body = await _body(request)
    LOG["calls"].append("getUpdates")
    # Первый опрос отдаёт /start, дальше — пустой список: бот отвечает и ждёт
    if LOG["updates"] == 0:
        LOG["updates"] = 1
        return {
            "ok": True,
            "result": [
                {
                    "update_id": 1001,
                    "message": {
                        "message_id": 1,
                        "date": int(datetime.now(timezone.utc).timestamp()),
                        "chat": {"id": 1, "type": "private"},
                        "from": {
                            "id": 1,
                            "is_bot": False,
                            "first_name": "Игорь",
                            "username": "igor",
                            "language_code": "ru",
                        },
                        "text": "/start",
                        "entities": [{"type": "bot_command", "offset": 0, "length": 6}],
                    },
                },
            ],
            "offset": body.get("offset"),
        }
    # Настоящий Telegram держит long polling и отвечает не сразу: без этой
    # паузы бот слал бы десятки тысяч запросов в секунду.
    await asyncio.sleep(1.0)
    return {"ok": True, "result": []}


@app.post("/bot{token}/sendMessage")
async def send_message(token: str, request: Request) -> dict[str, Any]:
    body = await _body(request)
    LOG["calls"].append("sendMessage")
    LOG["messages"].append(body)
    return {
        "ok": True,
        "result": {
            "message_id": 100 + len(LOG["messages"]),
            "date": int(datetime.now(timezone.utc).timestamp()),
            "chat": {"id": body.get("chat_id"), "type": "private"},
            "text": body.get("text", ""),
        },
    }


@app.post("/bot{token}/setMyCommands")
async def set_my_commands(token: str, request: Request) -> dict[str, Any]:
    body = await _body(request)
    LOG["calls"].append("setMyCommands")
    LOG["commands"] = body.get("commands") or []
    return {"ok": True, "result": True}


@app.post("/bot{token}/{method}")
async def other(token: str, method: str, request: Request) -> dict[str, Any]:
    """Всё остальное (deleteWebhook, answerCallbackQuery и т.п.) — успешно."""
    LOG["calls"].append(method)
    return {"ok": True, "result": True}


@app.api_route("/bot{token}/getWebhookInfo", methods=["GET", "POST"])
def webhook_info(token: str) -> dict[str, Any]:
    LOG["calls"].append("getWebhookInfo")
    return {"ok": True, "result": {"url": "", "has_custom_certificate": False, "pending_update_count": 0}}


async def _body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001 — тело может прийти формой
        form = await request.form()
        data = dict(form)
    return data if isinstance(data, dict) else {}


if __name__ == "__main__":
    import uvicorn

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    print(f"Заглушка Bot API: http://127.0.0.1:{port}  (журнал: /log, json={json.dumps(LOG)})")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
