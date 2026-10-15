@echo off
REM Stop the BetterNCM agent/backend started by this portable package.
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\loader\startup.ps1" -Stop -NcmData "%HERE%data"
pause
