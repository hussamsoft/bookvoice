@echo off

rem UAT 3b - Phone-size desktop window (390x844) for testing the mobile

rem layout on this PC. No phone needed; touch via mouse, resize freely.

setlocal

call "%~dp0_env.bat"

if errorlevel 1 goto :end

cd /d "%BV_ROOT%"

"%BV_PY%" dev_launcher.py --phone-view %*

:end

pause

endlocal

