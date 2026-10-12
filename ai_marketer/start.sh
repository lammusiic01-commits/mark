#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   AI МАРКЕТОЛОГ — ЗАПУСК ПРОЕКТА (Linux / macOS)
#
#   Один скрипт делает всё:
#     1. проверяет Docker и Docker Compose;
#     2. создаёт secrets.env из шаблона и открывает его на заполнение;
#     3. генерирует ENCRYPTION_KEY, если он пустой;
#     4. собирает контейнеры;
#     5. поднимает базу и Redis, применяет миграции;
#     6. запускает сервисы (API, бот, WebApp).
#
#   Проверка без запуска: ./start.sh --check
# ═══════════════════════════════════════════════════════════════

set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"

BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
fi

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check|--check-only) CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

step() { printf '\n%s[%s/6]%s %s\n' "$BOLD" "$1" "$RESET" "$2"; }
ok()   { printf '  %s✅%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s⚠️ %s%s\n' "$YELLOW" "$1" "$RESET"; }
fail() { printf '  %s❌ %s%s\n' "$RED" "$1" "$RESET"; }
note() { printf '     %s%s%s\n' "$DIM" "$1" "$RESET"; }

banner() {
  cat <<'TEXT'

   ╔══════════════════════════════════════════════╗
   ║      AI МАРКЕТОЛОГ — ЗАПУСК ПРОЕКТА          ║
   ║      Premium Telegram Mini App               ║
   ╚══════════════════════════════════════════════╝
TEXT
}

trap 'fail "Скрипт остановлен на строке $LINENO. Читайте сообщение выше."; exit 1' ERR

banner
if [ "$CHECK_ONLY" = "1" ]; then
  printf '\n%sРежим проверки: команды Docker не выполняются, показывается план.%s\n' "$DIM" "$RESET"
fi

# ─────────────────────────── 1. Docker ───────────────────────────
step 1 "Проверяю Docker…"
DC=()

detect_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DC=(docker compose)
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    DC=(docker-compose)
    return 0
  fi
  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = "1" ]; then
    warn "Docker не найден (в режиме проверки продолжаем)"
    DC=(docker compose)
  else
    fail "Docker не установлен!"
    note "Установите Docker Desktop: https://www.docker.com/products/docker-desktop"
    note "Linux: sudo apt install docker.io docker-compose-plugin (или docker.io + docker-compose)"
    exit 1
  fi
else
  ok "Docker найден ($(docker --version | cut -d, -f1))"
  if ! detect_compose; then
    if [ "$CHECK_ONLY" = "1" ]; then
      warn "Docker Compose не найден (в режиме проверки продолжаем)"
      DC=(docker compose)
    else
      fail "Не найден Docker Compose (ни 'docker compose', ни 'docker-compose')"
      note "Обновите Docker Desktop или установите плагин docker-compose-plugin"
      exit 1
    fi
  else
    ok "Compose найден: ${DC[*]}"
  fi
  if [ "$CHECK_ONLY" = "0" ]; then
    if ! docker info >/dev/null 2>&1; then
      fail "Docker установлен, но демон не запущен"
      note "Запустите Docker Desktop (или: sudo systemctl start docker) и повторите"
      exit 1
    fi
    ok "Демон Docker отвечает"
  fi
fi

# ───────────────────────── 2. secrets.env ────────────────────────
step 2 "Проверяю secrets.env…"

if [ ! -f "secrets.env" ]; then
  cp "secrets.env.example" "secrets.env"
  warn "Файл secrets.env создан из шаблона. Заполните его и запустите скрипт снова:"
  cat <<'TEXT'

   ╔══════════════════════════════════════════════╗
   ║   ⚠️  ВАЖНО: ЗАПОЛНИ secrets.env             ║
   ╚══════════════════════════════════════════════╝

   1. BOT_TOKEN          — токен у @BotFather (/newbot)
   2. OPENROUTER_API_KEY — бесплатный ключ: https://openrouter.ai/keys
   3. WEBAPP_URL         — HTTPS-адрес (локально: ngrok http 3000)
   4. TELEGRAM_PROXY_URL — прокси для работы из РФ (уже заполнен)

TEXT
  if [ -n "${EDITOR:-}" ]; then
    "$EDITOR" secrets.env || true
  elif command -v nano >/dev/null 2>&1; then
    nano secrets.env || true
  elif command -v vi >/dev/null 2>&1; then
    vi secrets.env || true
  else
    note "Откройте secrets.env любым редактором и заполните значения."
  fi
  exit 0
fi

ok "secrets.env найден"

replace_var() {  # replace_var ИМЯ ЗНАЧЕНИЕ ФАЙЛ
  local name="$1" value="$2" file="$3"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$name" "$value" "$file" <<'PY'
import sys
name, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
out, replaced = [], False
for line in lines:
    if line.strip().startswith(f"{name}="):
        out.append(f"{name}={value}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{name}={value}")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
  else
    # Запасной путь без Python: значение base64 не содержит символов sed-разделителя
    sed -i.bak "s|^${name}=.*|${name}=${value}|" "$file"
    rm -f "${file}.bak"
  fi
}

var_value() {  # var_value ИМЯ → значение из secrets.env (или пусто)
  local name="$1"
  grep -E "^${name}=" secrets.env | tail -n1 | cut -d= -f2- | tr -d '\r' || true
}

generate_key() {
  local script='import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
  if command -v python3 >/dev/null 2>&1 && python3 -c "$script" 2>/dev/null; then return 0; fi
  if command -v python >/dev/null 2>&1 && python -c "$script" 2>/dev/null; then return 0; fi
  if [ "$CHECK_ONLY" = "0" ] && command -v docker >/dev/null 2>&1; then
    docker run --rm python:3.12-slim python -c "$script" 2>/dev/null && return 0
  fi
  return 1
}

# ──────────────────── 3. ENCRYPTION_KEY и проверка значений ─────
step 3 "Проверяю ключ шифрования…"

if [ -n "$(var_value ENCRYPTION_KEY)" ]; then
  ok "Ключ шифрования уже установлен"
else
  NEW_KEY="$(generate_key || true)"
  if [ -z "$NEW_KEY" ]; then
    fail "Не удалось сгенерировать ENCRYPTION_KEY (нужен python3 или Docker)"
    note "Сгенерируйте ключ вручную и вставьте в secrets.env:"
    note 'python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"'
    exit 1
  fi
  replace_var ENCRYPTION_KEY "$NEW_KEY" secrets.env
  ok "Ключ шифрования сгенерирован и записан в secrets.env"
  note "Сохраните его в надёжном месте: без ключа подключения пользователей не восстановить"
fi

MISSING=()
[ -n "$(var_value BOT_TOKEN)" ] || MISSING+=(BOT_TOKEN)
[ -n "$(var_value OPENROUTER_API_KEY)" ] || MISSING+=(OPENROUTER_API_KEY)
[ -n "$(var_value DB_PASSWORD)" ] || MISSING+=(DB_PASSWORD)
[ -n "$(var_value WEBAPP_URL)" ] || MISSING+=(WEBAPP_URL)

if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "Не заполнены переменные: ${MISSING[*]}"
  note "Проект запустится, но без этих значений бот и AI-советы работать не будут."
  note "Откройте secrets.env и заполните их, затем запустите скрипт снова."
fi

case "$(var_value WEBAPP_URL)" in
  https://*) ok "WEBAPP_URL с HTTPS — Telegram сможет открыть приложение" ;;
  "") : ;;
  *) warn "WEBAPP_URL без HTTPS: Telegram откроет WebApp только по защищённому адресу" ;;
esac

# ──────────────────── Какие сервисы уже есть в проекте ───────────
PROFILES=()
[ -d api ] && PROFILES+=(--profile api)
[ -f bot/main.py ] && PROFILES+=(--profile bot)
[ -f webapp/package.json ] && PROFILES+=(--profile web)
MIGRATE_PROFILE=(--profile migrate)

note "Активные сервисы: api$([ -f bot/main.py ] && echo ', bot')$([ -f webapp/package.json ] && echo ', webapp')"
[ -f bot/main.py ] || note "Бот появится после этапа 2 (bot/main.py) — сейчас он в план не входит"
[ -f webapp/package.json ] || note "WebApp появится после этапа 8 (webapp/package.json)"

run_or_show() {
  if [ "$CHECK_ONLY" = "1" ]; then
    printf '     %s→ %s%s\n' "$DIM" "$*" "$RESET"
    return 0
  fi
  "$@"
}

# ───────────────────────── 4. Сборка ────────────────────────────
step 4 "Собираю Docker-контейнеры (первый запуск 3-5 минут)…"
run_or_show "${DC[@]}" --env-file secrets.env "${MIGRATE_PROFILE[@]}" "${PROFILES[@]}" build
ok "Образы собраны"

# ─────────────────────── 5. База и миграции ─────────────────────
step 5 "Поднимаю базу и применяю миграции…"

wait_healthy() {  # wait_healthy СЕРВИС [ТАЙМАУТ]
  local service="$1" timeout="${2:-120}" elapsed=0 container state
  while [ "$elapsed" -lt "$timeout" ]; do
    container="$("${DC[@]}" --env-file secrets.env ps -q "$service" 2>/dev/null || true)"
    if [ -n "$container" ]; then
      state="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)"
      if [ "$state" = "healthy" ]; then return 0; fi
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
}

if [ "$CHECK_ONLY" = "1" ]; then
  run_or_show "${DC[@]}" --env-file secrets.env up -d postgres redis
  run_or_show "${DC[@]}" --env-file secrets.env --profile migrate run --rm --no-deps migrate
else
  "${DC[@]}" --env-file secrets.env up -d postgres redis
  ok "PostgreSQL и Redis запущены"

  if wait_healthy postgres 150; then
    ok "PostgreSQL готов принимать подключения"
  else
    warn "PostgreSQL не отчитался как healthy — смотрю логи:"
    "${DC[@]}" --env-file secrets.env logs --tail 30 postgres || true
  fi

  if wait_healthy redis 60; then
    ok "Redis готов"
  else
    warn "Redis не отчитался — продолжаем, кэш подключится позже"
  fi

  if "${DC[@]}" --env-file secrets.env "${MIGRATE_PROFILE[@]}" run --rm --no-deps migrate; then
    ok "Миграции применены (alembic upgrade head)"
  else
    warn "Миграции не применились — проверьте логи выше. Проект продолжит запуск."
  fi
fi

# ───────────────────────── 6. Запуск ────────────────────────────
step 6 "Запускаю сервисы…"
run_or_show "${DC[@]}" --env-file secrets.env "${PROFILES[@]}" up -d
ok "Сервисы запущены"

API_PORT_VALUE="$(var_value API_PORT)"; API_PORT_VALUE="${API_PORT_VALUE:-8000}"
WEBAPP_PORT_VALUE="$(var_value WEBAPP_PORT)"; WEBAPP_PORT_VALUE="${WEBAPP_PORT_VALUE:-3000}"

cat <<TEXT

   ╔══════════════════════════════════════════════╗
   ║         ✅ ВСЁ ЗАПУЩЕНО!                      ║
   ╚══════════════════════════════════════════════╝

   🤖 Бот работает в фоне (если задан BOT_TOKEN)
   📡 API:      http://localhost:${API_PORT_VALUE}/docs
   💚 Проверка: http://localhost:${API_PORT_VALUE}/health
TEXT
if [ -f webapp/package.json ]; then
  printf '   🌐 WebApp:   http://localhost:%s\n' "$WEBAPP_PORT_VALUE"
else
  printf '   🌐 WebApp:   появится после этапа 8\n'
fi
cat <<TEXT

   Остановить:  ./stop.sh
   Логи:        ./logs.sh
   Обновление:  ./update.sh

TEXT
