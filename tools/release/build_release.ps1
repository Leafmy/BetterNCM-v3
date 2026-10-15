# build_release.ps1 -- assemble the two distributable BetterNCM(v3) packages.
#
#   * BetterNCM-v3-Portable-x64.zip   self-contained: bundled Node, its own data\ directory,
#                                     no registry writes, delete the folder to uninstall.
#   * BetterNCM-v3-Setup-x64.exe      one-click installer (IExpress self-extracting archive):
#                                     copies the runtime to %LOCALAPPDATA%\BetterNCM, installs
#                                     the version.dll proxy, the four plugins, the HKCU logon
#                                     watchdog, a shortcut and an uninstall entry.
#
# The payload is not a fork.  Both packages carry a verbatim copy of this checkout's runtime --
# loader\framework.js, loader\manager.js, loader\*.ps1, tools\*.mjs, the four .plugin archives --
# plus a bundled node.exe and the thin launchers that call the loader scripts from
# tools\release\portable and tools\release\setup.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\build_release.ps1
#   ... -OutDir "D:\dist" -NodeExe "C:\path\node.exe" -SkipSetup
#
# Notes:
#   * IExpress (built into Windows) is the packaging tool for the .exe; no Inno Setup / NSIS.
#   * It is only given two FLAT files (install.cmd + payload.zip) because IExpress does not
#     preserve nested directories reliably -- install.cmd expands the archive itself.

[CmdletBinding()]
param(
    [string]$OutDir  = '',
    [string]$NodeExe = '',
    [string]$Version = '3.1.41',
    [switch]$SkipSetup,
    [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'

function Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }
function Fail([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

$releaseDir = $PSScriptRoot
$repo = [System.IO.Path]::GetFullPath((Join-Path $releaseDir '..\..'))
if ([string]::IsNullOrEmpty($OutDir)) {
    $OutDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'release'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$staging = Join-Path $repo 'out\release'
if ($OutDir -match '\s') { Fail "OutDir must not contain whitespace (IExpress writes it into an unquoted .sed): $OutDir" }

# --- 0. prerequisites -------------------------------------------------------------------------
Step 'checking inputs'
if ([string]::IsNullOrEmpty($NodeExe)) {
    . (Join-Path $repo 'loader\paths.ps1')
    $NodeExe = Resolve-BncmNode -Root $repo
}
if (-not (Test-Path -LiteralPath $NodeExe)) { Fail "node.exe not found: $NodeExe" }

$loaderFiles = @('framework.js', 'manager.js', 'hijacks.json', 'selectors.json',
                 'paths.ps1', 'install.ps1', 'uninstall.ps1', 'startup.ps1',
                 'create-shortcut.ps1', 'bncm-agent.vbs')
$toolFiles = @('bncm_agent.mjs', 'ncm_host.mjs', 'market_host.mjs', 'cdp_inject.mjs', 'cdp_watch.mjs', 'bncm_preload.js')
$pluginFiles = @('LyricBar.plugin', 'MaterialYouTheme.plugin', 'RefinedNowPlaying.plugin',
                 'NCM-Font-Manager.plugin')

foreach ($f in $loaderFiles) { if (-not (Test-Path -LiteralPath (Join-Path $repo "loader\$f"))) { Fail "missing loader\$f" } }
foreach ($f in $toolFiles)   { if (-not (Test-Path -LiteralPath (Join-Path $repo "tools\$f")))  { Fail "missing tools\$f" } }
foreach ($f in $pluginFiles) { if (-not (Test-Path -LiteralPath (Join-Path $repo "plugins\$f"))) { Fail "missing plugins\$f" } }
# The bundled plugin market travels with both packages: `market\` is the offline source the market
# reads when there is no network, and it carries the four plugin archives above.  Without it the
# market still works, but "install the plugins this build ships" stops working offline.
if (-not (Test-Path -LiteralPath (Join-Path $repo 'market\plugins.json'))) {
    Fail 'missing market\plugins.json -- run: py tools\market\build_market.py'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'tools\market_host.mjs'))) { Fail 'missing tools\market_host.mjs' }
# Both packages redistribute GPL-3.0 code (this project + MaterialYouTheme.plugin) and an MIT-licensed
# Node runtime, so the license texts travel WITH the binaries instead of only living in the repo.
foreach ($f in @('LICENSE', 'THIRD-PARTY-NOTICES.md')) { if (-not (Test-Path -LiteralPath (Join-Path $repo $f))) { Fail "missing $f" } }
$proxy = Join-Path $repo 'out\loader\version.dll'
if (-not (Test-Path -LiteralPath $proxy)) { Fail "missing out\loader\version.dll -- run loader\build.cmd first" }
$iexpress = Join-Path $env:SystemRoot 'System32\iexpress.exe'
if (-not $SkipSetup -and -not (Test-Path -LiteralPath $iexpress)) { Fail "iexpress.exe not found; pass -SkipSetup" }

Info "repo     : $repo"
Info "node     : $NodeExe ($((Get-Item -LiteralPath $NodeExe).Length) bytes)"
Info "proxy    : $proxy"
Info "output   : $OutDir"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# --- helpers ----------------------------------------------------------------------------------
function Copy-Tree([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        $dest = Join-Path $To $item.Name
        if ($item.PSIsContainer) { Copy-Tree $item.FullName $dest }
        else { Copy-Item -LiteralPath $item.FullName -Destination $dest -Force }
    }
}

function Set-Bom([string]$Path) {
    # PowerShell 5.1 reads a BOM-less .ps1/.txt as the ANSI code page, which turns every Chinese
    # string into mojibake.  A BOM is the only reliable fix for a distributed script.
    #
    # Guard: only ever touch files that really are UTF-8 text.  Re-encoding a binary file inflates
    # it (node.exe 89 MB -> 130 MB, version.dll 144 KB -> 220 KB) and makes it unrunnable.
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return }
    if ($bytes -contains 0) { throw "refusing to re-encode a binary file: $Path" }
    $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($true)))
}

function Normalize-Encodings([string]$Dir) {
    # NOTE: `-Include '*.ps1','*.txt'` is silently IGNORED in combination with -LiteralPath, which
    # is how an earlier build re-encoded node.exe and every .plugin as UTF-8 text.  Filter by hand.
    #
    # NODE-LICENSE.txt is skipped on purpose: it is a verbatim copy of a third-party license and
    # adding a BOM would make the shipped text differ from the upstream file byte for byte.
    foreach ($f in Get-ChildItem -LiteralPath $Dir -Recurse -File) {
        if ($f.Name -eq 'NODE-LICENSE.txt') { continue }
        if ($f.Extension -eq '.ps1' -or $f.Extension -eq '.txt') { Set-Bom $f.FullName }
    }
}

function New-Zip([string]$SourceDir, [string]$ZipPath) {
    # Written by hand rather than with ZipFile::CreateFromDirectory: on .NET Framework that helper
    # stores entry names with BACKSLASHES ("app\bin\node.exe"), which is not what the ZIP spec
    # (APPNOTE 4.4.17) says and which non-Windows / spec-following extractors mishandle.
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ZipPath) | Out-Null
    $src = [System.IO.Path]::GetFullPath($SourceDir)
    $stream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::Create)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($f in Get-ChildItem -LiteralPath $src -Recurse -File) {
                $rel = $f.FullName.Substring($src.Length).TrimStart('\', '/').Replace('\', '/')
                $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
                $out = $entry.Open()
                try {
                    $in = [System.IO.File]::OpenRead($f.FullName)
                    try { $in.CopyTo($out) } finally { $in.Dispose() }
                } finally { $out.Dispose() }
            }
            # Empty directories (the portable package ships data\plugins ready to use) need their
            # own entry or they vanish from the archive.
            foreach ($d in Get-ChildItem -LiteralPath $src -Recurse -Directory) {
                if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) {
                    $rel = $d.FullName.Substring($src.Length).TrimStart('\', '/').Replace('\', '/') + '/'
                    $null = $zip.CreateEntry($rel)
                }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-SameFile([string]$A, [string]$B) {
    $ha = (Get-FileHash -LiteralPath $A -Algorithm SHA256).Hash
    $hb = (Get-FileHash -LiteralPath $B -Algorithm SHA256).Hash
    if ($ha -ne $hb) { Fail "staging corrupted $B (expected $ha, got $hb)" }
}

function Assert-Ascii([string]$Path) {
    # .cmd is read as the OEM/ANSI code page by cmd.exe and has no BOM convention at all, so the
    # launchers must stay ASCII -- a Chinese `echo` in a .cmd is mojibake on any codepage.
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    foreach ($b in $bytes) { if ($b -gt 127) { Fail "$Path contains non-ASCII bytes; .cmd files must stay ASCII" } }
}

# --- 1. the runtime tree ----------------------------------------------------------------------
Step 'building the runtime tree'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
$app = Join-Path $staging 'app'
New-Item -ItemType Directory -Force -Path (Join-Path $app 'bin'),
                                            (Join-Path $app 'loader'),
                                            (Join-Path $app 'tools'),
                                            (Join-Path $app 'plugins'),
                                            (Join-Path $app 'market'),
                                            (Join-Path $app 'out\loader') | Out-Null

Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $app 'bin\node.exe') -Force
foreach ($f in $loaderFiles) { Copy-Item -LiteralPath (Join-Path $repo "loader\$f") -Destination (Join-Path $app "loader\$f") -Force }
foreach ($f in $toolFiles)   { Copy-Item -LiteralPath (Join-Path $repo "tools\$f")   -Destination (Join-Path $app "tools\$f")   -Force }
foreach ($f in $pluginFiles) { Copy-Item -LiteralPath (Join-Path $repo "plugins\$f") -Destination (Join-Path $app "plugins\$f") -Force }
# The market source tree: index + plugin archives + preview images.  catalog.json rides along so a
# shipped copy can still explain where each listing came from.
Copy-Tree (Join-Path $repo 'market\plugins')   (Join-Path $app 'market\plugins')
Copy-Tree (Join-Path $repo 'market\previews')  (Join-Path $app 'market\previews')
foreach ($f in @('plugins.json', 'market.json', 'catalog.json', 'README.md')) {
    $src = Join-Path $repo "market\$f"
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $app "market\$f") -Force }
}
Copy-Item -LiteralPath $proxy -Destination (Join-Path $app 'out\loader\version.dll') -Force
foreach ($f in @('LICENSE', 'THIRD-PARTY-NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $repo $f) -Destination (Join-Path $app $f) -Force
}

# node.exe is redistributed under Node's MIT license, which requires the copyright notice to travel
# with the binary.  An upstream Node distribution ships the full text (Node + V8 + OpenSSL + ICU)
# as LICENSE next to node.exe; the DSH runtime keeps node.exe in bin\ and the text one level up.
# Absence is a warning rather than a failure: an unusual Node layout must not block a build, but it
# must be visible.
$nodeLicense = $null
$nodeDir  = [System.IO.Path]::GetDirectoryName($NodeExe)
$nodeRoot = [System.IO.Path]::GetDirectoryName($nodeDir)
foreach ($c in @((Join-Path $nodeDir 'LICENSE'), (Join-Path $nodeDir 'LICENSE.txt'),
                 (Join-Path $nodeRoot 'LICENSE'), (Join-Path $nodeRoot 'LICENSE.txt'))) {
    if (-not $nodeLicense -and (Test-Path -LiteralPath $c)) { $nodeLicense = $c }
}
if ($nodeLicense) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $app 'bin\NODE-LICENSE.txt') -Force
    Info "node license: $nodeLicense"
} else {
    Write-Host '   WARNING: no LICENSE found next to node.exe; the package would ship Node without its license text' -ForegroundColor Yellow
}

$appSize = (Get-ChildItem -LiteralPath $app -Recurse -File | Measure-Object -Property Length -Sum).Sum
Info ("app tree: {0:N1} MB, {1} files" -f ($appSize / 1MB),
      (Get-ChildItem -LiteralPath $app -Recurse -File).Count)

# The staging step must be byte-exact.  An earlier build silently re-encoded the binary files as
# UTF-8 text (see Set-Bom) and shipped a node.exe that Windows refused to run, so this is checked
# rather than assumed.
Assert-SameFile $NodeExe (Join-Path $app 'bin\node.exe')
Assert-SameFile $proxy   (Join-Path $app 'out\loader\version.dll')
foreach ($f in $pluginFiles) { Assert-SameFile (Join-Path $repo "plugins\$f") (Join-Path $app "plugins\$f") }
# The market's store must arrive byte-exact as well: a listing whose sha256 no longer matches the
# package sitting next to it is the one market failure that happens silently.
Assert-SameFile (Join-Path $repo 'market\plugins.json') (Join-Path $app 'market\plugins.json')
$marketIndex = Get-Content -LiteralPath (Join-Path $repo 'market\plugins.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $marketIndex) {
    $rel = ($entry.'file-url' -replace '/', '\')
    Assert-SameFile (Join-Path $repo "market\$rel") (Join-Path $app "market\$rel")
    Assert-SameFile (Join-Path $repo "market\$($entry.preview -replace '/', '\')") (Join-Path $app "market\$($entry.preview -replace '/', '\')")
}
Info "staging is byte-exact for node.exe, version.dll, every shipped plugin and $($marketIndex.Count) market listing(s)"

# --- 2. portable package ----------------------------------------------------------------------
Step 'building the portable package'
$portable = Join-Path $staging 'portable'
Copy-Tree $app (Join-Path $portable 'app')
foreach ($f in @('Start.cmd', 'Stop.cmd', 'Status.cmd', 'README.txt')) {
    Copy-Item -LiteralPath (Join-Path $releaseDir "portable\$f") -Destination (Join-Path $portable $f) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $portable 'data\plugins') | Out-Null
foreach ($f in @('Start.cmd', 'Stop.cmd', 'Status.cmd')) { Assert-Ascii (Join-Path $portable $f) }
Normalize-Encodings $portable

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$portableZip = Join-Path $OutDir 'BetterNCM-v3-Portable-x64.zip'
Assert-SameFile $NodeExe (Join-Path $portable 'app\bin\node.exe')
New-Zip $portable $portableZip
Info ("portable : {0}  ({1:N1} MB)" -f $portableZip, ((Get-Item -LiteralPath $portableZip).Length / 1MB))

# --- 3. setup package -------------------------------------------------------------------------
$setupExe = $null
if (-not $SkipSetup) {
    Step 'building the one-click installer'
    $payloadRoot = Join-Path $staging 'payloadroot'
    Copy-Tree $app (Join-Path $payloadRoot 'app')
    foreach ($f in @('install.ps1', 'uninstall.ps1', 'uninstall.cmd')) {
        Copy-Item -LiteralPath (Join-Path $releaseDir "setup\payload\install\$f") `
                  -Destination (New-Item -ItemType Directory -Force -Path (Join-Path $payloadRoot 'install')).FullName -Force
    }
    Copy-Item -LiteralPath (Join-Path $releaseDir 'portable\README.txt') -Destination (Join-Path $payloadRoot 'README.txt') -Force
    Normalize-Encodings $payloadRoot
    Assert-SameFile $NodeExe (Join-Path $payloadRoot 'app\bin\node.exe')

    $payloadZip = Join-Path $staging 'sfx\payload.zip'
    New-Zip $payloadRoot $payloadZip
    Info ("payload  : {0:N1} MB" -f ((Get-Item -LiteralPath $payloadZip).Length / 1MB))

    # IExpress writes SourceFiles0/TargetName into a .sed without quoting, and this checkout's path
    # contains a space ("All In"), so the two flat files are staged in a space-free temp directory.
    $sfxDir = Join-Path $env:TEMP ('bncm-sfx-' + $PID)
    if (Test-Path -LiteralPath $sfxDir) { Remove-Item -LiteralPath $sfxDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $sfxDir | Out-Null
    Copy-Item -LiteralPath $payloadZip -Destination (Join-Path $sfxDir 'payload.zip') -Force
    Copy-Item -LiteralPath (Join-Path $releaseDir 'setup\install.cmd') -Destination (Join-Path $sfxDir 'install.cmd') -Force
    Assert-Ascii (Join-Path $sfxDir 'install.cmd')
    if ($sfxDir -match '\s') { Fail "IExpress staging path contains a space: $sfxDir" }

    $setupExe = Join-Path $OutDir 'BetterNCM-v3-Setup-x64.exe'
    if (Test-Path -LiteralPath $setupExe) { Remove-Item -LiteralPath $setupExe -Force }

    # IExpress takes two flat files and one directive file.  UTF-16LE is what it expects.
    #
    # InsideCompressed=1 is NOT cosmetic: with 0 the stub produced an .exe that extracted nothing
    # and never launched AppLaunched (measured with a one-file payload).  ShowInstallProgramWindow=1
    # keeps the extraction progress visible.
    $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$setupExe
FriendlyName=BetterNCM v3 for NetEase Cloud Music $Version
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="install.cmd"
FILE1="payload.zip"
[SourceFiles]
SourceFiles0=$sfxDir\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
    $sedPath = Join-Path $sfxDir 'setup.sed'
    [System.IO.File]::WriteAllText($sedPath, $sed, (New-Object System.Text.UnicodeEncoding($false, $true)))

    # IExpress returns before the target file is flushed; poll for it.
    & $iexpress /N /Q $sedPath | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    while (-not (Test-Path -LiteralPath $setupExe)) {
        if ((Get-Date) -gt $deadline) { Fail "iexpress did not produce $setupExe within 180s (see $sfxDir)" }
        Start-Sleep -Milliseconds 500
    }
    Info ("setup    : {0}  ({1:N1} MB)" -f $setupExe, ((Get-Item -LiteralPath $setupExe).Length / 1MB))
    Remove-Item -LiteralPath $sfxDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- 4. checksums -----------------------------------------------------------------------------
Step 'writing checksums'
$sums = Join-Path $OutDir 'SHA256SUMS.txt'
$lines = @()
foreach ($f in @($portableZip, $setupExe)) {
    if ($f -and (Test-Path -LiteralPath $f)) {
        $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
        $lines += "$h  $([System.IO.Path]::GetFileName($f))"
    }
}
$lines | Set-Content -LiteralPath $sums -Encoding Ascii
$lines | ForEach-Object { Info $_ }

if (-not $KeepStaging) {
    Step 'cleaning staging'
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Info "removed $staging"
}

Step 'done'
Write-Host "Release output: $OutDir" -ForegroundColor Green
