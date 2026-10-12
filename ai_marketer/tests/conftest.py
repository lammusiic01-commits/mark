"""Общая подготовка тестов.

Тесты не трогают боевую базу: используется отдельная схема/URL из переменной
TEST_DATABASE_URL, а секреты подставляются из окружения.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Минимальные значения, чтобы core.config смог загрузиться в тестах
os.environ.setdefault("BOT_TOKEN", "1234567890:TEST-TOKEN-TEST-TOKEN-TEST")
os.environ.setdefault("WEBAPP_URL", "https://example.org")
os.environ.setdefault("TELEGRAM_PROXY_URL", "https://tg-proxy.example.org")
os.environ.setdefault("OPENROUTER_API_KEY", "sk-or-v1-test")
os.environ.setdefault("DB_PASSWORD", "test-password")
os.environ.setdefault("ENCRYPTION_KEY", os.environ.get("TEST_ENCRYPTION_KEY", "uRb9lP8DLGYq1Xo3wQeZ0Jv0nHt2sK7cM5aF4dR6bT8="))
os.environ.setdefault("ENV", "development")


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"
