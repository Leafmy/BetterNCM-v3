# create-shortcut.ps1 -- a "网易云音乐 (BetterNCM)" shortcut that needs no logon entry.
#
# Why it exists alongside startup.ps1: the logon watchdog has to RESTART the client when it comes
# up without --remote-debugging-port, which the user sees as a brief flicker.  A shortcut that goes
# through loader\bncm-agent.vbs --launch starts the client correctly in the first place, so nothing
# is ever restarted.  Both paths end in the same place.
#
# The shortcut carries the resolved client and data directories, so it works on a machine that is
# not this checkout (see loader/paths.ps1).
#
# Usage (via loader\create-shortcut.cmd):
#   loader\create-shortcut.cmd                    # desktop + start menu
#   loader\create-shortcut.cmd -DesktopOnly
#   loader\create-shortcut.cmd -Replace           # ALSO replace the existing 网易云音乐 shortcut
#   loader\create-shortcut.cmd -Remove            # delete the shortcuts we created

[CmdletBinding()]
param(
    [string]$Name = '网易云音乐 (BetterNCM)',
    [string]$NcmDir = '',
    [string]$NcmData = '',
    [switch]$DesktopOnly,
    [switch]$StartMenuOnly,
    [switch]$Replace,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'paths.ps1')
$vbs = Join-Path $PSScriptRoot 'bncm-agent.vbs'

# The shortcut must carry the resolved client/data directories: the agent's compiled-in defaults
# are a fact about the development machine, not about wherever this package is installed.
if ([string]::IsNullOrEmpty($NcmDir)) { $NcmDir = Resolve-BncmNcmDir -Root $root }
if ([string]::IsNullOrEmpty($NcmData)) { $NcmData = Resolve-BncmDataDir -Root $root }
$exe = Join-Path $NcmDir 'cloudmusic.exe'
$replaceName = '网易云音乐'
$launchArgs = '--launch --ncm "' + $NcmDir + '" --data "' + $NcmData + '" --plugins "' + (Join-Path $NcmData 'plugins') + '" --quiet'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

function New-Lnk([string]$path) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments = '"' + $vbs + '" ' + $launchArgs
    $lnk.WorkingDirectory = $root
    $lnk.Description = 'NetEase Cloud Music with BetterNCM (loads plugins automatically)'
    if (Test-Path -LiteralPath $exe) { $lnk.IconLocation = "$exe,0" }
    $lnk.Save()
    Write-Host "created: $path" -ForegroundColor Green
}

function Remove-Lnk([string]$path) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "removed: $path"
    }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"
$desktopLnk = Join-Path $desktop "$Name.lnk"

# --- -Remove -------------------------------------------------------------------
if ($Remove) {
    Remove-Lnk $desktopLnk
    Remove-Lnk $startMenu
    $backup = Join-Path $PSScriptRoot 'backup'
    if (Test-Path -LiteralPath $backup) {
        foreach ($f in @(Get-ChildItem -LiteralPath $backup -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
            $target = Join-Path $desktop $f.Name
            if (-not (Test-Path -LiteralPath $target)) {
                Copy-Item -LiteralPath $f.FullName -Destination $target -Force
                Write-Host "restored: $target"
            }
        }
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $vbs)) { Fail "agent shim not found: $vbs" }

if (-not $StartMenuOnly) { New-Lnk $desktopLnk }
if (-not $DesktopOnly) { New-Lnk $startMenu }

# --- optional: take over the user's existing shortcut --------------------------
if ($Replace) {
    $original = Join-Path $desktop "$replaceName.lnk"
    if (Test-Path -LiteralPath $original) {
        $backupDir = Join-Path $PSScriptRoot 'backup'
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        $backupFile = Join-Path $backupDir "$replaceName.lnk"
        if (-not (Test-Path -LiteralPath $backupFile)) {
            Copy-Item -LiteralPath $original -Destination $backupFile -Force
            Write-Host "backed up the original shortcut -> $backupFile"
        } else {
            Write-Host "original shortcut already backed up; keeping the first copy"
        }
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($original)
        $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $lnk.Arguments = '"' + $vbs + '" ' + $launchArgs
        $lnk.WorkingDirectory = $root
        $lnk.Description = 'NetEase Cloud Music with BetterNCM'
        if (Test-Path -LiteralPath $exe) { $lnk.IconLocation = "$exe,0" }
        $lnk.Save()
        Write-Host "replaced the existing shortcut: $original (restore with -Remove)" -ForegroundColor Yellow
    } else {
        Write-Host "no existing '$replaceName.lnk' on the desktop to replace" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host "Shortcut(s) point at: wscript.exe `"$vbs`" $launchArgs" -ForegroundColor Green
Write-Host 'That path starts the client with the debug port, so no restart is ever needed.'
