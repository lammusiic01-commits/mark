@echo off
title Restore Default Windows 11 Internet and Fix Happ VPN
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ======================================================================
echo   RESTORING DEFAULT WINDOWS 11 NETWORK SETTINGS AND FIXING HAPP VPN
echo ======================================================================
echo.

echo [1/7] Stopping any leftover sing-box tasks and processes...
schtasks /Delete /TN "TendaSmartGateway-SingBox" /F >nul 2>&1
schtasks /Delete /TN "TendaSmartGateway-WebUI" /F >nul 2>&1
taskkill /F /IM sing-box.exe >nul 2>&1

echo [2/7] Disabling Windows Router Mode (IPEnableRouter = 0) and RemoteAccess...
reg add "HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" /v IPEnableRouter /t REG_DWORD /d 0 /f >nul 2>&1
sc stop RemoteAccess >nul 2>&1
sc config RemoteAccess start= disabled >nul 2>&1

echo [3/7] Disabling IPv4 Forwarding on all network adapters (fixes Happ WinTun)...
netsh interface ipv4 set global forwarding=disabled >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPInterface -ErrorAction SilentlyContinue | Set-NetIPInterface -Forwarding Disabled -ErrorAction SilentlyContinue" >nul 2>&1

echo [4/7] Clearing stuck Windows System Proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul 2>&1
netsh winhttp reset proxy >nul 2>&1

echo [5/7] Resetting Ethernet adapter to automatic DHCP and DNS...
netsh interface ip set address "Ethernet" dhcp >nul 2>&1
netsh interface ip set dns "Ethernet" dhcp >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -Dhcp Enabled -ErrorAction SilentlyContinue; Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }" >nul 2>&1

echo [6/7] Resetting WinSock and TCP/IP stack for Happ VPN...
netsh winsock reset >nul 2>&1
ipconfig /release >nul 2>&1
ipconfig /renew >nul 2>&1
ipconfig /flushdns >nul 2>&1

echo [7/7] Removing temporary firewall rules...
netsh advfirewall firewall delete rule name="Tenda Gateway LAN Allow" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Remove-NetFirewallRule -DisplayGroup 'TendaSmartGateway' -ErrorAction SilentlyContinue" >nul 2>&1

echo.
echo ======================================================================
echo   SUCCESS! ALL NETWORK SETTINGS RESTORED TO WINDOWS 11 DEFAULTS!
echo   If Happ VPN still shows an error, restart your PC once to reload WinSock.
echo ======================================================================
echo.
pause
exit /b
