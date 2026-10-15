# uninstall.ps1 -- remove an installed BetterNCM(v3) package.
#
# Reverses install.ps1:
#   * stops the agent and removes the HKCU logon entry
#   * removes the shortcuts we created
#   * removes the version.dll proxy IF it is still the one we installed (loader\uninstall.ps1
#     checks the recorded SHA-256 and refuses to delete a foreign file)
#   * removes the Add/Remove Programs entry
#   * deletes the install directory itself (detached, because this script lives in it)
#
# The DATA directory (plugins, settings, caches) is user data and is kept unless -RemoveData.

[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [switch]$RemoveData,
    [switch]$KeepProxy,
    [switch]$NoWait
)

$ErrorActionPreference = 'Continue'

function Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }
function Warn([string]$m) { Write-Host "   ! $m" -ForegroundColor Yellow }

if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = Split-Path -Parent $PSScriptRoot }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$app = Join-Path $InstallDir 'app'
$loader = Join-Path $app 'loader'
$paths = Join-Path $loader 'paths.ps1'

Write-Host 'BetterNCM(v3) uninstaller' -ForegroundColor Green
Write-Host '-------------------------'
Info "install dir : $InstallDir"

$dataDir = ''
if (Test-Path -LiteralPath $paths) {
    . $paths
    try { $dataDir = Resolve-BncmDataDir -Root $app } catch { $dataDir = '' }
}
Info "data dir    : $(if ($dataDir) { $dataDir } else { '(unknown)' })"

# --- 1. agent + logon entry -----------------------------------------------------------------
Step 'stopping the agent and removing the logon entry'
if (Test-Path -LiteralPath (Join-Path $loader 'startup.ps1')) {
    & (Join-Path $loader 'startup.ps1') -Uninstall
} else {
    $killed = 0
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -match 'bncm_agent\.mjs') {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
        }
    }
    Info "stopped $killed agent process(es)"
}

# --- 2. shortcuts ---------------------------------------------------------------------------
Step 'removing the shortcuts'
if (Test-Path -LiteralPath (Join-Path $loader 'create-shortcut.ps1')) {
    & (Join-Path $loader 'create-shortcut.ps1') -Remove
    # -Remove restores any shortcut we replaced, so the user's own 网易云音乐 icon comes back.
} else {
    Warn 'create-shortcut.ps1 not found; remove the shortcut manually'
}

# --- 3. native proxy ------------------------------------------------------------------------
if ($KeepProxy) {
    Step 'keeping the native proxy (-KeepProxy)'
} else {
    Step 'removing the native proxy'
    if (Test-Path -LiteralPath (Join-Path $loader 'uninstall.ps1')) {
        & (Join-Path $loader 'uninstall.ps1') -StopClient
    } else {
        Warn 'loader\uninstall.ps1 not found; the proxy (if any) was left in the client directory'
    }
}

# --- 4. add/remove programs entry -----------------------------------------------------------
Step 'removing the Add/Remove Programs entry'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterNCM'
if (Test-Path -LiteralPath $uninstallKey) {
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Info 'removed HKCU ...\Uninstall\BetterNCM'
} else {
    Info 'no registry entry to remove'
}

# --- 5. user data (opt-in) ------------------------------------------------------------------
if ($RemoveData) {
    Step 'removing user data (-RemoveData)'
    if ($dataDir -and (Test-Path -LiteralPath $dataDir)) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
        Info "removed $dataDir"
    } else {
        Info 'nothing to remove'
    }
} elseif ($dataDir) {
    Info "user data kept: $dataDir"
}

# --- 6. the install directory itself --------------------------------------------------------
Step 'removing the install directory'
Write-Host "   $InstallDir"
if ($NoWait) {
    Info 'left in place (-NoWait); delete the folder manually when you are done'
} else {
    # This script is running from inside $InstallDir, so the deletion has to happen after this
    # PowerShell process exits: hand it to a detached cmd.exe that waits first.
    $cmd = 'timeout /t 2 /nobreak >nul & rmdir /s /q "' + $InstallDir + '"'
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
        -ArgumentList @('/c', $cmd) -WindowStyle Hidden | Out-Null
    Info 'scheduled; the folder disappears a moment after this window closes'
}

Write-Host ''
Write-Host 'BetterNCM removed.' -ForegroundColor Green
if ($dataDir -and -not $RemoveData) {
    Write-Host "Your plugins and settings are still in $dataDir (delete the folder to erase them)."
}
Write-Host ''
