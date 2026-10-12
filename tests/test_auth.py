import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from app.api.auth import AuthError, validate_init_data

BOT_TOKEN = "123456:TEST_TOKEN"


def make_init_data(bot_token: str, user: dict, auth_date: int | None = None, tamper: bool = False) -> str:
    fields = {
        "auth_date": str(auth_date or int(time.time())),
        "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
        "user": json.dumps(user, separators=(",", ":")),
    }
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if tamper:
        fields["user"] = json.dumps({"id": 999})
    return urlencode({**fields, "hash": digest})


USER = {"id": 42, "first_name": "Ivan", "username": "ivan"}


def test_valid_init_data_returns_user():
    data = make_init_data(BOT_TOKEN, USER)
    assert validate_init_data(data, BOT_TOKEN)["id"] == 42


def test_wrong_token_rejected():
    data = make_init_data(BOT_TOKEN, USER)
    with pytest.raises(AuthError, match="Подпись"):
        validate_init_data(data, "999:OTHER")


def test_tampered_payload_rejected():
    data = make_init_data(BOT_TOKEN, USER, tamper=True)
    with pytest.raises(AuthError, match="Подпись"):
        validate_init_data(data, BOT_TOKEN)


def test_expired_init_data_rejected():
    old = int(time.time()) - 2 * 24 * 3600
    data = make_init_data(BOT_TOKEN, USER, auth_date=old)
    with pytest.raises(AuthError, match="устарел"):
        validate_init_data(data, BOT_TOKEN)


def test_missing_hash_and_empty_inputs():
    with pytest.raises(AuthError):
        validate_init_data("auth_date=1&user=%7B%7D", BOT_TOKEN)
    with pytest.raises(AuthError):
        validate_init_data("", BOT_TOKEN)
    with pytest.raises(AuthError, match="BOT_TOKEN"):
        validate_init_data(make_init_data(BOT_TOKEN, USER), "")
