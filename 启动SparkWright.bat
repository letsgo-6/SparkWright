@echo off
chcp 65001 >nul
setlocal
title SparkWright
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
if errorlevel 1 (
  echo [ERROR] See the message above. Fix the problem and try again.
  pause
  exit /b 1
)
endlocal
