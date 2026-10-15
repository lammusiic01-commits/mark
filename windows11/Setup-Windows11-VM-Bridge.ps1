#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Автонастройка легковесной Linux VM / WSL2 Mirrored / Docker на Windows 11
    в режиме Сетевого моста (Bridged Adapter) с IP 192.168.0.2 для роутера Tenda TX2.
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host "   РАЗВЕРТЫВАНИЕ LINUX VM / WSL2 В РЕЖИМЕ МОСТА (BRIDGED) НА WINDOWS 11" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Blue
Write-Host ""
Write-Host "Выберите способ виртуализации на вашем ПК с Windows 11:"
Write-Host "  1) WSL2 в режиме Mirrored Networking + Hyper-V Firewall (Встроено в Windows 11 23H2/24H2)"
Write-Host "  2) VirtualBox + Vagrant в режиме Bridged Adapter с IP 192.168.0.2 (Работает на Windows 11 Home/Pro)"
Write-Host ""
$Mode = Read-Host "Введите номер [1-2]"

if ($Mode -eq "1") {
    Write-Host "`n==> Настройка файла .wslconfig для режима Mirrored Networking в Windows 11..." -ForegroundColor Cyan
    $WslConfigPath = Join-Path $env:USERPROFILE ".wslconfig"
    $WslContent = @"
[wsl2]
networkingMode=mirrored
dnsTunneling=false
firewall=false
autoProxy=false

[experimental]
hostAddressLoopback=true
"@
    Set-Content -Path $WslConfigPath -Value $WslContent -Encoding UTF8
    Write-Host "  [OK] Файл $WslConfigPath записан (networkingMode=mirrored)." -ForegroundColor Green

    # Разрешаем входящие пакеты из локальной сети Tenda TX2 (192.168.0.0/24) в Hyper-V Firewall
    if (Get-Command Set-NetFirewallHyperVVMSetting -ErrorAction SilentlyContinue) {
        Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow -ErrorAction SilentlyContinue
        Write-Host "  [OK] Hyper-V Firewall открыт для локальной сети роутера Tenda TX2." -ForegroundColor Green
    }

    Write-Host "`n==> Перезапуск подсистемы WSL2..." -ForegroundColor Cyan
    wsl --shutdown
    Write-Host "  [OK] Теперь запустите терминал Ubuntu (WSL) и выполните:" -ForegroundColor Green
    Write-Host "       sudo ./install.sh   (выберите пункт 1)" -ForegroundColor Yellow
}
elseif ($Mode -eq "2") {
    Write-Host "`n==> Проверка наличия VirtualBox и Vagrant..." -ForegroundColor Cyan
    if (-not (Get-Command VBoxManage -ErrorAction SilentlyContinue)) {
        Write-Host "  Установка Oracle VirtualBox через winget..." -ForegroundColor Gray
        winget install --id Oracle.VirtualBox -e --accept-source-agreements --accept-package-agreements
    }
    if (-not (Get-Command vagrant -ErrorAction SilentlyContinue)) {
        Write-Host "  Установка HashiCorp Vagrant через winget..." -ForegroundColor Gray
        winget install --id Hashicorp.Vagrant -e --accept-source-agreements --accept-package-agreements
    }
    Write-Host "`n==> Запуск виртуальной машины Tenda-TX2-Smart-Gateway (IP 192.168.0.2)..." -ForegroundColor Cyan
    Push-Location $PSScriptRoot
    vagrant up
    Pop-Location
    Write-Host "  [OK] Виртуальная машина с IP 192.168.0.2 запущена в режиме Bridged Adapter!" -ForegroundColor Green
    Write-Host "  Веб-панель управления доступна по адресу: http://192.168.0.2:8080" -ForegroundColor Yellow
}
