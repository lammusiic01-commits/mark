#!/usr/bin/env bash
# ==============================================================================
# Единый установщик Tenda TX2 Smart Gateway
# Выборочный обход блокировок (YouTube, Telegram, Instagram, Discord, ChatGPT)
# для всей домашней сети (Wi-Fi + кабель в ПК) с минимальной задержкой
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}======================================================================${NC}"
echo -e "${GREEN}   Tenda TX2 Smart Gateway — Система выборочной маршрутизации (РФ)${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""
echo "Выберите роль текущего устройства:"
echo "  1) Установить ДОМАШНИЙ ШЛЮЗ (Orange Pi / Raspberry Pi / Мини-ПК / Linux в сети Tenda TX2)"
echo "  2) Установить СЕРВЕРНУЮ ЧАСТЬ на зарубежный VPS (VLESS-Reality + BBR)"
echo "  3) Только сгенерировать конфиги и запустить Веб-панель управления (порт 8080)"
echo "  4) Показать таблицу статических маршрутов для веб-панели Tenda TX2 (192.168.0.1)"
echo ""
read -r -p "Введите номер пункта [1-4]: " CHOICE

case "${CHOICE}" in
  1)
    sudo bash "${PROJECT_DIR}/scripts/setup-gateway.sh"
    ;;
  2)
    sudo bash "${PROJECT_DIR}/scripts/setup-vps.sh"
    ;;
  3)
    python3 "${PROJECT_DIR}/app/core.py"
    echo -e "${GREEN}Конфиги успешно сгенерированы в configs/generated/${NC}"
    echo -e "Запускаю веб-панель на ${YELLOW}http://0.0.0.0:8080${NC} ..."
    python3 "${PROJECT_DIR}/app/server.py"
    ;;
  4)
    python3 -c '
import sys; sys.path.insert(0, ".")
from app.core import generate_tenda_static_routes
routes = generate_tenda_static_routes()
print("\nТаблица для меню Tenda TX2 -> Расширенные -> Статическая маршрутизация:")
print(f"{'\''Сеть назначения'\'':<18} | {'\''Маска подсети'\'':<16} | {'\''Шлюз'\'':<15}")
print("-" * 56)
for r in routes:
    print(f"{r[\"network\"]:<18} | {r[\"netmask\"]:<16} | {r[\"gateway\"]:<15}")
'
    ;;
  *)
    echo "Неверный выбор. Запустите ./install.sh повторно."
    exit 1
    ;;
esac
