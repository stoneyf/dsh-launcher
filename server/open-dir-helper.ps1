# Open a directory in Explorer and force its window to the foreground.
# Win11 24H2+ (per-window-process) behavior: "start <dir>" creates a new
# Explorer window+process, but the window is often left HIDDEN (vis=False)
# or opened as a background tab - the user sees nothing. We therefore
# enumerate ALL CabinetWClass windows (visible AND hidden), find the one
# showing the target folder, show it, and SetForegroundWindow it.
#
# A window "shows" the folder when:
#   - its top-level title is "<folder> - <locale suffix>", or
#   - its ShellTabWindowClass child (tab strip) title equals the folder name.
# Duplicate hidden windows for the same folder are closed to stop them
# accumulating (each one keeps its own explorer process alive).
# NOTE: keep this file ASCII-only (PS 5.1 reads BOM-less .ps1 as ANSI/GBK).
param(
  [Parameter(Mandatory)][string]$Dir,
  [string]$Log = ''
)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ODH {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);

  public static string Text(IntPtr h) {
    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    return sb.ToString();
  }
  public static string Class(IntPtr h) {
    var cs = new StringBuilder(64); GetClassName(h, cs, 64);
    return cs.ToString();
  }
  // All top-level CabinetWClass windows (visible and hidden), Z-order.
  // Line format: handle<TAB>visible<TAB>title<TAB>tabstripTitle
  public static List<string> ExplorerWindows() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (Class(h) != "CabinetWClass") return true;
      var tab = "";
      EnumChildWindows(h, (c, l2) => {
        if (Class(c) == "ShellTabWindowClass") { tab = Text(c); return false; }
        return true;
      }, IntPtr.Zero);
      res.Add(h.ToString("X8") + "\t" + (IsWindowVisible(h) ? "1" : "0") + "\t" + Text(h) + "\t" + tab);
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static void ShowAndFront(IntPtr h) {
    if (!IsWindowVisible(h)) ShowWindow(h, 5);        // SW_SHOW
    else if (IsIconic(h)) ShowWindow(h, 9);           // SW_RESTORE
    int pid; GetWindowThreadProcessId(h, out pid);
    uint fgThread = (uint)pid;
    uint curThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != curThread) attached = AttachThreadInput(curThread, fgThread, true);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(curThread, fgThread, false);
  }
  public static void Close(IntPtr h) {
    PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
  }
}
"@

function Log-Line($msg) {
  if ($Log) {
    try { Add-Content -LiteralPath $Log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $msg) -Encoding UTF8 } catch {}
  }
}

$folderName = Split-Path $Dir -Leaf

function Test-Match($line) {
  $parts = $line -split "`t"
  $title = if ($parts.Count -gt 2) { $parts[2] } else { '' }
  $tab = if ($parts.Count -gt 3) { $parts[3] } else { '' }
  return ($title -eq $folderName) -or ($title -like "$folderName - *") -or ($tab -eq $folderName)
}

# returns the handle of the best window showing the folder:
# visible matches win over hidden ones; among equals, Z-order (first) wins
function Get-Best($windows) {
  $hidden = $null
  foreach ($line in $windows) {
    if (-not (Test-Match $line)) { continue }
    $h = ($line -split "`t")[0]
    $vis = ($line -split "`t")[1]
    if ($vis -eq '1') { return $h }
    if (-not $hidden) { $hidden = $h }
  }
  return $hidden
}

$baseline = [ODH]::ExplorerWindows()
$baseHandles = @($baseline | ForEach-Object { ($_ -split "`t")[0] })
Log-Line "dir=$Dir folder=$folderName baseline=$($baseline.Count)"
foreach ($b in $baseline) { Log-Line "  base: $b" }

$target = Get-Best $baseline
if ($target) {
  Log-Line "existing window shows folder: $target"
  # close duplicate hidden windows for this folder (keep the one we show)
  foreach ($line in $baseline) {
    $h = ($line -split "`t")[0]
    if ($h -eq $target) { continue }
    if (Test-Match $line -and (($line -split "`t")[1] -eq '0')) {
      Log-Line "closing duplicate hidden window $h"
      [ODH]::Close([IntPtr][Convert]::ToInt64($h, 16))
    }
  }
}
else {
  Start-Process -FilePath $env:ComSpec -ArgumentList "/c start "" `"$Dir`"" -WindowStyle Hidden
  Log-Line "spawned start (no existing window)"
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline -and -not $target) {
    Start-Sleep -Milliseconds 400
    $cur = [ODH]::ExplorerWindows()
    # new window with a matching title (visible or hidden)
    foreach ($line in $cur) {
      $h = ($line -split "`t")[0]
      if ($baseHandles -notcontains $h -and (Test-Match $line)) { $target = $h; break }
    }
    if (-not $target) { $target = Get-Best $cur }
  }
  if ($target) { Log-Line "window showing folder after start: $target" }
}

# Fallback: nothing matched - bring the topmost visible Explorer window forward
# and retry start once (an interactive click may need a visible window to land in).
if (-not $target) {
  $cur = [ODH]::ExplorerWindows()
  $topmost = $null
  foreach ($line in $cur) {
    $parts = $line -split "`t"
    if ($parts[1] -eq '1') { $topmost = $parts[0]; break }
  }
  if ($topmost) {
    Log-Line "fallback: retrying with topmost visible $topmost"
    [ODH]::ShowAndFront([IntPtr][Convert]::ToInt64($topmost, 16))
    Start-Sleep -Milliseconds 300
    Start-Process -FilePath $env:ComSpec -ArgumentList "/c start "" `"$Dir`"" -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(5)
    $baseHandles = @($cur | ForEach-Object { ($_ -split "`t")[0] })
    while ((Get-Date) -lt $deadline -and -not $target) {
      Start-Sleep -Milliseconds 400
      $cur2 = [ODH]::ExplorerWindows()
      foreach ($line in $cur2) {
        $h = ($line -split "`t")[0]
        if ($baseHandles -notcontains $h -and (Test-Match $line)) { $target = $h; break }
      }
      if (-not $target) { $target = Get-Best $cur2 }
    }
    if (-not $target) { $target = $topmost; Log-Line "no match after retry, using topmost" }
  } else {
    Log-Line "fallback: no explorer windows at all"
  }
}

if ($target) {
  [ODH]::ShowAndFront([IntPtr][Convert]::ToInt64($target, 16))
  Log-Line "brought $target to front"
  exit 0
}
Log-Line "no target found"
exit 1
