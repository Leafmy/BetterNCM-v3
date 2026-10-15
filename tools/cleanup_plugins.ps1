# cleanup_plugins.ps1 -- retire the pre-existing BetterNCM plugin set.
#
# Why: the plugins that were installed under C:\betterncm are the old 2.10/3.0-era ones.
# Only three of them (LyricBar, RefinedNowPlaying, MaterialYouTheme) are being carried
# forward -- as built-in core plugins shipped by this repository (plugins/core/) -- and the
# rest are neither maintained nor compatible with 3.1.41.  So the whole old set is retired.
#
# Safety model (this is a MOVE, never a delete):
#   * dry-run by default; nothing is touched without -Apply;
#   * every entry is moved into <NcmData>\_backup_<yyyyMMdd-HHmmss>\<target>\<entry>;
#   * a manifest.json with per-entry file counts, byte counts and a tree SHA-256 is written
#     next to the backup, so the move can be verified later (-Verify).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\cleanup_plugins.ps1
#   powershell ... -Apply
#   powershell ... -Apply -PurgeData          # also retire the per-plugin data directories
#   powershell ... -Verify <backup dir>

[CmdletBinding()]
param(
    [string]$NcmData = 'C:\betterncm',
    [switch]$Apply,
    [switch]$PurgeData,
    [string]$Verify = ''
)

$ErrorActionPreference = 'Stop'

# Directories under <NcmData> that hold plugins (the first two are the plugin set itself).
$pluginTargets = @('plugins', 'plugins_runtime')

# Per-plugin data/state directories that the old plugins created.  Only touched with
# -PurgeData, and even then only moved into the backup.
$dataTargets = @(
    'amll-data',
    'downgrade_ok',
    'FluentMusicCover-Cache',
    'InfLink-Discord-RPC',
    'InfLink-Thumbnail-Cache',
    'RevivedUnblockInstaller',
    'StyleSnippets',
    'probe'
)

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg }

function Resolve-Existing([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Resolve-Path -LiteralPath $path).ProviderPath
}

# Digest of a file or directory: file count, total bytes, and a stable tree hash.
#
# The tree hash is SHA-256 over sorted "<relative path>|<size>|<file sha256>" lines, so a
# moved directory can be proven byte-identical later without keeping the original copy.
function Get-TreeDigest([string]$path) {
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer) {
        $h = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLower()
        return [ordered]@{ kind = 'file'; files = 1; bytes = $item.Length; sha256 = $h }
    }
    $root = $item.FullName
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)
    $lines = @()
    $total = 0L
    foreach ($f in $files) {
        $total += $f.Length
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        $fh = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
        $lines += "$rel|$($f.Length)|$fh"
    }
    $sorted = ($lines | Sort-Object) -join "`n"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($sorted)
        $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    } finally { $sha.Dispose() }
    return [ordered]@{ kind = 'dir'; files = $files.Count; bytes = $total; sha256 = $hash }
}

# --- -Verify <backup dir> ------------------------------------------------------
if ($Verify) {
    $dir = Resolve-Existing $Verify
    if (-not $dir) { Fail "backup directory not found: $Verify" }
    $manifestPath = Join-Path $dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "no manifest.json in $dir" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $bad = 0
    foreach ($e in $manifest.entries) {
        $p = Join-Path $dir $e.backup
        if (-not (Test-Path -LiteralPath $p)) { Write-Host "MISSING  $($e.backup)" -ForegroundColor Red; $bad++; continue }
        $d = Get-TreeDigest $p
        if ($d.sha256 -ne $e.sha256) {
            Write-Host "MISMATCH $($e.backup)  now=$($d.sha256.Substring(0,16)) want=$($e.sha256.Substring(0,16))" -ForegroundColor Red
            $bad++
        } else {
            Write-Host "OK       $($e.backup)  files=$($d.files) bytes=$($d.bytes)" -ForegroundColor Green
        }
    }
    if ($bad -gt 0) { Write-Host "RESULT: $bad entr(ies) failed verification." -ForegroundColor Red; exit 1 }
    Write-Host "RESULT: backup matches the manifest exactly." -ForegroundColor Green
    exit 0
}

# --- guard rails ---------------------------------------------------------------
$root = Resolve-Existing $NcmData
if (-not $root) { Fail "NcmData does not exist: $NcmData" }

$repoPlugins = Resolve-Existing (Join-Path $PSScriptRoot '..\plugins')
if ($repoPlugins -and ($root -eq $repoPlugins -or $repoPlugins.StartsWith($root + '\'))) {
    Fail "refusing to run: $root contains this repository's own plugins/ directory ($repoPlugins)"
}

# --- plan ----------------------------------------------------------------------
$selected = @()
foreach ($t in $pluginTargets) {
    $full = Join-Path $root $t
    if (-not (Test-Path -LiteralPath $full)) { continue }
    foreach ($child in @(Get-ChildItem -LiteralPath $full -Force)) {
        $selected += [ordered]@{ target = $t; source = $child.FullName; name = $child.Name }
    }
}
if ($PurgeData) {
    foreach ($t in $dataTargets) {
        $full = Join-Path $root $t
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $child = Get-Item -LiteralPath $full -Force
        $selected += [ordered]@{ target = '_data'; source = $child.FullName; name = $child.Name }
    }
}

Info "BetterNCM data dir : $root"
Info "plugin targets     : $($pluginTargets -join ', ')"
if ($PurgeData) { Info "data targets       : $($dataTargets -join ', ')" }
Info "entries to retire  : $($selected.Count)"
Info ''

if ($selected.Count -eq 0) {
    Info 'nothing to do: both plugin directories are already empty.'
    exit 0
}

$grandBytes = 0L
foreach ($s in $selected) {
    $d = Get-TreeDigest $s.source
    $grandBytes += [int64]$d.bytes
    Info ("  {0,-16} {1,-46} {2,10} bytes  {3,4} file(s)" -f $s.target, $s.name, $d.bytes, $d.files)
}
Info ''
Info ("total: {0} bytes" -f $grandBytes)
Info ''

if (-not $Apply) {
    Info 'DRY RUN -- nothing was moved. Re-run with -Apply to retire these entries.'
    Info 'They will be MOVED (not deleted) into <NcmData>\_backup_<timestamp>\.'
    exit 0
}

# --- apply: move into a timestamped backup ------------------------------------
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupDir = Join-Path $root "_backup_$stamp"
if (Test-Path -LiteralPath $backupDir) { Fail "backup directory already exists: $backupDir" }

# Sanity: the backup directory must be a direct child of the data root we resolved.
$backupFull = [System.IO.Path]::GetFullPath($backupDir)
if ([System.IO.Path]::GetDirectoryName($backupFull) -ne $root) {
    Fail "refusing to create a backup outside the data root: $backupFull"
}

New-Item -ItemType Directory -Force -Path $backupFull | Out-Null
Info "backing up to $backupFull"

$entries = @()
foreach ($s in $selected) {
    $targetDir = Join-Path $backupFull $s.target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $dest = Join-Path $targetDir $s.name
    if (Test-Path -LiteralPath $dest) { Fail "backup destination already exists: $dest" }

    $digest = Get-TreeDigest $s.source
    Move-Item -LiteralPath $s.source -Destination $dest

    # Verify the move landed intact before recording it.
    $after = Get-TreeDigest $dest
    if ($after.sha256 -ne $digest.sha256) { Fail "digest changed while moving $($s.source)" }

    $entries += [ordered]@{
        target        = $s.target
        name          = $s.name
        original_path = $s.source
        backup        = (Join-Path $s.target $s.name)
        kind          = $digest.kind
        files         = $digest.files
        bytes         = $digest.bytes
        sha256        = $digest.sha256
    }
    Info ("  moved {0,-46} -> {1}" -f $s.name, (Join-Path $s.target $s.name))
}

# Ensure the plugin directories still exist (empty) so the host does not have to create them.
foreach ($t in $pluginTargets) {
    $full = Join-Path $root $t
    if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Force -Path $full | Out-Null }
}

$manifest = [ordered]@{
    created_at   = (Get-Date).ToString('s')
    data_dir     = $root
    plugin_dirs  = $pluginTargets
    data_targets = if ($PurgeData) { $dataTargets } else { @() }
    entry_count  = $entries.Count
    total_bytes  = $grandBytes
    entries      = $entries
}
$manifestPath = Join-Path $backupFull 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Info ''
Info "retired $($entries.Count) entr(ies), $grandBytes bytes" -ForegroundColor Green
Info "backup   : $backupFull"
Info "manifest : $manifestPath"
Info ''
Info "verify with: tools\cleanup_plugins.cmd -Verify `"$backupFull`""
Info 'note: the four kept plugins are shipped as core plugins in plugins\core\ (already in the repo).'
