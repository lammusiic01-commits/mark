"""Логирование: консоль + ротируемый файл logs/app.log."""
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"
_configured = False


def setup_logging(level: int = logging.INFO) -> None:
    global _configured
    if _configured:
        return
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")

    root = logging.getLogger()
    root.setLevel(level)

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)

    file_handler = RotatingFileHandler(
        LOG_DIR / "app.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)

    root.addHandler(console)
    root.addHandler(file_handler)

    for noisy in ("aiohttp.access", "aiogram.event", "sqlalchemy.engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True
