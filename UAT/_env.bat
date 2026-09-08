@echo off
rem Shared UAT environment. Called by every numbered launcher; not run directly.
rem
rem Sets:
rem   BV_ROOT              repo root
rem   BV_VENV              backend venv interpreter, or empty if it is missing
rem   BOOKVOICE_DEV_PYTHON interpreter the backend runs on (the venv: CUDA torch
rem                        + chatterbox live there, so narration is real)
rem   BV_PY                interpreter the launcher shell runs on (needs
rem                        pywebview for a native window; PATH python has it)

for %%I in ("%~dp0..") do set "BV_ROOT=%%~fI"

set "BV_VENV=%BV_ROOT%\backend\.venv\Scripts\python.exe"
if exist "%BV_VENV%" (
  set "BOOKVOICE_DEV_PYTHON=%BV_VENV%"
) else (
  set "BV_VENV="
  echo [UAT] backend\.venv not found - falling back to PATH python for the
  echo [UAT] backend. Narration needs the venv: python -m venv backend\.venv
  echo [UAT] then pip install -r backend\requirements.txt
  echo.
)

where python >nul 2>&1
if errorlevel 1 (
  echo [UAT] "python" is not on PATH. Install Python 3.10+ ^(or open a shell
  echo [UAT] where python resolves^) and run this again.
  exit /b 1
)
set "BV_PY=python"
exit /b 0
