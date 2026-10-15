# startup.ps1 -- install / start / stop the BetterNCM agent, and register it as a logon watchdog.
#
# What this buys: 网易云音乐 loads plugins whether or not it was started from a shortcut.  The
# agent waits for cloudmusic.exe, and if the client came up WITHOUT --remote-debugging-port it
# restarts it once (rate-limited) so the injection channel exists.  See tools/bncm_agent.mjs for
# why we control the process start instead of patching the command line: the client has a
# `[boot] protocol command line injection detected` check, and that is exactly what it looks for.
#
# Scope: HKCU only.  No administrator rights, and nothing outside this user profile is touched.
#
# Usage (via loader\startup.cmd; .ps1 is blocked by policy here):
#   loader\startup.cmd -Install     # logon watchdog + plugin seed + start now   (installed use)
#   loader\startup.cmd -Start       # plugin seed + start now, NO logon entry    (portable use)
#   loader\startup.cmd -Stop
#   loader\startup.cmd -Uninstall
#   loader\startup.cmd -Status
#
# Path resolution (client directory, node interpreter, data directory) lives in loader/paths.ps1
# so a release package -- bundled node.exe, client found through the registry -- uses the same
# code as this checkout.

[CmdletBinding()]
param(
    [string]$NcmDir = '',
    [string]$NcmData = '',
    [string]$PluginDir = '',
    [string]$Node = '',
    [switch]$Install,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$NoPluginInstall,
    [switch]$NoStart,
    [switch]$NoRelaunch
)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'paths.ps1')

$vbs = Join-Path $PSScriptRoot 'bncm-agent.vbs'
$runKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$runName = 'BetterNCM'

function Resolve-Existing([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Resolve-Path -LiteralPath $path).ProviderPath
}

function Get-InstalledCommand {
    try {
        $v = (Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction Stop).$runName
        return $v
    } catch { return $null }
}

function Get-StatusReport {
    $nodeExe = ''
    try { $nodeExe = Resolve-BncmNode -Root $root } catch { $nodeExe = '(not found)' }
    $ncm = ''
    try { $ncm = Resolve-BncmNcmDir -Root $root } catch { $ncm = '(not found)' }
    $data = ''
    try { $data = Resolve-BncmDataDir -Root $root } catch { $data = '(not found)' }
    $plugins = $PluginDir
    if (-not $plugins) {
        if ($data -and $data -ne '(not found)') { $plugins = Join-Path $data 'plugins' } else { $plugins = '(not found)' }
    }
    $cmd = Get-InstalledCommand

    Write-Host "package root   : $root"
    Write-Host "agent shim     : $vbs"
    Write-Host "node.exe       : $nodeExe"
    Write-Host "client dir     : $ncm"
    Write-Host "run key        : $runKey\$runName"
    Write-Host "run value      : $(if ($cmd) { $cmd } else { '(not installed)' })"
    Write-Host "data dir       : $data"
    Write-Host "plugin dir     : $plugins"
    $installed = @()
    if (Test-Path -LiteralPath $plugins) {
        $installed = @(Get-ChildItem -LiteralPath $plugins -Filter '*.plugin' -ErrorAction SilentlyContinue |
                       ForEach-Object { $_.Name })
    }
    Write-Host "user plugins   : $(if ($installed.Count) { $installed -join ', ' } else { '(none)' })"
    $lock = Join-Path $root 'out\agent.lock'
    Write-Host "agent lock     : $(if (Test-Path -LiteralPath $lock) { (Get-Content -LiteralPath $lock -Raw).Trim() } else { '(none)' })"
    $descriptor = Join-Path $root 'out\host.json'
    if (Test-Path -LiteralPath $descriptor) {
        try {
            $d = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
            Write-Host "backend        : $($d.api) (data=$($d.data), plugins=$($d.pluginsDir))"
        } catch { }
    } else {
        Write-Host "backend        : (no descriptor)"
    }
}

function Start-Agent([string]$mode, [string]$ncm, [string]$data, [string]$plugins) {
    # `wscript.exe <shim> <args>` -- no console window, and the shim resolves node itself so the
    # same call works for a checkout (PATH/DSH runtime) and for a package (bundled bin\node.exe).
    $cliArgs = @("`"$vbs`"", $mode, '--ncm', "`"$ncm`"", '--data', "`"$data`"", '--plugins', "`"$plugins`"")
    if ($NoRelaunch) { $cliArgs += '--no-relaunch' }
    $cliArgs += '--quiet'
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList $cliArgs -WindowStyle Hidden | Out-Null

    Start-Sleep -Milliseconds 1500
    $lock = Join-Path $root 'out\agent.lock'
    if (Test-Path -LiteralPath $lock) {
        Write-Host "agent is running: $((Get-Content -LiteralPath $lock -Raw).Trim())" -ForegroundColor Green
        return $true
    }
    Write-Host "WARNING: the agent did not publish a lock file; check $(Join-Path $root 'out\agent.log')" -ForegroundColor Yellow
    return $false
}

# --- -Status (and the bare invocation) ----------------------------------------------------
if ($Status -or (-not $Install -and -not $Uninstall -and -not $Start -and -not $Stop)) {
    Get-StatusReport
    exit 0
}

# --- -Stop ---------------------------------------------------------------------------------
if ($Stop) {
    $killed = Stop-BncmAgent -Root $root
    Write-Host "stopped $killed agent process(es)"
    exit 0
}

# --- -Uninstall ----------------------------------------------------------------------------
if ($Uninstall) {
    $cmd = Get-InstalledCommand
    if ($cmd) {
        Remove-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue
        Write-Host "removed the logon entry '$runName'"
    } else {
        Write-Host "no logon entry to remove"
    }
    $killed = Stop-BncmAgent -Root $root
    if ($killed -gt 0) { Write-Host "stopped $killed agent process(es)" }
    Write-Host ''
    Write-Host "The plugin files under $(Resolve-BncmDataDir -Root $root)\plugins were left in place (user data)." -ForegroundColor Yellow
    exit 0
}

# --- resolve everything once for -Install / -Start -----------------------------------------
if (-not (Test-Path -LiteralPath $vbs)) { Fail-Bncm "agent shim not found: $vbs" }
if (-not (Test-Path -LiteralPath (Join-Path $root 'tools\bncm_agent.mjs'))) {
    Fail-Bncm "agent not found: $(Join-Path $root 'tools\bncm_agent.mjs')"
}

if ([string]::IsNullOrEmpty($NcmDir)) { $NcmDir = Resolve-BncmNcmDir -Root $root }
if ([string]::IsNullOrEmpty($NcmData)) { $NcmData = Resolve-BncmDataDir -Root $root }
if ([string]::IsNullOrEmpty($PluginDir)) { $PluginDir = Join-Path $NcmData 'plugins' }
$nodeExe = Resolve-BncmNode -Root $root

# --- plugin seed (identical for -Install and -Start) ---------------------------------------
if (-not $NoPluginInstall) {
    Install-BncmPlugins -SourceDir (Join-Path $root 'plugins') -PluginDir $PluginDir | Out-Null
}

# --- logon entry ( -Install only ) ----------------------------------------------------------
if ($Install) {
    if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    $value = 'wscript.exe "' + $vbs + '" --at-logon --ncm "' + $NcmDir + '" --data "' + $NcmData + '" --plugins "' + $PluginDir + '" --quiet'
    Set-ItemProperty -LiteralPath $runKey -Name $runName -Value $value -Type String
    $check = Get-InstalledCommand
    if ($check -ne $value) { Fail-Bncm "failed to write the logon entry (got '$check')" }
    Write-Host "logon entry installed:" -ForegroundColor Green
    Write-Host "  $runKey\$runName = $value"
}

# --- start (or just report) -----------------------------------------------------------------
if (-not $NoStart) {
    $null = Stop-BncmAgent -Root $root      # replace a stale/previous agent for this package
    $mode = if ($Install) { '--at-logon' } else { '--launch' }
    Write-Host ''
    Write-Host "starting the agent (mode $mode) ..."
    Start-Agent $mode $NcmDir $NcmData $PluginDir | Out-Null
}

Write-Host ''
if ($Install) {
    Write-Host "Next: open 网易云音乐. Check with: loader\startup.cmd -Status" -ForegroundColor Green
} else {
    Write-Host "BetterNCM agent started. Stop it with the Stop script, or check with the Status script." -ForegroundColor Green
}
