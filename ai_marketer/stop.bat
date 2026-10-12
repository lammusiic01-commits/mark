@echo off
rem ═══════════════════════════════════════════════════════════════
rem   AI МАРКЕТОЛОГ — ОСТАНОВКА ПРОЕКТА (Windows)
rem   stop.bat          — остановить контейнеры (данные сохраняются)
rem   stop.bat --purge  — остановить и удалить базу с Redis
rem ═══════════════════════════════════════════════════════════════

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "PURGE=0"
if /i "%~1"=="--purge" set "PURGE=1"

where docker >nul 2>&1
if errorlevel 1 (
    echo.
    echo    X  Docker не найден - останавливать нечего.
    echo.
    pause
    exit /b 1
)

docker compose version >nul 2>&1
if not errorlevel 1 (
    set "DC=docker compose"
) else (
    set "DC=docker-compose"
)

set "P=--profile migrate --profile api --profile bot --profile web"
set "E=--env-file secrets.env"

echo.
echo    Останавливаю AI Маркетолог...

if "%PURGE%"=="1" (
    echo.
    echo    ВНИМАНИЕ: вместе с контейнерами будут удалены база данных и Redis.
    set /p "CONFIRM=   Напишите ДА для подтверждения: "
    if /i not "!CONFIRM!"=="ДА" (
        echo    Отменено - ничего не удалено.
        echo.
        pause
        exit /b 0
    )
    %DC% !E! !P! down -v --remove-orphans
    echo.
    echo    OK Проект остановлен, данные удалены.
    echo.
    pause
    exit /b 0
)

%DC% !E! !P! down --remove-orphans
if errorlevel 1 (
    echo    X  Не удалось остановить контейнеры. Запустите: docker compose logs
    echo.
    pause
    exit /b 1
)

echo.
echo    OK Проект остановлен. Данные сохранены в томах.
echo       Запустить снова: start.bat
echo       Удалить данные:  stop.bat --purge
echo.
pause
exit /b 0
