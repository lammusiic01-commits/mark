$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

Write-Host "============================================================================" -ForegroundColor Blue
Write-Host "  ВОССТАНОВЛЕНИЕ БАЗОВЫХ НАСТРОЕК ИНТЕРНЕТА WINDOWS 11 И ПОЧИНКА HAPP VPN" -ForegroundColor Green
Write-Host "============================================================================" -ForegroundColor Blue
Write-Host ""

Write-Host "[1/6] Остановка фоновых процессов sing-box и удаление задач автозапуска..." -ForegroundColor Cyan
& schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
& schtasks.exe /Delete /TN "TendaSmartGateway-WebUI" /F 2>&1 | Out-Null
Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "[2/6] Отключение серверного режима маршрутизатора (IPEnableRouter = 0, RemoteAccess)..." -ForegroundColor Cyan
& reg.exe add "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v IPEnableRouter /t REG_DWORD /d 0 /f 2>&1 | Out-Null
& sc.exe stop RemoteAccess 2>&1 | Out-Null
& sc.exe config RemoteAccess start= disabled 2>&1 | Out-Null

Write-Host "[3/6] Отключение IPv4 Forwarding на сетевых адаптерах (восстанавливает работу драйвера Happ WinTun)..." -ForegroundColor Cyan
& netsh.exe interface ipv4 set global forwarding=disabled 2>&1 | Out-Null
Get-NetIPInterface -ErrorAction SilentlyContinue | Set-NetIPInterface -Forwarding Disabled -ErrorAction SilentlyContinue

Write-Host "[4/6] Сброс зависшего системного прокси Windows 11..." -ForegroundColor Cyan
& reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f 2>&1 | Out-Null
& netsh.exe winhttp reset proxy 2>&1 | Out-Null

Write-Host "[5/6] Возврат сетевой карты Ethernet в автоматический режим (DHCP IP и DHCP DNS)..." -ForegroundColor Cyan
& netsh.exe interface ip set address "Ethernet" dhcp 2>&1 | Out-Null
& netsh.exe interface ip set dns "Ethernet" dhcp 2>&1 | Out-Null
Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
    Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Dhcp Enabled -ErrorAction SilentlyContinue
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue
}

Write-Host "[6/7] Сброс каталога WinSock и обновление IP-адреса от роутера Tenda TX2..." -ForegroundColor Cyan
& netsh.exe winsock reset 2>&1 | Out-Null
& ipconfig.exe /release 2>&1 | Out-Null
& ipconfig.exe /renew 2>&1 | Out-Null
& ipconfig.exe /flushdns 2>&1 | Out-Null

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Green
Write-Host "  ВСЕ НАСТРОЙКИ СЕТИ ВОССТАНОВЛЕНЫ В ЗАВОДСКОЕ СОСТОЯНИЕ WINDOWS 11!" -ForegroundColor Green
Write-Host "  Если в Happ VPN остался старый сбой драйвера Tun - просто перезагрузите ПК." -ForegroundColor Yellow
Write-Host "============================================================================" -ForegroundColor Green
