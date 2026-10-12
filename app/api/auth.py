"""
Валидация Telegram initData (HMAC-SHA256) по документации Telegram Mini Apps:
  secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
  hash       = HMAC_SHA256(key=secret_key, msg=data_check_string)
data_check_string = все пары key=value кроме hash, отсортированные по key, через \n.
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

MAX_AUTH_AGE_SEC = 24 * 60 * 60


class AuthError(Exception):
    pass


def validate_init_data(init_data: str, bot_token: str, max_age: int = MAX_AUTH_AGE_SEC,
                       now: int | None = None) -> dict:
    """Проверяет подпись и возраст initData. Возвращает dict пользователя Telegram."""
    if not init_data:
        raise AuthError("Нет initData")
    if not bot_token:
        raise AuthError("BOT_TOKEN не задан на сервере")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise AuthError("В initData нет hash")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        raise AuthError("Подпись initData неверна")

    try:
        auth_date = int(pairs.get("auth_date", "0"))
    except ValueError as e:
        raise AuthError("Некорректный auth_date") from e
    current = int(time.time()) if now is None else now
    if auth_date <= 0 or current - auth_date > max_age:
        raise AuthError("initData устарел, открой приложение заново")

    raw_user = pairs.get("user")
    if not raw_user:
        raise AuthError("В initData нет пользователя")
    try:
        user = json.loads(raw_user)
    except json.JSONDecodeError as e:
        raise AuthError("Некорректные данные пользователя") from e
    if not isinstance(user, dict) or "id" not in user:
        raise AuthError("Некорректные данные пользователя")
    return user
