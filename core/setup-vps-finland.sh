export DEBIAN_FRONTEND=noninteractive

for i in {1..30}; do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
    sleep 2
  else
    break
  fi
done

apt-get update -y >/dev/null 2>&1 || true
apt-get install -y curl gpg ca-certificates jq openssl procps iproute2 iptables >/dev/null 2>&1 || true

# 1. Точная синхронизация времени UTC на VPS (критично для протокола VLESS-Reality!)
HTTP_DATE=$(curl -sI --max-time 5 https://1.1.1.1 | grep -i '^date:' | sed 's/^[Dd]ate: //;s/\r//' || true)
if [ -n "$HTTP_DATE" ]; then
  date -u -s "$HTTP_DATE" >/dev/null 2>&1 || true
fi
timedatectl set-ntp true >/dev/null 2>&1 || true

# 2. Swap 1 ГБ для стабильной работы на тарифе 299 руб
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null 2>&1 || true
  swapon /swapfile >/dev/null 2>&1 || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 3. Включение TCP BBR + FQ
cat << 'EOF' > /etc/sysctl.d/99-onedash-finland.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
vm.swappiness = 10
EOF
sysctl --system >/dev/null 2>&1 || true

# 4. Установка официального ядра Sing-box на Debian 12
if ! command -v sing-box >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod a+r /etc/apt/keyrings/sagernet.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/sagernet.asc] https://deb.sagernet.org/ * *" > /etc/apt/sources.list.d/sagernet.list
  apt-get update -y >/dev/null 2>&1
  apt-get install -y sing-box >/dev/null 2>&1
fi

# 5. Открытие порта 443 в файрволе VPS
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
if command -v ufw >/dev/null 2>&1; then
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# 6. Генерация ключей VLESS-Reality (используем www.microsoft.com вместо dl.google.com, так как домены google замедляются ТСПУ!)
CRED_FILE="/root/tenda-vps-credentials.json"
SNI_DOMAIN="www.microsoft.com"

if [ -f "$CRED_FILE" ]; then
  UUID=$(jq -r '.uuid' "$CRED_FILE")
  PRIVATE_KEY=$(jq -r '.private_key' "$CRED_FILE")
  PUBLIC_KEY=$(jq -r '.public_key' "$CRED_FILE")
  SHORT_ID=$(jq -r '.short_id' "$CRED_FILE")
else
  KEY_OUTPUT=$(sing-box generate reality-keypair)
  PRIVATE_KEY=$(echo "$KEY_OUTPUT" | awk '/PrivateKey:/ {print $2}')
  PUBLIC_KEY=$(echo "$KEY_OUTPUT" | awk '/PublicKey:/ {print $2}')
  UUID=$(sing-box generate uuid)
  SHORT_ID=$(sing-box generate rand --hex 8)
fi

SERVER_IP=$(curl -4 -fsSL --max-time 5 https://api.ipify.org || curl -4 -fsSL --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')

cat << EOF > "$CRED_FILE"
{"host":"${SERVER_IP}","port":443,"uuid":"${UUID}","public_key":"${PUBLIC_KEY}","short_id":"${SHORT_ID}","sni":"${SNI_DOMAIN}","private_key":"${PRIVATE_KEY}"}
EOF
chmod 600 "$CRED_FILE"

mkdir -p /etc/sing-box
cat << EOF > /etc/sing-box/config.json
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "cf-v4",
        "address": "1.1.1.1",
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
          "name": "tenda-win11",
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
          "short_id": [
            "${SHORT_ID}"
          ],
          "max_time_difference": "5m"
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

systemctl enable sing-box >/dev/null 2>&1 || true
systemctl restart sing-box
sleep 2

if ! systemctl is-active --quiet sing-box; then
  echo "ERROR: sing-box failed to start on VPS!"
  journalctl -u sing-box -n 20 --no-pager
  exit 1
fi

echo "TENDA_JSON_BEGIN"
cat "$CRED_FILE"
echo "TENDA_JSON_END"
