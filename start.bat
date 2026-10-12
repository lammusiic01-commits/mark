@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title AI Маркетолог
cd /d "%~dp0"

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

cls
echo.
echo    ==============================================
echo              AI МАРКЕТОЛОГ v4.0
echo        Telegram Mini App для Windows
echo    ==============================================
echo.

:: ═══ [1/7] Python (нужен 3.11-3.13) ═════════════════════
echo    [1/7] Проверка Python (нужен 3.11, 3.12 или 3.13)...
call :find_python
if not defined PYCMD (
    echo.
    echo    [ОШИБКА] Не найден Python 3.11, 3.12 или 3.13.
    echo    Для части библиотек проекта нет готовых сборок под Python 3.14 и новее,
    echo    поэтому нужен Python 3.12 (рекомендуется).
    echo.
    echo    Установленные версии Python:
    py -0p 2>nul
    echo.
    set /p "INSTALL_PY=   Установить Python 3.12 через winget? (Y/N): "
    if /i "!INSTALL_PY!"=="Y" (
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
        echo.
        echo    Python 3.12 установлен. Закрой это окно и запусти start.bat снова.
    ) else (
        echo    Скачай Python 3.12: https://www.python.org/downloads/release/python-3129/
        echo    ВАЖНО: поставь галочку "Add python.exe to PATH"
    )
    echo.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('%PYCMD% --version 2^>^&1') do set PYVER=%%v
echo          Python !PYVER! (%PYCMD%)

:: ═══ [2/7] Venv ═════════════════════════════════════════
echo.
echo    [2/7] Виртуальное окружение...
if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe -c "import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1
    if errorlevel 1 (
        echo          Существующее venv несовместимо с Python, пересоздаю...
        rmdir /s /q venv
    )
)
if not exist "venv\Scripts\python.exe" (
    %PYCMD% -m venv venv
    if errorlevel 1 (
        echo    [ОШИБКА] Не удалось создать venv.
        pause
        exit /b 1
    )
    echo          Создано
) else (
    echo          Существует
)
call venv\Scripts\activate.bat

:: ═══ [3/7] Зависимости ══════════════════════════════════
echo.
echo    [3/7] Зависимости Python...
set NEED_DEPS=1
if exist "venv\.deps_ok" (
    fc /b requirements.txt venv\.deps_ok >nul 2>&1 && set NEED_DEPS=0
)
if "!NEED_DEPS!"=="1" (
    echo          Установка (2-3 мин)...
    python -m pip install --upgrade pip -q
    python -m pip install -r requirements.txt -q
    if errorlevel 1 (
        echo    [ОШИБКА] Не удалось установить зависимости.
        echo    Проверь интернет и запусти start.bat снова.
        pause
        exit /b 1
    )
    copy /y requirements.txt venv\.deps_ok >nul
    echo          Установлены
) else (
    echo          Уже установлены
)

:: ═══ [4/7] Cloudflared (HTTPS для Mini App) ═════════════
echo.
echo    [4/7] Cloudflare Tunnel (для Mini App)...
if not exist "cloudflared.exe" (
    echo          Скачиваю cloudflared.exe (около 30 МБ, один раз)...
    if exist "cloudflared.exe.part" del /q "cloudflared.exe.part" >nul 2>&1
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe.part'"
    if exist "cloudflared.exe.part" (
        move /y "cloudflared.exe.part" "cloudflared.exe" >nul
    )
    if not exist "cloudflared.exe" (
        echo    [ОШИБКА] Не удалось скачать cloudflared.
        echo    Скачай вручную: https://github.com/cloudflare/cloudflared/releases
        echo    Переименуй файл в cloudflared.exe и положи в папку проекта.
        pause
        exit /b 1
    )
    echo          Скачан
) else (
    echo          Уже есть
)

:: ═══ [5/7] secrets.env ══════════════════════════════════
echo.
echo    [5/7] Проверка secrets.env...
if not exist "secrets.env" (
    copy /y secrets.env.example secrets.env >nul
    echo.
    echo    ==============================================
    echo      ЗАПОЛНИ secrets.env
    echo.
    echo      Обязательно:
    echo        BOT_TOKEN          - у @BotFather
    echo        TELEGRAM_PROXY_URL - уже заполнен
        echo.
    echo      Необязательно:
        echo        OPENROUTER_API_KEY - AI-советы (openrouter.ai/keys)
        echo.
    echo      После заполнения запусти start.bat снова.
    echo    ==============================================
    echo.
    notepad secrets.env
    pause
    exit /b 0
)

findstr /R /C:"^BOT_TOKEN=.\+" secrets.env >nul 2>&1
if errorlevel 1 (
    echo    [ОШИБКА] Заполни BOT_TOKEN в secrets.env
    notepad secrets.env
    pause
    exit /b 1
)

findstr /R /C:"^TELEGRAM_PROXY_URL=https://" secrets.env >nul 2>&1
if errorlevel 1 (
    echo    [ОШИБКА] В secrets.env должен быть TELEGRAM_PROXY_URL=https://... ^(Worker-прокси^)
    echo    Без него бот не работает из России.
    notepad secrets.env
    pause
    exit /b 1
)

findstr /R /C:"^ENCRYPTION_KEY=.\+" secrets.env >nul 2>&1
if errorlevel 1 (
    echo          Генерация ключа шифрования...
    python -c "import pathlib,re; from cryptography.fernet import Fernet; p=pathlib.Path('secrets.env'); k=Fernet.generate_key().decode(); t=p.read_text(encoding='utf-8'); t=re.sub(r'^ENCRYPTION_KEY=.*$', 'ENCRYPTION_KEY='+k, t, count=1, flags=re.M); p.write_text(t, encoding='utf-8')"
    if errorlevel 1 (
        echo    [ОШИБКА] Не удалось сгенерировать ENCRYPTION_KEY.
        pause
        exit /b 1
    )
    echo          Ключ сгенерирован
)
echo          OK

:: Порт берём из secrets.env (по умолчанию 8000)
set "PORT_VAL=8000"
for /f "delims=" %%p in ('powershell -NoProfile -Command "$l=(Get-Content secrets.env | Where-Object { $_ -match '^PORT=\s*\d+' } | Select-Object -First 1); if($l){ ($l -split '=',2)[1].Trim() }"') do set "PORT_VAL=%%p"

:: ═══ [6/7] Cloudflare Tunnel запуск ═════════════════════
echo.
echo    [6/7] Запуск Cloudflare Tunnel (HTTPS для Mini App)...
if not exist "logs" mkdir logs

:: Гасим старый cloudflared, если остался от прошлого запуска
taskkill /F /IM cloudflared.exe /T >nul 2>&1
if exist "tunnel.url" del /q "tunnel.url" >nul 2>&1
if exist "logs\tunnel.log" del /q "logs\tunnel.log" >nul 2>&1

start "" /b cmd /c "cloudflared.exe tunnel --no-autoupdate --url http://localhost:!PORT_VAL! > logs\tunnel.log 2>&1"

echo          Ожидание HTTPS URL (до 30 секунд)...
set "TUNNEL_URL="
for /l %%i in (1,1,30) do (
    if not defined TUNNEL_URL (
        ping -n 2 127.0.0.1 >nul
        for /f "delims=" %%u in ('powershell -NoProfile -Command "$t=''; if(Test-Path logs\tunnel.log){ $t=Get-Content logs\tunnel.log -Raw }; $m=[regex]::Match($t,'https://[a-z0-9-]+\.trycloudflare\.com'); if($m.Success){ $m.Value }"') do set "TUNNEL_URL=%%u"
    )
)

if not defined TUNNEL_URL (
    echo.
    echo    [ПРЕДУПРЕЖДЕНИЕ] Не удалось получить HTTPS URL от Cloudflare Tunnel.
    echo    Mini App не откроется в Telegram, пока tunnel не поднимется.
    echo    Смотри logs\tunnel.log
    echo.
) else (
    echo          !TUNNEL_URL!
)

:: Сохраняем URL для Python-процесса (пустой файл = tunnel не поднялся)
if defined TUNNEL_URL (
    > tunnel.url echo !TUNNEL_URL!
) else (
    > tunnel.url echo.
)
set "WEBAPP_URL=!TUNNEL_URL!"

:: ═══ [7/7] Миграции + Запуск ════════════════════════════
echo.
echo    [7/7] Миграции базы данных...
python -m alembic upgrade head >logs\migrations.log 2>&1
if errorlevel 1 (
    echo    [ПРЕДУПРЕЖДЕНИЕ] Миграции завершились с ошибкой. Смотри logs\migrations.log
)

cls
echo.
echo    ==============================================
echo              AI МАРКЕТОЛОГ ЗАПУЩЕН
echo    ==============================================
echo.
echo    Mini App URL:
if defined TUNNEL_URL (
    echo      !TUNNEL_URL!
) else (
    echo      НЕ ПОЛУЧЕН - см. logs\tunnel.log
)
echo.
echo    Открой бота в Telegram -^> /start
echo    Нажми кнопку "Открыть приложение"
echo.
echo    НЕ ЗАКРЫВАЙ ЭТО ОКНО!
echo    Для остановки: stop.bat
echo    ==============================================
echo.

:: Запуск основного процесса (блокирующий): API + бот + SPA
python -m app.main
set "EXIT_CODE=!errorlevel!"

:: После остановки Python гасим tunnel
taskkill /F /IM cloudflared.exe /T >nul 2>&1

echo.
echo    Сервер остановлен (код !EXIT_CODE!).
pause
exit /b !EXIT_CODE!

:find_python
set "PYCMD="
for %%V in (3.13 3.12 3.11) do (
    if not defined PYCMD (
        py -%%V -c "import sys" >nul 2>&1 && set "PYCMD=py -%%V"
    )
)
if not defined PYCMD (
    python -c "import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1 && set "PYCMD=python"
)
goto :eof
