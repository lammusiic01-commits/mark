"""Шифрование секретов пользователя (Fernet, ключ ENCRYPTION_KEY из secrets.env)."""
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class SecretError(Exception):
    pass


def _fernet() -> Fernet:
    if not settings.ENCRYPTION_KEY:
        raise SecretError("ENCRYPTION_KEY не задан в secrets.env. Запусти start.bat.")
    try:
        return Fernet(settings.ENCRYPTION_KEY.encode())
    except ValueError as e:
        raise SecretError("ENCRYPTION_KEY некорректен") from e


def encrypt_text(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_text(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise SecretError("Не удалось расшифровать секрет: ENCRYPTION_KEY изменился") from e


def mask_secret(value: str | None) -> str:
    if not value:
        return ""
    return "••••" + value[-4:] if len(value) > 4 else "••••"
