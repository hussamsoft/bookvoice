@echo off
setlocal

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python 3 is required to package BookVoice.
    exit /b 1
)

python build.py --msi --per-user
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo MSI packaging failed with exit code %EXITCODE%.
    exit /b %EXITCODE%
)

echo.
echo MSI packages are available in "%CD%\installer":
echo   BookVoice.msi       ^(machine-wide, administrator install^)
echo   BookVoice-User.msi  ^(per-user, no administrator required^)
exit /b 0
