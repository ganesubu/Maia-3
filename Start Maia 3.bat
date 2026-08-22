@echo off
setlocal
title Maia 3 Chess - Portable Local Server
cd /d "%~dp0"

set "PORT=8000"
set "ROOT=%~dp0"
set "SERVER=%~dp0Start Maia 3 Server.ps1"

echo.
echo   Maia 3
echo   --------------------------------------------
echo   Portable Windows launcher
echo   No Python or Node.js required.
echo.

if not exist "%SERVER%" (
    echo   ERROR: Start Maia 3 Server.ps1 is missing.
    echo.
    pause
    exit /b 1
)

if not exist "stockfish\stockfish-18-lite-single.js" if not exist "stockfish\stockfish-18-lite-single.wasm" (
    echo   Stockfish analysis engine is not present.
    echo   Downloading the pinned Stockfish 18 lite build...
    echo.
    if not exist "stockfish" mkdir "stockfish"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Invoke-WebRequest 'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single.js' -OutFile 'stockfish\stockfish-18-lite-single.js'; Invoke-WebRequest 'https://unpkg.com/stockfish@18.0.8/bin/stockfish-18-lite-single.wasm' -OutFile 'stockfish\stockfish-18-lite-single.wasm'; if (-not (Test-Path 'stockfish\Copying.txt')) { Invoke-WebRequest 'https://unpkg.com/stockfish@18.0.8/Copying.txt' -OutFile 'stockfish\Copying.txt' }; Write-Host 'Stockfish downloaded successfully.' } catch { Write-Host ''; Write-Host 'WARNING: Stockfish download failed.'; Write-Host 'Analysis will not be available until the engine files are present.'; Write-Host $_.Exception.Message; Write-Host '' }"
)

if not exist "weights\maia3-5m.bin" if not exist "weights\maia3-23m.bin" if not exist "weights\maia3-79m.bin" (
    echo.
    echo   WARNING: no Maia model files were found in weights\.
    echo   Copy at least one .bin file into that folder before playing,
    echo   or load a .bin from the app's Advanced screen.
    echo.
)

echo.
echo   Starting portable local web server on port %PORT%...
echo   No Python required.
echo.
echo   Keep this window open while playing.
echo   Press Ctrl+C here to stop the server.
echo.

start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SERVER%" -Root "%ROOT%" -Port %PORT%

timeout /t 1 /nobreak >nul
start "" "http://localhost:%PORT%/"

echo   Opened http://localhost:%PORT%/
echo.
echo   For phone setup, put the phone on the same Wi-Fi and open:
echo   http://YOUR-PC-IP:%PORT%/
echo.
pause
