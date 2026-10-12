"""Шифрование чувствительных данных (Fernet / AES-128-CBC + HMAC-SHA256).

Токены Яндекс.Директ и Метрики, cookie-сессии и пароли приложений в базе
хранятся только в зашифрованном виде. Ключ — единственная строка
ENCRYPTION_KEY в secrets.env.

Важно: ключ нельзя терять. Если он изменится, ранее сохранённые токены
расшифровать нельзя — пользователю придётся подключить сервис заново.
"""

from __future__ import annotations

import base64
import json
import os
import secrets as py_secrets
from typing import Any, TypeVar

from cryptography.fernet import Fernet, InvalidToken

from core.config import settings

T = TypeVar("T")

MASK_PREFIX = "enc:v1:"


def generate_key() -> str:
    """Генерирует ключ Fernet стандартными средствами Python (без зависимостей).

    Эквивалент cryptography.fernet.Fernet.generate_key(): 32 случайных байта
    в base64url. Такой ключ можно создать даже там, где библиотека ещё не
    установлена — например в start.bat до сборки контейнеров.
    """
    return base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")


def mask_secret(value: str | None, keep: int = 4) -> str:
    """Показывает только начало секрета: нужно для интерфейса и логов."""
    if not value:
        return ""
    value = value.strip()
    if len(value) <= keep:
        return "•" * len(value)
    return f"{value[:keep]}{'•' * min(12, len(value) - keep)}"


class SecretBox:
    """Обёртка над Fernet: строки и JSON-объекты.

    Пример:
        box = SecretBox()
        stored = box.encrypt("y0_AgAAAAB...")     # кладём в БД
        token = box.decrypt(stored)                # достаём
    """

    def __init__(self, key: str | None = None) -> None:
        key = (key or settings.ENCRYPTION_KEY or "").strip()
        if not key:
            raise ValueError("ENCRYPTION_KEY не задан — заполните secrets.env или запустите start.bat / start.sh")
        try:
            self._fernet = Fernet(key.encode("ascii"))
        except (ValueError, TypeError) as error:
            raise ValueError(
                "ENCRYPTION_KEY не подходит для Fernet: нужен ключ из 44 символов base64. "
                'Сгенерируйте новый: python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"',
            ) from error

    # ─── Строки ────────────────────────────────────────────────

    def encrypt(self, value: str) -> str:
        """Шифрует строку и добавляет версию формата — пригодится для миграций."""
        if value is None:
            raise ValueError("Нечего шифровать: передано None")
        token = self._fernet.encrypt(value.encode("utf-8")).decode("ascii")
        return f"{MASK_PREFIX}{token}"

    def decrypt(self, token: str | None) -> str:
        """Расшифровывает строку. Понимает и старый формат без префикса."""
        if not token:
            raise ValueError("Пустое значение нельзя расшифровать")
        raw = token[len(MASK_PREFIX) :] if token.startswith(MASK_PREFIX) else token
        try:
            return self._fernet.decrypt(raw.encode("ascii")).decode("utf-8")
        except InvalidToken as error:
            raise ValueError(
                "Не удалось расшифровать данные: ENCRYPTION_KEY не совпадает с тем, которым их шифровали. "
                "Верните прежний ключ из резервной копии secrets.env.",
            ) from error

    def try_decrypt(self, token: str | None, default: str | None = None) -> str | None:
        """Мягкий вариант: не падает, если ключ сменился."""
        try:
            return self.decrypt(token)
        except ValueError:
            return default

    # ─── JSON ──────────────────────────────────────────────────

    def encrypt_json(self, payload: dict[str, Any] | list[Any]) -> str:
        return self.encrypt(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def decrypt_json(self, token: str | None, default: T | None = None) -> T | dict[str, Any] | None:
        if not token:
            return default
        try:
            return json.loads(self.decrypt(token))
        except (ValueError, json.JSONDecodeError):
            return default

    # ─── Служебное ─────────────────────────────────────────────

    @staticmethod
    def random_token(length: int = 32) -> str:
        """Криптостойкая случайная строка — для state в OAuth и вебхуков."""
        return py_secrets.token_urlsafe(length)[:length]

    def key_fingerprint(self) -> str:
        """Короткий отпечаток ключа: можно писать в логи, секрет не раскрывает."""
        import hashlib

        digest = hashlib.sha256(str(settings.ENCRYPTION_KEY).encode("utf-8")).hexdigest()
        return digest[:12]


_BOX: SecretBox | None = None


def get_secret_box() -> SecretBox:
    """Единственный экземпляр шифровальщика на процесс."""
    global _BOX
    if _BOX is None:
        _BOX = SecretBox()
    return _BOX
