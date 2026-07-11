@echo off
setlocal EnableExtensions

REM BookVoice browser launcher — delegates to launch.py (shared logic).
cd /d "%~dp0"
set "APP_DIR=%CD%"

if not exist "%APP_DIR%\launch.py" (
  echo ERROR: launch.py not found in "%APP_DIR%"
  pause & exit /b 1
)

set "PY=%APP_DIR%\runtime\python\python.exe"
if exist "%PY%" (
  "%PY%" "%APP_DIR%\launch.py" --browser
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: bundled Python missing and no system python on PATH.
  echo Reinstall BookVoice or rebuild with: python build.py
  pause & exit /b 1
)

python "%APP_DIR%\launch.py" --browser
exit /b %ERRORLEVEL%
