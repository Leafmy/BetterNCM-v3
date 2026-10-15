@echo off
REM BetterNCM uninstaller (kept in the install directory).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" %*
pause
