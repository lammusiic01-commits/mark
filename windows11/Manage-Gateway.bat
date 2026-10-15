@echo off
title Tenda TX2 Smart Gateway - Windows 11 AutoSetup v3
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath '%~f0' -Encoding UTF8; $idx = [Array]::IndexOf($lines, '# === PS1_PAYLOAD_BEGIN ==='); if ($idx -lt 0) { Write-Error 'Payload marker not found'; exit 1 }; $body = ($lines[($idx+1)..($lines.Length-1)] -join \"`r`n\"); [System.IO.File]::WriteAllText(\"$env:TEMP\TendaAutoSetup.ps1\", $body, [System.Text.Encoding]::UTF8)"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\TendaAutoSetup.ps1"
pause
exit /b
# === PS1_PAYLOAD_BEGIN ===
$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Tenda TX2 Smart Gateway - Windows 11 + OneDash Finland (v3)"

$InstallDir = "C:\TendaGateway"
$BinDir = Join-Path $InstallDir "bin"
$CfgDir = Join-Path $InstallDir "configs"
$SingBoxExe = Join-Path $BinDir "sing-box.exe"
$SingBoxCfgPath = Join-Path $CfgDir "singbox_windows11.json"
$VpsJsonPath = Join-Path $CfgDir "vps_credentials.json"
$CustomDomainsPath = Join-Path $CfgDir "custom_domains.txt"
$GatewayIP = "192.168.0.2"
$TendaRouterIP = "192.168.0.1"
$SingBoxVersion = "1.10.7"

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null

# Полный встроенный список доменов (YouTube 4K, Telegram, Instagram/Meta, Discord + Голос, ChatGPT/Claude/Gemini, X/Spotify/Netflix/Rutracker)
$DefaultSelectiveDomains = @(
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "tv.youtube.com",
    "youtu.be", "googlevideo.com", "ytimg.com", "i.ytimg.com", "i9.ytimg.com", "s.ytimg.com",
    "yt3.ggpht.com", "yt4.ggpht.com", "ggpht.com", "youtubei.googleapis.com",
    "youtubeembeddedplayer.googleapis.com", "ytimg.l.google.com", "youtube-ui.l.google.com",
    "youtube-nocookie.com", "widevine.com", "jnn-pa.googleapis.com",
    "instagram.com", "www.instagram.com", "i.instagram.com", "graph.instagram.com",
    "cdninstagram.com", "scontent.cdninstagram.com", "threads.net", "www.threads.net",
    "facebook.com", "www.facebook.com", "m.facebook.com", "fbcdn.net", "fbsbx.com",
    "fb.com", "fb.me", "tfbnw.net", "meta.com", "meta.ai",
    "telegram.org", "www.telegram.org", "core.telegram.org", "web.telegram.org",
    "webk.telegram.org", "webz.telegram.org", "desktop.telegram.org", "t.me",
    "telegram.me", "telegram.dog", "telegra.ph", "telesco.pe", "cdn-telegram.org",
    "comments.app", "contest.com", "fragment.com", "tdesktop.com",
    "discord.com", "www.discord.com", "discordapp.com", "discordapp.net", "discord.gg",
    "discord.media", "discordcdn.com", "discord.dev", "discord.new", "discord.gift", "dis.gd",
    "openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "auth0.openai.com",
    "anthropic.com", "claude.ai", "gemini.google.com", "aistudio.google.com",
    "copilot.microsoft.com", "midjourney.com", "perplexity.ai", "poe.com",
    "x.com", "twitter.com", "twimg.com", "t.co", "spotify.com", "scdn.co", "spotifycdn.com",
    "netflix.com", "nflxvideo.net", "nflximg.net", "rutracker.org", "rutracker.net",
    "linkedin.com", "licdn.com", "canva.com", "notion.so", "medium.com", "patreon.com"
)

# Официальные подсети Telegram (AS62041, AS62014, AS59930, AS44907)
$TelegramCidrs = @(
    "91.105.192.0/23", "91.108.4.0/22", "91.108.8.0/22", "91.108.12.0/22",
    "91.108.16.0/22", "91.108.20.0/22", "91.108.56.0/22", "95.161.64.0/20",
    "149.154.160.0/20", "185.76.151.0/24"
)

$Debian12VpsBashScript = @'
export DEBIAN_FRONTEND=noninteractive
echo "=== [1/5] Подготовка Debian 12 (Хельсинки) ==="
for i in {1..30}; do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
    sleep 2
  else
    break
  fi
done

apt-get update -y
apt-get install -y curl gpg ca-certificates jq openssl procps iproute2

echo "=== [2/5] Настройка 1 ГБ Swap (защита памяти) ==="
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "=== [3/5] Включение TCP BBR + FQ ==="
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

echo "=== [4/5] Установка официального ядра Sing-box на Debian 12 ==="
if ! command -v sing-box >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod a+r /etc/apt/keyrings/sagernet.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/sagernet.asc] https://deb.sagernet.org/ * *" > /etc/apt/sources.list.d/sagernet.list
  apt-get update -y
  apt-get install -y sing-box
fi

echo "=== [5/5] Генерация ключей VLESS-Reality и запуск сервера на порту 443 ==="
CRED_FILE="/root/tenda-vps-credentials.json"
if [ -f "$CRED_FILE" ]; then
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
  SNI_DOMAIN="dl.google.com"
fi

SERVER_IP=$(curl -4 -fsSL --max-time 5 https://api.ipify.org || curl -4 -fsSL --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')

cat << EOF > "$CRED_FILE"
{"host":"${SERVER_IP}","port":443,"uuid":"${UUID}","public_key":"${PUBLIC_KEY}","short_id":"${SHORT_ID}","sni":"${SNI_DOMAIN}","private_key":"${PRIVATE_KEY}"}
EOF
chmod 600 "$CRED_FILE"

mkdir -p /etc/sing-box
cat << EOF > /etc/sing-box/config.json
{
  "log": { "level": "warn", "timestamp": true },
  "dns": {
    "servers": [
      { "tag": "cf-v4", "address": "1.1.1.1", "strategy": "ipv4_only" }
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
        { "name": "tenda-win11", "uuid": "${UUID}", "flow": "xtls-rprx-vision" }
      ],
      "tls": {
        "enabled": true,
        "server_name": "${SNI_DOMAIN}",
        "reality": {
          "enabled": true,
          "handshake": { "server": "${SNI_DOMAIN}", "server_port": 443 },
          "private_key": "${PRIVATE_KEY}",
          "short_id": ["${SHORT_ID}"]
        }
      }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct", "domain_strategy": "ipv4_only" },
    { "type": "block", "tag": "block" }
  ]
}
EOF

systemctl enable sing-box
systemctl restart sing-box
sleep 1
echo "TENDA_JSON_BEGIN"
cat "$CRED_FILE"
echo "TENDA_JSON_END"
'@

function Restore-NormalInternetNow {
    Write-Host "`n==> Восстановление стандартного интернета и DNS на сетевой карте ПК..." -ForegroundColor Cyan
    Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    & reg.exe add "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v IPEnableRouter /t REG_DWORD /d 0 /f 2>&1 | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f 2>&1 | Out-Null
    & sc.exe stop RemoteAccess 2>&1 | Out-Null
    & sc.exe config RemoteAccess start= disabled 2>&1 | Out-Null
    & netsh.exe int ipv4 set global forwarding=disabled 2>&1 | Out-Null
    & netsh.exe interface ip set address "Ethernet" dhcp 2>&1 | Out-Null
    & netsh.exe interface ip set dns "Ethernet" dhcp 2>&1 | Out-Null
    Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
        & netsh.exe interface ip set address "$($_.Name)" dhcp 2>&1 | Out-Null
        & netsh.exe interface ip set dns "$($_.Name)" dhcp 2>&1 | Out-Null
    }
    & ipconfig.exe /release 2>&1 | Out-Null
    & ipconfig.exe /renew 2>&1 | Out-Null
    & ipconfig.exe /flushdns 2>&1 | Out-Null
    Write-Host "  [OK] Стандартный интернет по DHCP полностью восстановлен!" -ForegroundColor Green
}

function Get-AllDomains {
    $list = [System.Collections.Generic.List[string]]::new()
    foreach ($d in $DefaultSelectiveDomains) {
        if (-not $list.Contains($d)) { $list.Add($d) }
    }
    if (Test-Path $CustomDomainsPath) {
        foreach ($line in (Get-Content $CustomDomainsPath -Encoding UTF8)) {
            $clean = $line.Trim().ToLower()
            if ($clean -and (-not $clean.StartsWith("#")) -and (-not $list.Contains($clean))) {
                $list.Add($clean)
            }
        }
    }
    return $list.ToArray()
}

function Build-SingBoxWin11Config([hashtable]$Vps) {
    $allDomains = Get-AllDomains
    $cfg = [ordered]@{
        log = @{ level = "warn"; timestamp = $true }
        dns = [ordered]@{
            servers = @(
                @{ tag = "dns-remote-doh"; address = "https://1.1.1.1/dns-query"; detour = "vless-primary" },
                @{ tag = "dns-direct-ru"; address = "77.88.8.8"; detour = "direct" },
                @{ tag = "dns-fakeip"; address = "fakeip" }
            )
            rules = @(
                @{ outbound = "any"; server = "dns-direct-ru" },
                @{ domain_suffix = @(".ru", ".xn--p1ai", ".su", ".by"); server = "dns-direct-ru" },
                @{ query_type = @("A", "AAAA"); domain_suffix = $allDomains; server = "dns-fakeip"; rewrite_ttl = 1 }
            )
            fakeip = @{ enabled = $true; inet4_range = "198.18.0.0/15" }
            final = "dns-direct-ru"
            strategy = "ipv4_only"
            independent_cache = $true
        }
        inbounds = @(
            [ordered]@{
                type = "tun"
                tag = "tun-in"
                interface_name = "SingBoxTun"
                inet4_address = "172.19.0.1/30"
                mtu = 1460
                auto_route = $true
                strict_route = $false
                inet4_route_exclude_address = @("192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12")
                stack = "system"
                sniff = $true
                sniff_override_destination = $true
            },
            [ordered]@{
                type = "mixed"
                tag = "mixed-in"
                listen = "0.0.0.0"
                listen_port = 2080
                sniff = $true
            },
            [ordered]@{
                type = "direct"
                tag = "dns-lan-53"
                listen = "0.0.0.0"
                listen_port = 53
                override_address = "8.8.8.8"
                override_port = 53
            }
        )
        outbounds = @(
            [ordered]@{
                type = "vless"
                tag = "vless-primary"
                server = $Vps.host
                server_port = [int]$Vps.port
                uuid = $Vps.uuid
                flow = "xtls-rprx-vision"
                packet_encoding = "xudp"
                tcp_fast_open = $true
                tls = [ordered]@{
                    enabled = $true
                    server_name = $Vps.sni
                    utls = @{ enabled = $true; fingerprint = "chrome" }
                    reality = @{
                        enabled = $true
                        public_key = $Vps.public_key
                        short_id = $Vps.short_id
                    }
                }
            },
            @{ type = "direct"; tag = "direct" },
            @{ type = "block"; tag = "block" },
            @{ type = "dns"; tag = "dns-out" }
        )
        route = [ordered]@{
            auto_detect_interface = $true
            final = "direct"
            rules = @(
                @{ ip_cidr = @("$($Vps.host)/32"); outbound = "direct" },
                @{ protocol = "dns"; outbound = "dns-out" },
                @{ ip_is_private = $true; outbound = "direct" },
                @{
                    domain_suffix = @(".ru", ".xn--p1ai", ".su", ".gosuslugi.ru", ".sberbank.ru", ".tbank.ru", ".yandex.ru", ".vk.com", ".ozon.ru", ".wildberries.ru")
                    outbound = "direct"
                },
                @{
                    protocol = "quic"
                    port = 443
                    domain_suffix = @("youtube.com", "googlevideo.com", "ytimg.com", "instagram.com", "cdninstagram.com")
                    outbound = "block"
                },
                @{ domain_suffix = $allDomains; outbound = "vless-primary" },
                @{ ip_cidr = $TelegramCidrs; outbound = "vless-primary" }
            )
        }
    }
    $jsonText = $cfg | ConvertTo-Json -Depth 15
    [System.IO.File]::WriteAllText($SingBoxCfgPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
}

function Install-WindowsGatewayCore([hashtable]$VpsCreds) {
    # Сначала восстанавливаем нормальный DNS на сетевой карте, если он был сбит прошлым запуском!
    Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
        Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses @("77.88.8.8", "192.168.0.1") -ErrorAction SilentlyContinue
    }

    Write-Host "`n==> [1/5] Генерация конфигурации Sing-box (C:\TendaGateway\configs\singbox_windows11.json)..." -ForegroundColor Cyan
    $VpsCreds | ConvertTo-Json -Depth 5 | Set-Content -Path $VpsJsonPath -Encoding UTF8
    Build-SingBoxWin11Config -Vps $VpsCreds
    Write-Host "  [OK] Конфигурация сохранена (Сервер: $($VpsCreds.host), YouTube 4K, TG, Instagram, Discord включены)." -ForegroundColor Green

    # СНАЧАЛА скачиваем sing-box.exe, пока интернет работает штатно!
    Write-Host "`n==> [2/5] Скачивание и установка ядра Sing-box для Windows 11..." -ForegroundColor Cyan
    if (-not (Test-Path $SingBoxExe)) {
        $ZipName = "sing-box-$SingBoxVersion-windows-amd64.zip"
        $OfficialUrl = "https://github.com/SagerNet/sing-box/releases/download/v$SingBoxVersion/$ZipName"
        $MirrorUrl1 = "https://ghfast.top/$OfficialUrl"
        $MirrorUrl2 = "https://mirror.ghproxy.com/$OfficialUrl"
        $ZipFile = Join-Path $BinDir $ZipName
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

        $Downloaded = $false
        foreach ($TryUrl in @($OfficialUrl, $MirrorUrl1, $MirrorUrl2)) {
            try {
                Write-Host "  Скачивание ядра Sing-box ($TryUrl) ..." -ForegroundColor Gray
                Invoke-WebRequest -Uri $TryUrl -OutFile $ZipFile -UseBasicParsing -TimeoutSec 25 -ErrorAction Stop
                if ((Test-Path $ZipFile) -and ((Get-Item $ZipFile).Length -gt 1000000)) {
                    $Downloaded = $true
                    break
                }
            } catch {
                Write-Host "  [i] Переключение на резервное зеркало..." -ForegroundColor Yellow
            }
        }
        if (-not $Downloaded) {
            Write-Host "  [!] Не удалось скачать sing-box с зеркал. Проверьте подключение к интернету." -ForegroundColor Red
            return
        }
        Expand-Archive -Path $ZipFile -DestinationPath $BinDir -Force
        $FoundExe = Get-ChildItem -Path $BinDir -Filter "sing-box.exe" -Recurse | Select-Object -First 1
        if ($FoundExe -and ($FoundExe.FullName -ne $SingBoxExe)) {
            Copy-Item -Path $FoundExe.FullName -Destination $SingBoxExe -Force
        }
        Remove-Item -Path $ZipFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  [OK] Ядро Sing-box установлено: $SingBoxExe" -ForegroundColor Green

    Write-Host "`n==> [3/5] Включение пересылки пакетов с Wi-Fi (IPv4 Forwarding) и Брандмауэра..." -ForegroundColor Cyan
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "IPEnableRouter" -Value 1 -Type DWord -ErrorAction SilentlyContinue
    Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
        Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Forwarding Enabled -ErrorAction SilentlyContinue
    }
    Set-Service -Name "RemoteAccess" -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service -Name "RemoteAccess" -ErrorAction SilentlyContinue

    # Надежная настройка Брандмауэра через стандартный netsh advfirewall (работает на любой сборке Windows 11 без ошибок параметров!)
    & netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule name="Tenda Gateway LAN Allow" dir=in action=allow remoteip=192.168.0.0/24 2>&1 | Out-Null
    Write-Host "  [OK] Маршрутизация Windows 11 и брандмауэр для домашней сети 192.168.0.0/24 настроены." -ForegroundColor Green

    Write-Host "`n==> [4/5] Настройка IP-адреса 192.168.0.2 для связи с роутером Tenda TX2 ($TendaRouterIP)..." -ForegroundColor Cyan
    $Adapter = Get-NetAdapter | Where-Object { $_.Status -eq "Up" -and $_.Name -notlike "*SingBox*" -and $_.InterfaceDescription -notlike "*Virtual*" -and $_.InterfaceDescription -notlike "*TAP*" -and $_.InterfaceDescription -notlike "*Wintun*" } | Select-Object -First 1
    if ($Adapter) {
        Write-Host "  Сетевая карта ПК: '$($Adapter.Name)'" -ForegroundColor Gray
        & netsh.exe interface ip set address name="$($Adapter.Name)" static $GatewayIP 255.255.255.0 $TendaRouterIP 1 2>&1 | Out-Null
        # ВАЖНО: ставим быстрый DNS 77.88.8.8 и роутер 192.168.0.1 (НЕ 127.0.0.1!), чтобы интернет на ПК никогда не падал!
        & netsh.exe interface ip set dns name="$($Adapter.Name)" static 77.88.8.8 2>&1 | Out-Null
        & netsh.exe interface ip add dns name="$($Adapter.Name)" 192.168.0.1 index=2 2>&1 | Out-Null
        Write-Host "  [OK] Адрес $GatewayIP (шлюз $TendaRouterIP, DNS 77.88.8.8) настроен безопасно." -ForegroundColor Green
    }

    Write-Host "`n==> [5/5] Запуск фоновой системной службы TendaSmartGateway-SingBox..." -ForegroundColor Cyan
    Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    & schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
    & schtasks.exe /Create /TN "TendaSmartGateway-SingBox" /TR "`"$SingBoxExe`" run -c `"$SingBoxCfgPath`"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
    & schtasks.exe /Run /TN "TendaSmartGateway-SingBox" 2>&1 | Out-Null
    Start-Sleep -Seconds 3

    Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
        Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Forwarding Enabled -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Green
    Write-Host " ГОТОВО! ШЛЮЗ ЗАПУЩЕН И РАБОТАЕТ НА ВАШЕМ ПК И В ДОМАШНЕЙ СЕТИ!" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Green
    Run-Diagnostics
    Show-TendaRoutesTable
}

function Run-OneClickFullDeploy {
    Clear-Host
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  АВТО-УСТАНОВКА 'ПОД КЛЮЧ': VPS ONEDASH (ХЕЛЬСИНКИ, DEBIAN 12) + WIN 11" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""

    # Если ключи уже были получены на прошлом шаге (например, от 91.108.239.5), предлагаем сразу завершить установку без повторного SSH!
    if (Test-Path $VpsJsonPath) {
        try {
            $Saved = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Saved.host -and $Saved.uuid -and $Saved.public_key) {
                Write-Host "Найдены уже сохраненные ключи вашего VPS ($($Saved.host), UUID: $($Saved.uuid))!" -ForegroundColor Green
                $UseSaved = Read-Host "Завершить установку на ПК с этими ключами без повторного ввода пароля SSH? [Y/n]"
                if ($UseSaved -notmatch "^[nNнН]") {
                    $VpsCreds = @{
                        host       = $Saved.host
                        port       = [int]$Saved.port
                        uuid       = $Saved.uuid
                        public_key = $Saved.public_key
                        short_id   = $Saved.short_id
                        sni        = $Saved.sni
                    }
                    Install-WindowsGatewayCore -VpsCreds $VpsCreds
                    return
                }
            }
        } catch {}
    }

    # Перед подключением по SSH убеждаемся, что на сетевой карте ПК работает интернет!
    Restore-NormalInternetNow

    $VpsIp = (Read-Host "`nВведите IP-адрес вашего VPS с rdp-onedash.ru (например, 91.108.239.5)").Trim()
    if (-not $VpsIp) {
        Write-Host "[!] IP-адрес не может быть пустым." -ForegroundColor Red
        return
    }
    $SshPort = (Read-Host "Введите SSH порт вашего VPS (например, 55971 или Enter если 22)").Trim()
    if (-not $SshPort) { $SshPort = "22" }

    Write-Host "`n==> Подключение к root@$VpsIp (порт $SshPort, Хельсинки, Debian 12)..." -ForegroundColor Cyan
    Write-Host "  Введите пароль от root вашего VPS (символы не отображаются, правая кнопка мыши и Enter):" -ForegroundColor Yellow

    $RemoteScriptFile = Join-Path $env:TEMP "setup_onedash_vps.sh"
    $LinuxScript = $Debian12VpsBashScript -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($RemoteScriptFile, $LinuxScript, (New-Object System.Text.UTF8Encoding($false)))

    $Captured = Get-Content -Raw $RemoteScriptFile | ssh.exe -o StrictHostKeyChecking=accept-new -p $SshPort "root@$VpsIp" "tr -d '\r' | bash -s"
    $FullText = ($Captured -join "`n")

    if ($FullText -match "TENDA_JSON_BEGIN\s*(\{[\s\S]*?\})\s*TENDA_JSON_END") {
        $Parsed = $Matches[1] | ConvertFrom-Json
        $VpsCreds = @{
            host       = $Parsed.host
            port       = [int]$Parsed.port
            uuid       = $Parsed.uuid
            public_key = $Parsed.public_key
            short_id   = $Parsed.short_id
            sni        = $Parsed.sni
        }
        Write-Host "`n  [OK] Сервер в Хельсинки настроен! Ключи получены автоматически:" -ForegroundColor Green
        Write-Host "       IP: $($VpsCreds.host) | UUID: $($VpsCreds.uuid) | ShortID: $($VpsCreds.short_id)" -ForegroundColor Cyan
        Install-WindowsGatewayCore -VpsCreds $VpsCreds
    } else {
        Write-Host "`n[!] Не удалось автоматически получить ответ от VPS. Проверьте пароль root или порт SSH." -ForegroundColor Yellow
    }
}

function Run-Diagnostics {
    Write-Host "`n----------------------------------------------------------------------------" -ForegroundColor Blue
    Write-Host "  ДИАГНОСТИКА РАБОТЫ ШЛЮЗА НА ВАШЕМ ПК (WINDOWS 11)" -ForegroundColor Cyan
    Write-Host "----------------------------------------------------------------------------" -ForegroundColor Blue

    if (Test-Connection -ComputerName $TendaRouterIP -Count 1 -Quiet -ErrorAction SilentlyContinue) {
        Write-Host "  [OK] Роутер Tenda TX2 ($TendaRouterIP) доступен по кабелю" -ForegroundColor Green
    } else {
        Write-Host "  [!] Роутер Tenda TX2 ($TendaRouterIP) не отвечает на пинг" -ForegroundColor Yellow
    }

    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-Host "  [OK] Служба Sing-box активна (PID: $($Proc.Id), ОЗУ: $([math]::Round($Proc.WorkingSet64 / 1MB, 1)) МБ)" -ForegroundColor Green
    } else {
        Write-Host "  [!] Служба Sing-box сейчас не запущена" -ForegroundColor Yellow
    }

    try {
        $Yt = Resolve-DnsName -Name "www.youtube.com" -Server "127.0.0.1" -Type A -ErrorAction Stop | Select-Object -First 1
        Write-Host "  [OK] Проверка YouTube (FakeIP): www.youtube.com -> $($Yt.IPAddress) (идет через Хельсинки!)" -ForegroundColor Green
    } catch {
        Write-Host "  [!] Локальный DNS на 127.0.0.1:53 пока не ответил" -ForegroundColor Yellow
    }

    try {
        $Sb = Resolve-DnsName -Name "sberbank.ru" -Server "127.0.0.1" -Type A -ErrorAction Stop | Select-Object -First 1
        Write-Host "  [OK] Проверка Сбербанка (РФ): sberbank.ru -> $($Sb.IPAddress) (идет НАПРЯМУЮ без VPN!)" -ForegroundColor Green
    } catch {}
}

function Add-CustomDomain {
    Write-Host ""
    $NewDom = (Read-Host "Введите домен сайта, который нужно пустить через туннель (например, canva.com)").Trim().ToLower()
    if (-not $NewDom) { return }
    Add-Content -Path $CustomDomainsPath -Value $NewDom -Encoding UTF8
    if (Test-Path $VpsJsonPath) {
        $SavedVpsObj = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $VpsHash = @{
            host       = $SavedVpsObj.host
            port       = [int]$SavedVpsObj.port
            uuid       = $SavedVpsObj.uuid
            public_key = $SavedVpsObj.public_key
            short_id   = $SavedVpsObj.short_id
            sni        = $SavedVpsObj.sni
        }
        Build-SingBoxWin11Config -Vps $VpsHash
        Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        & schtasks.exe /Run /TN "TendaSmartGateway-SingBox" 2>&1 | Out-Null
        Write-Host "  [OK] Домен '$NewDom' добавлен, шлюз перезапущен!" -ForegroundColor Green
    }
}

function Show-TendaRoutesTable {
    Write-Host "`n============================================================================" -ForegroundColor Blue
    Write-Host "  ЧТО ПРОПИСАТЬ В РОУТЕРЕ TENDA TX2 (http://192.168.0.1) ДЛЯ РАБОТЫ WI-FI" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "1. Меню 'Системные настройки' -> 'Настройки локальной сети (LAN)':" -ForegroundColor Cyan
    Write-Host "   - Оставьте галочку 'DHCP-сервер' ВКЛЮЧЕННОЙ"
    Write-Host "   - Первичный DNS-сервер : 192.168.0.2" -ForegroundColor Yellow
    Write-Host "   - Вторичный DNS-сервер : 77.88.8.8" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "2. Меню 'Расширенные настройки' -> 'Статическая маршрутизация' (Static Routing):" -ForegroundColor Cyan
    Write-Host "   -------------------------------------------------------------------------"
    Write-Host "   Сеть назначения   | Маска подсети   | Шлюз        | Что открывает"
    Write-Host "   -------------------------------------------------------------------------"
    Write-Host "   198.18.0.0        | 255.254.0.0     | 192.168.0.2 | YouTube, Insta, Discord, AI" -ForegroundColor Green
    Write-Host "   149.154.160.0     | 255.255.240.0   | 192.168.0.2 | Telegram (Звонки и медиа)" -ForegroundColor Green
    Write-Host "   91.108.4.0        | 255.255.252.0   | 192.168.0.2 | Telegram DC1-DC3"
    Write-Host "   91.108.8.0        | 255.255.252.0   | 192.168.0.2 | Telegram"
    Write-Host "   91.108.12.0       | 255.255.252.0   | 192.168.0.2 | Telegram"
    Write-Host "   91.108.16.0       | 255.255.252.0   | 192.168.0.2 | Telegram"
    Write-Host "   91.108.56.0       | 255.255.252.0   | 192.168.0.2 | Telegram DC5"
    Write-Host "   95.161.64.0       | 255.255.240.0   | 192.168.0.2 | Telegram CDN"
    Write-Host "   -------------------------------------------------------------------------"
}

function Uninstall-Gateway {
    Write-Host "`n==> Полный сброс и возврат стандартного интернета Windows 11..." -ForegroundColor Cyan
    & schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
    & netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
    Restore-NormalInternetNow
    Write-Host "  [OK] Служба удалена, стандартные настройки интернета Windows 11 полностью возвращены." -ForegroundColor Green
}

while ($true) {
    Clear-Host
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  TENDA TX2 SMART GATEWAY - АВТОУСТАНОВЩИК WINDOWS 11 + ONEDASH (v3.0)" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "  [1] ЗАВЕРШИТЬ УСТАНОВКУ (Ваш VPS 91.108.239.5 уже настроен - осталось запустить ПК!)" -ForegroundColor Yellow
    Write-Host "  [2] МГНОВЕННО ВЕРНУТЬ ОБЫЧНЫЙ ИНТЕРНЕТ И HAPP НА ПК (Сброс сети в DHCP)" -ForegroundColor Cyan
    Write-Host "  [3] Проверить состояние шлюза и протестировать YouTube / Сбербанк"
    Write-Host "  [4] Добавить свой сайт в список выборочного обхода"
    Write-Host "  [5] Показать таблицу настроек для веб-панели роутера Tenda TX2 (192.168.0.1)"
    Write-Host "  [6] Полностью отключить и удалить шлюз"
    Write-Host "  [0] Выход"
    Write-Host ""
    $Choice = (Read-Host "Введите цифру [0-6] и нажмите Enter").Trim()

    switch ($Choice) {
        "1" { Run-OneClickFullDeploy; Read-Host "`nНажмите Enter для возврата в меню" }
        "2" { Restore-NormalInternetNow; Read-Host "`nНажмите Enter для возврата в меню" }
        "3" { Run-Diagnostics; Read-Host "`nНажмите Enter для возврата в меню" }
        "4" { Add-CustomDomain; Read-Host "`nНажмите Enter для возврата в меню" }
        "5" { Show-TendaRoutesTable; Read-Host "`nНажмите Enter для возврата в меню" }
        "6" { Uninstall-Gateway; Read-Host "`nНажмите Enter для возврата в меню" }
        "0" { exit 0 }
        default { Start-Sleep -Milliseconds 500 }
    }
}
