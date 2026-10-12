@echo off
rem ═══════════════════════════════════════════════════════════════
rem   AI МАРКЕТОЛОГ — ЛОГИ (Windows)
rem   logs.bat            — все сервисы, живой поток (Ctrl+C — выход)
rem   logs.bat bot        — только бот
rem   logs.bat api 200    — последние 200 строк API
rem ═══════════════════════════════════════════════════════════════

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "SERVICE=%~1"
set "TAIL=%~2"
if not defined TAIL set "TAIL=100"

where docker >nul 2>&1
if errorlevel 1 (
    echo.
    echo    X  Docker не найден - логи недоступны.
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
if not defined SERVICE (
    echo    Логи всех сервисов ^(Ctrl+C - выход^):
    echo.
    %DC% !E! !P! logs -f --tail !TAIL!
) else (
    echo    Логи сервиса !SERVICE! ^(Ctrl+C - выход^):
    echo.
    %DC% !E! !P! logs -f --tail !TAIL! !SERVICE!
)

echo.
pause
exit /b 0
