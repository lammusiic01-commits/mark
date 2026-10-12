#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   AI МАРКЕТОЛОГ — ОСТАНОВКА ПРОЕКТА (Linux / macOS)
#   Останавливает все контейнеры и сети проекта.
#   Данные (база, Redis) сохраняются в томах — удалить: ./stop.sh --purge
# ═══════════════════════════════════════════════════════════════

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

GREEN=""; YELLOW=""; RED=""; RESET=""
if [ -t 1 ]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  printf '%s❌ Docker не найден — останавливать нечего.%s\n' "$RED" "$RESET"
  exit 1
fi

printf '\n🛑 Останавливаю AI Маркетолог…\n'

if [ "${1:-}" = "--purge" ]; then
  printf '%s⚠️  Вместе с контейнерами удаляю данные (база и Redis).%s\n' "$YELLOW" "$RESET"
  printf 'Уверены? Напишите "да" для подтверждения: '
  read -r answer
  if [ "$answer" != "да" ]; then
    printf 'Отменено — ничего не удалено.\n'
    exit 0
  fi
  "${DC[@]}" --env-file secrets.env --profile migrate --profile api --profile bot --profile web down -v --remove-orphans
  printf '%s✅ Проект остановлен, данные удалены.%s\n\n' "$GREEN" "$RESET"
  exit 0
fi

"${DC[@]}" --env-file secrets.env --profile migrate --profile api --profile bot --profile web down --remove-orphans

printf '%s✅ Проект остановлен. Данные сохранены в томах.%s\n' "$GREEN" "$RESET"
printf '   Запустить снова: ./start.sh\n'
printf '   Удалить данные:  ./stop.sh --purge\n\n'
