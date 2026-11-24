@echo off
setlocal
title Back Test View
cd /d "%~dp0"
if errorlevel 1 goto failed

where node.exe >nul 2>&1
if errorlevel 1 (
    for /d %%N in ("%LOCALAPPDATA%\Programs\NodeJS\node-v24.*-win-x64") do set "PATH=%%~fN;%PATH%"
)
where node.exe >nul 2>&1
if errorlevel 1 (
    set "PATH=%ProgramFiles%\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VisualStudio\NodeJs;%PATH%"
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js 24 or later is required. Install Node.js and try again.
    goto failed
)
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { process.exit(1); }"
if errorlevel 1 (
    echo Node.js 24 or later is required.
    goto failed
)
if not exist "node_modules\vite\package.json" (
    echo Dependencies are missing. Run npm install in this folder first.
    goto failed
)

set "PORT=5173"
echo Starting Back Test View at http://127.0.0.1:5173
echo Press Ctrl+C to stop the server.
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "for ($attempt = 0; $attempt -lt 30; $attempt++) { try { $response = Invoke-WebRequest 'http://127.0.0.1:5173/api/instruments' -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:5173'; exit } } catch [System.Net.WebException] { }; Start-Sleep -Seconds 1 }"
node server/index.ts
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Failed to start Back Test View. Check the message above.
pause
exit /b 1
