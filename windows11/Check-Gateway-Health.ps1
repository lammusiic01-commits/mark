<#
.SYNOPSIS
    Полная диагностика работы умного шлюза Tenda TX2 на Windows 11.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServicesJsonPath = Join-Path $ProjectRoot "configs\rules\services.json"
$StateObj = Get-Content $ServicesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

$TendaIP = $StateObj.network.tenda_router_ip
$GatewayIP = $StateObj.network.gateway_ip
$VpsHost = $StateObj.vps.primary.host
$VpsPort = [int]$StateObj.vps.primary.port

Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host "   ДИАГНОСТИКА ШЛЮЗА TENDA TX2 НА WINDOWS 11" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Blue

# 1. Пинг до роутера Tenda TX2
$PingTenda = Test-Connection -ComputerName $TendaIP -Count 1 -Quiet -ErrorAction SilentlyContinue
if ($PingTenda) {
    Write-Host "[OK] Роутер Tenda TX2 ($TendaIP) доступен по кабелю" -ForegroundColor Green
} else {
    Write-Host "[ОШИБКА] Роутер Tenda TX2 ($TendaIP) не отвечает на пинг!" -ForegroundColor Red
}

# 2. Проверка службы Sing-box
$SbProc = Get-Process -Name "sing-box" -ErrorAction SilentlyContinue
if ($SbProc) {
    Write-Host "[OK] Ядро Sing-box запущено (PID: $($SbProc.Id), ОЗУ: $([math]::Round($SbProc.WorkingSet64 / 1MB, 1)) МБ)" -ForegroundColor Green
} else {
    Write-Host "[!] Процесс sing-box.exe сейчас не запущен" -ForegroundColor Yellow
}

# 3. Проверка IP Forwarding в Windows 11
$ForwardRule = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "IPEnableRouter" -ErrorAction SilentlyContinue
if ($ForwardRule.IPEnableRouter -eq 1) {
    Write-Host "[OK] Маршрутизация транзитного Wi-Fi трафика (IPEnableRouter=1) включена" -ForegroundColor Green
} else {
    Write-Host "[!] Маршрутизация IPEnableRouter отключена (запустите Setup-Windows11-Gateway.ps1)" -ForegroundColor Yellow
}

# 4. Тест локального DNS FakeIP для YouTube и прямого DNS для Сбербанка
try {
    $YtDns = Resolve-DnsName -Name "www.youtube.com" -Server "127.0.0.1" -Type A -ErrorAction Stop | Select-Object -First 1
    if ($YtDns.IPAddress -like "198.18.*") {
        Write-Host "[OK] Split-DNS (YouTube): www.youtube.com -> $($YtDns.IPAddress) (Мгновенный FakeIP - идет в туннель!)" -ForegroundColor Green
    } else {
        Write-Host "[i] DNS ответ для www.youtube.com: $($YtDns.IPAddress)" -ForegroundColor Cyan
    }
} catch {
    Write-Host "[!] Локальный DNS на 127.0.0.1:53 не ответил" -ForegroundColor Yellow
}

try {
    $RuDns = Resolve-DnsName -Name "sberbank.ru" -Server "127.0.0.1" -Type A -ErrorAction Stop | Select-Object -First 1
    Write-Host "[OK] Split-DNS (РФ Банк): sberbank.ru -> $($RuDns.IPAddress) (Реальный IP - идет НАПРЯМУЮ!)" -ForegroundColor Green
} catch {}

# 5. Проверка доступности зарубежного VPS
$TcpCheck = Test-NetConnection -ComputerName $VpsHost -Port $VpsPort -WarningAction SilentlyContinue
if ($TcpCheck.TcpTestSucceeded) {
    Write-Host "[OK] Зарубежный VPS ($VpsHost`:$VpsPort) доступен по TCP" -ForegroundColor Green
} else {
    Write-Host "[!] Зарубежный VPS ($VpsHost`:$VpsPort) недоступен (проверьте IP вашего VPS в настройках)" -ForegroundColor Yellow
}

Write-Host "==========================================================================" -ForegroundColor Blue
