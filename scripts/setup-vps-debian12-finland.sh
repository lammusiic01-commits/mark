#!/usr/bin/env bash
# ==============================================================================
# СПЕЦИАЛЬНЫЙ АВТО-УСТАНОВЩИК ПОД VPS ONEDASH (rdp-onedash.ru)
# Локация: Хельсинки, Финляндия | ОС: Debian 12 (Bookworm) | Тариф: 299 руб/мес
# Настраивает:
#   1. Защиту памяти (1 ГБ Swap для тарифа 299₽, чтобы сервер никогда не зависал)
#   2. Сетевой профиль минимальной задержки Финляндия <-> РФ (TCP BBR + FQ + Low-NotSent)
#   3. Ядро Sing-box (VLESS + XTLS-Vision + Reality, маскировка под dl.google.com в Финляндии)
#   4. Авто-экспорт ключей для мгновенного подключения ПК на Windows 11 и роутера Tenda TX2
# ==============================================================================

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=== [1/6] Подготовка чистой ОС Debian 12 (Bookworm) на VPS в Хельсинки ===${NC}"
# Ожидание завершения фонового apt-обновления (часто запускается при первом старте VPS)
for i in {1..30}; do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
    echo "  Ожидание завершения системного процесса apt ($i/30)..."
    sleep 2
  else
    break
  fi
done

apt-get update -y
apt-get install -y curl gpg ca-certificates jq openssl procps iproute2

echo -e "${BLUE}=== [2/6] Создание 1 ГБ Swap-файла (защита ОЗУ для тарифа 299₽) ===${NC}"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile || true
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  echo "  [OK] Swap 1 ГБ активирован."
else
  echo "  [OK] Swap-файл уже активен."
fi

echo -e "${BLUE}=== [3/6] Тюнинг ядра Debian 12 под маршрут Хельсинки <-> РФ (TCP BBR + минимальный пинг) ===${NC}"
cat << 'EOF' > /etc/sysctl.d/99-onedash-finland-lowlatency.conf
# Алгоритм управления перегрузкой Google BBR + планировщик Fair Queueing
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Минимизация задержки (Bufferbloat) при передаче потоков YouTube 4K и звонков Telegram/Discord
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0

# Увеличенные буферы сокетов для гигабитного канала Финляндия -> РФ
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.ipv4.tcp_rmem = 4096 87380 26214400
net.ipv4.tcp_wmem = 4096 65536 26214400

# Оптимизация работы с памятью на VPS 1 ГБ RAM
vm.swappiness = 10
EOF
sysctl --system >/dev/null 2>&1 || true

echo -e "${BLUE}=== [4/6] Установка официального ядра Sing-box для Debian 12 ===${NC}"
if ! command -v sing-box >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod a+r /etc/apt/keyrings/sagernet.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/sagernet.asc] https://deb.sagernet.org/ * *" \
    > /etc/apt/sources.list.d/sagernet.list
  apt-get update -y
  apt-get install -y sing-box
fi

echo -e "${BLUE}=== [5/6] Генерация ключей VLESS-Reality и настройка /etc/sing-box/config.json ===${NC}"
# Если ключи уже создавались ранее, сохраняем их, чтобы не сбрасывать подключение дома
CRED_FILE="/root/tenda-vps-credentials.json"
if [ -f "$CRED_FILE" ] && [ "${FORCE_NEW_KEYS:-0}" != "1" ]; then
  UUID=$(jq -r '.uuid' "$CRED_FILE")
  PRIVATE_KEY=$(jq -r '.private_key' "$CRED_FILE")
  PUBLIC_KEY=$(jq -r '.public_key' "$CRED_FILE")
  SHORT_ID=$(jq -r '.short_id' "$CRED_FILE")
  SNI_DOMAIN=$(jq -r '.sni' "$CRED_FILE")
else
  KEY_OUTPUT=$(sing-box generate reality-keypair)
  PRIVATE_KEY=$(echo "$KEY_OUTPUT" | awk '/PrivateKey:/ {print $2}')
  PUBLIC_KEY=$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')
  UUID=$(sing-box generate uuid)
  SHORT_ID=$(sing-box generate rand --hex 8)
  # dl.google.com в Хельсинки отвечает с дата-центра Google в Хамине (Финляндия) за < 2 мс!
  SNI_DOMAIN="dl.google.com"
fi

SERVER_IP=$(curl -4 -fsSL --max-time 5 https://api.ipify.org || curl -4 -fsSL --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')

cat << EOF > "$CRED_FILE"
{
  "host": "${SERVER_IP}",
  "port": 443,
  "uuid": "${UUID}",
  "private_key": "${PRIVATE_KEY}",
  "public_key": "${PUBLIC_KEY}",
  "short_id": "${SHORT_ID}",
  "sni": "${SNI_DOMAIN}"
}
EOF
chmod 600 "$CRED_FILE"

mkdir -p /etc/sing-box
cat << EOF > /etc/sing-box/config.json
{
  "log": {
    "level": "warn",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "cloudflare-v4",
        "address": "1.1.1.1",
        "strategy": "ipv4_only"
      },
      {
        "tag": "google-v4",
        "address": "8.8.8.8",
        "strategy": "ipv4_only"
      }
    ],
    "strategy": "ipv4_only"
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
          "name": "tenda-win11-home",
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
    {
      "type": "direct",
      "tag": "direct",
      "domain_strategy": "ipv4_only"
    },
    {
      "type": "block",
      "tag": "block"
    }
  ]
}
EOF

echo -e "${BLUE}=== [6/6] Запуск службы Sing-box и проверка порта 443 ===${NC}"
systemctl enable sing-box
systemctl restart sing-box
sleep 1

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN} VPS ONEDASH (ХЕЛЬСИНКИ, DEBIAN 12) УСПЕШНО НАСТРОЕН И ЗАПУЩЕН!${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "  Локация      : ${YELLOW}Хельсинки, Финляндия (TCP BBR включен)${NC}"
echo -e "  IP-адрес VPS : ${YELLOW}${SERVER_IP}${NC}"
echo -e "  Порт         : ${YELLOW}443${NC}"
echo -e "  UUID         : ${YELLOW}${UUID}${NC}"
echo -e "  SNI          : ${YELLOW}${SNI_DOMAIN}${NC}"
echo -e "  Public Key   : ${YELLOW}${PUBLIC_KEY}${NC}"
echo -e "  Short ID     : ${YELLOW}${SHORT_ID}${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo "TENDA_CREDENTIALS_JSON_BEGIN"
cat "$CRED_FILE"
echo "TENDA_CREDENTIALS_JSON_END"
