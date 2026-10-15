#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Полная автоматическая установка 'В 1 КЛИК' прямо с вашего Windows 11 ПК:
    1) Подключается по SSH к вашему VPS от OneDash (rdp-onedash.ru, Хельсинки, Debian 12)
    2) Настраивает на VPS: 1 ГБ Swap, TCP BBR, Sing-box (VLESS-Reality XTLS-Vision)
    3) Автоматически забирает сгенерированные ключи с VPS на ваш ПК с Windows 11
    4) Настраивает и запускает шлюз на вашем ПК (192.168.0.2) для работы по кабелю и Wi-Fi
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VpsScriptPath = Join-Path $ProjectRoot "scripts\setup-vps-debian12-finland.sh"
$ServicesJsonPath = Join-Path $ProjectRoot "configs\rules\services.json"
$WinGatewayScript = Join-Path $PSScriptRoot "Setup-Windows11-Gateway.ps1"

Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host "   АВТО-УСТАНОВКА 'ПОД КЛЮЧ': VPS ONEDASH (ХЕЛЬСИНКИ, DEBIAN 12) + WIN 11" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host ""
Write-Host "Этот мастер сам подключится к вашему новому VPS в Финляндии (Debian 12),"
Write-Host "установит сервер VLESS-Reality + TCP BBR, сам скачает ключи и настроит ваш ПК!"
Write-Host ""

$VpsIp = Read-Host "Введите IP-адрес вашего VPS с rdp-onedash.ru (например, 185.x.x.x)"
$VpsIp = $VpsIp.Trim()
if (-not $VpsIp) {
    Write-Host "[ОШИБКА] IP-адрес VPS не может быть пустым." -ForegroundColor Red
    exit 1
}

$SshPort = Read-Host "Введите SSH порт вашего VPS [нажмите Enter, если стандартный 22]"
$SshPort = $SshPort.Trim()
if (-not $SshPort) { $SshPort = "22" }

Write-Host "`n==> [Шаг 1/3] Подключение к root@$VpsIp (Debian 12, Хельсинки)..." -ForegroundColor Cyan
Write-Host "  (Сейчас введите пароль от root вашего VPS из письма/личного кабинета OneDash;" -ForegroundColor Yellow
Write-Host "   при вводе пароля в консоли символы не отображаются - просто вставьте его правой кнопкой мыши и нажмите Enter)" -ForegroundColor Yellow
Write-Host ""

# Читаем скрипт и принудительно переводим окончания строк в формат Linux (LF), чтобы bash на Debian 12 отработал идеально
$LinuxScriptContent = (Get-Content -Path $VpsScriptPath -Raw -Encoding UTF8) -replace "`r`n", "`n"

# Передаем скрипт по SSH напрямую в bash на Debian 12 VPS и перехватываем вывод
$OutputLines = $LinuxScriptContent | ssh -o StrictHostKeyChecking=accept-new -p $SshPort "root@$VpsIp" "bash -s" | Tee-Object -Variable CapturedOutput
$FullOutput = ($CapturedOutput -join "`n")

if ($FullOutput -match "TENDA_CREDENTIALS_JSON_BEGIN\s*(\{[\s\S]*?\})\s*TENDA_CREDENTIALS_JSON_END") {
    $CredJsonRaw = $Matches[1]
    $Creds = $CredJsonRaw | ConvertFrom-Json

    Write-Host "`n==> [Шаг 2/3] Ключи с вашего VPS в Хельсинки успешно получены автоматически!" -ForegroundColor Green
    Write-Host "  IP сервера : $($Creds.host)" -ForegroundColor Cyan
    Write-Host "  UUID       : $($Creds.uuid)" -ForegroundColor Cyan
    Write-Host "  Public Key : $($Creds.public_key)" -ForegroundColor Cyan
    Write-Host "  Short ID   : $($Creds.short_id)" -ForegroundColor Cyan
    Write-Host "  SNI        : $($Creds.sni)" -ForegroundColor Cyan

    # Записываем полученные ключи в services.json
    $StateObj = Get-Content $ServicesJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $StateObj.vps.primary.name = "OneDash Helsinki (Finland Debian 12)"
    $StateObj.vps.primary.host = $Creds.host
    $StateObj.vps.primary.port = [int]$Creds.port
    $StateObj.vps.primary.uuid = $Creds.uuid
    $StateObj.vps.primary.public_key = $Creds.public_key
    $StateObj.vps.primary.short_id = $Creds.short_id
    $StateObj.vps.primary.sni = $Creds.sni
    $StateObj | ConvertTo-Json -Depth 10 | Set-Content $ServicesJsonPath -Encoding UTF8

    Write-Host "`n==> [Шаг 3/3] Запуск настройки домашнего шлюза на вашем ПК с Windows 11..." -ForegroundColor Cyan
    & $WinGatewayScript -SkipVpsPrompt
} else {
    Write-Host "`n[!] Не удалось автоматически считать JSON-блок ключей с VPS. Проверьте пароль root или скопируйте ключи вручную." -ForegroundColor Yellow
}
