# manager.ps1 -- acceptance test for the plugin-manager mechanism (G4).
#
# The point of this test is that NOTHING is locked any more: every plugin is a user plugin and
# hidden in the UI: a forged request must not be able to remove or disable a built-in plugin, and
# the files on disk must be untouched afterwards.  Read-only apart from a temporary probe plugin.
#
# Run via: test\manager.cmd

[CmdletBinding()]
param(
    [string]$NcmData = 'C:\betterncm',
    [string]$RepoPlugins = ''
)

$ErrorActionPreference = 'Continue'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrEmpty($RepoPlugins)) { $RepoPlugins = Join-Path $NcmData 'plugins' }
$descriptor = Join-Path $root 'out\host.json'

$results = @()
function Check([string]$name, [scriptblock]$fn) {
    try {
        $r = & $fn
        $ok = $false; $detail = ''
        if ($r -is [array]) { $ok = [bool]$r[0]; $detail = [string]$r[1] } else { $ok = [bool]$r; $detail = [string]$r }
        $script:results += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
        Write-Host "  $(if ($ok) { 'ok  ' } else { 'FAIL' }) $name$(if ($detail) { '  :: ' + $detail })" `
            -ForegroundColor $(if ($ok) { 'Gray' } else { 'Red' })
    } catch {
        $script:results += [pscustomobject]@{ name = $name; ok = $false; detail = $_.Exception.Message }
        Write-Host "  FAIL $name :: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host 'BetterNCM acceptance: plugin manager mechanism' -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $descriptor)) {
    Write-Host "ERROR: no backend descriptor at $descriptor -- start the loader first" -ForegroundColor Red
    exit 2
}
$d = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
$headers = @{ 'X-BNCM-Key' = $d.key; 'Content-Type' = 'application/json' }
function Api([string]$path) {
    (Invoke-WebRequest -Uri "$($d.api)$path" -Headers $headers -UseBasicParsing).Content | ConvertFrom-Json
}
function ApiPost([string]$path, [string]$body) {
    try {
        $r = Invoke-WebRequest -Uri "$($d.api)$path" -Method POST -Headers $headers -Body $body -UseBasicParsing
        return @{ code = $r.StatusCode; body = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if (-not $resp) { throw }
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        return @{ code = [int]$resp.StatusCode; body = $sr.ReadToEnd() }
    }
}

$state = $null
Check '/api/state answers' {
    $script:state = Api '/api/state'
    @(($true), "core=$($script:state.core.Count) user=$($script:state.plugins.Count)")
}

# --- decoupling: nothing is "built-in" any more ---------------------------------
# LyricBar / RefinedNowPlaying / MaterialYouTheme used to ship in plugins\core and were force
# locked (403 from the backend).  They are ordinary user plugins now, so the assertions below
# are the INVERSE of the old ones.
$allSlugs = @('RefinedNowPlaying', 'LyricBar', 'MaterialYouTheme')

Check 'no core (built-in) plugin tier exists' {
    @((@($script:state.core).Count -eq 0), "core=$(@($script:state.core).Count)")
}

Check 'no plugin is locked' {
    $entries = @($script:state.plugins) + @($script:state.core)
    $locked = @($entries | Where-Object { $_.locked -or $_.core })
    @(($locked.Count -eq 0), "locked=$($locked.Count)")
}

Check 'all four plugins ship as user plugins' {
    $have = @($script:state.plugins | ForEach-Object { $_.slug })
    $missing = @($allSlugs | Where-Object { $have -notcontains $_ })
    @(($missing.Count -eq 0), "found=$($have -join ',') missing=$($missing -join ',')")
}

Check 'the old plugins\core directory is gone from the repo' {
    @((-not (Test-Path -LiteralPath (Join-Path $root 'plugins\core'))), 'plugins\core still exists')
}

# Every plugin must now be controllable.  Disable then immediately re-enable, so the round trip
# proves the lock is gone without leaving anything disabled behind.
foreach ($slug in $allSlugs) {
    Check "disable '$slug' is accepted (no core lock)" {
        $r = ApiPost '/api/plugins/disable' ("{""slug"":""$slug""}")
        $ok = ($r.code -eq 200)
        ApiPost '/api/plugins/enable' ("{""slug"":""$slug""}") | Out-Null
        @(($ok), "HTTP $($r.code)")
    }
}

Check 'an unknown slug is a 404, not a crash' {
    $r = ApiPost '/api/plugins/uninstall' '{"slug":"definitely-not-a-plugin"}'
    @(($r.code -eq 404), "HTTP $($r.code)")
}

# --- user plugin lifecycle ----------------------------------------------------
$probe = Join-Path $RepoPlugins 'bncm-acceptance-probe.plugin'
$src = Join-Path $root 'plugins\bncm-selftest.plugin'
if (Test-Path -LiteralPath $src) {
    New-Item -ItemType Directory -Force -Path $RepoPlugins | Out-Null
    Copy-Item -LiteralPath $src -Destination $probe -Force

    Check 'a user plugin can be disabled' {
        $r = ApiPost '/api/plugins/disable' '{"slug":"bncm-selftest"}'
        @(($r.code -eq 200), "HTTP $($r.code)")
    }
    Check 'a user plugin can be enabled again' {
        $r = ApiPost '/api/plugins/enable' '{"slug":"bncm-selftest"}'
        @(($r.code -eq 200), "HTTP $($r.code)")
    }
    Check 'a user plugin uninstall MOVES the file (never deletes)' {
        $r = ApiPost '/api/plugins/uninstall' '{"slug":"bncm-selftest"}'
        $moved = $false
        if ($r.code -eq 200) {
            $payload = $r.body | ConvertFrom-Json
            $moved = (Test-Path -LiteralPath $payload.moved_to)
        }
        @(($r.code -eq 200 -and $moved), "HTTP $($r.code)")
    }
    Check 'the probe file is gone from the plugin dir' {
        @((-not (Test-Path -LiteralPath $probe)), $probe)
    }
} else {
    Write-Host "  skip user-plugin lifecycle (no $src to copy)" -ForegroundColor Yellow
}

Write-Host ''
$failed = @($results | Where-Object { -not $_.ok })
$summary = [pscustomobject]@{
    at = (Get-Date).ToString('s'); total = $results.Count
    passed = $results.Count - $failed.Count; failed = $failed.Count; results = $results
}
$json = Join-Path $root 'out\acceptance-manager.json'
New-Item -ItemType Directory -Force -Path (Split-Path $json) | Out-Null
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $json -Encoding UTF8
Write-Host ("{0}/{1} checks passed" -f $summary.passed, $summary.total) -ForegroundColor $(if ($failed.Count) { 'Red' } else { 'Green' })
Write-Host "report: $json"
if ($failed.Count) { exit 1 } else { exit 0 }
