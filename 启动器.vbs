' DSH Launcher double-click entry: run the engine hidden (no cmd window).
' Keep ASCII-only (WScript reads .vbs as ANSI/GBK on Chinese Windows).
Set sh = CreateObject("WScript.Shell")
bat = WScript.ScriptDirectory & "\launcher.bat"
sh.Run "cmd.exe /c """ & bat & """", 0, False
