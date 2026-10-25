@echo off
setlocal
title Building SingLine Studio
cd /d "%~dp0"

echo.
echo  SingLine Studio - building the Windows installer
echo  ================================================
echo.

where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 (
    echo  Python is not installed.
    echo  Install Python 3.12 from https://www.python.org/downloads/windows/
    echo  and tick "Add python.exe to PATH" during setup. Then run this again.
    echo.
    pause
    exit /b 1
  )
)
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

echo  This downloads about 2 GB and takes 20 to 40 minutes.
echo  Keep this window open. Progress is written to build-log.txt.
echo  Started %date% %time%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1" > "%~dp0build-log.txt" 2>&1
set RC=%errorlevel%

echo  Finished %date% %time%
echo.
powershell -NoProfile -Command "Get-Content -Tail 6 '%~dp0build-log.txt'"
echo.
if "%RC%"=="0" (
  echo  Done. Your installer is in the "release" folder.
  start "" explorer "%~dp0release"
) else (
  echo  The build stopped with an error. See build-log.txt for details.
)
echo.
pause
