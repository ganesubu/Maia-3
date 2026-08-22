@echo off
setlocal
cd /d "%~dp0"
title Maia 3 - Portable Windows

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

echo.
echo   Maia 3 - Portable Windows
echo   =========================
echo   No Python or Node.js required.
echo.

if not exist "%~dp0Start Maia 3 Server.ps1" (
    echo ERROR: Start Maia 3 Server.ps1 is missing.
    echo.
    pause
    exit /b 1
)

rem Stockfish is optional for playing. If it is missing, the app can still
rem play Maia. The first run downloads the pinned analysis engine.
if not exist "%~dp0stockfish\stockfish-18-lite-single.js" (
    echo Checking Stockfish...
    if not exist "%~dp0stockfish" mkdir "%~dp0stockfish"

    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop';" ^
      "$root=(Split-Path -Parent '%~dp0Start Maia 3 Server.ps1');" ^
      "try {" ^
      "  Invoke-WebRequest -UseBasicParsing 'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single.js' -OutFile (Join-Path $root 'stockfish\stockfish-18-lite-single.js');" ^
      "  Invoke-WebRequest -UseBasicParsing 'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single.wasm' -OutFile (Join-Path $root 'stockfish\stockfish-18-lite-single.wasm');" ^
      "  if (-not (Test-Path (Join-Path $root 'stockfish\Copying.txt'))) { Invoke-WebRequest -UseBasicParsing 'https://unpkg.com/stockfish@18.0.8/Copying.txt' -OutFile (Join-Path $root 'stockfish\Copying.txt') };" ^
      "  Write-Host 'Stockfish is ready.';" ^
      "} catch {" ^
      "  Write-Host 'Stockfish download failed:' $_.Exception.Message;" ^
      "  Write-Host 'Maia play remains available; analysis needs Stockfish files.';" ^
      "}"
    echo.
)

echo Starting the local server on port %PORT%...
echo.
echo Keep this window open while using Maia 3.
echo Press Ctrl+C to stop.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start Maia 3 Server.ps1" -Port %PORT%

echo.
echo Maia 3 server stopped.
pause
