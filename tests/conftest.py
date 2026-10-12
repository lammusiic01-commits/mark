import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Изолированные настройки для тестов: не зависят от реального secrets.env и data.db.
# Переменные окружения имеют приоритет над secrets.env в pydantic-settings.
os.environ.setdefault("ENCRYPTION_KEY", "Yx1cQ0m3m0x1fVdQ6Y0p1o3t2c5b8wK7l9sA4dF2gH0=")
os.environ.setdefault("BOT_TOKEN", "123456:TEST_TOKEN")
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="aim-test-"), "test.db"))
os.environ.setdefault("DEV_MODE", "1")
os.environ.setdefault("ADMIN_TG_IDS", "")
os.environ.setdefault("SBP_MERCHANT_ID", "")
os.environ.setdefault("SBP_ACCOUNT", "")
