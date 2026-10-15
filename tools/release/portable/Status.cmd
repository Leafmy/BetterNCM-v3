@echo off
REM Show what the BetterNCM agent / backend / client look like right now.
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\loader\startup.ps1" -Status -NcmData "%HERE%data"
pause
