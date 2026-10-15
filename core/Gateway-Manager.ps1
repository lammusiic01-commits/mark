$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Tenda TX2 & OneDash Finland - Менеджер выборочного обхода и Happ VPN"

$CoreDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = "C:\TendaGateway"
$BinDir = Join-Path $InstallDir "bin"
$CfgDir = Join-Path $InstallDir "configs"
$SingBoxExe = Join-Path $BinDir "sing-box.exe"
$SingBoxCfgPath = Join-Path $CfgDir "singbox_windows11.json"
$VpsJsonPath = Join-Path $CfgDir "vps_credentials.json"
$CustomDomainsPath = Join-Path $CfgDir "custom_domains.txt"
$HappLinkFile = Join-Path ([Environment]::GetFolderPath("Desktop")) "HAPP-FINLAND-LINK.txt"
$SingBoxVersion = "1.10.7"

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null

# Полный список доменов для выборочного обхода (YouTube 4K, Telegram, Instagram/Meta, Discord + Голос, ChatGPT/Claude/Gemini, Spotify, X, Rutracker)
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

$TelegramCidrs = @(
    "91.105.192.0/23", "91.108.4.0/22", "91.108.8.0/22", "91.108.12.0/22",
    "91.108.16.0/22", "91.108.20.0/22", "91.108.56.0/22", "95.161.64.0/20",
    "149.154.160.0/20", "185.76.151.0/24"
)

function Get-VlessUri([hashtable]$Vps) {
    return "vless://$($Vps.uuid)@$($Vps.host):$($Vps.port)?encryption=none&flow=xtls-rprx-vision&security=reality&sni=$($Vps.sni)&fp=chrome&pbk=$($Vps.public_key)&sid=$($Vps.short_id)&type=tcp#Finland-Helsinki-OneDash"
}

function Save-And-ShowHappLink([hashtable]$Vps) {
    $Uri = Get-VlessUri -Vps $Vps
    Set-Content -Path $HappLinkFile -Value $Uri -Encoding UTF8
    try { Set-Clipboard -Value $Uri -ErrorAction SilentlyContinue } catch {}

    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ВАША ГОТОВАЯ ССЫЛКА VLESS-REALITY ДЛЯ HAPP (СКОПИРОВАНА В БУФЕР ОБМЕНА!)" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "  $Uri" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  - Эта ссылка также сохранена на Рабочем столе в файле: HAPP-FINLAND-LINK.txt" -ForegroundColor Cyan
    Write-Host "  - Вы можете вставить ее в приложение Happ на ПК или переслать себе на телефон!" -ForegroundColor Cyan
    Write-Host "============================================================================" -ForegroundColor Blue
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

function Build-SafeSingBoxConfig([hashtable]$Vps) {
    # ВАЖНО: Конфиг НЕ трогает физическую сетевую карту Ethernet и НЕ слушает порт 53 на хосте,
    # а использует безопасный виртуальный интерфейс SingBoxTun (как в штатных клиентах) + порт 2080 для Wi-Fi!
    $allDomains = Get-AllDomains
    $cfg = [ordered]@{
        log = @{ level = "warn"; timestamp = $true }
        dns = [ordered]@{
            servers = @(
                @{ tag = "dns-remote"; address = "https://1.1.1.1/dns-query"; detour = "vless-finland" },
                @{ tag = "dns-ru"; address = "77.88.8.8"; detour = "direct" },
                @{ tag = "dns-fakeip"; address = "fakeip" }
            )
            rules = @(
                @{ outbound = "any"; server = "dns-ru" },
                @{ domain_suffix = @(".ru", ".xn--p1ai", ".su", ".by"); server = "dns-ru" },
                @{ query_type = @("A", "AAAA"); domain_suffix = $allDomains; server = "dns-fakeip"; rewrite_ttl = 1 }
            )
            fakeip = @{ enabled = $true; inet4_range = "198.18.0.0/15" }
            final = "dns-ru"
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
                tag = "lan-proxy-2080"
                listen = "0.0.0.0"
                listen_port = 2080
                sniff = $true
            }
        )
        outbounds = @(
            [ordered]@{
                type = "vless"
                tag = "vless-finland"
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
                    domain_suffix = @(".ru", ".xn--p1ai", ".su", ".gosuslugi.ru", ".sberbank.ru", ".tbank.ru", ".yandex.ru", ".ya.ru", ".vk.com", ".ozon.ru", ".wildberries.ru")
                    outbound = "direct"
                },
                @{
                    protocol = "quic"
                    port = 443
                    domain_suffix = @("youtube.com", "googlevideo.com", "ytimg.com", "instagram.com", "cdninstagram.com")
                    outbound = "block"
                },
                @{ domain_suffix = $allDomains; outbound = "vless-finland" },
                @{ ip_cidr = $TelegramCidrs; outbound = "vless-finland" }
            )
        }
    }
    $jsonText = $cfg | ConvertTo-Json -Depth 15
    [System.IO.File]::WriteAllText($SingBoxCfgPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
}

function Start-SafeSelectiveTunnel([hashtable]$VpsCreds) {
    # Гарантируем, что физическая сетевая карта Ethernet работает в штатном автоматическом режиме DHCP!
    & (Join-Path $CoreDir "Repair-Network.ps1")

    Write-Host "`n==> [1/3] Сохранение ключей VPS ($($VpsCreds.host)) и генерация ссылки для Happ..." -ForegroundColor Cyan
    $VpsCreds | ConvertTo-Json -Depth 5 | Set-Content -Path $VpsJsonPath -Encoding UTF8
    Build-SafeSingBoxConfig -Vps $VpsCreds
    Save-And-ShowHappLink -Vps $VpsCreds

    Write-Host "`n==> [2/3] Проверка наличия ядра Sing-box для Windows 11..." -ForegroundColor Cyan
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
                Write-Host "  Скачивание $TryUrl ..." -ForegroundColor Gray
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
            Write-Host "  [!] Не удалось автоматически скачать sing-box.exe. Но ваша ссылка vless:// для Happ уже готова выше!" -ForegroundColor Yellow
            return
        }
        Expand-Archive -Path $ZipFile -DestinationPath $BinDir -Force
        $FoundExe = Get-ChildItem -Path $BinDir -Filter "sing-box.exe" -Recurse | Select-Object -First 1
        if ($FoundExe -and ($FoundExe.FullName -ne $SingBoxExe)) {
            Copy-Item -Path $FoundExe.FullName -Destination $SingBoxExe -Force
        }
        Remove-Item -Path $ZipFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  [OK] Ядро Sing-box готово: $SingBoxExe" -ForegroundColor Green

    Write-Host "`n==> [3/3] Запуск выборочного обхода (БЕЗ изменения настроек сетевой карты Ethernet!)..." -ForegroundColor Cyan
    & netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule name="Tenda Gateway LAN Allow" dir=in action=allow protocol=TCP localport=2080 remoteip=192.168.0.0/24 2>&1 | Out-Null

    & schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
    & schtasks.exe /Create /TN "TendaSmartGateway-SingBox" /TR "`"$SingBoxExe`" run -c `"$SingBoxCfgPath`"" /SC ONLOGON /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
    & schtasks.exe /Run /TN "TendaSmartGateway-SingBox" 2>&1 | Out-Null
    Start-Sleep -Seconds 3

    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-Host "  [OK] Выборочный туннель запущен (PID: $($Proc.Id))!" -ForegroundColor Green
        Write-Host "  - YouTube, Telegram, Instagram, Discord, ChatGPT идут через Хельсинки ($($VpsCreds.host))" -ForegroundColor Green
        Write-Host "  - ya.ru, Сбербанк, Госуслуги, игры и все сайты .ru идут НАПРЯМУЮ!" -ForegroundColor Green
        Write-Host "  - Внимание: не включайте одновременно Happ и встроенный туннель (используйте что-то одно)." -ForegroundColor Yellow
    }
}

function Setup-And-ConnectVps {
    Clear-Host
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ПОДКЛЮЧЕНИЕ VPS ONEDASH (ХЕЛЬСИНКИ, DEBIAN 12) + ВЫБОРОЧНЫЙ ОБХОД" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""

    if (Test-Path $VpsJsonPath) {
        try {
            $Saved = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Saved.host -and $Saved.uuid -and $Saved.public_key) {
                Write-Host "На вашем ПК уже сохранены ключи от VPS Хельсинки ($($Saved.host))!" -ForegroundColor Green
                $UseSaved = Read-Host "Использовать их без повторного подключения по SSH? [Y/n]"
                if ($UseSaved -notmatch "^[nNнН]") {
                    $VpsCreds = @{
                        host       = $Saved.host
                        port       = [int]$Saved.port
                        uuid       = $Saved.uuid
                        public_key = $Saved.public_key
                        short_id   = $Saved.short_id
                        sni        = $Saved.sni
                    }
                    Start-SafeSelectiveTunnel -VpsCreds $VpsCreds
                    return
                }
            }
        } catch {}
    }

    $VpsIp = (Read-Host "Введите IP вашего VPS (например, 91.108.239.5)").Trim()
    if (-not $VpsIp) { return }
    $SshPort = (Read-Host "Введите SSH порт вашего VPS (например, 55971 или Enter если 22)").Trim()
    if (-not $SshPort) { $SshPort = "22" }

    Write-Host "`n==> Подключение к root@$VpsIp (порт $SshPort)..." -ForegroundColor Cyan
    Write-Host "  Введите пароль от root вашего VPS (правая кнопка мыши и Enter):" -ForegroundColor Yellow

    $BashFile = Join-Path $CoreDir "setup-vps-helsinki.sh"
    $LinuxScript = (Get-Content -Path $BashFile -Raw -Encoding UTF8) -replace "`r`n", "`n"
    $TempSh = Join-Path $env:TEMP "setup_vps_clean.sh"
    [System.IO.File]::WriteAllText($TempSh, $LinuxScript, (New-Object System.Text.UTF8Encoding($false)))

    $Captured = Get-Content -Raw $TempSh | ssh.exe -o StrictHostKeyChecking=accept-new -p $SshPort "root@$VpsIp" "tr -d '\r' | bash -s"
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
        Start-SafeSelectiveTunnel -VpsCreds $VpsCreds
    } else {
        Write-Host "`n[!] Не удалось получить ключи по SSH. Проверьте пароль или порт." -ForegroundColor Yellow
    }
}

function Stop-SelectiveTunnelOnly {
    Write-Host "`n==> Остановка встроенного фонового туннеля Sing-box..." -ForegroundColor Cyan
    & schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
    Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    & ipconfig.exe /flushdns 2>&1 | Out-Null
    Write-Host "  [OK] Встроенный туннель остановлен. Теперь вы можете свободно включать Happ VPN!" -ForegroundColor Green
}

function Show-WiFiInstructions {
    $LocalIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
    if (-not $LocalIp) { $LocalIp = "192.168.0.115" }
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  КАК ПОДКЛЮЧИТЬ ТЕЛЕФОНЫ И ТВ ДОМА ПО WI-FI (2 БЕЗОПАСНЫХ СПОСОБА)" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Способ А (На телефоне через Happ / Streisand / v2rayNG - работает везде, даже вне дома):" -ForegroundColor Cyan
    Write-Host "  1. Нажмите пункт [3] в главном меню - скопируйте вашу ссылку vless://..."
    Write-Host "  2. Отправьте ее себе в Избранное Telegram и добавьте в Happ на телефоне."
    Write-Host ""
    Write-Host "Способ Б (По домашнему Wi-Fi через ваш ПК без включения VPN на телефоне):" -ForegroundColor Cyan
    Write-Host "  Когда на ПК запущен наш выборочный туннель (пункт [2]), он открывает в вашей"
    Write-Host "  домашней сети Tenda TX2 локальный умный прокси на порту 2080:"
    Write-Host "  - В настройках Wi-Fi на телефоне/ТВ выберите 'Прокси -> Вручную'"
    Write-Host "  - Сервер: $LocalIp   |   Порт: 2080" -ForegroundColor Yellow
    Write-Host "  (При этом все российские сайты и банки на телефоне тоже будут идти НАПРЯМУЮ!)"
    Write-Host "============================================================================" -ForegroundColor Blue
}

while ($true) {
    Clear-Host
    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    $StatusText = if ($Proc) { "АКТИВЕН (PID: $($Proc.Id))" } else { "ВЫКЛЮЧЕН (Свободно для Happ VPN)" }
    $StatusColor = if ($Proc) { "Green" } else { "Yellow" }

    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  TENDA TX2 & ONEDASH (ХЕЛЬСИНКИ) - ЧИСТАЯ СБОРКА ДЛЯ WINDOWS 11" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  Статус встроенного туннеля: " -NoNewline
    Write-Host $StatusText -ForegroundColor $StatusColor
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "  [1] ВОССТАНОВИТЬ БАЗОВЫЕ НАСТРОЙКИ ИНТЕРНЕТА И ПОЧИНИТЬ HAPP VPN" -ForegroundColor Cyan
    Write-Host "  [2] ЗАПУСТИТЬ АВТОМАТИЧЕСКИЙ ВЫБОРОЧНЫЙ ОБХОД (YouTube/TG/Insta/Discord без VPN)" -ForegroundColor Yellow
    Write-Host "  [3] ПОЛУЧИТЬ ССЫЛКУ VLESS:// ВАШЕГО СЕРВЕРА (для импорта в Happ на ПК и телефоне)" -ForegroundColor Green
    Write-Host "  [4] ОСТАНОВИТЬ ВСТРОЕННЫЙ ТУННЕЛЬ (чтобы пользоваться через приложение Happ)"
    Write-Host "  [5] КАК ПОДКЛЮЧИТЬ ТЕЛЕФОНЫ И ТВ ПО WI-FI (Инструкция)"
    Write-Host "  [0] Выход"
    Write-Host ""
    $Choice = (Read-Host "Введите номер пункта [0-5] и нажмите Enter").Trim()

    switch ($Choice) {
        "1" {
            & (Join-Path $CoreDir "Repair-Network.ps1")
            Read-Host "`nНажмите Enter для возврата в меню"
        }
        "2" {
            Setup-And-ConnectVps
            Read-Host "`nНажмите Enter для возврата в меню"
        }
        "3" {
            if (Test-Path $VpsJsonPath) {
                $Saved = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
                Save-And-ShowHappLink -Vps @{
                    host       = $Saved.host
                    port       = [int]$Saved.port
                    uuid       = $Saved.uuid
                    public_key = $Saved.public_key
                    short_id   = $Saved.short_id
                    sni        = $Saved.sni
                }
            } else {
                Write-Host "`n[i] Сначала подключите ваш VPS через пункт [2], чтобы сгенерировать ссылку!" -ForegroundColor Yellow
            }
            Read-Host "`nНажмите Enter для возврата в меню"
        }
        "4" {
            Stop-SelectiveTunnelOnly
            Read-Host "`nНажмите Enter для возврата в меню"
        }
        "5" {
            Show-WiFiInstructions
            Read-Host "`nНажмите Enter для возврата в меню"
        }
        "0" { exit 0 }
        default { Start-Sleep -Milliseconds 400 }
    }
}
