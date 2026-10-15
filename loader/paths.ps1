# paths.ps1 -- shared path resolution for the BetterNCM(v3) loader.
#
# Why this file exists
# --------------------
# Every loader script used to hard-code the two facts of this one development machine:
# the client at `E:\CloudMusic` and the Node interpreter inside the DSH runtime.  That is fine
# for a checkout and fatal for a distributed package, so the four questions every entry point
# asks ("where is the client?", "where is node?", "where is the data directory?", "which
# plugins ship?") are answered here, once, in a fixed order.
#
# Dot-source it after the param() block (PSScriptRoot is not available while param defaults are
# evaluated under -File):
#
#     . (Join-Path $PSScriptRoot 'paths.ps1')
#
# Every resolver takes an explicit override first and only then falls back to discovery, so a
# caller that already knows the answer is never overruled.

$ErrorActionPreference = 'Stop'

# --- the release plugin set ---------------------------------------------------------------
#
# These four are the ones the project ships: three third-party plugins (LyricBar,
# MaterialYouTheme, RefinedNowPlaying) adapted to this compatibility layer, plus this project's
# own NCM Font Manager.  They are installed by the SAME code path into the SAME user-plugin
# directory and are managed identically by the manager -- none of them is a built-in
# `plugins/core` plugin any more.  The same four are listed by the bundled plugin market
# (market/plugins.json), so a user can reinstall any of them from the manager as well.
#
# The list is explicit on purpose: `plugins/` in a checkout also carries three test fixtures
# (bncm-selftest, broken-plugin, incompatible-plugin) that must never be installed for a user.
$script:BncmDistPlugins = @(
    'LyricBar.plugin',
    'MaterialYouTheme.plugin',
    'RefinedNowPlaying.plugin',
    'NCM-Font-Manager.plugin'
)

function Get-BncmDistPlugins { return $script:BncmDistPlugins }

function Fail-Bncm([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Test-BncmWritable([string]$Dir) {
    # A directory is "writable" only if we can create it and put a file in it.  Existence is not
    # enough: `C:\betterncm` frequently exists from an earlier install and is still not writable
    # for a standard user, and silently failing there is worse than falling back.
    try {
        New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null
        $probe = Join-Path $Dir '.bncm-write-probe'
        Set-Content -LiteralPath $probe -Value 'ok' -Encoding Ascii -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch { return $false }
}

function Resolve-BncmNcmDir {
    <#
      Where the NetEase client is installed.

      1. -NcmDir / -Override      explicit wins
      2. $env:BNCM_NCM_DIR        per-machine override for a launcher
      3. the installer registry   HKLM ...\Netease\cloudmusic\install_dir (what the client writes)
      4. well-known directories
      5. the path of a running cloudmusic.exe
    #>
    param(
        [string]$Override = '',
        [string]$Root = ''
    )
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Override) { $candidates.Add($Override) }
    if ($env:BNCM_NCM_DIR) { $candidates.Add($env:BNCM_NCM_DIR) }

    foreach ($key in @(
            'HKLM:\SOFTWARE\WOW6432Node\Netease\cloudmusic',
            'HKLM:\SOFTWARE\Netease\cloudmusic',
            'HKCU:\SOFTWARE\Netease\cloudmusic')) {
        try {
            $v = (Get-ItemProperty -LiteralPath $key -Name 'install_dir' -ErrorAction Stop).install_dir
            if ($v) { $candidates.Add($v) }
        } catch { }
    }

    $wellKnown = New-Object System.Collections.Generic.List[string]
    foreach ($base in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $wellKnown.Add((Join-Path $base 'Netease\CloudMusic')) }
    }
    foreach ($p in @('C:\CloudMusic', 'D:\CloudMusic', 'E:\CloudMusic', 'F:\CloudMusic')) { $wellKnown.Add($p) }
    foreach ($p in $wellKnown) { $candidates.Add($p) }

    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='cloudmusic.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.ExecutablePath) { $candidates.Add((Split-Path -Parent $proc.ExecutablePath)) }
    }

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        try {
            $full = [System.IO.Path]::GetFullPath($c)
        } catch { continue }
        if (Test-Path -LiteralPath (Join-Path $full 'cloudmusic.exe')) { return $full }
    }

    Fail-Bncm @"
cannot find the NetEase Cloud Music installation.
  Pass it explicitly:  -NcmDir "X:\path\to\CloudMusic"
  or set the environment variable BNCM_NCM_DIR.
  Expected to find cloudmusic.exe in that directory.
"@
}

function Resolve-BncmNode {
    <#
      The Node interpreter (>= 21, for the global WebSocket API).

      1. -Node / -Override     explicit wins
      2. $env:BNCM_NODE
      3. <Root>\bin\node.exe   the runtime bundled with a release package
      4. the DSH development runtime (this checkout's machine)
      5. node.exe on PATH
    #>
    param(
        [string]$Override = '',
        [string]$Root = ''
    )
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Override) { $candidates.Add($Override) }
    if ($env:BNCM_NODE) { $candidates.Add($env:BNCM_NODE) }
    if ($Root) { $candidates.Add((Join-Path $Root 'bin\node.exe')) }
    $candidates.Add((Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'))
    $candidates.Add('node.exe')

    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if ($c -eq 'node.exe') {
            $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($cmd) { return $cmd.Source }
            continue
        }
        if (Test-Path -LiteralPath $c) { return [System.IO.Path]::GetFullPath($c) }
    }
    Fail-Bncm @"
node.exe not found (Node >= 21 is required for the global WebSocket API).
  Pass it explicitly:  -Node "C:\path\to\node.exe", or set BNCM_NODE.
"@
}

function Resolve-BncmDataDir {
    <#
      The BetterNCM data directory: holds `plugins\`, `disabled_plugins.json`, logs and caches.

      1. -DataDir / -Override
      2. $env:BETTERNCM_PROFILE
      3. C:\betterncm            the project's historical location -- reused when it already exists
                                 and is writable, so an existing install is not duplicated
      4. %LOCALAPPDATA%\BetterNCM
    #>
    param(
        [string]$Override = '',
        [string]$Root = ''
    )
    if ($Override) { return [System.IO.Path]::GetFullPath($Override) }
    if ($env:BETTERNCM_PROFILE) { return [System.IO.Path]::GetFullPath($env:BETTERNCM_PROFILE) }

    foreach ($c in @('C:\betterncm', (Join-Path $env:LOCALAPPDATA 'BetterNCM'))) {
        if (Test-Path -LiteralPath $c) {
            if (Test-BncmWritable $c) { return [System.IO.Path]::GetFullPath($c) }
            Write-Host "note: $c exists but is not writable; trying the next location" -ForegroundColor Yellow
        }
    }
    $fallback = Join-Path $env:LOCALAPPDATA 'BetterNCM'
    if (-not (Test-BncmWritable $fallback)) { Fail-Bncm "no writable data directory (tried C:\betterncm and $fallback)" }
    return [System.IO.Path]::GetFullPath($fallback)
}

function Install-BncmPlugins {
    <#
      Install the distribution plugin set into the user plugin directory.

      One code path for all four plugins, and it is idempotent:
        * missing destination  -> copy;
        * identical bytes      -> nothing to do;
        * different bytes      -> back the user's copy up first, then copy.

      The backup matters: `plugins\` is the user's directory.  A plugin the user edited (or an
      older release) is never destroyed by an update.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$PluginDir,
        [string[]]$Names = @(),
        [switch]$Quiet
    )
    if (-not $Names -or $Names.Count -eq 0) { $Names = Get-BncmDistPlugins }
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null

    $installed = @(); $updated = @(); $kept = @(); $missing = @()
    foreach ($name in $Names) {
        $src = Join-Path $SourceDir $name
        if (-not (Test-Path -LiteralPath $src)) { $missing += $name; continue }
        $dst = Join-Path $PluginDir $name
        $srcHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash

        if (-not (Test-Path -LiteralPath $dst)) {
            Copy-Item -LiteralPath $src -Destination $dst -Force
            $installed += $name
            continue
        }
        $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
        if ($dstHash -eq $srcHash) { $kept += $name; continue }

        $backupDir = Join-Path $PluginDir ('_backup_' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        Copy-Item -LiteralPath $dst -Destination (Join-Path $backupDir $name) -Force
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $updated += $name
    }
    if (-not $Quiet) {
        if ($installed.Count) { Write-Host "installed plugins: $($installed -join ', ')" -ForegroundColor Green }
        if ($updated.Count)   { Write-Host "updated plugins  : $($updated -join ', ')  (previous copies backed up in _backup_*)" -ForegroundColor Yellow }
        if ($kept.Count)      { Write-Host "already current  : $($kept -join ', ')" }
        if ($missing.Count)   { Write-Host "not found in $SourceDir : $($missing -join ', ')" -ForegroundColor Yellow }
    }
    return [pscustomobject]@{
        installed = $installed; updated = $updated; kept = $kept; missing = $missing
    }
}

function Get-BncmNodeProcesses {
    # Every node.exe whose command line runs this package's agent or backend.
    param([Parameter(Mandatory = $true)][string]$Root)
    $needle = [System.IO.Path]::GetFullPath($Root)
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -like "*$needle*" -and
            ($p.CommandLine -match 'bncm_agent\.mjs' -or $p.CommandLine -match 'ncm_host\.mjs')) {
            $p
        }
    }
}

function Stop-BncmAgent {
    # Stop only the agent/backend that belongs to this package -- never an unrelated node.exe.
    param([Parameter(Mandatory = $true)][string]$Root)
    $killed = 0
    foreach ($p in Get-BncmNodeProcesses -Root $Root) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
    # The repo-wide stop the other scripts also use: anything running bncm_agent.mjs.
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -match 'bncm_agent\.mjs') {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
        }
    }
    $lock = Join-Path $Root 'out\agent.lock'
    if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
    return $killed
}
