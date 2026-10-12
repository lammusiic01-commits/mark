#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   AI МАРКЕТОЛОГ — ЛОГИ (Linux / macOS)
#   ./logs.sh            — все сервисы, живой поток (Ctrl+C — выход)
#   ./logs.sh bot        — только бот
#   ./logs.sh api 200    — последние 200 строк API
# ═══════════════════════════════════════════════════════════════

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

RED=""; RESET=""
if [ -t 1 ]; then RED=$'\033[31m'; RESET=$'\033[0m'; fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  printf '%s❌ Docker не найден — логи недоступны.%s\n' "$RED" "$RESET"
  exit 1
fi

SERVICE="${1:-}"
TAIL="${2:-100}"
PROFILES=(--profile migrate --profile api --profile bot --profile web)

if [ -z "$SERVICE" ]; then
  printf '\n📜 Логи всех сервисов (Ctrl+C — выход):\n\n'
  exec "${DC[@]}" --env-file secrets.env "${PROFILES[@]}" logs -f --tail "$TAIL"
fi

printf '\n📜 Логи сервиса %s (Ctrl+C — выход):\n\n' "$SERVICE"
exec "${DC[@]}" --env-file secrets.env "${PROFILES[@]}" logs -f --tail "$TAIL" "$SERVICE"
