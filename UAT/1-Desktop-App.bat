@echo off
rem UAT 1/4 — Desktop app (native window via pywebview).
rem Closest to the shipped product. Requires WebView2 on Windows.
setlocal
cd /d "%~dp0.."
python launch.py %*
pause
