#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   AI МАРКЕТОЛОГ — ОБНОВЛЕНИЕ (Linux / macOS)
#   1. забирает свежий код из git (если это git-копия);
#   2. пересобирает образы;
#   3. применяет миграции;
#   4. поднимает сервисы заново.
#   secrets.env и данные не трогаются.
# ═══════════════════════════════════════════════════════════════

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

GREEN=""; YELLOW=""; DIM=""; RESET=""
if [ -t 1 ]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  printf '❌ Docker не найден. Установите Docker Desktop и повторите.\n'
  exit 1
fi

PROFILES=(--profile migrate --profile api)
[ -f bot/main.py ] && PROFILES+=(--profile bot)
[ -f webapp/package.json ] && PROFILES+=(--profile web)

printf '\n⬆️  Обновляю AI Маркетолог…\n\n'

if [ -d .git ]; then
  printf '  %sgit pull%s\n' "$DIM" "$RESET"
  if git pull --ff-only; then
    printf '%s  ✅ Код обновлён%s\n' "$GREEN" "$RESET"
  else
    printf '%s  ⚠️  git pull не удался (локальные правки?) — продолжаю с текущим кодом%s\n' "$YELLOW" "$RESET"
  fi
else
  printf '  %sРаспакованная копия без git — беру текущие файлы%s\n' "$DIM" "$RESET"
fi

if [ ! -f secrets.env ]; then
  printf '❌ Нет secrets.env — сначала запустите ./start.sh\n'
  exit 1
fi

printf '  Собираю образы…\n'
"${DC[@]}" --env-file secrets.env "${PROFILES[@]}" build

printf '  Поднимаю базу и Redis…\n'
"${DC[@]}" --env-file secrets.env up -d postgres redis
sleep 5

printf '  Применяю миграции…\n'
"${DC[@]}" --env-file secrets.env --profile migrate run --rm --no-deps migrate || \
  printf '%s  ⚠️  Миграции не применились — смотрите логи%s\n' "$YELLOW" "$RESET"

printf '  Перезапускаю сервисы…\n'
"${DC[@]}" --env-file secrets.env "${PROFILES[@]}" up -d --remove-orphans

printf '\n%s✅ Обновление завершено.%s Проверьте: ./logs.sh\n\n' "$GREEN" "$RESET"
