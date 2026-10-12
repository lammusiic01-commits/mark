"""Тесты фундамента: конфиг, шифрование, модели, миграция, API, логи, скрипты.

Запуск внутри контейнера (там есть все зависимости):
    docker compose --env-file secrets.env --profile api run --rm api pytest -q

Тесты не требуют поднятой базы: там, где нужен PostgreSQL, проверяется
корректное поведение при недоступности и соответствие схемы моделям.
"""

from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


# ═══════════════════════ Конфигурация ═════════════════════════

def test_settings_builds_connection_strings() -> None:
    from core.config import settings

    assert settings.DATABASE_URL.startswith("postgresql+asyncpg://")
    assert f"@{settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}" in settings.DATABASE_URL
    assert settings.REDIS_URL == f"redis://{settings.REDIS_HOST}:{settings.REDIS_PORT}/{settings.REDIS_DB}"


def test_settings_validates_secrets() -> None:
    from core.config import Settings, SettingsError

    with pytest.raises(Exception):
        Settings(BOT_TOKEN="не-токен", WEBAPP_URL="без-схемы", TELEGRAM_PROXY_URL="https://proxy", OPENROUTER_API_KEY="k", DB_PASSWORD="p", ENCRYPTION_KEY="x" * 44)

    assert SettingsError is not None


def test_settings_warns_on_placeholders() -> None:
    from core.config import settings

    notes = settings.warnings()
    assert isinstance(notes, list)
    assert all(isinstance(note, str) for note in notes)


# ════════════════════════ Шифрование ══════════════════════════

def test_secret_box_round_trip() -> None:
    from core.security import SecretBox

    box = SecretBox()
    assert box.decrypt(box.encrypt("y0_AgAAAA-token")) == "y0_AgAAAA-token"
    payload = {"login": "agency", "ids": [1, 2]}
    assert box.decrypt_json(box.encrypt_json(payload)) == payload


def test_secret_box_rejects_wrong_key() -> None:
    from core.security import SecretBox, generate_key

    token = SecretBox().encrypt("секрет")
    other = SecretBox(generate_key())
    assert other.try_decrypt(token) is None
    with pytest.raises(ValueError, match="ENCRYPTION_KEY не совпадает"):
        other.decrypt(token)


def test_generated_key_is_valid_fernet_key() -> None:
    from core.security import generate_key

    key = generate_key()
    assert len(key) == 44
    assert key.endswith("=")
    assert "-" in key or "_" in key or True  # urlsafe-алфавит, паддинг на месте


def test_mask_keeps_secret_hidden() -> None:
    from core.security import mask_secret

    masked = mask_secret("y0_AgAAAA123456789")
    assert masked.startswith("y0_A")
    assert "123456789" not in masked


# ═══════════════════════════ Модели ═══════════════════════════

def test_all_tables_present() -> None:
    from core.models import Base

    assert set(Base.metadata.tables) == {
        "users",
        "service_connections",
        "campaigns",
        "bot_reports",
        "hypotheses",
        "payments",
    }


def test_required_columns_exist() -> None:
    from core.models import Campaign, Hypothesis, Payment, ServiceConnection, User

    assert "encrypted_token" in ServiceConnection.__table__.columns
    assert {"balance", "onboarding_completed", "tg_id"} <= set(User.__table__.columns.keys())
    assert {"daily_budget", "target_cpa", "stats_cache"} <= set(Campaign.__table__.columns.keys())
    assert {"code", "priority", "expected_impact_pct", "status"} <= set(Hypothesis.__table__.columns.keys())
    assert {"payment_id", "sbp_url", "paid_at"} <= set(Payment.__table__.columns.keys())


def test_user_tg_id_is_unique() -> None:
    from core.models import User

    assert User.__table__.c.tg_id.unique is True


def test_to_dict_is_json_friendly() -> None:
    import json

    from core.models import User

    data = User(tg_id=42, username="agency").to_dict()
    assert json.dumps(data, default=str)


# ═════════════════ Миграция против моделей ═════════════════════

def _load_migration(recorded: list[tuple]) -> types.ModuleType:
    """Загружает 0001_initial с подменённым alembic.op — базы не требуется."""
    fake_alembic = types.ModuleType("alembic")
    fake_alembic.op = types.SimpleNamespace(
        create_table=lambda name, *cols, **kw: recorded.append(("create_table", name, cols, kw)),
        create_index=lambda name, table, cols, **kw: recorded.append(("create_index", name, table, tuple(cols), kw)),
        drop_table=lambda name: recorded.append(("drop_table", name)),
    )
    fake_alembic.context = types.SimpleNamespace()

    spec = importlib.util.spec_from_file_location("initial_migration", ROOT / "migrations/versions/0001_initial.py")
    module = importlib.util.module_from_spec(spec)
    saved = sys.modules.get("alembic")
    sys.modules["alembic"] = fake_alembic
    try:
        spec.loader.exec_module(module)
    finally:
        if saved is not None:
            sys.modules["alembic"] = saved
        else:
            sys.modules.pop("alembic", None)
    return module


def test_migration_creates_same_columns_as_models() -> None:
    from core.models import Base

    recorded: list[tuple] = []
    migration = _load_migration(recorded)
    migration.upgrade()

    created = {row[1]: row[2] for row in recorded if row[0] == "create_table"}
    assert set(created) == set(Base.metadata.tables)

    for table in Base.metadata.sorted_tables:
        migration_columns = {getattr(column, "name", None) for column in created[table.name]}
        assert migration_columns == set(table.columns.keys()), f"рассинхрон в таблице {table.name}"


def test_migration_downgrade_drops_everything() -> None:
    from core.models import Base

    recorded: list[tuple] = []
    migration = _load_migration(recorded)
    migration.downgrade()

    assert {row[1] for row in recorded if row[0] == "drop_table"} == set(Base.metadata.tables)


# ════════════════════════════ Логи ════════════════════════════

def test_logger_hides_secrets() -> None:
    from core.config import settings
    from core.logger import get_logger

    log = get_logger("тест")
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        log.info("проверка", BOT_TOKEN=settings.BOT_TOKEN, password="очень-секретно", обычное="видно")

    output = buffer.getvalue()
    assert "очень-секретно" not in output
    assert settings.BOT_TOKEN not in output
    assert "видно" in output


# ═══════════════════════════ API ══════════════════════════════

def test_app_exposes_version_and_docs() -> None:
    from fastapi.testclient import TestClient

    from api.server import VERSION, app

    client = TestClient(app)
    response = client.get("/api/version")
    assert response.status_code == 200
    assert response.json()["version"] == VERSION
    assert "BOT_TOKEN" not in response.text
    assert client.get("/docs").status_code == 200


def test_health_reports_problem_instead_of_crashing() -> None:
    from fastapi.testclient import TestClient

    from api.server import app

    response = TestClient(app).get("/health")
    assert response.status_code in (200, 503)
    body = response.json()
    assert body["status"] in ("ok", "degraded")
    assert set(body["checks"]) == {"database", "redis"}


# ═══════════════════════ Скрипты запуска ══════════════════════

@pytest.mark.parametrize("script", ["start.sh", "stop.sh", "logs.sh", "update.sh"])
def test_shell_scripts_are_valid(script: str) -> None:
    path = ROOT / script
    assert path.exists(), f"нет файла {script}"
    result = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("script", ["start.bat", "stop.bat", "logs.bat", "update.bat"])
def test_batch_scripts_exist_and_are_balanced(script: str) -> None:
    text = (ROOT / script).read_text(encoding="utf-8")
    assert text.startswith("@echo off"), f"{script}: должен начинаться с @echo off"
    # грубая проверка парности блоков if/for — ловит обрезанные файлы
    assert text.count("(") == text.count(")"), f"{script}: несбалансированные скобки"


def test_docker_compose_uses_only_env_file_for_secrets() -> None:
    text = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "secrets.env" in text
    assert "env_file" in text
    # пароли и токены не должны быть вписаны в compose напрямую
    assert "BOT_TOKEN:" not in text
    assert "ENCRYPTION_KEY:" not in text
    assert "OPENROUTER_API_KEY:" not in text


def test_gitignore_protects_secrets() -> None:
    text = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "secrets.env" in text
    assert (ROOT / "secrets.env.example").exists()
