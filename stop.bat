@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo    Остановка AI Маркетолог...

:: 1. Python-процесс приложения (app.main) — ищем по командной строке
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*app.main*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

:: 2. Cloudflare Tunnel
taskkill /F /IM cloudflared.exe /T >nul 2>&1

:: 3. Старое окно start.bat (по заголовку)
taskkill /F /FI "WINDOWTITLE eq AI Маркетолог*" /T >nul 2>&1

echo    Остановлено.
ping -n 3 127.0.0.1 >nul
endlocal
