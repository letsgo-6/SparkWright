@echo off
chcp 65001 >nul
setlocal
title SparkWright
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Please install Node.js 22.12+ and try again.
  echo https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm is missing. Please reinstall Node.js with npm.
  pause
  exit /b 1
)
node "scripts\start-personal.mjs"
if errorlevel 1 (
  echo [ERROR] See the message above. Fix the problem and try again.
  pause
  exit /b 1
)
endlocal
