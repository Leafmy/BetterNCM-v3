@echo off
REM BetterNCM portable launcher -- starts NetEase Cloud Music through the agent so plugins load.
REM Self-contained: no logon entry, no registry writes, nothing outside this folder.
REM Extra switches are forwarded, e.g.:  Start.cmd -NcmDir "D:\CloudMusic"
setlocal
set "HERE=%~dp0"
echo Starting BetterNCM from "%HERE%" ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%app\loader\startup.ps1" -Start -NcmData "%HERE%data" %*
if errorlevel 1 (
  echo.
  echo Something went wrong - see the messages above.
  pause
  exit /b 1
)
echo.
echo BetterNCM is running in the background; the client was started with the debug port.
echo   check status : Status.cmd
echo   stop         : Stop.cmd
timeout /t 6 /nobreak >nul
