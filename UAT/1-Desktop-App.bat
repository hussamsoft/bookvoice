@echo off

rem UAT 1/4 - Desktop app (native window via pywebview).

rem Closest to the shipped product. Requires WebView2 on Windows.

rem Runs the source checkout through dev_launcher.py: launch.py is the packaged

rem launcher and refuses to start without dist/runtime/worker/python.exe.

setlocal

call "%~dp0_env.bat"

if errorlevel 1 goto :end

cd /d "%BV_ROOT%"

"%BV_PY%" dev_launcher.py %*

:end

pause

endlocal

