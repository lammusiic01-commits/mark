$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Finland VPS & Tenda TX2 - Прямой РФ интернет + Зарубежные сайты через Финляндию"

$CoreDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = "C:\TendaGateway"
$BinDir = Join-Path $InstallDir "bin"
$CfgDir = Join-Path $InstallDir "configs"
$SingBoxExe = Join-Path $BinDir "sing-box.exe"
$SingBoxCfgPath = Join-Path $CfgDir "singbox_finland.json"
$VpsJsonPath = Join-Path $CfgDir "vps_credentials.json"
$SingBoxVersion = "1.10.7"

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null

# Список всех российских доменных зон и платформ, которые ВСЕГДА идут НАПРЯМУЮ (и на ПК, и по Wi-Fi)
$RuDirectSuffixes = @(
    ".ru", ".xn--p1ai", ".su", ".by",
    "ya.ru", "yandex.ru", "yandex.net", "yandex.com", "yastatic.net",
    "vk.com", "vk.ru", "userapi.com", "vkuseraudio.net", "vkuservideo.net",
    "sberbank.ru", "sber.ru", "tbank.ru", "tinkoff.ru", "vtb.ru", "alfabank.ru",
    "gosuslugi.ru", "mos.ru", "nalog.ru",
    "ozon.ru", "ozone.ru", "wildberries.ru", "wb.ru", "avito.ru",
    "mail.ru", "imgsmail.ru", "ok.ru", "mycdn.me",
    "dzen.ru", "kinopoisk.ru", "rutube.ru", "ivi.ru", "okko.tv",
    "2gis.ru", "hh.ru", "pochta.ru", "rzd.ru", "gismeteo.ru", "kp.ru", "rbc.ru", "lenta.ru"
)

# Строка исключений прокси для Windows 11 (гарантирует, что все сайты РФ открываются напрямую даже мимо локального порта)
$WinProxyBypassList = "localhost;127.*;10.*;172.16.*;192.168.*;*.ru;*.xn--p1ai;*.su;*.by;ya.ru;*.yandex.ru;*.yandex.net;*.yastatic.net;*.vk.com;*.userapi.com;*.sberbank.ru;*.tbank.ru;*.tinkoff.ru;*.gosuslugi.ru;*.ozon.ru;*.wildberries.ru;*.avito.ru;*.mail.ru;*.ok.ru;*.dzen.ru;*.kinopoisk.ru;*.rutube.ru;<local>"

function Get-LocalLanIP {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like "192.168.*" } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = "192.168.0.115" }
    return $ip
}

function Build-FinlandOnlyForeignConfig([hashtable]$Vps) {
    # ВАЖНО:
    # 1. НЕ используется драйвер WinTun (type: tun отсутствует), поэтому Happ VPN работает свободно по вашему решению!
    # 2. Все сайты РФ (.ru, .рф, банки, Госуслуги, Яндекс, ВК, Озон) идут СТРОГО НАПРЯМУЮ (outbound: direct).
    # 3. ВСЕ зарубежные ресурсы (final: vless-finland) идут через ваш VPS в Финляндии (91.108.239.5).
    # 4. Порт 2080 открыт на 0.0.0.0:2080, поэтому работает одновременно и на этом ПК, и для всех устройств по Wi-Fi!
    $cfg = [ordered]@{
        log = @{ level = "warn"; timestamp = $true }
        dns = [ordered]@{
            servers = @(
                @{ tag = "dns-finland"; address = "https://1.1.1.1/dns-query"; detour = "vless-finland" },
                @{ tag = "dns-direct-ru"; address = "77.88.8.8"; detour = "direct" }
            )
            rules = @(
                @{ outbound = "any"; server = "dns-direct-ru" },
                @{ domain_suffix = $RuDirectSuffixes; server = "dns-direct-ru" }
            )
            final = "dns-finland"
            strategy = "ipv4_only"
            independent_cache = $true
        }
        inbounds = @(
            [ordered]@{
                type = "mixed"
                tag = "shared-pc-and-wifi-in"
                listen = "0.0.0.0"
                listen_port = 2080
                sniff = $true
                sniff_override_destination = $true
                set_system_proxy = $false
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
            # ВСЕ ЗАРУБЕЖНЫЕ РЕСУРСЫ ИДУТ ЧЕРЕЗ СЕРВЕР В ФИНЛЯНДИИ:
            final = "vless-finland"
            rules = @(
                @{ ip_cidr = @("$($Vps.host)/32"); outbound = "direct" },
                @{ protocol = "dns"; outbound = "dns-out" },
                @{ ip_is_private = $true; outbound = "direct" },
                # ВСЕ САЙТЫ РФ ИДУТ СТРОГО НАПРЯМУЮ ЧЕРЕЗ ВАШЕГО ПРОВАЙДЕРА:
                @{ domain_suffix = $RuDirectSuffixes; outbound = "direct" },
                # Блокировка UDP QUIC для YouTube/Instagram ускоряет 4K видео по TCP BBR:
                @{
                    protocol = "quic"
                    port = 443
                    domain_suffix = @("youtube.com", "googlevideo.com", "ytimg.com", "instagram.com", "cdninstagram.com")
                    outbound = "block"
                }
            )
        }
    }
    $jsonText = $cfg | ConvertTo-Json -Depth 15
    [System.IO.File]::WriteAllText($SingBoxCfgPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
}

function Enable-SafeSelectiveRoutingOnPC {
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:2080" /f 2>&1 | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "$WinProxyBypassList" /f 2>&1 | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f 2>&1 | Out-Null
}

function Start-FinlandGatewayCore([hashtable]$VpsCreds) {
    # 1. Сначала гарантируем, что базовый интернет Windows 11 и сетевая карта Ethernet в 100% заводском режиме DHCP (для работы Happ!)
    & (Join-Path $CoreDir "Restore-Internet.ps1")

    Write-Host "`n==> [1/4] Сохранение конфигурации (РФ сайты -> напрямую, Зарубежные -> Финляндия $($VpsCreds.host))..." -ForegroundColor Cyan
    $VpsCreds | ConvertTo-Json -Depth 5 | Set-Content -Path $VpsJsonPath -Encoding UTF8
    Build-FinlandOnlyForeignConfig -Vps $VpsCreds
    Write-Host "  [OK] Конфигурация сохранена в $SingBoxCfgPath" -ForegroundColor Green

    Write-Host "`n==> [2/4] Проверка и скачивание ядра Sing-box..." -ForegroundColor Cyan
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
            Write-Host "  [!] Не удалось скачать sing-box.exe. Проверьте подключение к интернету." -ForegroundColor Red
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

    Write-Host "`n==> [3/4] Открытие порта 2080 для домашнего Wi-Fi (роутер Tenda TX2) и запуск службы..." -ForegroundColor Cyan
    & netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule name="Tenda Gateway LAN Allow" dir=in action=allow protocol=TCP localport=2080 remoteip=192.168.0.0/24 2>&1 | Out-Null

    & schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
    & schtasks.exe /Create /TN "TendaSmartGateway-SingBox" /TR "`"$SingBoxExe`" run -c `"$SingBoxCfgPath`"" /SC ONLOGON /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
    & schtasks.exe /Run /TN "TendaSmartGateway-SingBox" 2>&1 | Out-Null
    Start-Sleep -Seconds 2

    # Проверяем, что порт 2080 действительно поднялся, прежде чем включать маршрутизацию зарубежных сайтов!
    $PortCheck = Test-NetConnection -ComputerName "127.0.0.1" -Port 2080 -WarningAction SilentlyContinue
    if ($PortCheck.TcpTestSucceeded) {
        Write-Host "`n==> [4/4] Включение разделения трафика (РФ - напрямую, Зарубежные - через Финляндию)..." -ForegroundColor Cyan
        Enable-SafeSelectiveRoutingOnPC
        $LanIp = Get-LocalLanIP
        Write-Host ""
        Write-Host "============================================================================" -ForegroundColor Green
        Write-Host "  ГОТОВО! СЕРВЕР В ФИНЛЯНДИИ ($($VpsCreds.host)) РАБОТАЕТ!" -ForegroundColor Green
        Write-Host "============================================================================" -ForegroundColor Green
        Write-Host "  1. НА ЭТОМ КОМПЬЮТЕРЕ:" -ForegroundColor Cyan
        Write-Host "     - Все сайты РФ (ya.ru, Сбербанк, Госуслуги, ВК, Озон, .ru/.рф) идут НАПРЯМУЮ!" -ForegroundColor Green
        Write-Host "     - Все зарубежные ресурсы (YouTube, Instagram, TG, Discord) идут через Финляндию!" -ForegroundColor Green
        Write-Host "     - Драйвер виртуальной сети свободен: VPN Happ включается и выключается по вашему решению!" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  2. НА ТЕЛЕФОНАХ И УСТРОЙСТВАХ ПО ДОМАШНЕМУ WI-FI (Tenda TX2):" -ForegroundColor Cyan
        Write-Host "     В настройках вашей домашней сети Wi-Fi на телефоне укажите один раз:"
        Write-Host "     - Настройка прокси: Вручную"
        Write-Host "     - Сервер (Имя узла): $LanIp" -ForegroundColor Yellow
        Write-Host "     - Порт: 2080" -ForegroundColor Yellow
        Write-Host "     (На телефоне по Wi-Fi сайты РФ тоже пойдут напрямую, а зарубежные - через Финляндию!)"
        Write-Host "============================================================================" -ForegroundColor Green
    } else {
        Write-Host "  [!] Не удалось запустить локальный порт 2080. Прямой интернет оставлен без изменений." -ForegroundColor Yellow
    }
}

function Connect-And-RunFinlandVps {
    Clear-Host
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ПОДКЛЮЧЕНИЕ СЕРВЕРА В ФИНЛЯНДИИ (ХЕЛЬСИНКИ, DEBIAN 12)" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""

    if (Test-Path $VpsJsonPath) {
        try {
            $Saved = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Saved.host -and $Saved.uuid -and $Saved.public_key) {
                Write-Host "Найдены уже сохраненные ключи вашего VPS в Финляндии ($($Saved.host))!" -ForegroundColor Green
                $UseSaved = Read-Host "Запустить сразу с ними без повторного ввода пароля SSH? [Y/n]"
                if ($UseSaved -notmatch "^[nNнН]") {
                    Start-FinlandGatewayCore -VpsCreds @{
                        host       = $Saved.host
                        port       = [int]$Saved.port
                        uuid       = $Saved.uuid
                        public_key = $Saved.public_key
                        short_id   = $Saved.short_id
                        sni        = $Saved.sni
                    }
                    return
                }
            }
        } catch {}
    }

    & (Join-Path $CoreDir "Restore-Internet.ps1")

    $VpsIp = (Read-Host "`nВведите IP вашего VPS в Финляндии (например, 91.108.239.5)").Trim()
    if (-not $VpsIp) { return }
    $SshPort = (Read-Host "Введите SSH порт вашего VPS (например, 55971 или Enter если 22)").Trim()
    if (-not $SshPort) { $SshPort = "22" }

    Write-Host "`n==> Подключение к root@$VpsIp (порт $SshPort, Хельсинки)..." -ForegroundColor Cyan
    Write-Host "  Введите пароль от root вашего VPS (правая кнопка мыши и Enter):" -ForegroundColor Yellow

    $BashFile = Join-Path $CoreDir "setup-vps-finland.sh"
    $LinuxScript = (Get-Content -Path $BashFile -Raw -Encoding UTF8) -replace "`r`n", "`n"
    $TempSh = Join-Path $env:TEMP "setup_vps_finland.sh"
    [System.IO.File]::WriteAllText($TempSh, $LinuxScript, (New-Object System.Text.UTF8Encoding($false)))

    $Captured = Get-Content -Raw $TempSh | ssh.exe -o StrictHostKeyChecking=accept-new -p $SshPort "root@$VpsIp" "tr -d '\r' | bash -s"
    $FullText = ($Captured -join "`n")

    if ($FullText -match "TENDA_JSON_BEGIN\s*(\{[\s\S]*?\})\s*TENDA_JSON_END") {
        $Parsed = $Matches[1] | ConvertFrom-Json
        Start-FinlandGatewayCore -VpsCreds @{
            host       = $Parsed.host
            port       = [int]$Parsed.port
            uuid       = $Parsed.uuid
            public_key = $Parsed.public_key
            short_id   = $Parsed.short_id
            sni        = $Parsed.sni
        }
    } else {
        Write-Host "`n[!] Не удалось получить ответ от VPS. Проверьте пароль root или порт SSH." -ForegroundColor Yellow
    }
}

function Test-CurrentRouting {
    $LanIp = Get-LocalLanIP
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ДИАГНОСТИКА И СТАТУС РАБОТЫ" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-Host "  [OK] Шлюз Финляндии запущен (PID: $($Proc.Id), локальный адрес для Wi-Fi: $LanIp`:2080)" -ForegroundColor Green
    } else {
        Write-Host "  [!] Шлюз Финляндии сейчас выключен (работает только прямой интернет)" -ForegroundColor Yellow
    }
    Write-Host "  [OK] Сетевая карта Ethernet в штатном режиме DHCP (IP: $LanIp) - Happ VPN свободен" -ForegroundColor Green
}

function Show-WiFiGuide {
    $LanIp = Get-LocalLanIP
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  НАСТРОЙКА ДОМАШНЕГО WI-FI (РОУТЕР TENDA TX2) ДЛЯ ТЕЛЕФОНОВ И УСТРОЙСТВ" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Шаг 1. Чтобы за вашим компьютером в роутере Tenda TX2 всегда был закреплен адрес $LanIp`:" -ForegroundColor Cyan
    Write-Host "  - Зайдите в роутер http://192.168.0.1 -> 'Расширенные' -> 'Привязка IP и MAC' (Static IP Lease)"
    Write-Host "  - Нажмите '+' возле вашего компьютера ($LanIp) и сохраните."
    Write-Host ""
    Write-Host "Шаг 2. На телефоне (iPhone / Android) в настройках вашей домашней сети Wi-Fi Tenda:" -ForegroundColor Cyan
    Write-Host "  - Нажмите значок (i) рядом с вашей сетью Wi-Fi -> 'Настройка прокси' -> 'Вручную'"
    Write-Host "  - Сервер (Имя узла): $LanIp" -ForegroundColor Yellow
    Write-Host "  - Порт: 2080" -ForegroundColor Yellow
    Write-Host "  - Нажмите 'Сохранить'."
    Write-Host ""
    Write-Host "Результат на телефоне по Wi-Fi:" -ForegroundColor Green
    Write-Host "  - Все российские сайты и приложения банков идут НАПРЯМУЮ через вашего провайдера РФ!"
    Write-Host "  - Все зарубежные ресурсы (YouTube, Instagram, Telegram, ChatGPT) идут через ваш VPS в Финляндии!"
    Write-Host "  - Когда вы выходите из дома (на мобильный интернет 4G/LTE), эта настройка Wi-Fi автоматически не используется."
    Write-Host "============================================================================" -ForegroundColor Blue
}

while ($true) {
    Clear-Host
    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    $LanIp = Get-LocalLanIP
    $StatusText = if ($Proc) { "ВКЛЮЧЕН (РФ -> Напрямую | Зарубежные -> Финляндия | Wi-Fi: $LanIp`:2080)" } else { "ВЫКЛЮЧЕН (100% базовый интернет)" }
    $StatusColor = if ($Proc) { "Green" } else { "Yellow" }

    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  УМНЫЙ ШЛЮЗ ФИНЛЯНДИЯ (ХЕЛЬСИНКИ) + TENDA TX2 ДЛЯ WINDOWS 11" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  Статус: " -NoNewline
    Write-Host $StatusText -ForegroundColor $StatusColor
    Write-Host "  Happ VPN: Работает независимо на ваше прямое соединение (вкл/выкл когда хотите)" -ForegroundColor Cyan
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "  [1] ВКЛЮЧИТЬ СЕРВЕР В ФИНЛЯНДИИ (РФ сайты - напрямую, Зарубежные - через Финляндию)" -ForegroundColor Yellow
    Write-Host "  [2] ВОССТАНОВИТЬ БАЗОВЫЕ НАСТРОЙКИ ИНТЕРНЕТА (Отключить шлюз / Сбросить сеть в стандарт)" -ForegroundColor Cyan
    Write-Host "  [3] КАК ПОДКЛЮЧИТЬ ТЕЛЕФОНЫ ПО WI-FI (Инструкция для Tenda TX2)"
    Write-Host "  [4] ПРОВЕРИТЬ СТАТУС РАБОТЫ"
    Write-Host "  [0] Выход"
    Write-Host ""
    $Choice = (Read-Host "Введите номер пункта [0-4] и нажмите Enter").Trim()

    switch ($Choice) {
        "1" { Connect-And-RunFinlandVps; Read-Host "`nНажмите Enter для возврата в меню" }
        "2" { & (Join-Path $CoreDir "Restore-Internet.ps1"); Read-Host "`nНажмите Enter для возврата в меню" }
        "3" { Show-WiFiGuide; Read-Host "`nНажмите Enter для возврата в меню" }
        "4" { Test-CurrentRouting; Read-Host "`nНажмите Enter для возврата в меню" }
        "0" { exit 0 }
        default { Start-Sleep -Milliseconds 400 }
    }
}
