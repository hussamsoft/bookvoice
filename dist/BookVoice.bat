@echo off
setlocal EnableExtensions

REM BookVoice browser launcher — delegates to launch.py (shared logic).
cd /d "%~dp0"
set "APP_DIR=%CD%"

if not exist "%APP_DIR%\launch.py" (
  echo ERROR: launch.py not found in "%APP_DIR%"
  pause & exit /b 1
)

set "PY=%APP_DIR%\runtime\worker\python.exe"
if exist "%PY%" (
  "%PY%" "%APP_DIR%\launch.py" --browser
  exit /b %ERRORLEVEL%
)

echo ERROR: packaged BookVoice worker missing.
echo Reinstall BookVoice or rebuild with: python build.py
pause & exit /b 1
