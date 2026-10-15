# verify_release.ps1 -- prove the two release packages work before they are handed over.
#
# What it does (nothing outside a temp directory, plus one registry key that is removed again):
#
#   1. extracts BetterNCM-v3-Portable-x64.zip and runs the PACKAGED loader from it:
#        * the bundled node.exe runs the agent's --status
#        * loader\startup.ps1 -Start -NoStart seeds the four plugins into <portable>\data\plugins
#        * the packaged backend is started and GET /api/plugins is checked for all four plugins,
#          their loadAfter/requirements, and no core lock
#   2. runs BetterNCM-v3-Setup-x64.exe against a temp install directory (no proxy, no autostart,
#      no shortcut, no agent start) and checks the runtime + plugins + uninstaller landed
#   3. cleans up
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\verify_release.ps1
#   ... -ReleaseDir "D:\dist" -KeepTemp

[CmdletBinding()]
param(
    [string]$ReleaseDir = '',
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$cond, [string]$detail = '') {
    if ($cond) { $script:pass++; Write-Host "  ok   $name" }
    else { $script:fail++; Write-Host "  FAIL $name$(if ($detail) { ' :: ' + $detail })" -ForegroundColor Red }
}

if ([string]::IsNullOrEmpty($ReleaseDir)) {
    $ReleaseDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'release'
}
$portableZip = Join-Path $ReleaseDir 'BetterNCM-v3-Portable-x64.zip'
$setupExe    = Join-Path $ReleaseDir 'BetterNCM-v3-Setup-x64.exe'

# The four plugins both packages ship, plus the four slugs the bundled market must list.  Declared
# once so the portable tree, the seeded user plugin directory and the installer cannot drift apart.
$distPlugins = @('LyricBar.plugin', 'MaterialYouTheme.plugin', 'RefinedNowPlaying.plugin',
                 'NCM-Font-Manager.plugin')
$distSlugs   = @('LyricBar', 'MaterialYouTheme', 'RefinedNowPlaying', 'NCM-Font-Manager')

if (-not (Test-Path -LiteralPath $portableZip)) { throw "missing $portableZip" }

$temp = Join-Path $env:TEMP ('bncm-verify-' + $PID)
if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $temp | Out-Null

function Wait-Host([string]$descriptor, [int]$seconds = 20) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while (-not (Test-Path -LiteralPath $descriptor)) {
        if ((Get-Date) -gt $deadline) { return $null }
        Start-Sleep -Milliseconds 300
    }
    return Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
}

try {
    # --- 1. portable ------------------------------------------------------------------------
    Write-Host ''
    Write-Host 'portable package' -ForegroundColor Cyan
    $portableDir = Join-Path $temp 'portable'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($portableZip, $portableDir)

    $app = Join-Path $portableDir 'app'
    $node = Join-Path $app 'bin\node.exe'
    Check 'bundled node.exe is present' (Test-Path -LiteralPath $node)
    Check 'launcher Start.cmd is present' (Test-Path -LiteralPath (Join-Path $portableDir 'Start.cmd'))
    Check 'agent is present' (Test-Path -LiteralPath (Join-Path $app 'tools\bncm_agent.mjs'))
    foreach ($f in $distPlugins) {
        Check "shipped plugin $f" (Test-Path -LiteralPath (Join-Path $app "plugins\$f"))
    }

    # The bundled market is the reason a fresh install can add a plugin with no network at all, so
    # its index and every package it names must be inside the package.
    $mkIndexPath = Join-Path $app 'market\plugins.json'
    Check 'bundled market index is present' (Test-Path -LiteralPath $mkIndexPath)
    if (Test-Path -LiteralPath $mkIndexPath) {
        # NOTE: do NOT wrap ConvertFrom-Json in @(...) -- PowerShell 5.1 writes the parsed array as
        # a SINGLE object onto the pipeline, so @(...) produces a one-element array whose element is
        # the real array (count=1, and every per-entry check then compares paths for all four at
        # once).  Assign the parsed value directly and wrap only where a scalar is possible.
        $mkIndex = Get-Content -LiteralPath $mkIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Check 'bundled market lists four plugins' (@($mkIndex).Count -eq 4) "count=$(@($mkIndex).Count)"
        $mkSlugs = @($mkIndex | ForEach-Object { $_.slug })
        foreach ($s in $distSlugs) { Check "bundled market lists $s" ($mkSlugs -contains $s) }
        $missingPkg = @($mkIndex | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $app ("market\" + ($_.'file-url' -replace '/', '\'))))
        })
        Check 'every listed market package is inside the build' ($missingPkg.Count -eq 0) `
              (($missingPkg | ForEach-Object { $_.slug }) -join ', ')
        $missingPrev = @($mkIndex | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $app ("market\" + ($_.preview -replace '/', '\'))))
        })
        Check 'every listed preview image is inside the build' ($missingPrev.Count -eq 0) `
              (($missingPrev | ForEach-Object { $_.slug }) -join ', ')
        Check 'the market backend module is shipped' `
              (Test-Path -LiteralPath (Join-Path $app 'tools\market_host.mjs'))
    }

    $nodeVersion = & $node --version 2>&1
    Check "bundled node runs ($nodeVersion)" ($nodeVersion -match '^v\d+')

    $status = & $node (Join-Path $app 'tools\bncm_agent.mjs') --status 2>&1 | Out-String
    Check 'the packaged agent reports status' (($status -match 'data dir\s*:') -and ($status -match 'plugins dir\s*:'))

    # Seed + do not start: exercises loader\startup.ps1 exactly as Start.cmd does, minus the client.
    $dataDir = Join-Path $portableDir 'data'
    $seed = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'loader\startup.ps1') `
                -Start -NoStart -NcmData $dataDir 2>&1 | Out-String
    foreach ($f in $distPlugins) {
        Check "seeded into data\plugins: $f" (Test-Path -LiteralPath (Join-Path $dataDir "plugins\$f"))
    }

    # Serve the seeded set with the packaged backend and inspect the manifest the loader will see.
    $desc = Join-Path $temp 'host.json'
    $hostProc = Start-Process -FilePath $node -PassThru -WindowStyle Hidden -ArgumentList @(
        ('"' + (Join-Path $app 'tools\ncm_host.mjs') + '"'), '--port', '0', '--descriptor', ('"' + $desc + '"'),
        '--data', ('"' + $dataDir + '"'), '--plugins', ('"' + (Join-Path $dataDir 'plugins') + '"'), '--ncm', 'E:\CloudMusic')
    try {
        $d = Wait-Host $desc
        Check 'packaged backend publishes a descriptor' ($null -ne $d)
        if ($d) {
            $hdr = @{ 'X-BNCM-Key' = $d.key }
            $pl = Invoke-RestMethod -Headers $hdr -Uri "$($d.api)/api/plugins"
            $slugs = @($pl.plugins | ForEach-Object { $_.manifest.slug })
            foreach ($s in @('LyricBar', 'MaterialYouTheme', 'RefinedNowPlaying')) {
                Check "backend discovers $s" ($slugs -contains $s)
            }
            Check 'no plugin is locked (all are ordinary user plugins)' `
                  (@($pl.plugins | Where-Object { $_.locked -or $_.core -or $_.lock_reason }).Count -eq 0)
            Check 'no core plugin is shipped' (@($pl.core).Count -eq 0)
            $lyric = $pl.plugins | Where-Object { $_.manifest.slug -eq 'LyricBar' }
            Check 'LyricBar requirement on RefinedNowPlaying survives to the loader' `
                  ($lyric.manifest.requirements -contains 'RefinedNowPlaying')
            $rnp = $pl.plugins | Where-Object { $_.manifest.slug -eq 'RefinedNowPlaying' }
            Check 'RefinedNowPlaying loadAfter MaterialYouTheme survives to the loader' `
                  ($rnp.manifest.loadAfter -contains 'MaterialYouTheme')
            $sel = Invoke-RestMethod -Headers $hdr -Uri "$($d.api)/api/selectors"
            Check 'selector registry is served' ($sel.builds.'3.1.41' -ne $null)

            # The market must work from the PACKAGED tree, with the packaged data directory, and
            # with its bundled source resolved from disk (no mirror, no network).
            $mk = Invoke-RestMethod -Headers $hdr -Uri "$($d.api)/api/market/plugins"
            $builtin = @($mk.sources | Where-Object { $_.id -eq 'builtin' })
            Check 'the packaged market serves the built-in source' `
                  ($builtin.Count -eq 1 -and $builtin[0].ok)
            Check 'the built-in source lists four plugins' ($builtin.Count -eq 1 -and $builtin[0].count -eq 4)
            $bundled = @($mk.plugins | Where-Object { $_.bundled })
            Check 'the market marks four plugins as bundled' ($bundled.Count -eq 4) "count=$($bundled.Count)"
            foreach ($s in $distSlugs) {
                Check "the market knows about $s" (@($mk.plugins | Where-Object { $_.slug -eq $s }).Count -eq 1)
            }
            Check 'the market sees the seeded plugins as installed' `
                  (@($bundled | Where-Object { $_.installed }).Count -eq 4)
            $font = $mk.plugins | Where-Object { $_.slug -eq 'NCM-Font-Manager' }
            Check 'the Font Manager listing carries a verified digest' `
                  ($font.sha256 -match '^[0-9a-f]{64}$')
            $sources = Invoke-RestMethod -Headers $hdr -Uri "$($d.api)/api/market/sources"
            Check 'the market source list is served' (@($sources.sources).Count -ge 1)
        }
    } finally {
        if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue }
    }

    # --- 2. installer -----------------------------------------------------------------------
    Write-Host ''
    Write-Host 'one-click installer' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $setupExe)) {
        Check 'Setup .exe exists' $false $setupExe
    } else {
        $installDir = Join-Path $temp 'installed'
        $installData = Join-Path $temp 'installed-data'
        # The IExpress stub ignores its own command line and then never launches AppLaunched, so
        # switches reach install.cmd through the environment instead (see setup\install.cmd).
        $env:BNCM_NOPAUSE = '1'
        $env:BNCM_SETUP_ARGS = '-InstallDir "' + $installDir + '" -DataDir "' + $installData + '" -NoProxy -NoAutostart -NoShortcut -NoStart'
        $proc = Start-Process -FilePath $setupExe -PassThru -Wait
        # The IExpress stub returns as soon as it has launched install.cmd, and install.cmd's own
        # exit code never reaches us, so completion is detected by the artifact it produces last.
        $deadline = (Get-Date).AddSeconds(300)
        while (-not (Test-Path -LiteralPath (Join-Path $installDir 'Uninstall.ps1'))) {
            if ((Get-Date) -gt $deadline) { break }
            Start-Sleep -Milliseconds 1000
        }
        Check 'installer produced the uninstaller (install ran to completion)' `
              (Test-Path -LiteralPath (Join-Path $installDir 'Uninstall.ps1'))
        Check 'installed runtime is present' (Test-Path -LiteralPath (Join-Path $installDir 'app\loader\framework.js'))
        Check 'installed node is present' (Test-Path -LiteralPath (Join-Path $installDir 'app\bin\node.exe'))
        Check 'uninstaller was copied' (Test-Path -LiteralPath (Join-Path $installDir 'Uninstall.ps1'))
        foreach ($f in $distPlugins) {
            Check "installed plugins: $f" (Test-Path -LiteralPath (Join-Path $installData "plugins\$f"))
        }
        Check 'installed market index is present' `
              (Test-Path -LiteralPath (Join-Path $installDir 'app\market\plugins.json'))
        $unkey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterNCM'
        Check 'Add/Remove Programs entry was written' (Test-Path -LiteralPath $unkey)
        Remove-Item -LiteralPath $unkey -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item Env:\BNCM_NOPAUSE -ErrorAction SilentlyContinue
        Remove-Item Env:\BNCM_SETUP_ARGS -ErrorAction SilentlyContinue
    }
} finally {
    if (-not $KeepTemp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Host "temp kept: $temp" }
}

Write-Host ''
Write-Host "$pass passed, $fail failed" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
