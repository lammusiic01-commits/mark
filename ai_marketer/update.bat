@echo off
rem ═══════════════════════════════════════════════════════════════
rem   AI МАРКЕТОЛОГ — ОБНОВЛЕНИЕ (Windows)
rem   1. забирает свежий код из git (если это git-копия);
rem   2. пересобирает образы;
rem   3. применяет миграции;
rem   4. поднимает сервисы заново.
rem   secrets.env и данные не трогаются.
rem ═══════════════════════════════════════════════════════════════

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
    echo.
    echo    X  Docker не найден. Установите Docker Desktop и повторите.
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

if not exist "secrets.env" (
    echo.
    echo    X  Нет файла secrets.env - сначала запустите start.bat
    echo.
    pause
    exit /b 1
)

set "P=--profile migrate --profile api"
if exist "%CD%\bot\main.py" set "P=!P! --profile bot"
if exist "%CD%\webapp\package.json" set "P=!P! --profile web"
set "E=--env-file secrets.env"

echo.
echo    Обновляю AI Маркетолог...
echo.

if exist ".git" (
    echo    git pull
    git pull --ff-only
    if errorlevel 1 (
        echo    ВНИМАНИЕ: git pull не удался ^(локальные правки?^) - продолжаю с текущим кодом
    ) else (
        echo    OK Код обновлён
    )
) else (
    echo    Распакованная копия без git - беру текущие файлы
)

echo    Собираю образы...
%DC% !E! !P! build
if errorlevel 1 (
    echo    X  Сборка не удалась - смотрите сообщения выше.
    echo.
    pause
    exit /b 1
)

echo    Поднимаю базу и Redis...
%DC% !E! up -d postgres redis
timeout /t 5 /nobreak >nul

echo    Применяю миграции...
%DC% !E! --profile migrate run --rm --no-deps migrate
if errorlevel 1 echo    ВНИМАНИЕ: миграции не применились - смотрите логи

echo    Перезапускаю сервисы...
%DC% !E! !P! up -d --remove-orphans

echo.
echo    OK Обновление завершено. Проверьте: logs.bat
echo.
pause
exit /b 0
