@echo off
rem BookVoice server launcher — serves BookVoice to phones/tablets on this
rem network while the desktop app stays closed. Keep the window open; the
rem server stops when you close it or press Ctrl+C.
setlocal
cd /d "%~dp0"

set "PYTHON=%~dp0runtime\worker\python.exe"
if exist "%PYTHON%" goto run

where python >nul 2>nul
if errorlevel 1 (
  echo BookVoice runtime is missing: %PYTHON%
  echo Rebuild it from a full checkout with: python build.py
  pause
  exit /b 1
)
set "PYTHON=python"

:run
"%PYTHON%" "%~dp0serve_bookvoice.py" --host lan %*
echo.
echo BookVoice server stopped.
pause
exit /b %errorlevel%
