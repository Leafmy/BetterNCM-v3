@echo off
REM BetterNCM(v3) one-click installer entry point (launched by the self-extracting Setup .exe).
REM
REM Flat on purpose: IExpress only unpacks the two files listed in its .sed, and it does NOT
REM preserve nested directories reliably, so the real payload travels as payload.zip and is
REM expanded here (subdirectories intact) before install\install.ps1 takes over.
REM
REM Options: a double-click runs the default install.  Extra switches can be supplied either on
REM the Setup .exe's own command line (%*) or -- because the IExpress stub ignores its arguments
REM and then never launches this script -- through the BNCM_SETUP_ARGS environment variable:
REM   set BNCM_SETUP_ARGS=-InstallDir D:\bncm -NoProxy -NoAutostart -NoShortcut -NoStart
REM BNCM_NOPAUSE=1 makes the whole thing unattended (used by tools\release\verify_release.ps1).
setlocal
set "HERE=%~dp0"
set "WORK=%TEMP%\bncm-setup-%RANDOM%%RANDOM%"
set "EXTRA=%*"
if defined BNCM_SETUP_ARGS set "EXTRA=%EXTRA% %BNCM_SETUP_ARGS%"

echo.
echo BetterNCM(v3) installer
echo -----------------------
echo Unpacking to %WORK% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%HERE%payload.zip' -DestinationPath '%WORK%' -Force"
if errorlevel 1 (
  echo.
  echo ERROR: could not unpack payload.zip
  if not defined BNCM_NOPAUSE pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%WORK%\install\install.ps1" -PayloadRoot "%WORK%" %EXTRA%
set "RC=%ERRORLEVEL%"

rmdir /s /q "%WORK%" 2>nul

echo.
if not "%RC%"=="0" echo The installer exited with code %RC%.
if not defined BNCM_NOPAUSE pause
exit /b %RC%
