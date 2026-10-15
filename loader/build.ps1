# build.ps1 -- build the version.dll proxy loader (x64).
#
# Usage:
#   pwsh -File loader\build.ps1
#   pwsh -File loader\build.ps1 -OutDir out\loader
#
# No external dependencies: only the Visual Studio C++ toolset and the Windows SDK,
# both already present on this machine.  vcpkg / CEF headers are NOT required for the
# proxy stage.

[CmdletBinding()]
param(
    [string]$OutDir = '',
    [string]$Config = 'Release'
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not available while param() defaults are evaluated under -File.
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $PSScriptRoot '..\out\loader' }

function Find-VcVars64 {
    $candidates = @(
        "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $root = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($root) {
            $p = Join-Path $root 'VC\Auxiliary\Build\vcvars64.bat'
            if (Test-Path -LiteralPath $p) { return $p }
        }
    }
    throw "vcvars64.bat not found. Install the MSVC x64 build tools."
}

$vcvars = Find-VcVars64
Write-Host "using vcvars: $vcvars"

$srcDir = Join-Path $PSScriptRoot 'version_proxy'
$out    = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $out | Out-Null

$obj = [System.IO.Path]::GetFullPath((Join-Path $out 'obj'))
Remove-Item -Recurse -Force $obj -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $obj | Out-Null

$optFlags = if ($Config -eq 'Debug') { @('/Od', '/Zi', '/MTd') } else { @('/O2', '/MT') }

# /LD -> DLL, /MT -> static CRT (no VC++ redist needed on the target machine).
# /std:c++17 is required: std::string::data() is const-only before C++17.
#
# Two stages (compile each source, then link) rather than one cl invocation: cl rejects
# "/Fo<dir>" when more than one source file is given, and explicit object paths also keep us
# clear of the cmd.exe quoting trap where a path ending in "\" escapes the closing quote.
$commonArgs = @(
    '/nologo', '/W4', '/EHsc', '/utf-8', '/std:c++17',
    '/DUNICODE', '/D_UNICODE', '/DWIN32_LEAN_AND_MEAN', '/DNOMINMAX'
) + $optFlags + @('/c')

# vcvars64.bat is a batch file, so it must run inside cmd.exe in this same process tree.
# The repo path contains a space ("All In"), so every token must be quoted individually.
function Quote-Arg([string]$a) { if ($a -match '[\s"]') { '"' + $a + '"' } else { $a } }
function Invoke-Tool([string]$tool, [string[]]$arguments) {
    $line = 'call "{0}" >nul 2>&1 && {1} {2}' -f $vcvars, $tool,
            (($arguments | ForEach-Object { Quote-Arg $_ }) -join ' ')
    Write-Verbose $line
    # Emit the tool's output to the host, not to the pipeline: otherwise the caller's
    # assignment captures the output lines together with the exit code.
    cmd.exe /c $line 2>&1 | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
}

$units = @('proxy', 'payload')
$objects = @()
foreach ($u in $units) {
    $objFile = Join-Path $obj "$u.obj"
    $objects += $objFile
    $rc = Invoke-Tool 'cl.exe' ($commonArgs + @(
        "/Fo$objFile", (Join-Path $srcDir "$u.cpp")))
    if ($rc -ne 0) { throw "compiling $u.cpp failed with exit code $rc" }
}

$rc = Invoke-Tool 'link.exe' (@(
    '/NOLOGO', '/DLL', '/MACHINE:X64', '/SUBSYSTEM:WINDOWS', '/INCREMENTAL:NO',
    "/OUT:$out\version.dll", "/PDB:$out\version.pdb"
) + $objects)
if ($rc -ne 0) { throw "link.exe failed with exit code $rc" }

$dll = Join-Path $out 'version.dll'
if (-not (Test-Path -LiteralPath $dll)) { throw "expected output missing: $dll" }

Write-Host ''
Write-Host "built: $dll ($((Get-Item $dll).Length) bytes)"
Write-Host "sha256: $((Get-FileHash $dll -Algorithm SHA256).Hash.ToLower())"
