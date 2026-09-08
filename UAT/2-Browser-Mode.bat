@echo off

rem UAT 2/4 - Browser mode (default browser, same backend).

rem Use when WebView2 is missing, or to test with devtools open (F12).

setlocal

call "%~dp0_env.bat"

if errorlevel 1 goto :end

cd /d "%BV_ROOT%"

"%BV_PY%" dev_launcher.py --browser %*

:end

pause

endlocal

