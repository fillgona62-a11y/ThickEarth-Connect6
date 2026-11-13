@echo off
setlocal
cd /d "%~dp0"

set "APP_MODE=desktop"
set "HOST=127.0.0.1"
set "PORT=8787"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install Node 22.5 or newer first.
  pause
  exit /b 1
)

echo.
echo   ThickEarth / Connect6
echo   ---------------------------------------------
echo   URL : http://127.0.0.1:8787/
echo   Rule: 19x19, black opens with 1 stone, then 2 per turn, six in a row wins
echo.
echo   Keep this window open while playing.
echo   Close it or press Ctrl+C to stop the server.
echo.
echo   If the browser does not open, copy the URL above manually.
echo.

start "" "http://127.0.0.1:8787/"

node "%~dp0server\index.js"

echo.
echo Server stopped.
pause
