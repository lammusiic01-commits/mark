@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo    ВНИМАНИЕ: будет удалена база data.db
echo    (кампании, статистика, тесты, отчёты, баланс).
echo    secrets.env не трогается.
echo.
set /p OK=   Продолжить? (y/N): 
if /i not "%OK%"=="y" (
    echo    Отменено.
    exit /b 0
)

call stop.bat >nul 2>&1
del /q data.db data.db-wal data.db-shm >nul 2>&1
echo    База сброшена. Запусти start.bat.
pause
endlocal
