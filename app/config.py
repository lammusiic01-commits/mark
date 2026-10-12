"""
Настройки приложения.

Источники (по приоритету):
  1. Переменные окружения (WEBAPP_URL выставляет start.bat)
  2. secrets.env в корне проекта
  3. Значения по умолчанию ниже

HTTPS-адрес Mini App не хранится в secrets.env: он приходит из Cloudflare Tunnel
и записывается start.bat в tunnel.url.
"""
import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
TUNNEL_URL_FILE = ROOT / "tunnel.url"


def _read_tunnel_url() -> str:
    """HTTPS URL из tunnel.url. Пустая строка, если файла нет или адрес не HTTPS."""
    if not TUNNEL_URL_FILE.exists():
        return ""
    url = TUNNEL_URL_FILE.read_text(encoding="utf-8").strip()
    return url if url.startswith("https://") else ""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / "secrets.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Telegram
    BOT_TOKEN: str = ""
    # Cloudflare Worker, форвардит запросы к api.telegram.org (обязательно для РФ)
    TELEGRAM_PROXY_URL: str = "https://tg-proxy.lammusiic01.workers.dev"
    # Через запятую: Telegram ID администраторов (подтверждение оплат)
    ADMIN_TG_IDS: str = ""

    # AI (OpenRouter)
    OPENROUTER_API_KEY: str = ""
    AI_MODEL: str = "google/gemini-2.0-flash-exp:free"
    # Стоимость одного AI-совета, если используется общий ключ сервиса (копейки)
    AI_CHARGE_KOP: int = 300

    # Security
    ENCRYPTION_KEY: str = ""

    # Payments (СБП / перевод по QR ST00012)
    SBP_MERCHANT_ID: str = ""  # ФИО или название получателя
    SBP_ACCOUNT: str = ""      # расчётный счёт получателя (20 цифр)
    SBP_BIC: str = ""          # БИК банка получателя (необязательно)
    MIN_TOPUP_RUB: int = 100

    # Server (локальный порт; Cloudflare Tunnel смотрит на него)
    PORT: int = 8000

    # Только для разработки в браузере без Telegram: пропускает проверку initData
    DEV_MODE: bool = False

    # Путь к SQLite-файлу; пусто = data.db в корне. Удобно для тестов.
    DB_PATH: str = ""

    # Фоновый мониторинг сайтов пользователей, секунды
    MONITOR_INTERVAL_SEC: int = 900

    @property
    def WEBAPP_URL(self) -> str:
        """HTTPS URL Mini App: переменная WEBAPP_URL (если HTTPS), иначе tunnel.url."""
        env_url = os.environ.get("WEBAPP_URL", "").strip()
        if env_url.startswith("https://"):
            return env_url
        return _read_tunnel_url()

    @property
    def admin_ids(self) -> set[int]:
        out: set[int] = set()
        for part in self.ADMIN_TG_IDS.split(","):
            part = part.strip()
            if part.isdigit():
                out.add(int(part))
        return out

    @property
    def DATABASE_URL(self) -> str:
        path = Path(self.DB_PATH) if self.DB_PATH else ROOT / "data.db"
        return f"sqlite+aiosqlite:///{path.as_posix()}"


settings = Settings()
