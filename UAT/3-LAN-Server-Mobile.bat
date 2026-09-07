@echo off
rem UAT 3/4 — LAN server for phone/tablet testing (touch interface).
rem Prints the http://192.168.x.x:PORT to open on the mobile browser.
rem Requires --allow-lan by design; see deploy/README.md#lan.
setlocal
cd /d "%~dp0.."
python serve_bookvoice.py --host lan --allow-lan %*
pause
