@echo off
rem UAT 3b — Phone-size desktop window (390x844) for testing the mobile
rem layout on this PC. No phone needed; touch via mouse, resize freely.
setlocal
cd /d "%~dp0.."
python launch.py --phone-view %*
pause
