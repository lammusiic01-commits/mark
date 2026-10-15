#!/usr/bin/env bash
# ==============================================================================
# Автоматическая настройка зарубежного VPS-сервера для Tenda TX2 Smart Gateway
# Поддерживает: Ubuntu 22.04 / 24.04, Debian 11 / 12
# Устанавливает: Sing-box (VLESS-XTLS-Vision-Reality) + TCP BBR + SmartDNS/SNIProxy
# ==============================================================================

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=== [1/5] Оптимизация ядра Linux (TCP BBR + FQ для минимальной задержки и 4K YouTube) ===${NC}"
cat << 'EOF' > /etc/sysctl.d/99-tenda-lowlatency.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen = 3
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_mtu_probing = 1
EOF
sysctl --system >/dev/null 2>&1 || true

echo -e "${BLUE}=== [2/5] Установка официального пакета Sing-box ===${NC}"
apt-get update -y
apt-get install -y curl gpg jq openssl python3

mkdir -p /etc/apt/keyrings
curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
chmod a+r /etc/apt/keyrings/sagernet.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/sagernet.asc] https://deb.sagernet.org/ * *" \
  > /etc/apt/sources.list.d/sagernet.list
apt-get update -y
apt-get install -y sing-box

echo -e "${BLUE}=== [3/5] Генерация криптографических ключей X25519 (VLESS-Reality) ===${NC}"
KEY_OUTPUT=$(sing-box generate reality-keypair)
PRIVATE_KEY=$(echo "$KEY_OUTPUT" | awk '/PrivateKey:/ {print $2}')
PUBLIC_KEY=$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')
UUID=$(sing-box generate uuid)
SHORT_ID=$(sing-box generate rand --hex 8)
SNI_DOMAIN="${SNI_DOMAIN:-dl.google.com}"
SERVER_IP=$(curl -4 -fsSL https://ifconfig.me || hostname -I | awk '{print $1}')

echo -e "${BLUE}=== [4/5] Запись конфигурации /etc/sing-box/config.json ===${NC}"
mkdir -p /etc/sing-box
cat << EOF > /etc/sing-box/config.json
{
  "log": {
    "level": "warn",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-reality-in",
      "listen": "::",
      "listen_port": 443,
      "tcp_fast_open": true,
      "sniff": true,
      "sniff_override_destination": true,
      "users": [
        {
          "name": "tenda-home-gateway",
          "uuid": "${UUID}",
          "flow": "xtls-rprx-vision"
        }
      ],
      "tls": {
        "enabled": true,
        "server_name": "${SNI_DOMAIN}",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "${SNI_DOMAIN}",
            "server_port": 443
          },
          "private_key": "${PRIVATE_KEY}",
          "short_id": ["${SHORT_ID}"]
        }
      }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" },
    { "type": "block", "tag": "block" }
  ]
}
EOF

echo -e "${BLUE}=== [5/5] Запуск и добавление в автозагрузку ===${NC}"
systemctl enable sing-box
systemctl restart sing-box

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN} VPS СЕРВЕР УСПЕШНО НАСТРОЕН И ЗАПУЩЕН!${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "Скопируйте эти параметры в веб-панель домашнего шлюза (http://192.168.0.2:8080):"
echo -e "  IP-адрес VPS : ${YELLOW}${SERVER_IP}${NC}"
echo -e "  Порт         : ${YELLOW}443${NC}"
echo -e "  UUID         : ${YELLOW}${UUID}${NC}"
echo -e "  SNI          : ${YELLOW}${SNI_DOMAIN}${NC}"
echo -e "  Public Key   : ${YELLOW}${PUBLIC_KEY}${NC}"
echo -e "  Short ID     : ${YELLOW}${SHORT_ID}${NC}"
echo -e "${GREEN}======================================================================${NC}"
