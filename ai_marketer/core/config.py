"""Чтение единственного файла секретов — secrets.env.

Все ключи, токены и пароли живут только здесь. В коде, документации и
docker-compose.yml секретов нет: контейнеры получают их через env_file.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Корень проекта: .../ai_marketer
ROOT = Path(__file__).resolve().parent.parent
SECRETS_FILE = ROOT / "secrets.env"
EXAMPLE_FILE = ROOT / "secrets.env.example"

# Переменные, без которых проект не поднимется — используем в понятной ошибке
REQUIRED_VARS = ("BOT_TOKEN", "WEBAPP_URL", "TELEGRAM_PROXY_URL", "OPENROUTER_API_KEY", "DB_PASSWORD", "ENCRYPTION_KEY")

PLACEHOLDER_MARKERS = ("change_me", "xxxxxxxx", "AAAAAAAA", "your-domain")


class SettingsError(RuntimeError):
    """Понятная человеку ошибка конфигурации вместо трейсбека pydantic."""


class Settings(BaseSettings):
    """Настройки проекта. Значения берутся из secrets.env и переменных окружения.

    Переменные окружения имеют приоритет над файлом — это позволяет запускать
    контейнеры с переопределением, не редактируя secrets.env.
    """

    model_config = SettingsConfigDict(
        env_file=SECRETS_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # ─── Telegram ──────────────────────────────────────────────
    BOT_TOKEN: str
    WEBAPP_URL: str
    TELEGRAM_PROXY_URL: str

    # ─── OpenRouter ────────────────────────────────────────────
    OPENROUTER_API_KEY: str
    AI_MODEL: str = "meta-llama/llama-3.3-70b-instruct:free"

    # ─── База данных ───────────────────────────────────────────
    DB_HOST: str = "postgres"
    DB_PORT: int = 5432
    DB_NAME: str = "ai_marketer"
    DB_USER: str = "marketer"
    DB_PASSWORD: str

    # ─── Redis ─────────────────────────────────────────────────
    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0

    # ─── Шифрование ────────────────────────────────────────────
    ENCRYPTION_KEY: str

    # ─── СБП ───────────────────────────────────────────────────
    SBP_MERCHANT_ID: str = ""
    SBP_ACCOUNT: str = ""
    SBP_SECRET_KEY: str = ""

    # ─── Порты ─────────────────────────────────────────────────
    API_PORT: int = 8000
    WEBAPP_PORT: int = 3000

    # ─── Режим работы ──────────────────────────────────────────
    ENV: Literal["development", "production"] = "production"
    LOG_LEVEL: str = Field(default="INFO")

    # Необязательное поле: строка подключения целиком (DATABASE_URL).
    # Нужна там, где хостинг выдаёт одну строку вместо набора DB_*; в
    # остальных случаях части соединяются из DB_HOST/DB_PORT/DB_NAME/DB_USER.
    DATABASE_URL_OVERRIDE: str = Field(default="", alias="DATABASE_URL")

    # ─── Поля, вычисляемые из секретов ─────────────────────────

    @property
    def DATABASE_URL(self) -> str:
        """Строка подключения для SQLAlchemy async.

        Если задан DATABASE_URL (как это делают некоторые хостинги), берём его
        целиком: так можно подключить и PostgreSQL от хостинга, и SQLite на
        время локальной проверки.
        """
        override = (self.DATABASE_URL_OVERRIDE or "").strip()
        if override:
            return override
        return (
            f"postgresql+asyncpg://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    @property
    def SYNC_DATABASE_URL(self) -> str:
        """Синхронный вариант — нужен инструментам вроде alembic --sql."""
        return (
            f"postgresql+psycopg://{self.DB_USER}:{self.DB_PASSWORD}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )

    @property
    def REDIS_URL(self) -> str:
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    @property
    def is_production(self) -> bool:
        return self.ENV == "production"

    @property
    def webapp_url_https(self) -> bool:
        return self.WEBAPP_URL.lower().startswith("https://")

    @property
    def proxy_url_normalized(self) -> str:
        """Адрес прокси без хвостового слэша — так его склеивает aiogram."""
        return self.TELEGRAM_PROXY_URL.rstrip("/")

    @property
    def sbp_enabled(self) -> bool:
        return bool(self.SBP_MERCHANT_ID and self.SBP_ACCOUNT)

    # ─── Проверки ──────────────────────────────────────────────

    @field_validator("WEBAPP_URL", "TELEGRAM_PROXY_URL")
    @classmethod
    def _check_url(cls, value: str) -> str:
        value = value.strip()
        if not value.startswith(("http://", "https://")):
            raise ValueError("должен начинаться с http:// или https://")
        return value.rstrip("/")

    @field_validator("BOT_TOKEN")
    @classmethod
    def _check_bot_token(cls, value: str) -> str:
        value = value.strip()
        if ":" not in value or len(value) < 20:
            raise ValueError("похоже, это не токен бота (ожидается вид 1234567890:AA...)")
        return value

    @field_validator("ENCRYPTION_KEY")
    @classmethod
    def _check_encryption_key(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("пустой ключ шифрования — запустите start.bat или start.sh, он создаст ключ автоматически")
        if len(value) != 44:
            raise ValueError("ключ Fernet — это 44 символа base64; сгенерируйте новый (start.bat / start.sh)")
        return value

    @field_validator("LOG_LEVEL")
    @classmethod
    def _check_log_level(cls, value: str) -> str:
        level = value.strip().upper()
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if level not in allowed:
            raise ValueError(f"LOG_LEVEL должен быть одним из {', '.join(sorted(allowed))}")
        return level

    # ─── Диагностика ───────────────────────────────────────────

    def warnings(self) -> list[str]:
        """Некритичные замечания, которые полезно показать при старте."""
        notes: list[str] = []
        if not self.webapp_url_https:
            notes.append(
                "WEBAPP_URL без HTTPS: Telegram откроет приложение только по защищённому адресу "
                "(локально используйте ngrok или cloudflared)",
            )
        for name in ("BOT_TOKEN", "DB_PASSWORD", "ENCRYPTION_KEY"):
            value = str(getattr(self, name, "") or "")
            if any(marker.lower() in value.lower() for marker in PLACEHOLDER_MARKERS):
                notes.append(f"{name} выглядит как значение из примера — замените его на своё")
        if not self.sbp_enabled:
            notes.append("СБП не настроен: приём платежей будет в тестовом режиме")
        return notes

    def missing_vars(self) -> list[str]:
        """Переменные, которые не заданы в secrets.env (для подсказки в start-скриптах)."""
        text = SECRETS_FILE.read_text(encoding="utf-8") if SECRETS_FILE.exists() else ""
        missing: list[str] = []
        for name in REQUIRED_VARS:
            pattern = f"{name}="
            line = next((row for row in text.splitlines() if row.strip().startswith(pattern)), "")
            if not line or not line.split("=", 1)[1].strip():
                missing.append(name)
        return missing


def _load_settings() -> Settings:
    """Загружает настройки и превращает ошибки pydantic в понятный текст."""
    if not SECRETS_FILE.exists() and not os.environ.get("BOT_TOKEN"):
        raise SettingsError(
            f"Не найден файл секретов {SECRETS_FILE.name}.\n"
            f"Скопируйте {EXAMPLE_FILE.name} в {SECRETS_FILE.name} и заполните значения "
            "(или просто запустите start.bat / start.sh — он сделает это сам).",
        )
    try:
        return Settings()  # type: ignore[call-arg]
    except Exception as error:  # pydantic ValidationError и производные
        raise SettingsError(
            "Не получилось прочитать secrets.env.\n"
            f"Проверьте переменные: {', '.join(REQUIRED_VARS)}.\n"
            f"Подробности: {error}",
        ) from error


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Настройки загружаются один раз на процесс."""
    return _load_settings()


# Совместимый с ТЗ короткий импорт: from core.config import settings
settings = get_settings()
