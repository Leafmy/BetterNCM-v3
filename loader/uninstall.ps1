# uninstall.ps1 -- remove the BetterNCM(v3) proxy and restore the original state.
#
# Safety: the installed file is only deleted when its SHA-256 still matches the hash we
# recorded at install time.  If anything (an upstream update, another tool) replaced it,
# we stop and report instead of destroying someone else's file.

[CmdletBinding()]
param(
    [string]$NcmDir = 'E:\CloudMusic',
    [switch]$StopClient,
    [switch]$Verify,
    [switch]$KeepAutostart
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- stop the unattended agent and its logon entry -------------------------------
# Done FIRST and unconditionally: leaving the watchdog registered while the proxy is gone would
# keep restarting the user's client for no reason.
if (-not $KeepAutostart) {
    $runKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    try {
        $existing = Get-ItemProperty -LiteralPath $runKey -Name 'BetterNCM' -ErrorAction Stop
        if ($existing.BetterNCM) {
            Remove-ItemProperty -LiteralPath $runKey -Name 'BetterNCM' -ErrorAction SilentlyContinue
            Write-Host 'removed the BetterNCM logon entry'
        }
    } catch { }

    $killed = 0
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -and $p.CommandLine -match 'bncm_agent\.mjs') {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
        }
    }
    if ($killed -gt 0) { Write-Host "stopped $killed agent process(es)" }

    $lock = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\out\agent.lock'))
    if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
}

$manifestPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\out\loader\install-manifest.json'))
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Fail "no install manifest at $manifestPath -- nothing recorded as installed by this tool"
}
$m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$target = $m.target
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "already absent: $target"
} else {
    $running = @(Get-Process -Name 'cloudmusic' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        if ($StopClient) {
            Write-Host "stopping $($running.Count) cloudmusic process(es) ..."
            $running | Stop-Process -Force
            Start-Sleep -Milliseconds 1500
        } else {
            Fail "the client is running. Close it, or pass -StopClient."
        }
    }

    $current = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($current -ne $m.proxy_sha256) {
        Fail @"
refusing to delete $target
  recorded : $($m.proxy_sha256)
  on disk  : $current
The file is not the one this tool installed. Inspect it manually.
"@
    }
    Remove-Item -LiteralPath $target -Force
    Write-Host "removed: $target"
}

if ($m.backup -and (Test-Path -LiteralPath $m.backup)) {
    # Guard: never "restore" a file that is actually our own proxy.  A bad backup would make
    # uninstall a no-op and leave the client permanently modified.
    $backupHash = (Get-FileHash -LiteralPath $m.backup -Algorithm SHA256).Hash.ToLower()
    if ($backupHash -eq $m.proxy_sha256) {
        Write-Host "WARNING: backup $($m.backup) is identical to our proxy; refusing to restore it." -ForegroundColor Yellow
        Write-Host "         The original version.dll is not recoverable from this backup." -ForegroundColor Yellow
    } else {
        Copy-Item -LiteralPath $m.backup -Destination $target -Force
        Write-Host "restored original version.dll from $($m.backup)"
    }
}

Remove-Item -LiteralPath $manifestPath -Force
Write-Host 'manifest cleared.'

if ($Verify) {
    $verifyScript = Join-Path $PSScriptRoot '..\test\restore-verify.ps1'
    if (Test-Path -LiteralPath $verifyScript) {
        Write-Host ''
        Write-Host 'running baseline verification ...'
        & $verifyScript
    }
}
