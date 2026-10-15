# install.ps1 -- one-click installer for BetterNCM(v3) on NetEase Cloud Music 3.1.41.
#
# Called by install.cmd, which is what the self-extracting Setup .exe launches.  Four things
# happen, in this order, and each one is optional:
#
#   1. the runtime is copied to %LOCALAPPDATA%\BetterNCM\app
#   2. the version.dll proxy is installed into the client (backed up; -NoProxy to skip)
#   3. the four distribution plugins are installed into the user plugin directory, the logon
#      watchdog is registered in HKCU, and the agent is started  (-NoAutostart / -NoStart)
#   4. a Start Menu / desktop shortcut and an uninstall entry are created (-NoShortcut)
#
# Nothing here is a fork of the loader: steps 2-4 call loader\install.ps1,
# loader\startup.ps1 and loader\create-shortcut.ps1 from the copied runtime, so an installed
# package behaves exactly like the checkout it was built from.

[CmdletBinding()]
param(
    [string]$PayloadRoot = '',
    [string]$InstallDir  = '',
    [string]$DataDir     = '',
    [string]$NcmDir      = '',
    [switch]$NoProxy,
    [switch]$NoAutostart,
    [switch]$NoShortcut,
    [switch]$NoStart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }
function Warn([string]$m) { Write-Host "   ! $m" -ForegroundColor Yellow }

if ([string]::IsNullOrEmpty($PayloadRoot)) { $PayloadRoot = Split-Path -Parent $PSScriptRoot }
$srcApp = Join-Path $PayloadRoot 'app'
if (-not (Test-Path -LiteralPath (Join-Path $srcApp 'loader\framework.js'))) {
    throw "payload not found at $srcApp -- install.ps1 expects app\ and install\ next to each other"
}

# Reuse the loader's own path discovery (client directory, node interpreter, data directory).
. (Join-Path $srcApp 'loader\paths.ps1')

if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'BetterNCM' }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$dstApp = Join-Path $InstallDir 'app'
if ([string]::IsNullOrEmpty($NcmDir))  { $NcmDir  = Resolve-BncmNcmDir  -Root $srcApp }
if ([string]::IsNullOrEmpty($DataDir)) { $DataDir = Resolve-BncmDataDir -Root $srcApp }
$pluginDir = Join-Path $DataDir 'plugins'

Write-Host 'BetterNCM(v3) installer for NetEase Cloud Music 3.1.41' -ForegroundColor Green
Write-Host '--------------------------------------------------------'
Info "payload       : $PayloadRoot"
Info "will install  : $InstallDir"
Info "client        : $NcmDir"
Info "data dir      : $DataDir"
Info "plugins       : $pluginDir"
if ($DryRun) { Warn 'DRY RUN: nothing will be written' }

# --- 1. runtime -----------------------------------------------------------------------------
Step 'copying the runtime'
if ($DryRun) {
    Info "would copy $srcApp -> $dstApp"
    $appExists = Test-Path -LiteralPath (Join-Path $dstApp 'loader\framework.js')
} else {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # robocopy returns 0-7 for success; >= 8 is a real failure.
    & robocopy $srcApp $dstApp /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
    $appExists = Test-Path -LiteralPath (Join-Path $dstApp 'loader\framework.js')
}
if (-not $appExists) { throw "runtime copy did not produce $dstApp\loader\framework.js" }
Info "runtime in place: $dstApp"

# --- 2. native proxy ------------------------------------------------------------------------
Step 'installing the native proxy (version.dll)'
if ($NoProxy) {
    Info 'skipped (-NoProxy). Plugins still load: the agent injects over CDP.'
} elseif ($DryRun) {
    Info "would run loader\install.ps1 -NcmDir `"$NcmDir`""
} else {
    # loader\install.ps1 refuses to replace a mapped DLL, so the client has to be closed.  A
    # one-click installer cannot ask, and the user has just clicked "install".
    $running = @(Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Info "stopping the running client ($($running.Count) process(es)) ..."
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 1500
    }
    $global:LASTEXITCODE = 0
    & (Join-Path $dstApp 'loader\install.ps1') -NcmDir $NcmDir
    if ($LASTEXITCODE -ne 0) {
        Warn "the proxy step exited with code $LASTEXITCODE -- continuing, plugins do not need it"
    }
}

# --- 3. plugins + autostart + agent ---------------------------------------------------------
Step 'installing plugins, auto-start and starting the agent'
# Hashtable splatting, not array splatting: an array splat binds its elements POSITIONALLY in
# PowerShell (parameter names are not interpreted), so `@('-NcmDir', $x, ...)` silently shifted
# every value one slot and died with "a positional parameter cannot be found that accepts
# argument '-PluginDir'".  A hashtable binds by name, which is what we mean.
$startParams = @{ NcmDir = $NcmDir; NcmData = $DataDir; PluginDir = $pluginDir }
if ($NoAutostart) { $startParams['Start'] = $true } else { $startParams['Install'] = $true }
if ($NoStart) { $startParams['NoStart'] = $true }
if ($DryRun) {
    Info "would run loader\startup.ps1 $(($startParams.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' ')"
} else {
    & (Join-Path $dstApp 'loader\startup.ps1') @startParams
}

# --- 4. shortcut + uninstaller --------------------------------------------------------------
Step 'creating the shortcut and the uninstaller'
if ($NoShortcut) {
    Info 'shortcut skipped (-NoShortcut)'
} elseif ($DryRun) {
    Info 'would create the Start Menu + desktop shortcut'
} else {
    & (Join-Path $dstApp 'loader\create-shortcut.ps1') -NcmDir $NcmDir -NcmData $DataDir
}

$uninstallPs = Join-Path $InstallDir 'Uninstall.ps1'
$uninstallCmd = Join-Path $InstallDir 'Uninstall.cmd'
if (-not $DryRun) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $uninstallPs -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.cmd') -Destination $uninstallCmd -Force

    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterNCM'
    New-Item -Path $uninstallKey -Force | Out-Null
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayName'     -Value 'BetterNCM (网易云音乐 3.1.41 插件加载器)'
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayVersion'  -Value '3.1.41'
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'Publisher'       -Value 'BetterNCM-v3'
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'InstallLocation' -Value $InstallDir
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'UninstallString' -Value ('"' + $uninstallCmd + '"')
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'NoModify'        -Value 1 -Type DWord
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'NoRepair'        -Value 1 -Type DWord
    $icon = Join-Path $NcmDir 'cloudmusic.exe'
    if (Test-Path -LiteralPath $icon) { Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayIcon' -Value $icon }
    Info "uninstall entry: $uninstallKey"
    Info "uninstaller    : $uninstallCmd"
}

# --- summary --------------------------------------------------------------------------------
Step 'done'
Write-Host ''
Write-Host 'How to use it' -ForegroundColor Green
Write-Host '  * Open NetEase Cloud Music normally.  The agent starts it with the debug port so the'
Write-Host '    plugins load; if the client was already running without it, it is restarted once.'
Write-Host '  * Or use the "网易云音乐 (BetterNCM)" shortcut for a zero-restart start.'
Write-Host ''
Write-Host 'What was installed' -ForegroundColor Green
Write-Host "  runtime : $dstApp"
Write-Host "  plugins : $pluginDir"
if (-not $NoProxy) { Write-Host "  proxy   : $(Join-Path $NcmDir 'version.dll')" }
Write-Host ''
Write-Host 'Uninstall: Settings > Apps, or run' -ForegroundColor Green
Write-Host "  $uninstallCmd"
Write-Host ''
