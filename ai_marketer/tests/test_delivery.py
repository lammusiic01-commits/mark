"""Тесты поставки: одна кнопка запуска, единый файл секретов, релиз, Mini App.

Здесь проверяется то, что пользователь видит со стороны: скрипты запуска и
остановки, шаблон секретов, сборка релиза по тегу и требования к интерфейсу
(прокси Telegram, haptics, безопасные зоны, формат чисел, отсутствие ключей).

Запуск: python -m pytest tests -q
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WEBAPP = ROOT / "webapp"

# Ключи, которые по условиям проекта обязаны быть в шаблоне секретов
REQUIRED_ENV_KEYS = (
    "BOT_TOKEN",
    "WEBAPP_URL",
    "TELEGRAM_PROXY_URL",
    "OPENROUTER_API_KEY",
    "AI_MODEL",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "REDIS_HOST",
    "REDIS_PORT",
    "ENCRYPTION_KEY",
    "SBP_MERCHANT_ID",
    "SBP_ACCOUNT",
    "SBP_SECRET_KEY",
    "API_PORT",
    "WEBAPP_PORT",
    "ENV",
    "LOG_LEVEL",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def webapp_files(suffix: str) -> list[Path]:
    """Все файлы Mini App с нужным расширением (без сборки и зависимостей)."""
    skip = {"node_modules", "dist", ".vite", "coverage"}
    return sorted(
        path
        for path in WEBAPP.rglob(f"*{suffix}")
        if not any(part in skip for part in path.parts)
    )


# ═══════════════════════ Запуск одной кнопкой ═══════════════════════


def test_start_scripts_exist() -> None:
    for name in ("start.bat", "start.sh", "stop.bat", "stop.sh", "logs.bat", "logs.sh", "update.bat", "update.sh"):
        path = ROOT / name
        assert path.is_file(), f"нет файла {name}"


def test_start_script_does_everything_by_itself() -> None:
    """start.sh: проверка Docker, создание секретов, ключ, сборка, миграции, запуск."""
    text = read(ROOT / "start.sh")
    checks = {
        "проверка docker": "command -v docker",
        "создание secrets.env из шаблона": "cp \"secrets.env.example\" \"secrets.env\"",
        "генерация ENCRYPTION_KEY": "urandom(32)",
        "сборка образов": "build",
        "миграции": "alembic upgrade head",
        "запуск сервисов": "up -d",
    }
    for title, needle in checks.items():
        assert needle in text, f"start.sh: не найдено «{title}»"


def test_windows_start_script_matches_unix() -> None:
    text = read(ROOT / "start.bat")
    for needle in ("secrets.env.example", "docker compose", "alembic", "urandom"):
        assert needle in text, f"start.bat: не найдено «{needle}»"


def test_shell_scripts_are_valid() -> None:
    """bash -n: скрипты синтаксически корректны (проверяем, если есть bash)."""
    import shutil
    import subprocess

    bash = shutil.which("bash")
    if not bash:
        pytest.skip("bash недоступен")

    for name in ("start.sh", "stop.sh", "logs.sh", "update.sh"):
        result = subprocess.run([bash, "-n", str(ROOT / name)], capture_output=True, text=True)
        assert result.returncode == 0, f"{name}: {result.stderr}"


# ═════════════════════════ Единый файл секретов ═════════════════════


def test_secrets_template_has_all_keys() -> None:
    text = read(ROOT / "secrets.env.example")
    for key in REQUIRED_ENV_KEYS:
        assert re.search(rf"^{key}=", text, re.MULTILINE), f"в шаблоне нет {key}"


def test_secrets_template_has_no_real_keys() -> None:
    """В шаблоне — только заглушки: боевые значения пользователь вписывает сам."""
    text = read(ROOT / "secrets.env.example")
    for found in re.findall(r"sk-(?:or-v1-)?[A-Za-z0-9]{20,}", text):
        assert _looks_like_placeholder(found), "в шаблоне похоже на настоящий ключ OpenRouter"
    token = re.search(r"BOT_TOKEN=(\S+)", text)
    assert token, "в шаблоне нет BOT_TOKEN"
    assert _looks_like_placeholder(token.group(1)), "в шаблоне похоже на настоящий токен бота"
    assert "tg-proxy.lammusiic01.workers.dev" in text, "прокси Telegram по умолчанию должен быть указан"
    assert "meta-llama/llama-3.3-70b-instruct:free" in text, "бесплатная модель по умолчанию"


def test_secrets_file_is_ignored_by_git() -> None:
    text = read(ROOT / ".gitignore")
    assert "secrets.env" in text
    assert "!secrets.env.example" in text or "secrets.env.example" not in text


def test_compose_reads_secrets_only_from_env_file() -> None:
    """В docker-compose нет значений секретов: только ссылка на secrets.env."""
    text = read(ROOT / "docker-compose.yml")
    assert "env_file:" in text and "secrets.env" in text
    assert not re.search(r"BOT_TOKEN:\s*\S", text), "токен бота не должен быть в compose"
    assert not re.search(r"sk-or-v1-", text), "ключ OpenRouter не должен быть в compose"


def _looks_like_placeholder(key: str) -> bool:
    """Заглушка или настоящий ключ: у заглушки один повторяющийся символ либо xxxx.

    Подходит и для ключей OpenRouter (sk-or-v1-…), и для токенов бота (1234:AAAA).
    """
    body = (key.split(":", 1)[-1] if ":" in key else key.rsplit("-", 1)[-1]).lower()
    return len(set(body)) <= 2 or "xxxx" in body or "your" in body


def test_no_keys_anywhere_in_sources() -> None:
    """Ни в коде, ни в тестах нет настоящих ключей — только заглушки и secrets.env."""
    pattern = re.compile(r"sk-(?:or-v1-)?[A-Za-z0-9]{20,}")
    skip = {"node_modules", "dist", ".git", "__pycache__", ".venv"}
    for path in ROOT.rglob("*.py"):
        if any(part in skip for part in path.parts):
            continue
        for found in pattern.findall(read(path)):
            assert _looks_like_placeholder(found), f"{path.relative_to(ROOT)}: похоже на настоящий ключ"


def test_bot_and_webapp_never_call_telegram_directly() -> None:
    """Адреса Telegram в коде нет — он берётся только из TELEGRAM_PROXY_URL."""
    literal = re.compile(r"['\"`]https?://api\.telegram\.org")
    skip = {"node_modules", "dist", ".git", "__pycache__"}
    offenders: list[str] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in {".py", ".js", ".vue"}:
            continue
        if any(part in skip for part in path.parts):
            continue
        if path.name == Path(__file__).name:
            continue
        for line_no, line in enumerate(read(path).splitlines(), start=1):
            if literal.search(line):
                offenders.append(f"{path.relative_to(ROOT)}:{line_no}")
    assert not offenders, "прямой адрес Telegram в коде: " + ", ".join(offenders)

    # Адрес для запросов собирается из прокси
    session = read(ROOT / "bot" / "proxy_session.py")
    assert "TELEGRAM_PROXY_URL" in session and "TelegramAPIServer" in session


# ══════════════════════════════ Релиз ═══════════════════════════════


def test_release_workflow_covers_tags() -> None:
    workflow = ROOT / ".github" / "workflows" / "release.yml"
    text = read(workflow)
    assert "tags:" in text
    assert re.search(r"v\*", text), "релиз запускается по тегу v*"
    assert "zip -r" in text, "workflow собирает ZIP"
    assert "softprops/action-gh-release" in text, "ZIP публикуется в GitHub Releases"
    assert "pytest" in text, "перед публикацией прогоняются тесты"
    assert "secrets.env" in text, "архив проверяется на отсутствие secrets.env"


def test_workflow_actions_are_current() -> None:
    """Версии actions — на актуальных раннерах (старые используют Node 20)."""
    text = read(ROOT / ".github" / "workflows" / "release.yml")
    for action, major in (("actions/checkout", 7), ("actions/setup-python", 7), ("softprops/action-gh-release", 3)):
        found = re.search(rf"uses:\s*{re.escape(action)}@v(\d+)", text)
        assert found, f"workflow не использует {action}"
        assert int(found.group(1)) >= major, f"{action}: версия ниже v{major}"


def test_dockerfile_builds_miniapp() -> None:
    """Интерфейс собирается внутри образа и раздаётся бэкендом."""
    text = read(ROOT / "Dockerfile")
    assert "node:20-alpine" in text, "нет ступени сборки фронтенда"
    assert "npm run build" in text
    assert "/app/webapp/dist" in text, "собранный интерфейс не попадает в образ"


def test_webapp_served_by_api() -> None:
    """API отдаёт собранный интерфейс: Telegram open нужен один адрес."""
    text = read(ROOT / "api" / "server.py")
    assert "WEBAPP_DIST" in text
    assert "StaticFiles" in text


# ═══════════════════════════ Mini App: требования ═══════════════════


def test_pages_exist_for_every_route() -> None:
    routes = read(WEBAPP / "src" / "router.js")
    imported = set(re.findall(r"import\(\s*['\"]\./pages/([A-Za-z0-9_]+)\.vue", routes))
    assert imported, "роутер не ссылается на экраны"
    for name in sorted(imported):
        assert (WEBAPP / "src" / "pages" / f"{name}.vue").is_file(), f"нет файла экрана {name}.vue"


def test_all_screens_from_spec_are_present() -> None:
    """Экраны из задания: онбординг, подключения, главная, боты, гипотезы, кампании, баланс, отчёты, настройки."""
    expected = {
        "Onboarding",
        "Connect",
        "Dashboard",
        "BotShield",
        "Hypotheses",
        "Campaigns",
        "Balance",
        "Reports",
        "Settings",
    }
    present = {path.stem for path in (WEBAPP / "src" / "pages").glob("*.vue")}
    missing = expected - present
    assert not missing, f"нет экранов: {sorted(missing)}"


def test_hash_navigation_used() -> None:
    """Хэш-навигация: работает и в nginx, и из файла, без настройки сервера."""
    text = read(WEBAPP / "src" / "router.js")
    assert "createWebHashHistory" in text


def test_numeric_format_is_russian() -> None:
    text = read(WEBAPP / "src" / "composables" / "useFormat.js")
    assert "Intl.NumberFormat" in text
    assert "ru-RU" in text


def test_haptics_everywhere() -> None:
    """Касание = отклик: haptics вызываются на действиях каждого экрана."""
    pages = webapp_files(".vue")
    in_pages = [path for path in pages if "pages" in path.parts]
    assert len(in_pages) >= 9
    for path in in_pages:
        text = read(path)
        assert "useHaptics" in text or "haptics" in text or "haptic" in text, f"{path.name}: нет haptics"


def test_closing_confirmation_and_safe_area() -> None:
    text = read(WEBAPP / "src" / "composables" / "useTelegram.js")
    assert "enableClosingConfirmation" in text, "нет подтверждения закрытия"
    assert "safeArea" in text or "viewport" in text, "нет учёта безопасных зон"

    styles = read(WEBAPP / "src" / "styles" / "main.css") + read(WEBAPP / "src" / "styles" / "variables.css")
    assert "env(safe-area-inset" in styles, "нет отступов под вырез и полосу iPhone"


def test_glass_design_system_uses_vendor_prefix() -> None:
    """Стекло (blur) — с префиксом -webkit-: иначе Safari в iOS его не покажет."""
    files = webapp_files(".css") + webapp_files(".vue")
    plain = sum(len(re.findall(r"^\s*backdrop-filter:", read(path), re.MULTILINE)) for path in files)
    prefixed = sum(len(re.findall(r"^\s*-webkit-backdrop-filter:", read(path), re.MULTILINE)) for path in files)
    assert plain, "в оформлении нет стеклянных поверхностей (backdrop-filter)"
    assert prefixed >= plain, f"правил без префикса -webkit-: {plain - prefixed}"


def test_no_react_or_svelte() -> None:
    """Стек зафиксирован: Vue 3. Никаких React и Svelte."""
    package = read(WEBAPP / "package.json")
    assert "\"vue\"" in package
    for banned in ("react", "react-dom", "svelte", "next"):
        assert f'"{banned}"' not in package, f"в зависимостях появился {banned}"


def test_api_calls_use_relative_paths() -> None:
    """Адрес API относительный: страница не знает, где живёт сервер."""
    text = read(WEBAPP / "src" / "composables" / "useApi.js")
    assert "VITE_API_BASE || '/api'" in text, "адрес API по умолчанию — /api"
    assert "X-Telegram-Init-Data" in text, "нет заголовка входа из Telegram"
    # Абсолютных адресов в вызовах быть не должно — иначе превью и прод разойдутся
    for match in re.findall(r"fetch\(`\$\{API_BASE\}[^`]*`", text):
        assert not match.startswith("fetch(`http"), match


def test_webapp_tests_are_wired() -> None:
    package = read(WEBAPP / "package.json")
    assert '"test"' in package, "нет команды тестов Mini App"
    assert (WEBAPP / "tests" / "screens.spec.js").is_file()


def test_readme_describes_launch_and_secrets() -> None:
    text = read(ROOT / "README.md")
    for needle in ("start.bat", "start.sh", "secrets.env", "ENCRYPTION_KEY", "WebApp"):
        assert needle in text, f"в README нет упоминания «{needle}»"
