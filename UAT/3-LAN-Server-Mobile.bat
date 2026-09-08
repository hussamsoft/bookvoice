@echo off

rem UAT 3/4 - LAN server for phone/tablet testing (touch interface).

rem Prints the http://192.168.x.x:PORT to open on the mobile browser.

rem Requires --allow-lan by design; see deploy/README.md#lan.

rem Runs on the backend venv directly: serve_bookvoice.py starts the backend

rem with the interpreter that runs it.

setlocal

call "%~dp0_env.bat"

if errorlevel 1 goto :end

cd /d "%BV_ROOT%"

set "BV_SERVER_PY=%BV_VENV%"

if not defined BV_SERVER_PY set "BV_SERVER_PY=python"

"%BV_SERVER_PY%" serve_bookvoice.py --host lan --allow-lan %*

:end

pause

endlocal

