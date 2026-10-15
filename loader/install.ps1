# install.ps1 -- install the BetterNCM(v3) version.dll proxy into the NetEase client.
#
# Reversible by design:
#   * if a version.dll already exists in the install directory it is backed up first;
#   * a manifest is written so uninstall.ps1 can prove it only removes what we added;
#   * the client must be closed, so no file is replaced while mapped.
#
# Run via loader\install.cmd (recommended) or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File loader\install.ps1

[CmdletBinding()]
param(
    [string]$NcmDir = '',
    [string]$Proxy  = '',
    [switch]$StopClient,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not available while param() defaults are evaluated under -File.
if ([string]::IsNullOrEmpty($Proxy)) { $Proxy = Join-Path $PSScriptRoot '..\out\loader\version.dll' }

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'paths.ps1')

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# An empty -NcmDir means "find the client": the checkout default (E:\CloudMusic) is not a fact
# about the machine the package is installed on.  See loader/paths.ps1 for the lookup order.
if ([string]::IsNullOrEmpty($NcmDir)) { $NcmDir = Resolve-BncmNcmDir -Root $root }

$proxyPath = [System.IO.Path]::GetFullPath($Proxy)
if (-not (Test-Path -LiteralPath $proxyPath)) {
    Fail "proxy not built: $proxyPath`n       run loader\build.cmd first"
}
$proxyHash = (Get-FileHash -LiteralPath $proxyPath -Algorithm SHA256).Hash.ToLower()

if (-not (Test-Path -LiteralPath $NcmDir)) { Fail "client directory not found: $NcmDir" }
$hostExe = Join-Path $NcmDir 'cloudmusic.exe'
if (-not (Test-Path -LiteralPath $hostExe)) { Fail "$NcmDir does not look like a NetEase install (no cloudmusic.exe)" }

# --- refuse to install while the client is mapped -------------------------------
$running = @(Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if ($StopClient) {
        Write-Host "stopping $($running.Count) cloudmusic process(es) ..."
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 1500
        $still = @(Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)
        if ($still.Count -gt 0) { Fail "could not stop the client; close it manually and retry" }
    } else {
        Fail "the client is running ($($running.Count) process(es)). Close it, or pass -StopClient."
    }
}

# --- warn about the detected filename ------------------------------------------
$detected = Join-Path $NcmDir 'msimg32.dll'
if (Test-Path -LiteralPath $detected) {
    Write-Host "WARNING: $detected exists." -ForegroundColor Yellow
    Write-Host "         NetEase 3.1.41 checks for that exact filename (CheckThirdPluginHook," -ForegroundColor Yellow
    Write-Host "         telemetry field existThirdPlugin) and may refuse to start. See docs/04-antitamper.md." -ForegroundColor Yellow
    Write-Host "         Remove it before testing this loader." -ForegroundColor Yellow
}

# --- back up an existing version.dll -------------------------------------------
#
# Only ever back up a file that is NOT ours.  Reinstalling over our own proxy used to copy the
# proxy to version.dll.orig, after which uninstall "restored" the proxy instead of the real
# original -- leaving the install permanently modified.  So:
#   * if our manifest says the current file is our own proxy, do not touch the backup;
#   * if a backup already exists, keep the original one (never overwrite it).
$target = Join-Path $NcmDir 'version.dll'
$backupDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'backup'))
$backupFile = Join-Path $backupDir 'version.dll.orig'
$manifestPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\out\loader\install-manifest.json'))

$prevProxyHash = $null
if (Test-Path -LiteralPath $manifestPath) {
    try { $prevProxyHash = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).proxy_sha256 } catch { $prevProxyHash = $null }
}

$backupPath = $null
if (Test-Path -LiteralPath $target) {
    $currentHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($prevProxyHash -and $currentHash -eq $prevProxyHash) {
        Write-Host 'existing version.dll is this tool''s own previous install; keeping any original backup as-is'
    } elseif (Test-Path -LiteralPath $backupFile) {
        Write-Host "original backup already recorded at $backupFile; not overwriting"
        $backupPath = $backupFile
    } else {
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Copy-Item -LiteralPath $target -Destination $backupFile -Force
        $backupPath = $backupFile
        Write-Host "backed up pre-existing version.dll -> $backupFile"
    }
}
# Preserve a recorded original even when the current file was ours.
if (-not $backupPath -and (Test-Path -LiteralPath $backupFile)) { $backupPath = $backupFile }

if ($WhatIf) {
    Write-Host "[WhatIf] would copy $proxyPath -> $target"
    exit 0
}

Copy-Item -LiteralPath $proxyPath -Destination $target -Force

$installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
if ($installedHash -ne $proxyHash) { Fail "copy verification failed for $target" }

$manifest = [ordered]@{
    installed_at   = (Get-Date).ToString('s')
    ncm_dir        = $NcmDir
    client_version = (Get-Item -LiteralPath $hostExe).VersionInfo.FileVersion
    target         = $target
    proxy_sha256   = $installedHash
    backup         = $backupPath
}
$manifestPath = $manifestPath   # computed above
New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath) | Out-Null
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Host ''
Write-Host "installed: $target" -ForegroundColor Green
Write-Host "sha256   : $installedHash"
Write-Host "manifest : $manifestPath"
Write-Host ''
Write-Host "Next: start the client, then inspect $(Join-Path $env:LOCALAPPDATA 'BetterNCM\logs\loader.log')"
