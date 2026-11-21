@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Learning Space

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 or newer from https://nodejs.org
  pause
  exit /b 1
)

set "NODE_VER="
for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set "NODE_VER=%%v"
for /f "tokens=1 delims=." %%a in ("!NODE_VER!") do set "NODE_MAJOR=%%a"
if !NODE_MAJOR! LSS 22 (
  echo [ERROR] Node.js !NODE_VER! is too old. Version 22 or newer is required.
  echo         Download: https://nodejs.org
  pause
  exit /b 1
)

if not exist "app\data\workbench.db" (
  echo First run: preparing sample data...
  node app\seed.js
  if errorlevel 1 (
    echo [ERROR] Failed to prepare sample data. See the message above.
    pause
    exit /b 1
  )
)

set "PORT=7321"
if not "%WORKBENCH_PORT%"=="" set "PORT=%WORKBENCH_PORT%"

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Port %PORT% is already in use - the workbench may already be running.
  start "" "http://127.0.0.1:%PORT%/"
  pause
  exit /b 0
)

echo Starting Learning Space...
echo   URL: http://127.0.0.1:%PORT%/
echo   Close this window to stop.
echo.
start "" "http://127.0.0.1:%PORT%/"
node app\server.js
if errorlevel 1 (
  echo [ERROR] Server exited abnormally. See the message above.
  pause
)
