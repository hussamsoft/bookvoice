@echo off
rem UAT 4/4 — Backend only, no UI shell.
rem For API testing (curl, Postman) and log watching. Health: /api/health.
setlocal
cd /d "%~dp0.."
python launch.py --no-window %*
pause
