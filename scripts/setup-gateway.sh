#!/usr/bin/env bash
# ==============================================================================
# Автоматическая настройка домашнего прозрачного шлюза для роутера Tenda TX2
# Работает на: Orange Pi / Raspberry Pi (Armbian/Debian), мини-ПК, Ubuntu/Debian VM
# Обеспечивает работу YouTube, Telegram, Instagram, Discord по Wi-Fi и кабелю
# ==============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=== [1/6] Включение маршрутизации пакетов (IP Forwarding) и TCP BBR ===${NC}"
cat << 'EOF' > /etc/sysctl.d/99-tenda-gateway.conf
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen = 3
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
EOF
sysctl --system >/dev/null 2>&1 || true

echo -e "${BLUE}=== [2/6] Установка необходимых пакетов (sing-box, dnsmasq, nftables, python3) ===${NC}"
apt-get update -y
apt-get install -y curl gpg dnsmasq nftables python3 iproute2

if ! command -v sing-box >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod a+r /etc/apt/keyrings/sagernet.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/sagernet.asc] https://deb.sagernet.org/ * *" \
    > /etc/apt/sources.list.d/sagernet.list
  apt-get update -y
  apt-get install -y sing-box
fi

echo -e "${BLUE}=== [3/6] Генерация конфигураций Sing-box, Dnsmasq и Nftables ===${NC}"
python3 "${PROJECT_DIR}/app/core.py"

mkdir -p /etc/sing-box
cp "${PROJECT_DIR}/configs/generated/singbox_gateway.json" /etc/sing-box/config.json
cp "${PROJECT_DIR}/configs/generated/dnsmasq_tenda.conf" /etc/dnsmasq.d/tenda-gateway.conf
cp "${PROJECT_DIR}/configs/generated/nftables_gateway.conf" /etc/nftables.conf

echo -e "${BLUE}=== [4/6] Настройка службы Веб-панели управления (порт 8080) ===${NC}"
cat << EOF > /etc/systemd/system/tenda-gateway-ui.service
[Unit]
Description=Tenda TX2 Smart Gateway Web UI & Config Generator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/python3 ${PROJECT_DIR}/app/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo -e "${BLUE}=== [5/6] Настройка службы Watchdog (контроль минимальной задержки и авто-восстановление) ===${NC}"
cat << EOF > /etc/systemd/system/tenda-gateway-watchdog.service
[Unit]
Description=Tenda TX2 Smart Gateway Watchdog & Failover Monitor
After=sing-box.service

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/python3 ${PROJECT_DIR}/scripts/watchdog.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo -e "${BLUE}=== [6/6] Перезапуск служб ===${NC}"
systemctl daemon-reload
systemctl enable sing-box dnsmasq nftables tenda-gateway-ui tenda-gateway-watchdog
systemctl restart nftables || true
systemctl restart sing-box
systemctl restart dnsmasq
systemctl restart tenda-gateway-ui
systemctl restart tenda-gateway-watchdog

GW_IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN} ДОМАШНИЙ ШЛЮЗ TENDA TX2 УСПЕШНО УСТАНОВЛЕН И ЗАПУЩЕН!${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "1. Откройте веб-панель управления: ${YELLOW}http://${GW_IP}:8080${NC}"
echo -e "2. Зайдите в настройки роутера Tenda TX2 (${YELLOW}http://192.168.0.1${NC}):"
echo -e "   -> «Системные настройки» -> «Настройки локальной сети (LAN)»"
echo -e "   -> Снимите галочку «DHCP-сервер» (теперь адрес шлюза и быстрый DNS раздаются автоматически)"
echo -e "3. Переподключите Wi-Fi на телефоне и кабель на ПК — YouTube, TG и Instagram работают!"
echo -e "${GREEN}======================================================================${NC}"
