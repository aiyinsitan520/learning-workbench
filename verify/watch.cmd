@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo Watching app\ for changes. Press Ctrl+C to stop.
echo Each change re-runs the read-only contract check.
echo.

set "LAST="
:loop
for /f "tokens=*" %%t in ('dir /b /s /o-d app\public\js\*.js app\public\*.css app\lib\*.js app\server.js architecture\*.sql 2^>nul ^| findstr /v "\\data\\"') do (
  set "NEWEST=%%t"
  goto :haveone
)
:haveone
for %%f in ("%NEWEST%") do set "STAMP=%%~tf"

if not "%STAMP%"=="%LAST%" (
  set "LAST=%STAMP%"
  echo.
  echo [%DATE% %TIME%] change detected - checking...
  python verify\check_contract.py | findstr /c:"[FAIL]" /c:"检查项:" /c:"结果:"
)
timeout /t 3 /nobreak >nul
goto :loop
