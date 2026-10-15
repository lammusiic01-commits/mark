$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

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

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Blue
Write-Host "  ВОССТАНОВЛЕНИЕ БАЗОВЫХ НАСТРОЕК ИНТЕРНЕТА WINDOWS 11 (СБРОС В СТАНДАРТ)" -ForegroundColor Green
Write-Host "============================================================================" -ForegroundColor Blue

Write-Host "[1/6] Остановка фонового процесса sing-box и удаление автозапуска..." -ForegroundColor Cyan
& schtasks.exe /Delete /TN "TendaSmartGateway-SingBox" /F 2>&1 | Out-Null
& schtasks.exe /Delete /TN "TendaSmartGateway-WebUI" /F 2>&1 | Out-Null
& reg.exe delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "TendaFinlandGateway" /f 2>&1 | Out-Null
Get-Process -Name "sing-box" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "[2/6] Отключение серверного режима маршрутизатора (IPEnableRouter = 0, RemoteAccess)..." -ForegroundColor Cyan
& reg.exe add "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v IPEnableRouter /t REG_DWORD /d 0 /f 2>&1 | Out-Null
& sc.exe stop RemoteAccess 2>&1 | Out-Null
& sc.exe config RemoteAccess start= disabled 2>&1 | Out-Null

Write-Host "[3/6] Отключение IPv4 Forwarding (освобождает драйвер для прямого интернета и Happ VPN)..." -ForegroundColor Cyan
& netsh.exe interface ipv4 set global forwarding=disabled 2>&1 | Out-Null
Get-NetIPInterface -ErrorAction SilentlyContinue | Set-NetIPInterface -Forwarding Disabled -ErrorAction SilentlyContinue

Write-Host "[4/6] Отключение прокси в настройках Windows 11 и уведомление браузеров..." -ForegroundColor Cyan
& reg.exe add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f 2>&1 | Out-Null
& reg.exe delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f 2>&1 | Out-Null
& netsh.exe winhttp reset proxy 2>&1 | Out-Null
& netsh.exe advfirewall firewall delete rule name="Block-Browser-QUIC-UDP443" 2>&1 | Out-Null
Refresh-WinInetProxy

Write-Host "[5/6] Возврат сетевой карты Ethernet в автоматический режим (DHCP IP и DHCP DNS)..." -ForegroundColor Cyan
& netsh.exe interface ip set address "Ethernet" dhcp 2>&1 | Out-Null
& netsh.exe interface ip set dns "Ethernet" dhcp 2>&1 | Out-Null
Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
    Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Dhcp Enabled -ErrorAction SilentlyContinue
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue
}

Write-Host "[6/6] Сброс кэша DNS..." -ForegroundColor Cyan
& ipconfig.exe /flushdns 2>&1 | Out-Null

Write-Host ""
Write-Host "  [OK] Базовые настройки интернета Windows 11 полностью восстановлены!" -ForegroundColor Green
