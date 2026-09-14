# Open a directory in Explorer and force its window to the foreground.
# Win11 24H2+ (per-window-process) behavior: opening a folder often leaves the
# new window hidden / in the background, or lands it as a tab the user never
# notices. We launch explorer.exe for the folder, then enumerate CabinetWClass
# windows and bring the right one to the front:
#   1) prefer a NEW window (opened just now, not in the baseline) -- the most
#      reliable signal that "this is the folder we just asked for";
#   2) else match the window title / tab strip against the folder name
#      (the folder was already open, so explorer focused the existing window);
#   3) else fall back to the topmost visible Explorer window.
# Duplicate hidden windows for the same folder are closed so they don't pile up.
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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
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
  // All top-level CabinetWClass windows (visible AND hidden), in Z-order
  // (topmost first). Line: handle<TAB>visible<TAB>title<TAB>tabstripTitle
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

$baseline = @([ODH]::ExplorerWindows())
$baseHandles = @($baseline | ForEach-Object { ($_ -split "`t")[0] })
Log-Line "dir=$Dir folder=$folderName baseline=$($baseline.Count)"

# Launch the folder in Explorer (visible). If it's already open this focuses
# the existing window instead of creating a new one.
try { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$Dir`"" } catch { Log-Line "explorer launch failed: $($_.Exception.Message)" }
Log-Line "launched explorer.exe"

$target = $null
$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline -and -not $target) {
  Start-Sleep -Milliseconds 300
  $cur = @([ODH]::ExplorerWindows())
  # 1) a NEW window (not in baseline) = the one we just opened
  foreach ($line in $cur) {
    $h = ($line -split "`t")[0]
    if ($baseHandles -notcontains $h) { $target = $h; Log-Line "new window: $h ($line)"; break }
  }
  # 2) folder already open -> match by title/tab
  if (-not $target) {
    foreach ($line in $cur) {
      if (Test-Match $line) { $target = ($line -split "`t")[0]; Log-Line "matched window: $target"; break }
    }
  }
}

if (-not $target) {
  # close duplicate hidden windows for this folder, then fall back to topmost
  $cur = @([ODH]::ExplorerWindows())
  foreach ($line in $cur) {
    $h = ($line -split "`t")[0]
    if (Test-Match $line -and (($line -split "`t")[1] -eq '0')) {
      [ODH]::Close([IntPtr][Convert]::ToInt64($h, 16)); Log-Line "closing dup hidden $h"
    }
  }
  foreach ($line in $cur) {
    if (($line -split "`t")[1] -eq '1') { $target = ($line -split "`t")[0]; Log-Line "fallback topmost: $target"; break }
  }
}

if ($target) {
  [ODH]::ShowAndFront([IntPtr][Convert]::ToInt64($target, 16))
  Log-Line "brought $target to front"
  exit 0
}
Log-Line "no target found"
exit 1
