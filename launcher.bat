@echo off
rem ============================================================
rem  DSH Launcher engine
rem  - Prefer the bundled electron runtime (runtime\electron,
rem    separate instance lock).
rem  - Falls back to plain Node mode when electron is missing
rem    (keeps console window + auto opens browser).
rem  NOTE: keep this file ASCII-only (cmd.exe GBK code page).
rem ============================================================
cd /d %~dp0

if exist runtime\electron\dist\electron.exe (
  start "" runtime\electron\dist\electron.exe electron
  exit /b
) else (
  echo [Launcher] electron runtime not found, using plain Node mode...
  runtime\node\node.exe server\main.mjs --browser
  pause
)
