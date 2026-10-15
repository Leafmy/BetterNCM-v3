# launch.ps1 -- start a modded BetterNCM session for NetEase Cloud Music 3.1.41.
#
#     loader\launch.cmd                  # host + client + injection, watch until Ctrl+C
#     loader\launch.cmd -Once            # inject once and exit (leaves client running)
#     loader\launch.cmd -NoStart         # attach to an already-running client
#     loader\launch.cmd -NoHost          # reuse a host already listening (reads -Descriptor)
#
# Dev mode (plugin authors -- docs/14-plugin-dev-guide.md):
#     loader\launch.cmd -DevDir ..\my-plugin -DevWatch        # load unpacked source, hot-reload
#     loader\launch.cmd -DevSource acme/my-plugin#dev:dist    # straight from a GitHub repo
#     loader\launch.cmd -DevSource .\thing.plugin             # a packed archive
#   The page then drives it through window.betterncm.dev (addSource / reload / watch / hook).
#
# Orchestration:
#   1. start tools/ncm_host.mjs  (the BetterNCM backend: fs API, plugin discovery, framework.js)
#   2. read the descriptor it writes (ephemeral port + API key)
#   3. start the client with --remote-debugging-port if it is not already
#   4. inject loader/framework.js with window.__BNCM_CONFIG__ pointing at the backend
#   5. keep watching and re-inject when the page reloads (unless -Once)
#
# Security: --remote-debugging-port is a loopback-only DevTools endpoint.  It is closed again
# by loader\launch.cmd -StopClient, and plain double-clicking the client never opens it.

[CmdletBinding()]
param(
    [string]$NcmDir = '',
    [int]$Port = 9222,
    [string]$Match = 'orpheus://orpheus/pub/app.html',
    [string]$DataDir = '',
    [string]$PluginsDir = '',
    [int]$HostPort = 0,
    [string]$Descriptor = '',
    [string]$Framework = '',
    [switch]$NoWatch,
    [switch]$NoStart,
    [switch]$NoHost,
    [switch]$Once,
    [switch]$KeepHost,
    [switch]$StopClient,
    [switch]$Force,
    [switch]$Agent,
    [ValidateSet('', 'strict')]
    [string]$Ncm3Gate = '',
    # --- dev mode (see docs/14-plugin-dev-guide.md) ------------------------------
    #   -DevDir    a plugin directory to load straight from source (no packing)
    #   -DevSource a directory, a .plugin/.zip path or URL, or owner/repo[#ref][:subdir]
    [string]$DevDir = '',
    [string[]]$DevSource = @(),
    [switch]$DevWatch,
    [int]$Duration = 0
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'paths.ps1')
if ([string]::IsNullOrEmpty($Descriptor)) { $Descriptor = Join-Path $repoRoot 'out\host.json' }
if ([string]::IsNullOrEmpty($Framework))  { $Framework  = Join-Path $repoRoot 'loader\framework.js' }
if ([string]::IsNullOrEmpty($PluginsDir)) { $PluginsDir = Join-Path $repoRoot 'plugins' }
$corePluginsDir = Join-Path $repoRoot 'plugins\core'
if (-not (Test-Path -LiteralPath $corePluginsDir)) { $corePluginsDir = '' }   # no built-ins ship

# The checkout used to hard-code E:\CloudMusic and a DSH-runtime node path; both now come from
# loader/paths.ps1 so `loader\launch.cmd` works on a machine where the package is installed.
if ([string]::IsNullOrEmpty($NcmDir)) { $NcmDir = Resolve-BncmNcmDir -Root $repoRoot }
$node = Resolve-BncmNode -Root $repoRoot
$exe = Join-Path $NcmDir 'cloudmusic.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found" }

# --- -Agent: hand the whole session to the unattended supervisor -----------------
# launch.ps1 stays the development entry point (it prints, it can be timed, it reuses a host),
# but the real "opens with 网易云音乐" path is tools/bncm_agent.mjs.  This switch exists so the
# two are not confused: -Agent behaves exactly like the shortcut / logon entry.
if ($Agent) {
    $agentArgs = @((Join-Path $repoRoot 'tools\bncm_agent.mjs'), '--ncm', $NcmDir,
                   '--port', "$Port", '--data', $(if ($DataDir) { $DataDir } else { 'C:\betterncm' }),
                   '--plugins', $PluginsDir)
    # No built-ins ship, so plugins\core is normally absent and $corePluginsDir is ''.  Putting that
    # empty value into Start-Process's -ArgumentList makes PowerShell reject the whole list
    # ("Cannot validate argument on parameter 'ArgumentList'... null or empty"), which is how
    # loader\launch.cmd broke once the core tier was emptied.  An empty value must be omitted.
    if ($corePluginsDir) { $agentArgs += @('--core-plugins', $corePluginsDir) }
    if ($NoStart) { $agentArgs += '--once' } else { $agentArgs += '--launch' }
    if ($NoWatch -and -not $NoStart) { $agentArgs += '--once' }
    if ($DevDir) { $agentArgs += @('--dev-dir', $DevDir) }
    foreach ($s in $DevSource) { $agentArgs += @('--dev-source', $s) }
    if ($DevWatch) { $agentArgs += '--dev-watch' }
    if ($Duration -gt 0) { $agentArgs += @('--duration', "$Duration") }
    Write-Host "delegating to the agent: node tools\bncm_agent.mjs"
    & $node @agentArgs
    exit $LASTEXITCODE
}

# Start-Process joins -ArgumentList with spaces and does not quote; the repo path contains a
# space ("All In"), so any argument that is a path must be quoted explicitly.
function Quote-Arg([string]$a) { if ($a -match '[\s"]') { '"' + $a + '"' } else { $a } }

# --- -StopClient: revert to a plain session (no debug port) --------------------
if ($StopClient) {
    Write-Host 'stopping the client ...'
    Get-Process -Name cloudmusic -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 1500
    Write-Host 'stopped. Debug port is now closed; start the client normally when you want it.'
    exit 0
}

# --- 1/2. backend ------------------------------------------------------------
$hostProc = $null
$api = $null
$key = ''

if ($NoHost) {
    if (-not (Test-Path -LiteralPath $Descriptor)) { throw "-NoHost given but no descriptor at $Descriptor" }
    $d = Get-Content -LiteralPath $Descriptor -Raw | ConvertFrom-Json
    $api = $d.api; $key = $d.key
    Write-Host "reusing host: $api (plugins=$($d.pluginsDir))"
} else {
    Remove-Item -LiteralPath $Descriptor -ErrorAction SilentlyContinue
    $hostLog = Join-Path $repoRoot 'out\host.stdout.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $hostLog) | Out-Null
    $hostArgs = @((Join-Path $repoRoot 'tools\ncm_host.mjs'),
                  '--port', "$HostPort", '--descriptor', $Descriptor,
                  '--plugins', $PluginsDir, '--ncm', $NcmDir)
    if ($corePluginsDir) { $hostArgs += @('--core-plugins', $corePluginsDir) }
    if ($DataDir) { $hostArgs += @('--data', $DataDir) }
    if ($DevDir) { $hostArgs += @('--dev-dir', $DevDir) }
    foreach ($s in $DevSource) { $hostArgs += @('--dev-source', $s) }
    if ($DevWatch) { $hostArgs += '--dev-watch' }
    $hostArgs = @($hostArgs | ForEach-Object { Quote-Arg $_ })
    Write-Host "starting backend: node tools\ncm_host.mjs --port $HostPort"
    $hostProc = Start-Process -FilePath $node -ArgumentList $hostArgs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $hostLog -RedirectStandardError "$hostLog.err"

    # The port is ephemeral unless -HostPort was given, so wait for the descriptor.
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Path -LiteralPath $Descriptor)) {
        if ((Get-Date) -gt $deadline) { throw "backend did not publish $Descriptor within 20s (see $hostLog)" }
        if ($hostProc.HasExited) { throw "backend exited with code $($hostProc.ExitCode) (see $hostLog)" }
        Start-Sleep -Milliseconds 300
    }
    $d = Get-Content -LiteralPath $Descriptor -Raw | ConvertFrom-Json
    $api = $d.api; $key = $d.key
    Write-Host "backend ready: $api"
    Write-Host "  data dir   : $($d.data)"
    Write-Host "  plugins dir: $($d.pluginsDir)"
}

# --- 3. client ---------------------------------------------------------------
$running = @(Get-Process -Name cloudmusic -ErrorAction SilentlyContinue)
$withPort = $false
if ($running.Count -gt 0) {
    $withPort = [bool](Get-CimInstance Win32_Process -Filter "Name='cloudmusic.exe'" |
        Where-Object { $_.CommandLine -match "remote-debugging-port=$Port" })
}

if ($NoStart) {
    Write-Host 'attaching to the running client (-NoStart).'
} elseif ($running.Count -gt 0 -and $withPort) {
    Write-Host 'client already running with the debug port; attaching.'
} else {
    if ($running.Count -gt 0) {
        Write-Host "restarting the client (it lacks --remote-debugging-port=$Port) ..."
        $running | Stop-Process -Force
        Start-Sleep -Milliseconds 1800
    }
    Write-Host "starting: $exe --remote-debugging-port=$Port"
    Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
    Start-Sleep -Seconds 10
}

if ($NoWatch) {
    Write-Host 'started (-NoWatch).'
    exit 0
}

# --- 4/5. inject -------------------------------------------------------------
Write-Host "injecting $Framework"
Write-Host "  api=$api"
$watchArgs = @((Join-Path $repoRoot 'tools\cdp_watch.mjs'),
               '--port', "$Port", '--match', $Match,
               '--api', $api, '--key', $key,
               '--framework', $Framework, '--interval', '3')
if ($Once) { $watchArgs += '--once' }
if ($Force) { $watchArgs += '--force' }
if ($Ncm3Gate) { $watchArgs += @('--ncm3-gate', $Ncm3Gate) }
if ($Duration -gt 0) { $watchArgs += @('--duration', "$Duration") }

try {
    & $node @watchArgs
    $rc = $LASTEXITCODE
} finally {
    if ($hostProc -and -not $KeepHost -and -not $hostProc.HasExited) {
        Write-Host 'stopping backend ...'
        Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue
    } elseif ($hostProc -and $KeepHost) {
        Write-Host "backend left running (pid $($hostProc.Id), -KeepHost)."
    }
}
exit $rc
