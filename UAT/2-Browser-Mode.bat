@echo off
rem UAT 2/4 — Browser mode (default browser, same backend).
rem Use when WebView2 is missing, or to test with devtools open (F12).
setlocal
cd /d "%~dp0.."
python launch.py --browser %*
pause
