@echo off
REM Wrapper: .ps1 files are blocked by the default execution policy on this machine.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manager.ps1" %*
exit /b %ERRORLEVEL%
