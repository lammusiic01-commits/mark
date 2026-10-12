@echo off
rem ═══════════════════════════════════════════════════════════════
rem   AI МАРКЕТОЛОГ — ЗАПУСК ПРОЕКТА (Windows)
rem
rem   Один двойной клик — и проект работает:
rem     1. проверка Docker и Docker Compose;
rem     2. создание secrets.env из шаблона ^(+ открытие в Блокноте^);
rem     3. генерация ENCRYPTION_KEY, если он пустой;
rem     4. сборка контейнеров;
rem     5. запуск базы и Redis, применение миграций;
rem     6. запуск сервисов ^(API, бот, WebApp^).
rem
rem   Проверка без запуска:  start.bat --check
rem ═══════════════════════════════════════════════════════════════

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "ROOT=%CD%"
set "SECRETS=%ROOT%\secrets.env"
set "TEMPLATE=%ROOT%\secrets.env.example"
set "ENVFILE=--env-file secrets.env"
set "DC="
set "DRY=0"
set "PROFILES=--profile migrate --profile api"

for %%A in (%*) do (
    if /i "%%~A"=="--check" set "DRY=1"
    if /i "%%~A"=="--check-only" set "DRY=1"
    if /i "%%~A"=="-h" goto :usage
    if /i "%%~A"=="--help" goto :usage
)

cls
echo.
echo    ===============================================
echo    ^|      AI МАРКЕТОЛОГ - ЗАПУСК ПРОЕКТА          ^|
echo    ^|      Premium Telegram Mini App               ^|
echo    ===============================================
echo.
if "%DRY%"=="1" echo    Режим проверки: команды Docker только показываются.
echo.

rem ─────────────────────── 1. Docker ───────────────────────────
echo [1/6] Проверяю Docker...
where docker >nul 2>&1
if errorlevel 1 (
    if "%DRY%"=="1" (
        echo       ВНИМАНИЕ: Docker не найден ^(в режиме проверки продолжаем^)
        set "DC=docker compose"
        goto :docker_done
    )
    echo.
    echo       X  Docker не установлен!
    echo.
    echo       Установите Docker Desktop для Windows:
    echo       https://www.docker.com/products/docker-desktop
    echo.
    echo       После установки перезагрузите компьютер и запустите start.bat заново.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%V in ('docker --version 2^>nul') do echo       OK Docker найден ^(%%V^)

docker compose version >nul 2>&1
if not errorlevel 1 (
    set "DC=docker compose"
    goto :compose_found
)
where docker-compose >nul 2>&1
if not errorlevel 1 (
    set "DC=docker-compose"
    goto :compose_found
)

echo       X  Не найден Docker Compose ^(ни "docker compose", ни "docker-compose"^)
echo       Обновите Docker Desktop или установите плагин docker-compose-plugin.
echo.
pause
exit /b 1

:compose_found
echo       OK Compose найден: !DC!

if "%DRY%"=="0" (
    docker info >nul 2>&1
    if errorlevel 1 (
        echo.
        echo       X  Docker установлен, но не запущен.
        echo       Откройте Docker Desktop и дождитесь надписи "Engine running",
        echo       затем запустите start.bat снова.
        echo.
        pause
        exit /b 1
    )
    echo       OK Демон Docker отвечает
)

:docker_done

rem ───────────────────── 2. secrets.env ────────────────────────
echo.
echo [2/6] Проверяю secrets.env...

if not exist "%SECRETS%" (
    copy /Y "%TEMPLATE%" "%SECRETS%" >nul
    echo       Файл secrets.env создан из шаблона.
    echo.
    echo    ===============================================
    echo    ^|   ВАЖНО: ЗАПОЛНИ secrets.env                ^|
    echo    ===============================================
    echo.
    echo    1. BOT_TOKEN          - токен у @BotFather ^(/newbot^)
    echo    2. OPENROUTER_API_KEY - бесплатный ключ: https://openrouter.ai/keys
    echo    3. WEBAPP_URL         - HTTPS-адрес ^(локально: ngrok http 3000^)
    echo    4. TELEGRAM_PROXY_URL - прокси для работы из РФ ^(уже заполнен^)
    echo.
    echo    Сейчас откроется Блокнот. Заполните значения, сохраните файл
    echo    ^(Ctrl+S^) и запустите start.bat снова.
    echo.
    pause
    start "" notepad "%SECRETS%"
    exit /b 0
)

echo       OK secrets.env найден

rem ──────────────── 3. ENCRYPTION_KEY и проверки ───────────────
echo.
echo [3/6] Проверяю ключ шифрования...

call :GetVar ENCRYPTION_KEY
if defined VALUE (
    echo       OK Ключ шифрования уже установлен
) else (
    set "NEWKEY="
    call :GenerateKey
    if not defined NEWKEY (
        echo       X  Не удалось сгенерировать ENCRYPTION_KEY.
        echo       Сгенерируйте ключ вручную ^(например, через python^) и вставьте в secrets.env
        echo.
        pause
        exit /b 1
    )
    call :SetVar ENCRYPTION_KEY "!NEWKEY!"
    echo       OK Ключ шифрования сгенерирован и записан в secrets.env
    echo          Сохраните его в надёжном месте: без ключа подключения пользователей не восстановить
)

set "MISSING="
call :GetVar BOT_TOKEN
if not defined VALUE set "MISSING=!MISSING! BOT_TOKEN"
call :GetVar OPENROUTER_API_KEY
if not defined VALUE set "MISSING=!MISSING! OPENROUTER_API_KEY"
call :GetVar DB_PASSWORD
if not defined VALUE set "MISSING=!MISSING! DB_PASSWORD"
call :GetVar WEBAPP_URL
if not defined VALUE set "MISSING=!MISSING! WEBAPP_URL"

if defined MISSING (
    echo       ВНИМАНИЕ: не заполнены переменные:!MISSING!
    echo       Проект запустится, но без этих значений бот и AI-советы работать не будут.
    echo       Откройте secrets.env, заполните их и запустите start.bat снова.
)

call :GetVar WEBAPP_URL
echo !VALUE! | findstr /i /b /c:"https://" >nul
if not errorlevel 1 echo       OK WEBAPP_URL с HTTPS - Telegram сможет открыть приложение

rem ──────────── Какие сервисы уже есть в проекте ───────────────
if exist "%ROOT%\bot\main.py" (
    set "PROFILES=!PROFILES! --profile bot"
) else (
    echo       Бот появится после этапа 2 ^(bot\main.py^) - сейчас он в план не входит
)
if exist "%ROOT%\webapp\package.json" (
    set "PROFILES=!PROFILES! --profile web"
) else (
    echo       WebApp появится после этапа 8 ^(webapp\package.json^)
)

rem ───────────────────────── 4. Сборка ────────────────────────
echo.
echo [4/6] Собираю Docker-контейнеры ^(первый запуск 3-5 минут^)...
call :Run %DC% !ENVFILE! !PROFILES! build
if errorlevel 1 goto :build_failed
echo       OK Образы собраны

rem ───────────────────── 5. База и миграции ───────────────────
echo.
echo [5/6] Поднимаю базу и применяю миграции...

if "%DRY%"=="1" (
    call :Run %DC% !ENVFILE! up -d postgres redis
    call :Run %DC% !ENVFILE! --profile migrate run --rm --no-deps migrate
    goto :services
)

call :Run %DC% !ENVFILE! up -d postgres redis
echo       PostgreSQL и Redis запущены

call :WaitHealthy postgres 150
call :WaitHealthy redis 60

call :Run %DC% !ENVFILE! --profile migrate run --rm --no-deps migrate
if errorlevel 1 (
    echo       ВНИМАНИЕ: миграции не применились - смотрите логи выше.
    echo       Продолжаем запуск: схему можно применить позже командой update.bat
) else (
    echo       OK Миграции применены ^(alembic upgrade head^)
)

:services
rem ───────────────────────── 6. Запуск ────────────────────────
echo.
echo [6/6] Запускаю сервисы...
call :Run %DC% !ENVFILE! !PROFILES! up -d
if errorlevel 1 goto :up_failed
echo       OK Сервисы запущены

call :GetVar API_PORT
if not defined VALUE set "VALUE=8000"
set "APIPORT=!VALUE!"
call :GetVar WEBAPP_PORT
if not defined VALUE set "VALUE=3000"
set "WEBPORT=!VALUE!"

echo.
echo    ===============================================
echo    ^|          ВСЁ ЗАПУЩЕНО!                      ^|
echo    ===============================================
echo.
echo    Бот работает в фоне ^(если задан BOT_TOKEN^)
echo    API:      http://localhost:!APIPORT!/docs
echo    Проверка: http://localhost:!APIPORT!/health
if exist "%ROOT%\webapp\package.json" (
    echo    WebApp:   http://localhost:!WEBPORT!
) else (
    echo    WebApp:   появится после этапа 8
)
echo.
echo    Остановить:  stop.bat
echo    Логи:        logs.bat
echo    Обновление:  update.bat
echo.
pause
exit /b 0

rem ═════════════════════ Подпрограммы ═════════════════════════

:build_failed
echo.
echo       X  Сборка не удалась. Частые причины:
echo          - Docker Desktop не запущен или мало памяти ^(нужно 2 ГБ^);
echo          - нет доступа в интернет для скачивания образов;
echo          - в secrets.env остались символы из примера.
echo       Полные логи: docker compose --env-file secrets.env logs
echo.
pause
exit /b 1

:up_failed
echo.
echo       X  Не удалось запустить контейнеры. Посмотрите логи командой logs.bat
echo.
pause
exit /b 1

:usage
echo.
echo    Запуск проекта:      start.bat
echo    Проверка без старта: start.bat --check
echo    Остановка:           stop.bat
echo    Логи:                logs.bat
echo    Обновление:          update.bat
echo.
exit /b 0

rem ─── Run: выполняет команду либо печатает её в режиме проверки ───
:Run
if "%DRY%"=="1" (
    echo       -^> %*
    exit /b 0
)
%*
exit /b %errorlevel%

rem ─── WaitHealthy СЕРВИС ТАЙМАУТ: ждёт статус healthy ───
:WaitHealthy
setlocal EnableDelayedExpansion
set "SERVICE=%~1"
set "TIMEOUT=%~2"
set /a ELAPSED=0
:WaitHealthyLoop
set "CID="
for /f "tokens=*" %%C in ('%DC% %ENVFILE% ps -q %SERVICE% 2^>nul') do set "CID=%%C"
if defined CID (
    set "STATE=unknown"
    for /f "tokens=*" %%S in ('docker inspect -f "{{.State.Health.Status}}" !CID! 2^>nul') do set "STATE=%%S"
    if "!STATE!"=="healthy" (
        echo       OK %SERVICE% готов
        endlocal
        exit /b 0
    )
)
set /a ELAPSED+=3
if !ELAPSED! GEQ %TIMEOUT% (
    echo       ВНИМАНИЕ: %SERVICE% не отчитался как healthy за %TIMEOUT% сек - продолжаем
    endlocal
    exit /b 1
)
timeout /t 3 /nobreak >nul
goto :WaitHealthyLoop

rem ─── GetVar ИМЯ: читает значение из secrets.env в VALUE ───
:GetVar
set "VALUE="
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%SECRETS%") do (
    if /i "%%~A"=="%~1" set "VALUE=%%~B"
)
if defined VALUE set "VALUE=!VALUE:"=!"
if defined VALUE for /f "tokens=* delims= " %%T in ("!VALUE!") do set "VALUE=%%T"
exit /b 0

rem ─── SetVar ИМЯ ЗНАЧЕНИЕ: заменяет или добавляет строку в secrets.env ───
:SetVar
setlocal EnableDelayedExpansion
set "SNAME=%~1"
set "SVALUE=%~2"
set "PSCODE=$p='%SECRETS%'; $n='%SNAME%'; $v='%SVALUE%'; $c=[System.IO.File]::ReadAllText($p); $r=[regex]::Replace($c, '(?m)^'+$n+'=.*', $n+'='+$v); if ($r -notmatch ('(?m)^'+$n+'=')) { $r = $r.TrimEnd() + [Environment]::NewLine + $n + '=' + $v + [Environment]::NewLine }; [System.IO.File]::WriteAllText($p, $r, (New-Object System.Text.UTF8Encoding($false)))"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%PSCODE%" >nul 2>&1
if errorlevel 1 (
    rem запасной путь: доклеить значение в конец файла
    >>"%SECRETS%" echo %SNAME%=%SVALUE%
)
endlocal
exit /b 0

rem ─── GenerateKey: генерирует ключ Fernet в NEWKEY ───
:GenerateKey
setlocal EnableDelayedExpansion
set "KEY="
for /f "tokens=*" %%K in ('powershell -NoProfile -Command "$b=New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')" 2^>nul') do set "KEY=%%K"
if not defined KEY (
    where python >nul 2>&1
    if not errorlevel 1 (
        for /f "tokens=*" %%K in ('python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())" 2^>nul') do set "KEY=%%K"
    )
)
if not defined KEY (
    where docker >nul 2>&1
    if not errorlevel 1 (
        for /f "tokens=*" %%K in ('docker run --rm python:3.12-slim python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())" 2^>nul') do set "KEY=%%K"
    )
)
endlocal & set "NEWKEY=%KEY%"
exit /b 0
