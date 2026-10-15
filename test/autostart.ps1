# autostart.ps1 -- acceptance test for the unattended path (G1).
#
# Checks the things that "loads plugins when you open 网易云音乐" actually means, end to end:
# the logon entry exists, the agent is alive, the backend answers, the page carries the framework,
# the core plugins loaded, and the lyrics hijack landed.  Everything is read-only.
#
# Requires a RUNNING client that was started through the loader (agent or launch.cmd).
# Run via: test\autostart.cmd

[CmdletBinding()]
param(
    [string]$NcmData = 'C:\betterncm',
    [int]$Port = 9222
)

$ErrorActionPreference = 'Continue'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node.exe' }

$results = @()
function Check([string]$name, [scriptblock]$fn) {
    try {
        $r = & $fn
        if ($r -eq $null) { $r = '' }
        $ok = $false
        $detail = ''
        if ($r -is [array]) { $ok = [bool]$r[0]; $detail = [string]$r[1] }
        else { $ok = [bool]$r; $detail = [string]$r }
        $script:results += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
        $mark = if ($ok) { 'ok  ' } else { 'FAIL' }
        Write-Host "  $mark $name$(if ($detail) { '  :: ' + $detail })" -ForegroundColor $(if ($ok) { 'Gray' } else { 'Red' })
    } catch {
        $script:results += [pscustomobject]@{ name = $name; ok = $false; detail = $_.Exception.Message }
        Write-Host "  FAIL $name :: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Cdp([string]$expr) {
    # Write the expression to a file and use --expr-file.  PowerShell 5.1 mangles embedded double
    # quotes when passing arguments to a native executable, which silently corrupts any JS that
    # contains a string literal (it showed up as "SyntaxError: Unexpected token ':'").
    $tmp = Join-Path $env:TEMP ('bncm-expr-' + [guid]::NewGuid().ToString('N') + '.js')
    try {
        Set-Content -LiteralPath $tmp -Value $expr -Encoding UTF8
        $out = & $node (Join-Path $root 'tools\cdp_inject.mjs') --port $Port --expr-file $tmp 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($out -join ' ') }
        # cdp_inject prints "target: <url>" then the value; take the last non-empty line.
        $lines = @($out | Where-Object { $_ -ne $null -and "$_" -ne '' })
        return $lines[-1]
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "BetterNCM acceptance: unattended start (port $Port)" -ForegroundColor Cyan

Check 'HKCU logon entry installed' {
    $v = (Get-ItemProperty -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'BetterNCM' -ErrorAction SilentlyContinue).BetterNCM
    @([bool]$v, $(if ($v) { $v } else { 'not installed -- run loader\startup.cmd -Install' }))
}

Check 'agent process alive' {
    $n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -match 'bncm_agent\.mjs' })
    @(($n.Count -gt 0), "count=$($n.Count)")
}

Check 'agent --status reports ready' {
    $out = & $node (Join-Path $root 'tools\bncm_agent.mjs') --status --port $Port 2>&1
    @(($LASTEXITCODE -eq 0), (($out | Select-Object -First 3) -join ' | '))
}

Check 'CDP endpoint reachable' {
    $v = Cdp 'typeof window.__BNCM_FRAMEWORK__'
    @(($v -match 'string'), "framework global=$v")
}

Check 'framework present in the page' {
    $v = Cdp 'JSON.stringify(window.__BNCM_LOADED__.build)'
    @(($v -match 'bncm-v3-framework'), "build=$v")
}

Check 'preload ran at document-start (hooking webpack only when needed)' {
    # Two states are correct:
    #   * a rule is enabled -> the push accessor must be installed (runtimeHooked);
    #   * no rule is enabled -> the preload deliberately leaves webpack alone, because interposition
    #     itself was measured to break the client's boot (docs/11 section 8).
    # Either way the preload must have run BEFORE the bundle, which is what boot.hadJsonp records.
    $v = Cdp 'JSON.stringify({boot:window.__BNCM_HIJACK__.boot, intercept:window.__BNCM_HIJACK__.intercept, hooked:window.__BNCM_HIJACK__.runtimeHooked})'
    $startOfDocument = ($v -match '"readyState":"loading"')
    $consistent = (($v -match '"intercept":true' -and $v -match '"hooked":true') -or
                   ($v -match '"intercept":false' -and $v -match '"hooked":false'))
    @(($startOfDocument -and $consistent), "probe=$v")
}

Check 'all three plugins loaded (they are all user plugins now)' {
    # LyricBar / RefinedNowPlaying / MaterialYouTheme are no longer built-ins, so this asserts
    # plain loaded state rather than a core tier; the decoupling itself is guarded by manager.cmd.
    $v = Cdp 'JSON.stringify((window.__BNCM_LOADED__.plugins||[]).map(function(p){return p.slug+":"+p.state}))'
    $expect = @('RefinedNowPlaying:loaded', 'LyricBar:loaded', 'MaterialYouTheme:loaded')
    $missing = @($expect | Where-Object { $v -notmatch [regex]::Escape($_) })
    @(($missing.Count -eq 0), "plugins=$v")
}

Check 'no rewrite is applied (interposition stays off)' {
    # The rewrite mechanism is blocked on scope preservation (docs/11 section 8), and the
    # interposition itself -- the push accessor plus the capture module -- was measured to stop the
    # client from mounting.  So the invariant is that NOTHING is applied and webpack was not
    # touched.  Page errors are reported but not gated: the client and third-party plugins raise
    # their own.
    $v = Cdp 'JSON.stringify({applied:(window.__BNCM_HIJACK__.applied||[]).filter(function(a){return typeof a==="object"}).length, intercept:window.__BNCM_HIJACK__.intercept, payloads:window.__BNCM_HIJACK__.jsonpPayloads, pageErrors:(window.__BNCM_HIJACK__.pageErrors||[]).length})'
    @(($v -match '"applied":0'), "state=$v")
}

Check 'the client UI actually rendered (not a blank window)' {
    # This is precisely what the interposition experiment broke: the app never mounted.  Keep it as
    # a hard gate for any future rewrite work.
    $v = Cdp 'JSON.stringify({rootKids:(document.getElementById("root")||{}).childElementCount, containers:document.querySelectorAll("[class*=ContentContainer_],[class*=LeftScrollContainer_]").length, bodyText:(document.body.innerText||"").length})'
    @(($v -notmatch '"rootKids":0' -and $v -notmatch '"containers":0' -and $v -notmatch '"bodyText":0'), "probe=$v")
}

Check 'legacy DOM alias restored (#main-player)' {
    # LyricBar mounts by polling for #main-player, which 3.x removed; the alias layer re-creates it
    # on the modern player bar.  Without it LyricBar loads and then does nothing at all.
    $v = Cdp 'JSON.stringify({alias:!!window.betterncm.injector.domAliases.applied, mainPlayer:!!document.getElementById("main-player")})'
    @(($v -match '"alias":true' -and $v -match '"mainPlayer":true'), "probe=$v")
}

Check 'LyricBar mounted its bar' {
    # The end of the lyric chain: RNP-Next publishes lyrics, the alias supplies a mount point, and
    # the bar appears.  It may legitimately read "纯音乐，请欣赏" for an instrumental track.
    $v = Cdp 'JSON.stringify({bar:!!document.querySelector(".lyric-bar")})'
    @(($v -match '"bar":true'), "probe=$v")
}

Check 'no floating badge overlays the client window' {
    # The status used to be a fixed bottom-right overlay (#__bncm_badge__).  It now lives inside
    # BetterNCM's own manager panel, so nothing may float over the client's UI any more.
    $v = Cdp 'JSON.stringify({badge:!!document.getElementById("__bncm_badge__")})'
    @(($v -match '"badge":false'), "probe=$v")
}

Check 'status is shown inside the BetterNCM panel' {
    # No core tier any more (every plugin is decoupled), so the status is "plugins N✓" without a
    # core counter; asserting the absence of "core" also guards the decoupling.
    $v = Cdp '(function(){var M=window.__BNCM_MANAGER__; if(!M) return "no-manager"; M.open(); var h=document.querySelector(".bncm-mgr-build"); var t=h?h.textContent:null; M.close(); return JSON.stringify({text:t, locks:document.querySelectorAll(".bncm-mgr-lock").length});})()'
    @(($v -match 'NCM 3\.' -and $v -match '插件 4' -and $v -notmatch 'core ' -and $v -match '"locks":0'), "probe=$v")
}

Check 'RefinedNowPlaying will not show its false hijack notice' {
    # RNP shows "Hijack 错误 ... 歌词无法显示" unless getSucceededHijacks() contains its slug.  We
    # apply no rewrite, but the lyric pipeline demonstrably works through RNP-Next's own 3.x path,
    # so the loader reports that capability -- named "-verified" when observed, "-ncm3-expected" on
    # an ncm3 client whose proof was cleared.
    $v = Cdp 'window.betterncm.app.getSucceededHijacks().then(function(l){return JSON.stringify({list:l, passes:l.some(function(x){return String(x).indexOf("RefinedNowPlaying")!==-1}), notice:!!document.getElementById("refined-now-playing-hijack-failure-notice")})})'
    @(($v -match '"passes":true' -and $v -match '"notice":false'), "probe=$v")
}

Check 'the lyric pipeline is observed working' {
    # Direct evidence that the notice is a false alarm: RNP published lyrics (now or on an earlier
    # run, recorded in localStorage).
    $v = Cdp 'JSON.stringify(window.betterncm.status().lyrics)'
    @(($v -match '"pipelineProven":true'), "lyrics=$v")
}

Check 'preload beat the bundle, or no rule needs it' {
    # The engine can only rewrite a factory it sees BEFORE the webpack runtime assigns push, so
    # hadJsonp=true means this document was already executing its chunks when the preload arrived.
    # The agent reloads once to fix that -- but only when an ENABLED rule needs it, so with every
    # rule disabled (the current state, docs/11 section 8) being late is harmless.  This check
    # therefore accepts either case while reporting which one applies.
    $boot = Cdp 'JSON.stringify(window.__BNCM_HIJACK__.boot)'
    $enabled = Cdp 'JSON.stringify((window.__BNCM_HIJACK__.expected||[]).length)'
    $raced = ($boot -match '"hadJsonp":false')
    @(($raced -or $enabled -eq '0'), "raced=$raced enabledRules=$enabled")
}

Check 'loadedPlugins is slug-addressable (RNP/LyricBar probe it)' {
    $v = Cdp 'JSON.stringify(!!(window.loadedPlugins && window.loadedPlugins.MaterialYouTheme && window.loadedPlugins.RefinedNowPlaying))'
    @(($v -eq 'true'), "bySlug=$v")
}

Check 'every non-core plugin loaded (no silent version gating)' {
    # Live bug: window.APP_CONF is undefined on 3.1.41, so the version detector returned null and
    # every plugin with ncm-version-req was skipped.  Userspace plugins must not silently vanish.
    $v = Cdp 'JSON.stringify((window.__BNCM_LOADED__.plugins||[]).filter(function(p){return !p.core}).map(function(p){return p.slug+":"+p.state}))'
    @(($v -notmatch ':skipped' -and $v -notmatch ':error'), "nonCore=$v")
}

Check 'synchronous ncm.getPlaying() works' {
    $v = Cdp 'JSON.stringify({t:typeof window.betterncm.ncm.getPlaying().id})'
    @(($v -match '"t":"string"'), "probe=$v")
}

Check 'getSucceededHijacks resolves to an array' {
    # It is a PROMISE (upstream signature); awaiting it is the contract, and the old probe that
    # did not await reported a false failure.
    $v = Cdp 'Promise.resolve(window.betterncm.app.getSucceededHijacks()).then(function(a){return JSON.stringify({isArray:Array.isArray(a),n:a.length})})'
    @(($v -match '"isArray":true'), "probe=$v")
}

Write-Host ''
$failed = @($results | Where-Object { -not $_.ok })
$summary = [pscustomobject]@{
    at = (Get-Date).ToString('s')
    port = $Port
    total = $results.Count
    passed = $results.Count - $failed.Count
    failed = $failed.Count
    results = $results
}
$json = Join-Path $root 'out\acceptance-autostart.json'
New-Item -ItemType Directory -Force -Path (Split-Path $json) | Out-Null
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $json -Encoding UTF8

Write-Host ("{0}/{1} checks passed" -f $summary.passed, $summary.total) -ForegroundColor $(if ($failed.Count) { 'Red' } else { 'Green' })
Write-Host "report: $json"
if ($failed.Count) { exit 1 } else { exit 0 }
