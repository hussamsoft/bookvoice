@echo off
setlocal EnableExtensions

REM Build the full BookVoice release: frontend, dist/ payload, Launcher.exe,
REM and both MSI installers (BookVoice.msi + BookVoice-User.msi).
REM Run from the repo root, or just double-click this file.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: python not found on PATH.
  pause & exit /b 1
)

echo Building BookVoice dist/ and MSI installers...
python build.py --msi --per-user
if errorlevel 1 (
  echo.
  echo Build FAILED. See output above.
  pause & exit /b 1
)

echo.
echo Done. Installers are in installer\BookVoice.msi and installer\BookVoice-User.msi
pause
exit /b 0
