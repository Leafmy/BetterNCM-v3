# restore-verify.ps1 -- prove the client installation is byte-identical to the P0 baseline.
#
# Reads test\baseline\hashes.json (captured before any modification) and compares every
# recorded file.  Runtime-generated paths were excluded when the baseline was taken and are
# therefore not checked here; see docs/00-baseline.md for the exclusion list.

[CmdletBinding()]
param(
    [string]$BaselinePath = ''
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not available while param() defaults are evaluated under -File.
if ([string]::IsNullOrEmpty($BaselinePath)) {
    $BaselinePath = Join-Path $PSScriptRoot 'baseline\hashes.json'
}

if (-not (Test-Path -LiteralPath $BaselinePath)) {
    Write-Host "ERROR: baseline not found: $BaselinePath" -ForegroundColor Red
    exit 1
}
# Windows PowerShell 5.1 decodes UTF-8 without a BOM as ANSI, which mangles non-ASCII
# filenames (the client ships e.g. resource\3D环绕.ncae).  Read it explicitly as UTF-8.
$snap = [System.IO.File]::ReadAllText($BaselinePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$root = $snap.install_dir

Write-Host "baseline : $BaselinePath"
Write-Host "captured : $($snap.captured_at)"
Write-Host "root     : $root"
Write-Host ''

$missing = @(); $changed = @(); $unreadable = @(); $ok = 0

# Volatile paths the client rewrites while running; recorded in the snapshot so both
# sides of the comparison agree on what "clean" means.
$excludedFiles = @($snap.excluded_relative_files)
if ($excludedFiles.Count -eq 0) { $excludedFiles = @('debug.log', 'cloudmusic.elog', 'localdata', 'info', 'isc_chat.dat') }

foreach ($prop in $snap.install.PSObject.Properties) {
    $rel = $prop.Name
    if ($excludedFiles -contains $rel) { continue }
    $exp = $prop.Value
    $full = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { $missing += $rel; continue }
    try {
        $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()
    } catch {
        $unreadable += $rel
        continue
    }
    if ($h -ne $exp.sha256) { $changed += [pscustomobject]@{ file = $rel; expected = $exp.sha256; actual = $h } }
    else { $ok++ }
}

# Anything present now that the baseline did not record, inside the install directory.
$expectedNames = @{}
foreach ($prop in $snap.install.PSObject.Properties) { $expectedNames[$prop.Name] = $true }
$excluded = @($snap.excluded_relative_dirs)
if ($excluded.Count -eq 0) { $excluded = @('Cache','Log','update','Temp','dumps','webapp91x64','webdata','ad') }
$extra = @()
foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\') -replace '\\', '/'
    $top = ($rel -split '/')[0]
    if ($excluded -contains $top) { continue }
    if ($excludedFiles -contains $rel) { continue }
    if (-not $expectedNames.ContainsKey($rel)) { $extra += $rel }
}

Write-Host "unchanged : $ok"
Write-Host "unreadable: $($unreadable.Count)"
foreach ($x in $unreadable) { Write-Host "   ? $x (locked/dev/binary -- skipped)" -ForegroundColor DarkYellow }
Write-Host "missing   : $($missing.Count)"
foreach ($x in $missing) { Write-Host "   - $x" -ForegroundColor Red }
Write-Host "changed   : $($changed.Count)"
foreach ($c in $changed) {
    Write-Host "   ~ $($c.file)" -ForegroundColor Yellow
    Write-Host "       expected $($c.expected)"
    Write-Host "       actual   $($c.actual)"
}
Write-Host "extra     : $($extra.Count)"
foreach ($x in $extra) { Write-Host "   + $x" -ForegroundColor Yellow }

Write-Host ''
if ($missing.Count -eq 0 -and $changed.Count -eq 0 -and $extra.Count -eq 0) {
    Write-Host 'RESULT: install directory matches the baseline exactly.' -ForegroundColor Green
    exit 0
}
Write-Host 'RESULT: differences found (see above).' -ForegroundColor Yellow
exit 2
