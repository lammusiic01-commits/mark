@echo off
title Tenda TX2 & OneDash Finland - Windows 11 Gateway Manager
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%~dp0core\Gateway-Manager.ps1" (
    echo ======================================================================
    echo   PLEASE EXTRACT THE ZIP ARCHIVE FIRST!
    echo   Right-click the downloaded .zip file and click "Extract All..."
    echo ======================================================================
    pause
    exit /b
)

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\Gateway-Manager.ps1"
