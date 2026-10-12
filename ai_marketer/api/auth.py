"""Проверка Telegram initData — вход в Mini App без пароля.

Telegram передаёт приложению строку initData и подпись к ней. Мы обязаны
проверить подпись сами: без этого любой желающий мог бы назваться чужим
пользователем и увидеть чужие кампании и деньги.

Как проверяется подпись (алгоритм Telegram WebApp):
  1. берём BOT_TOKEN как ключ и строку "WebAppData" как данные — HMAC-SHA256,
     получаем secret_key;
  2. из initData собираем строку «ключ=значение» по алфавиту, без поля hash,
     склеиваем через перевод строки;
  3. HMAC-SHA256(secret_key, эта строка) должен совпасть с полем hash.

Сравнение — только hmac.compare_digest (защита от подбора по времени ответа).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

# Сколько живёт подпись: сутки — разумный компромисс между безопасностью и
# тем, что приложение может быть открыто со вчерашнего дня
MAX_AUTH_AGE_SECONDS = 24 * 60 * 60

# Допустимое опережение часов (клиент может быть впереди сервера)
CLOCK_SKEW_SECONDS = 60

INIT_DATA_HEADER = "X-Telegram-Init-Data"


class AuthError(RuntimeError):
    """Подпись не прошла проверку: доступ к API закрыт."""

    def __init__(self, message: str, *, code: int = 401) -> None:
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class TelegramUser:
    """Пользователь из initData — минимально нужный набор полей."""

    id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    language_code: str | None = None
    photo_url: str | None = None
    is_premium: bool = False

    @property
    def display_name(self) -> str:
        if self.first_name:
            return self.first_name
        if self.username:
            return f"@{self.username}"
        return "друг"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "language_code": self.language_code,
            "photo_url": self.photo_url,
            "is_premium": self.is_premium,
        }


def secret_key(bot_token: str) -> bytes:
    """Ключ подписи: HMAC-SHA256(ключ="WebAppData", данные=токен бота)."""
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def data_check_string(pairs: list[tuple[str, str]]) -> str:
    """Строка для подписи: только пары ключ=значение, отсортированные по ключу."""
    filtered = sorted((key, value) for key, value in pairs if key != "hash")
    return "\n".join(f"{key}={value}" for key, value in filtered)


def sign_init_data(user: dict[str, Any], bot_token: str, *, auth_date: int | None = None) -> str:
    """Собирает подписанный initData.

    Нужно для тестов, CLI-проверок и отладки: в продакшене строку формирует
    сам Telegram на клиенте.
    """
    pairs: list[tuple[str, str]] = [
        ("auth_date", str(auth_date or int(time.time()))),
        ("query_id", "AAAtest-query-id"),
        ("user", json.dumps(user, ensure_ascii=False, separators=(",", ":"))),
    ]
    signature = hmac.new(secret_key(bot_token), data_check_string(pairs).encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode([*pairs, ("hash", signature)])


def verify_init_data(
    init_data: str,
    *,
    bot_token: str | None = None,
    max_age_seconds: int = MAX_AUTH_AGE_SECONDS,
    check_age: bool = True,
) -> TelegramUser:
    """Проверяет подпись initData и возвращает пользователя.

    Бросает AuthError с понятным текстом — его увидит клиент, а в лог попадёт
    причина без самих данных подписи.
    """
    token = (bot_token or settings.BOT_TOKEN or "").strip()
    if not token:
        raise AuthError("BOT_TOKEN не задан — проверка входа невозможна", code=500)

    raw = (init_data or "").strip()
    if not raw:
        raise AuthError("Нет данных авторизации Telegram")

    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=False)
    except ValueError as error:
        raise AuthError(f"Данные авторизации повреждены: {error}") from error

    given_hash = next((value for key, value in pairs if key == "hash"), "")
    if not given_hash:
        raise AuthError("В данных авторизации нет подписи")

    expected = hmac.new(secret_key(token), data_check_string(pairs).encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, given_hash):
        log.warning("Отклонён вход: подпись Telegram не совпала")
        raise AuthError("Подпись Telegram не совпала — откройте приложение заново из бота")

    fields = {key: value for key, value in pairs}

    if check_age:
        try:
            auth_date = int(fields.get("auth_date", "0"))
        except ValueError:
            raise AuthError("Некорректная дата авторизации") from None
        age = time.time() - auth_date
        if age > max_age_seconds:
            raise AuthError("Сессия устарела — откройте приложение заново из бота")
        if age < -CLOCK_SKEW_SECONDS:
            raise AuthError("Дата авторизации из будущего — проверьте часы на устройстве")

    raw_user = fields.get("user") or ""
    if not raw_user:
        raise AuthError("В данных авторизации нет пользователя")
    try:
        payload = json.loads(raw_user)
    except json.JSONDecodeError as error:
        raise AuthError(f"Не удалось прочитать пользователя: {error}") from error

    user_id = payload.get("id")
    if not isinstance(user_id, int):
        raise AuthError("В данных авторизации нет идентификатора пользователя")

    return TelegramUser(
        id=int(user_id),
        username=payload.get("username"),
        first_name=payload.get("first_name"),
        last_name=payload.get("last_name"),
        language_code=payload.get("language_code"),
        photo_url=payload.get("photo_url"),
        is_premium=bool(payload.get("is_premium") or False),
    )


def init_data_from_headers(headers: Any, bot_token: str | None = None) -> TelegramUser:
    """Достаёт initData из заголовков запроса и проверяет её.

    Работает и с «X-Telegram-Init-Data», и с Authorization: tma <initData> —
    вторую форму иногда используют клиенты.
    """
    raw = ""
    if headers is not None:
        raw = str(headers.get(INIT_DATA_HEADER) or headers.get(INIT_DATA_HEADER.lower()) or "")
        if not raw:
            authorization = str(headers.get("Authorization") or headers.get("authorization") or "")
            if authorization.lower().startswith("tma "):
                raw = authorization[4:]
    return verify_init_data(raw, bot_token=bot_token)


def mask_init_data(init_data: str, keep: int = 12) -> str:
    """Короткая безопасная версия строки авторизации — только для логов."""
    text = (init_data or "").strip()
    if len(text) <= keep:
        return "…"
    return f"{text[:keep]}…({len(text)} симв.)"


__all__ = [
    "CLOCK_SKEW_SECONDS",
    "INIT_DATA_HEADER",
    "MAX_AUTH_AGE_SECONDS",
    "AuthError",
    "TelegramUser",
    "data_check_string",
    "init_data_from_headers",
    "mask_init_data",
    "secret_key",
    "sign_init_data",
    "verify_init_data",
]
