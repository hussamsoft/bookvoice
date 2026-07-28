@echo off
setlocal EnableExtensions

REM Double-click launcher for a Narrator source checkout.
REM The packaged desktop executable is the supported runtime entry point.
cd /d "%~dp0"

set "BOOKVOICE_EXE=%CD%\dist\Launcher.exe"
if not exist "%BOOKVOICE_EXE%" (
  echo ERROR: The packaged BookVoice app has not been built.
  echo.
  echo Run this from a terminal first:
  echo   python build.py
  echo.
  pause
  exit /b 1
)

start "BookVoice" /D "%CD%\dist" "%BOOKVOICE_EXE%" %*
if errorlevel 1 (
  echo ERROR: BookVoice could not be started.
  pause
  exit /b 1
)

exit /b 0
