@echo off
title SMR Research Assistant - Setup
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================================
echo    SMR Research Assistant - Environment Check and Install
echo ============================================================
echo.

REM ---------- 1. Check Node.js ----------
set NODE_OK=0
where node >nul 2>nul
if %errorlevel%==0 goto NODE_FOUND

echo [1/3] Node.js NOT found. (Version 20 or newer is required)
echo.
echo   This app is zero-dependency but needs the Node.js runtime.
echo   Choose how to install:
echo     [1] Open official download page (LTS recommended)
echo     [2] Try one-click install via winget (Windows 10/11)
echo     [3] I installed it manually, check again
echo.
set /p NODE_CHOICE=Type 1, 2 or 3 then press Enter: 

if "!NODE_CHOICE!"=="1" goto OPEN_PAGE
if "!NODE_CHOICE!"=="2" goto WINGET_INSTALL
goto RECHECK

:OPEN_PAGE
start https://nodejs.org/en/download
echo   Download page opened. After installing, run this file again.
pause
exit /b 0

:WINGET_INSTALL
echo   Installing Node.js LTS via winget ...
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
echo   After install finishes, close this window and run this file again
echo   to refresh the environment PATH.
pause
exit /b 0

:RECHECK
where node >nul 2>nul
if %errorlevel%==0 goto NODE_FOUND
echo   Node.js still not found. Please install it first, then run this file again.
pause
exit /b 0

:NODE_FOUND
for /f "delims=" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [1/3] Node.js detected: !NODE_VER!
echo.

REM ---------- 2. Create desktop shortcut + silent launcher ----------
echo [2/3] Creating desktop shortcut ...
set "SMR_DIR=%~dp0"
set "SMR_DIR=%SMR_DIR:~0,-1%"

set NODE_PATH=
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_PATH set "NODE_PATH=%%i"
)
if not defined NODE_PATH set "NODE_PATH=node"

powershell -NoProfile -Command ^
  "$dir = $env:SMR_DIR; $nodePath = $env:NODE_PATH;" ^
  "$vbs = 'Set ws = CreateObject(\"Wscript.Shell\")' + \"`r`n\" + 'ws.CurrentDirectory = \"' + $dir + '\"' + \"`r`n\" + 'ws.Run \"\"\"' + $nodePath + '\"\" \"\"' + $dir + '\src\main.js\"\"\", 0, False';" ^
  "[System.IO.File]::WriteAllText((Join-Path $dir 'start-silent.vbs'), $vbs, [System.Text.Encoding]::Unicode);" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\SMR Research Assistant.lnk');" ^
  "$lnk.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe');" ^
  "$lnk.Arguments = '\"' + (Join-Path $dir 'start-silent.vbs') + '\"';" ^
  "$lnk.WorkingDirectory = $dir;" ^
  "$lnk.Description = 'SMR Research Assistant - local service';" ^
  "$lnk.Save();" ^
  "Write-Output 'desktop-ok'"
if %errorlevel%==0 (
  echo   Desktop shortcut created: SMR Research Assistant
) else (
  echo   [WARN] Shortcut creation failed. You can run install.bat again.
)

REM ---------- 3. First launch ----------
echo [3/3] Starting service and opening browser ...
start "" /b wscript.exe "%SMR_DIR%\start-silent.vbs"
echo.
echo ============================================================
echo    Setup complete!
echo    - Service is running in the background
echo    - Browser will open http://127.0.0.1:39010
echo    - First visit: fill in TEXT model + VISION model (and
echo      optional Bilibili Cookie) in the setup window
echo    - Later: double-click "SMR Research Assistant" on desktop
echo ============================================================
echo.
timeout /t 8 >nul
exit /b 0
