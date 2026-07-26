@echo off
title Grant
mode con: cols=85 lines=48
cd /d "%~dp0"

if not exist node_modules (
    echo [*] Installing required dependencies...
    call npm install
)

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' AND CommandLine LIKE '%%pc_controller.js%%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
node pc_controller.js
pause
