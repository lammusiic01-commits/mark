#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Автоматический установщик домашнего шлюза Tenda TX2 Smart Gateway для Windows 11 (Вариант Б).
.DESCRIPTION
    Настраивает ваш ПК на Windows 11 (подключенный кабелем к роутеру Tenda TX2) так, чтобы:
    1) На самом ПК по кабелю И на всех устройствах по Wi-Fi (телефоны, ТВ, ноутбуки)
       выборочно работали YouTube (4K), Telegram, Instagram, Discord (с голосом), ChatGPT и др.
    2) Российские сайты, банки, Госуслуги и игры шли НАПРЯМУЮ через провайдера с задержкой 0 мс.
    3) Всё работало в фоновом режиме как системная служба Windows 11 (потребляет ~25 МБ ОЗУ, 0% CPU).
#>

param(
    [string]$GatewayIP = "192.168.0.2",
    [string]$TendaRouterIP = "192.168.0.1",
    [string]$SubnetPrefix = "24",
    [string]$SingBoxVersion = "1.10.7",
    [switch]$UpdateVpsOnly,
    [switch]$SkipVpsPrompt,
    [switch]$Uninstall
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WinDir = $PSScriptRoot
$BinDir = Join-Path $WinDir "bin"
$SingBoxExe = Join-Path $BinDir "sing-box.exe"
$ConfigPath = Join-Path $ProjectRoot "configs\generated\singbox_windows11.json"
$ServicesJsonPath = Join-Path $ProjectRoot "configs\rules\services.json"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

if ($Uninstall) {
    Write-Step "Остановка служб и возврат стандартных сетевых настроек Windows 11..."
    Unregister-ScheduledTask -TaskName "TendaSmartGateway-SingBox" -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "TendaSmartGateway-WebUI" -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-NetFirewallRule -DisplayGroup "TendaSmartGateway" -ErrorAction SilentlyContinue
    Write-Ok "Фоновая служба Sing-box остановлена и удалена из автозагрузки."
    Write-Host "Если вы хотите вернуть получение IP по DHCP на сетевой карте ПК, выполните в PowerShell:"
    Write-Host "  Set-NetIPInterface -InterfaceAlias 'Ethernet' -Dhcp Enabled" -ForegroundColor Yellow
    exit 0
}

Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host "   TENDA TX2 SMART GATEWAY - АВТОНАСТРОЙКА ПОД WINDOWS 11 (ВАРИАНТ Б)" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Blue

# 1. Запрос параметров зарубежного VPS (VLESS-Reality)
Write-Step "[1/7] Настройка параметров зарубежного VPS (VLESS-Reality)"
if ((Test-Path $ServicesJsonPath) -and (-not $SkipVpsPrompt)) {
    $StateObj = Get-Content $ServicesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $CurrentVps = $StateObj.vps.primary
    Write-Host "Текущий VPS в конфиге: $($CurrentVps.host):$($CurrentVps.port) (SNI: $($CurrentVps.sni))" -ForegroundColor Gray
    $AskVps = Read-Host "Хотите ввести новые данные вашего VPS сервера сейчас? (y/N)"
    if ($AskVps -match "^[yYдД]" -or $UpdateVpsOnly) {
        $InputHost = Read-Host "  Введите IP-адрес вашего VPS (например, 185.x.x.x)"
        $InputUuid = Read-Host "  Введите UUID клиента"
        $InputPubKey = Read-Host "  Введите Public Key (Reality X25519)"
        $InputShortId = Read-Host "  Введите Short ID (hex)"
        $InputSni = Read-Host "  Введите SNI домен [Enter = dl.google.com]"

        if ($InputHost)   { $StateObj.vps.primary.host = $InputHost.Trim() }
        if ($InputUuid)   { $StateObj.vps.primary.uuid = $InputUuid.Trim() }
        if ($InputPubKey) { $StateObj.vps.primary.public_key = $InputPubKey.Trim() }
        if ($InputShortId){ $StateObj.vps.primary.short_id = $InputShortId.Trim() }
        if ($InputSni)    { $StateObj.vps.primary.sni = $InputSni.Trim() }

        $StateObj | ConvertTo-Json -Depth 10 | Set-Content $ServicesJsonPath -Encoding UTF8
        Write-Ok "Параметры VPS сохранены в configs\rules\services.json"
    }
}

# Прямое обновление singbox_windows11.json (работает даже без установленного Python!)
if (Get-Command python -ErrorAction SilentlyContinue) {
    python (Join-Path $ProjectRoot "app\core.py") | Out-Null
    Write-Ok "Конфигурация singbox_windows11.json пересобрана через Python-ядро."
} elseif (Test-Path $ConfigPath) {
    $SbCfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $StateObj = Get-Content $ServicesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($ob in $SbCfg.outbounds) {
        if ($ob.tag -eq "vless-primary") {
            $ob.server = $StateObj.vps.primary.host
            $ob.server_port = [int]$StateObj.vps.primary.port
            $ob.uuid = $StateObj.vps.primary.uuid
            $ob.tls.server_name = $StateObj.vps.primary.sni
            $ob.tls.reality.public_key = $StateObj.vps.primary.public_key
            $ob.tls.reality.short_id = $StateObj.vps.primary.short_id
        }
    }
    $SbCfg | ConvertTo-Json -Depth 12 | Set-Content $ConfigPath -Encoding UTF8
    Write-Ok "Конфигурация singbox_windows11.json обновлена средствами PowerShell."
}

if ($UpdateVpsOnly) {
    Restart-ScheduledTask -TaskName "TendaSmartGateway-SingBox" -ErrorAction SilentlyContinue
    Write-Ok "Конфиг обновлён, служба перезапущена!"
    exit 0
}

# 2. Определение сетевой карты ПК, подключенной по кабелю к Tenda TX2
Write-Step "[2/7] Проверка кабельного подключения к роутеру Tenda TX2 ($TendaRouterIP)"
$ActiveRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" |
    Where-Object { $_.NextHop -eq $TendaRouterIP } |
    Select-Object -First 1

if (-not $ActiveRoute) {
    $ActiveRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1
}

$AdapterIndex = $ActiveRoute.InterfaceIndex
$Adapter = Get-NetAdapter -InterfaceIndex $AdapterIndex
Write-Ok "Найдена сетевая карта ПК: '$($Adapter.Name)' ($($Adapter.InterfaceDescription))"

$CurrentIPObj = Get-NetIPAddress -InterfaceIndex $AdapterIndex -AddressFamily IPv4 | Select-Object -First 1
Write-Host "  Текущий IP компьютера: $($CurrentIPObj.IPAddress)" -ForegroundColor Gray

if ($CurrentIPObj.IPAddress -ne $GatewayIP) {
    $SetStatic = Read-Host "  Закрепить за этим ПК статический IP $GatewayIP (шлюз $TendaRouterIP)? [Y/n]"
    if ($SetStatic -notmatch "^[nNнН]") {
        Set-NetIPInterface -InterfaceIndex $AdapterIndex -Dhcp Disabled -ErrorAction SilentlyContinue
        Remove-NetIPAddress -InterfaceIndex $AdapterIndex -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
        Remove-NetRoute -InterfaceIndex $AdapterIndex -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
        New-NetIPAddress -InterfaceIndex $AdapterIndex -IPAddress $GatewayIP -PrefixLength $SubnetPrefix -DefaultGateway $TendaRouterIP | Out-Null
        Set-DnsClientServerAddress -InterfaceIndex $AdapterIndex -ServerAddresses @("127.0.0.1", "77.88.8.8")
        Write-Ok "Статический IP $GatewayIP успешно закреплён за сетевой картой '$($Adapter.Name)'"
    }
} else {
    Set-DnsClientServerAddress -InterfaceIndex $AdapterIndex -ServerAddresses @("127.0.0.1", "77.88.8.8")
    Write-Ok "Статический IP $GatewayIP уже настроен."
}

# 3. Включение маршрутизации пакетов (IP Forwarding) в ядре Windows 11
Write-Step "[3/7] Включение маршрутизации пакетов (IPv4 Forwarding) в Windows 11"
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "IPEnableRouter" -Value 1 -Type DWord
Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object {
    Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Forwarding Enabled -ErrorAction SilentlyContinue
}
Set-Service -Name "RemoteAccess" -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name "RemoteAccess" -ErrorAction SilentlyContinue
Write-Ok "Маршрутизация транзитного трафика с Wi-Fi устройств Tenda TX2 включена."

# 4. Настройка правил Брандмауэра Windows Defender
Write-Step "[4/7] Открытие локальных портов в Брандмауэре Windows 11 (только для домашней сети 192.168.0.0/24)"
& netsh.exe advfirewall firewall delete rule name="Tenda Gateway LAN Allow" 2>&1 | Out-Null
& netsh.exe advfirewall firewall add rule name="Tenda Gateway LAN Allow" dir=in action=allow remoteip=192.168.0.0/24 2>&1 | Out-Null

Write-Ok "Правила брандмауэра для локальной сети 192.168.0.0/24 созданы."

# 5. Автоматическое скачивание официального бинарника Sing-box для Windows 11 (amd64)
Write-Step "[5/7] Установка ядра Sing-box для Windows 11 (с драйвером Wintun)"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

if (-not (Test-Path $SingBoxExe)) {
    $ZipName = "sing-box-$SingBoxVersion-windows-amd64.zip"
    $DownloadUrl = "https://github.com/SagerNet/sing-box/releases/download/v$SingBoxVersion/$ZipName"
    $ZipPath = Join-Path $BinDir $ZipName
    Write-Host "  Скачивание $DownloadUrl ..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing
    Expand-Archive -Path $ZipPath -DestinationPath $BinDir -Force
    $ExtractedExe = Get-ChildItem -Path $BinDir -Filter "sing-box.exe" -Recurse | Select-Object -First 1
    if ($ExtractedExe -and $ExtractedExe.FullName -ne $SingBoxExe) {
        Copy-Item -Path $ExtractedExe.FullName -Destination $SingBoxExe -Force
    }
    Remove-Item -Path $ZipPath -Force -ErrorAction SilentlyContinue
    Write-Ok "Ядро Sing-box v$SingBoxVersion успешно установлено в $SingBoxExe"
} else {
    Write-Ok "Бинарный файл $SingBoxExe уже установлен."
}

# 6. Регистрация фонового автозапуска в Планировщике задач Windows 11 (от имени SYSTEM)
Write-Step "[6/7] Регистрация системной службы автозапуска при старте Windows 11"
Unregister-ScheduledTask -TaskName "TendaSmartGateway-SingBox" -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction -Execute $SingBoxExe -Argument "run -c `"$ConfigPath`"" -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "TendaSmartGateway-SingBox" -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName "TendaSmartGateway-SingBox"
Start-Sleep -Seconds 3

# Включаем IPv4 Forwarding и на только что созданном адаптере SingBoxTun
Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object {
    Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Forwarding Enabled -ErrorAction SilentlyContinue
}
Write-Ok "Фоновая служба TendaSmartGateway-SingBox запущена и добавлена в автозагрузку Windows 11!"

# 7. Запуск Веб-панели управления (если установлен Python)
Write-Step "[7/7] Настройка локальной Веб-панели управления (http://192.168.0.2:8080)"
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($PythonCmd) {
    Unregister-ScheduledTask -TaskName "TendaSmartGateway-WebUI" -Confirm:$false -ErrorAction SilentlyContinue
    $PyAction = New-ScheduledTaskAction -Execute $PythonCmd.Source -Argument "`"$ProjectRoot\app\server.py`"" -WorkingDirectory $ProjectRoot
    Register-ScheduledTask -TaskName "TendaSmartGateway-WebUI" -Action $PyAction -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
    Start-ScheduledTask -TaskName "TendaSmartGateway-WebUI"
    Write-Ok "Веб-панель управления доступна по адресу: http://$GatewayIP`:8080"
} else {
    Write-Warn "Python не найден (он нужен только для веб-панели, сам шлюз Sing-box уже работает!)."
    Write-Host "  Чтобы установить Python в 1 команду: winget install Python.Python.3.11" -ForegroundColor Gray
}

Write-Host "`n==========================================================================" -ForegroundColor Green
Write-Host " ГОТОВО! ВАШ ПК НА WINDOWS 11 ТЕПЕРЬ РАБОТАЕТ КАК УМНЫЙ ШЛЮЗ ДЛЯ ДОМА!" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Green
Write-Host "На самом компьютере по кабелю YouTube, Telegram, Instagram и Discord УЖЕ работают!"
Write-Host "`nЧтобы подключить все телефоны и ТВ по Wi-Fi, зайдите на роутер Tenda TX2 (http://192.168.0.1):"
Write-Host "  1) 'Системные настройки' -> 'Настройки локальной сети (LAN)':"
Write-Host "     Оставьте DHCP-сервер ВКЛЮЧЕННЫМ (чтобы Wi-Fi работал даже при выключенном ПК!),"
Write-Host "     но укажите:"
Write-Host "       Первичный DNS-сервер : $GatewayIP" -ForegroundColor Yellow
Write-Host "       Вторичный DNS-сервер : 77.88.8.8" -ForegroundColor Yellow
Write-Host "  2) 'Расширенные настройки' -> 'Статическая маршрутизация' - добавьте строки:"
Write-Host "       Сеть: 198.18.0.0     | Маска: 255.254.0.0   | Шлюз: $GatewayIP  (Все сайты: YouTube, Insta, Discord, AI)" -ForegroundColor Cyan
Write-Host "       Сеть: 149.154.160.0  | Маска: 255.255.240.0 | Шлюз: $GatewayIP  (Telegram Звонки и Медиа)" -ForegroundColor Cyan
Write-Host "       Сеть: 91.108.4.0     | Маска: 255.255.252.0 | Шлюз: $GatewayIP  (Telegram DC1-DC3)" -ForegroundColor Cyan
Write-Host "       Сеть: 91.108.8.0     | Маска: 255.255.252.0 | Шлюз: $GatewayIP  (Telegram)" -ForegroundColor Cyan
Write-Host "       Сеть: 91.108.56.0    | Маска: 255.255.252.0 | Шлюз: $GatewayIP  (Telegram DC5)" -ForegroundColor Cyan
Write-Host "==========================================================================" -ForegroundColor Green
