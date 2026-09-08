@echo off

rem UAT 4/4 - Backend only, no UI shell.

rem For API testing (curl, Postman) and log watching. Health: /api/health.

rem The chosen port is printed to this console and to bookvoice_launch.log.

setlocal

call "%~dp0_env.bat"

if errorlevel 1 goto :end

cd /d "%BV_ROOT%"

"%BV_PY%" dev_launcher.py --no-window %*

:end

pause

endlocal

