# capture-window.ps1 -- screenshot a specific top-level window by process name / handle.
#
# Used as visual evidence that the injected bootstrap renders inside the NetEase UI.
# PrintWindow with PW_RENDERFULLCONTENT is tried first (works without stealing focus and
# without the window being on top); if the result is blank - which happens with some
# GPU-composited surfaces - we fall back to bringing the window forward and blitting the
# screen region it occupies.

[CmdletBinding()]
param(
    [string]$ProcessName = 'cloudmusic',
    [string]$Out = 'out\ui-bncm.png',
    [int]$PreferHandle = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    public delegate bool EnumProc(IntPtr h, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    public class WinInfo {
        public IntPtr Handle; public uint Pid; public string Title; public string Class;
        public int Width; public int Height; public bool Visible;
    }

    // Enumerate every top-level window whose owning process is in the supplied set.
    // .NET's Process.MainWindowHandle only exposes one window per process and, for NetEase
    // Cloud Music, that is a small "SystemHint" helper rather than the real UI.
    public static List<WinInfo> TopLevelFor(uint[] pids) {
        var wanted = new HashSet<uint>(pids);
        var list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!wanted.Contains(pid)) return true;
            RECT r; GetWindowRect(h, out r);
            var t = new System.Text.StringBuilder(512); GetWindowTextW(h, t, 512);
            var c = new System.Text.StringBuilder(512); GetClassNameW(h, c, 512);
            list.Add(new WinInfo {
                Handle = h, Pid = pid, Title = t.ToString(), Class = c.ToString(),
                Width = r.Right - r.Left, Height = r.Bottom - r.Top, Visible = IsWindowVisible(h)
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@
if (-not ('WinCap' -as [type])) { Add-Type -TypeDefinition $sig }

function Get-BestWindow {
    param([int]$Prefer)
    $targets = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    if ($targets.Count -eq 0) { return $null }
    $pids = [uint32[]]($targets | ForEach-Object { [uint32]$_.Id })

    $all = [WinCap]::TopLevelFor($pids)
    Write-Host "top-level windows found: $($all.Count)"
    foreach ($w in ($all | Sort-Object { $_.Width * $_.Height } -Descending)) {
        Write-Host ("   {0,6}x{1,-5} vis={2,-5} class={3,-28} '{4}'" -f $w.Width, $w.Height, $w.Visible, $w.Class, $w.Title)
    }

    if ($Prefer -ne 0) {
        $hit = $all | Where-Object { [int]$_.Handle -eq $Prefer }
        if ($hit) { return $hit | Select-Object -First 1 }
    }
    # Prefer the main CEF browser window.  NetEase keeps several top-level windows
    # (SystemHintWindow, DesktopLyrics, MiniPlayer, a tiny OrpheusBrowserHost now-playing bar);
    # the real UI is the large Chrome_WidgetWin_0, which may be hidden if the client was
    # minimised to the tray.
    $cef = $all | Where-Object { $_.Class -in @('Chrome_WidgetWin_0', 'OrpheusBrowserHost') } |
        Sort-Object { $_.Width * $_.Height } -Descending
    if ($cef) { return $cef | Select-Object -First 1 }
    return $all | Sort-Object { $_.Width * $_.Height } -Descending | Select-Object -First 1
}

$win = Get-BestWindow -Prefer $PreferHandle
if (-not $win) { Write-Host 'ERROR: no window with a non-zero handle for that process.'; exit 1 }

Write-Host ("window: pid={0} handle={1} {2}x{3} '{4}'" -f $win.Pid, $win.Handle, $win.Width, $win.Height, $win.Title)
if ($win.Width -lt 200 -or $win.Height -lt 200) {
    Write-Host 'WARNING: window looks too small to be the main UI.'
}

$rect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($win.Handle, [ref]$rect)
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top

$outFull = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path (Split-Path $outFull) | Out-Null

function Save-PrintWindow {
    # A hidden window renders as an empty/black frame, so reveal it first.
    if (-not [WinCap]::IsWindowVisible($win.Handle)) {
        Write-Host 'window is hidden (tray/minimised); showing it for capture'
        [void][WinCap]::ShowWindow($win.Handle, 5)   # SW_SHOW
        Start-Sleep -Milliseconds 1200
    }
    [void][WinCap]::SetForegroundWindow($win.Handle)
    Start-Sleep -Milliseconds 600
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    # 2 = PW_RENDERFULLCONTENT (Windows 8.1+)
    $ok = [WinCap]::PrintWindow($win.Handle, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); return $null }
    return $bmp
}

function Save-ScreenRegion {
    [void][WinCap]::ShowWindow($win.Handle, 9)   # SW_RESTORE
    [void][WinCap]::SetForegroundWindow($win.Handle)
    Start-Sleep -Milliseconds 1200
    # Re-read the rect: showing/restoring/foregrounding the window can move it, and the rect
    # read during window selection is now stale.  A stale rect yields a misaligned grab.
    $r2 = New-Object WinCap+RECT
    [void][WinCap]::GetWindowRect($win.Handle, [ref]$r2)
    $bmp = New-Object System.Drawing.Bitmap(($r2.Right - $r2.Left), ($r2.Bottom - $r2.Top))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r2.Left, $r2.Top, 0, 0, (New-Object System.Drawing.Size($bmp.Width, $bmp.Height)))
    $g.Dispose()
    return $bmp
}

# Blankness heuristic.  A GPU-composited CEF surface comes back pure black from
# PrintWindow while the non-client frame (title bar, buttons) still renders, so sampling the
# whole window is not enough -- we must sample below the title bar.
function Test-Blank {
    param($Bmp, [int]$SkipTop = 0)
    $first = $null; $distinct = 0
    for ($y = $SkipTop; $y -lt $Bmp.Height; $y += 5) {
        for ($x = 0; $x -lt $Bmp.Width; $x += 5) {
            $c = $Bmp.GetPixel($x, $y).ToArgb()
            if ($null -eq $first) { $first = $c; $distinct = 1 }
            elseif ($c -ne $first) { $distinct++ }
            if ($distinct -ge 12) { return $false }
        }
    }
    return $true
}

$bmp = Save-PrintWindow
$mode = 'PrintWindow'
# Height of the non-client title bar, i.e. where the client area starts inside the grab.
$clientRect = New-Object WinCap+RECT
[void][WinCap]::GetClientRect($win.Handle, [ref]$clientRect)
$clientOrigin = New-Object WinCap+POINT
[void][WinCap]::ClientToScreen($win.Handle, [ref]$clientOrigin)
$skipTop = [Math]::Max(0, ($clientOrigin.Y - $rect.Top) + 2)

if (-not $bmp -or (Test-Blank $bmp $skipTop)) {
    if ($bmp) { $bmp.Dispose() }
    Write-Host 'PrintWindow returned a blank client area (GPU-composited CEF surface); using screen capture.'
    $bmp = Save-ScreenRegion
    $mode = 'screen'
}

$bmp.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "mode : $mode"
Write-Host "saved: $outFull ($((Get-Item $outFull).Length) bytes)"
