@echo off
rem ============================================================
rem  DSH Launcher V3 engine
rem  - Prefer V2's installed electron runtime (separate instance lock,
rem    can coexist with V2, but close V2 first to share port 7610).
rem  - Falls back to plain Node mode when electron is missing
rem    (keeps console window + auto opens browser).
rem  NOTE: keep this file ASCII-only (cmd.exe GBK code page).
rem ============================================================
cd /d %~dp0

if exist electron\node_modules\electron\dist\electron.exe (
  start "" electron\node_modules\electron\dist\electron.exe electron-v3
  exit /b
) else (
  echo [Launcher V3] electron runtime not found, using plain Node mode...
  runtime\node\node.exe server-v3\main.mjs --browser
  pause
)
