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
$SingBoxLogPath = "C:/TendaGateway/singbox.log"
$VpsJsonPath = Join-Path $CfgDir "vps_credentials.json"
$SingBoxVersion = "1.10.7"

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null

# Список исключений для прокси Windows 11: ВСЕ сайты РФ идут 100% напрямую мимо прокси!
$WinProxyBypassList = "localhost;127.*;10.*;172.16.*;192.168.*;*.ru;*.xn--p1ai;*.su;*.by;ya.ru;*.yandex.ru;*.yandex.net;*.yastatic.net;*.vk.com;*.userapi.com;*.sberbank.ru;*.tbank.ru;*.tinkoff.ru;*.gosuslugi.ru;*.ozon.ru;*.wildberries.ru;*.avito.ru;*.mail.ru;*.ok.ru;*.dzen.ru;*.kinopoisk.ru;*.rutube.ru;<local>"

function Refresh-WinInetProxy {
    try {
        if (-not ("WinInetHelper" -as [type])) {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinInetHelper {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int lpdwBufferLength);
    public static void Refresh() {
        InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    }
}
"@ -ErrorAction SilentlyContinue
        }
        [WinInetHelper]::Refresh()
    } catch {}
}

function Get-LocalLanIP {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like "192.168.*" } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = "192.168.0.115" }
    return $ip
}

function Build-FinlandOnlyForeignConfig([hashtable]$Vps) {
    # Литеральный JSON-шаблон (без багов сериализации массивов PowerShell!)
    $HostIp = $Vps.host
    $PortNum = [int]$Vps.port
    $UuidStr = $Vps.uuid
    $SniStr = $Vps.sni
    $PubKeyStr = $Vps.public_key
    $ShortIdStr = $Vps.short_id

    $JsonContent = @"
{
  "log": {
    "level": "info",
    "output": "$SingBoxLogPath",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "dns-finland",
        "address": "https://1.1.1.1/dns-query",
        "detour": "vless-finland"
      },
      {
        "tag": "dns-direct-ru",
        "address": "77.88.8.8",
        "detour": "direct"
      }
    ],
    "rules": [
      {
        "outbound": "any",
        "server": "dns-direct-ru"
      },
      {
        "domain_suffix": [
          ".ru",
          ".xn--p1ai",
          ".su",
          ".by",
          "ya.ru",
          "yandex.ru",
          "yandex.net",
          "yastatic.net",
          "vk.com",
          "userapi.com",
          "sberbank.ru",
          "tbank.ru",
          "tinkoff.ru",
          "gosuslugi.ru",
          "ozon.ru",
          "wildberries.ru",
          "avito.ru",
          "mail.ru",
          "dzen.ru",
          "kinopoisk.ru",
          "rutube.ru"
        ],
        "server": "dns-direct-ru"
      }
    ],
    "final": "dns-finland",
    "strategy": "ipv4_only",
    "independent_cache": true
  },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "shared-pc-and-wifi-in",
      "listen": "0.0.0.0",
      "listen_port": 2080,
      "sniff": true,
      "sniff_override_destination": true,
      "set_system_proxy": false
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "vless-finland",
      "server": "$HostIp",
      "server_port": $PortNum,
      "uuid": "$UuidStr",
      "flow": "xtls-rprx-vision",
      "packet_encoding": "xudp",
      "tcp_fast_open": true,
      "tls": {
        "enabled": true,
        "server_name": "$SniStr",
        "utls": {
          "enabled": true,
          "fingerprint": "chrome"
        },
        "reality": {
          "enabled": true,
          "public_key": "$PubKeyStr",
          "short_id": "$ShortIdStr"
        }
      }
    },
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    },
    {
      "type": "dns",
      "tag": "dns-out"
    }
  ],
  "route": {
    "auto_detect_interface": true,
    "final": "vless-finland",
    "rules": [
      {
        "ip_cidr": [
          "$HostIp/32"
        ],
        "outbound": "direct"
      },
      {
        "protocol": "dns",
        "outbound": "dns-out"
      },
      {
        "ip_is_private": true,
        "outbound": "direct"
      },
      {
        "domain_suffix": [
          ".ru",
          ".xn--p1ai",
          ".su",
          ".by",
          "ya.ru",
          "yandex.ru",
          "yandex.net",
          "yastatic.net",
          "vk.com",
          "userapi.com",
          "sberbank.ru",
          "tbank.ru",
          "tinkoff.ru",
          "gosuslugi.ru",
          "ozon.ru",
          "wildberries.ru",
          "avito.ru",
          "mail.ru",
          "dzen.ru",
          "kinopoisk.ru",
          "rutube.ru"
        ],
        "outbound": "direct"
      }
    ]
  }
}
"@
    [System.IO.File]::WriteAllText($SingBoxCfgPath, $JsonContent, (New-Object System.Text.UTF8Encoding($false)))
}

function Enable-SafeSelectiveRoutingOnPC {
    # 1. Блокируем браузерный UDP 443 (QUIC), чтобы Яндекс.Браузер и Chrome не шли в обход прокси напрямую к ТСПУ!
    & netsh.exe advfirewall firewall delete rule name="Block-Browser-QUIC-UDP443" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule name="Block-Browser-QUIC-UDP443" dir=out action=block protocol=UDP remoteport=443 2>&1 | Out-Null

    # 2. Включаем прокси Windows с прямым обходом для всех сайтов РФ (.ru / .рф / ya.ru / банки / Госуслуги)
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:2080" /f 2>&1 | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "$WinProxyBypassList" /f 2>&1 | Out-Null
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f 2>&1 | Out-Null

    # 3. Мгновенно уведомляем открытые окна Яндекс.Браузера / Chrome / Edge без их перезапуска!
    Refresh-WinInetProxy
}

function Start-FinlandGatewayCore([hashtable]$VpsCreds) {
    & (Join-Path $CoreDir "Restore-Internet.ps1")

    # Синхронизация времени Windows 11 (обязательно для протокола VLESS-Reality!)
    Write-Host "`n==> [1/5] Синхронизация точного времени Windows 11 для протокола Reality..." -ForegroundColor Cyan
    & net.exe start w32time 2>&1 | Out-Null
    & w32tm.exe /resync /force 2>&1 | Out-Null

    Write-Host "`n==> [2/5] Сохранение конфигурации (РФ -> напрямую, Зарубежные -> Финляндия $($VpsCreds.host))..." -ForegroundColor Cyan
    $VpsCreds | ConvertTo-Json -Depth 5 | Set-Content -Path $VpsJsonPath -Encoding UTF8
    Build-FinlandOnlyForeignConfig -Vps $VpsCreds
    Write-Host "  [OK] Конфигурация сохранена (SNI: $($VpsCreds.sni))." -ForegroundColor Green

    Write-Host "`n==> [3/5] Проверка и скачивание ядра Sing-box..." -ForegroundColor Cyan
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

    Write-Host "`n==> [4/5] Запуск фонового процесса Sing-box и открытие порта 2080 для Wi-Fi..." -ForegroundColor Cyan
    Remove-Item -Path "C:\TendaGateway\singbox.log" -Force -ErrorAction SilentlyContinue
    & netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
    & netsh.exe advfirewall firewall add rule name="Tenda Gateway LAN Allow" dir=in action=allow protocol=TCP localport=2080 remoteip=192.168.0.0/24 2>&1 | Out-Null

    # Запускаем напрямую в текущей сессии и добавляем в автозагрузку пользователя
    Start-Process -FilePath $SingBoxExe -ArgumentList "run -c `"$SingBoxCfgPath`"" -WorkingDirectory $InstallDir -WindowStyle Hidden
    & reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "TendaFinlandGateway" /t REG_SZ /d "`"$SingBoxExe`" run -c `"$SingBoxCfgPath`"" /f 2>&1 | Out-Null
    Start-Sleep -Seconds 3

    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    if (-not $Proc) {
        Write-Host "  [ОШИБКА] Процесс sing-box.exe не запустился! Лог ошибки:" -ForegroundColor Red
        if (Test-Path "C:\TendaGateway\singbox.log") {
            Get-Content "C:\TendaGateway\singbox.log" -Tail 15
        }
        return
    }

    Write-Host "`n==> [5/5] Реальная сквозная проверка открытия YouTube, Twitch и Яндекса..." -ForegroundColor Cyan
    $YtCode = & curl.exe -I -s -x "http://127.0.0.1:2080" -o NUL -w "%{http_code}" --max-time 10 "https://www.youtube.com"
    $TwCode = & curl.exe -I -s -x "http://127.0.0.1:2080" -o NUL -w "%{http_code}" --max-time 10 "https://www.twitch.tv"
    $YaCode = & curl.exe -I -s --noproxy "*" -o NUL -w "%{http_code}" --max-time 8 "https://ya.ru"

    Write-Host "  - Тест YouTube через Финляндию : HTTP $YtCode" -ForegroundColor $(if ($YtCode -match "^(200|301|302)$") { "Green" } else { "Yellow" })
    Write-Host "  - Тест Twitch через Финляндию  : HTTP $TwCode" -ForegroundColor $(if ($TwCode -match "^(200|301|302)$") { "Green" } else { "Yellow" })
    Write-Host "  - Тест ya.ru (Прямой РФ)       : HTTP $YaCode" -ForegroundColor $(if ($YaCode -match "^(200|301|302)$") { "Green" } else { "Yellow" })

    if (($YtCode -notmatch "^(200|301|302)$") -and ($TwCode -notmatch "^(200|301|302)$")) {
        Write-Host "`n  [!] Внимание: Туннель до VPS $($VpsCreds.host) не пропустил тестовый запрос!" -ForegroundColor Red
        Write-Host "  Прокси в браузере НЕ включен, чтобы не ломать интернет. Последние строки лога:" -ForegroundColor Yellow
        if (Test-Path "C:\TendaGateway\singbox.log") {
            Get-Content "C:\TendaGateway\singbox.log" -Tail 15
        }
        return
    }

    Enable-SafeSelectiveRoutingOnPC
    $LanIp = Get-LocalLanIP
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Green
    Write-Host "  ПРОВЕРЕНО И ЗАПУЩЕНО! YOUTUBE И TWITCH ОТКРЫВАЮТСЯ ЧЕРЕЗ ФИНЛЯНДИЮ!" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Green
    Write-Host "  1. НА ЭТОМ КОМПЬЮТЕРЕ:" -ForegroundColor Cyan
    Write-Host "     - Все сайты РФ (ya.ru, Сбербанк, Госуслуги, ВК, Озон) идут НАПРЯМУЮ!" -ForegroundColor Green
    Write-Host "     - Все зарубежные сайты (YouTube, Twitch, Instagram, TG, Discord) идут через Финляндию!" -ForegroundColor Green
    Write-Host "     - VPN Happ свободен и включается/выключается только по вашему решению!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  2. НА ТЕЛЕФОНАХ ПО ДОМАШНЕМУ WI-FI (Tenda TX2):" -ForegroundColor Cyan
    Write-Host "     В настройках Wi-Fi на телефоне -> 'Прокси: Вручную' -> Сервер: $LanIp | Порт: 2080" -ForegroundColor Yellow
    Write-Host "============================================================================" -ForegroundColor Green
}

function Connect-And-RunFinlandVps {
    Clear-Host
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ПОДКЛЮЧЕНИЕ И ОБНОВЛЕНИЕ СЕРВЕРА В ФИНЛЯНДИИ (ХЕЛЬСИНКИ, DEBIAN 12)" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""

    # Проверяем, есть ли сохраненные ключи УЖЕ с новым SNI (www.microsoft.com)
    if (Test-Path $VpsJsonPath) {
        try {
            $Saved = Get-Content $VpsJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($Saved.host -and $Saved.uuid -and $Saved.public_key -and ($Saved.sni -eq "www.microsoft.com")) {
                Write-Host "Найдены актуальные ключи вашего VPS ($($Saved.host), SNI: www.microsoft.com)!" -ForegroundColor Green
                $UseSaved = Read-Host "Запустить сразу без повторного ввода пароля SSH? [Y/n]"
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

    # Передача скрипта через Base64 полностью исключает ошибку 'bash: line 1: #!/usr/bin/env: No such file or directory'!
    $BashFile = Join-Path $CoreDir "setup-vps-finland.sh"
    $LinuxScript = (Get-Content -Path $BashFile -Raw -Encoding UTF8) -replace "`r`n", "`n"
    $B64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($LinuxScript))

    $Captured = ssh.exe -o StrictHostKeyChecking=accept-new -p $SshPort "root@$VpsIp" "echo '$B64' | base64 -d | tr -d '\r' > /tmp/setup_vps.sh && bash /tmp/setup_vps.sh"
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
        Write-Host "`n[!] Не удалось получить ответ от VPS. Вывод сервера:" -ForegroundColor Yellow
        Write-Host $FullText -ForegroundColor Gray
    }
}

function Test-CurrentRouting {
    $LanIp = Get-LocalLanIP
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  ДИАГНОСТИКА И РЕАЛЬНЫЙ ТЕСТ ОТКРЫТИЯ САЙТОВ" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    $Proc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-Host "  [OK] Процесс sing-box запущен (PID: $($Proc.Id), локальный адрес для Wi-Fi: $LanIp`:2080)" -ForegroundColor Green
        $YtCode = & curl.exe -I -s -x "http://127.0.0.1:2080" -o NUL -w "%{http_code}" --max-time 8 "https://www.youtube.com"
        $TwCode = & curl.exe -I -s -x "http://127.0.0.1:2080" -o NUL -w "%{http_code}" --max-time 8 "https://www.twitch.tv"
        $YaCode = & curl.exe -I -s --noproxy "*" -o NUL -w "%{http_code}" --max-time 8 "https://ya.ru"
        Write-Host "  - YouTube через Финляндию : HTTP $YtCode" -ForegroundColor $(if ($YtCode -match "^(200|301|302)$") { "Green" } else { "Red" })
        Write-Host "  - Twitch через Финляндию  : HTTP $TwCode" -ForegroundColor $(if ($TwCode -match "^(200|301|302)$") { "Green" } else { "Red" })
        Write-Host "  - ya.ru напрямую (РФ)     : HTTP $YaCode" -ForegroundColor $(if ($YaCode -match "^(200|301|302)$") { "Green" } else { "Red" })
    } else {
        Write-Host "  [!] Шлюз Финляндии сейчас выключен (работает только прямой интернет)" -ForegroundColor Yellow
    }
    if (Test-Path "C:\TendaGateway\singbox.log") {
        Write-Host "`nПоследние записи лога (C:\TendaGateway\singbox.log):" -ForegroundColor Cyan
        Get-Content "C:\TendaGateway\singbox.log" -Tail 10
    }
}

function Show-WiFiGuide {
    $LanIp = Get-LocalLanIP
    Write-Host ""
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host "  НАСТРОЙКА ДОМАШНЕГО WI-FI (РОУТЕР TENDA TX2) ДЛЯ ТЕЛЕФОНОВ И УСТРОЙСТВ" -ForegroundColor Green
    Write-Host "============================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Host "На телефоне (iPhone / Android) в настройках вашей домашней сети Wi-Fi Tenda:" -ForegroundColor Cyan
    Write-Host "  - Нажмите значок (i) рядом с вашей сетью Wi-Fi -> 'Настройка прокси' -> 'Вручную'"
    Write-Host "  - Сервер (Имя узла): $LanIp" -ForegroundColor Yellow
    Write-Host "  - Порт: 2080" -ForegroundColor Yellow
    Write-Host "  - Нажмите 'Сохранить'."
    Write-Host ""
    Write-Host "На телефоне по Wi-Fi все сайты РФ пойдут напрямую, а зарубежные - через Финляндию!" -ForegroundColor Green
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
    Write-Host "  [4] ПРОВЕРИТЬ СТАТУС И РЕАЛЬНЫЙ ТЕСТ YOUTUBE / TWITCH / YA.RU"
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
