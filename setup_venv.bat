@echo off
setlocal

if not exist requirements.txt (
    echo requirements.txt not found in %CD%
    exit /b 1
)

set VENV_PY=
where uv >nul 2>nul
if not errorlevel 1 set VENV_PY=uv
if not defined VENV_PY (
    where python >nul 2>nul
    if not errorlevel 1 set VENV_PY=python
)
if not defined VENV_PY (
    echo ERROR: neither uv nor python was found on PATH. Install Python 3.10+ and try again.
    exit /b 1
)

if exist .venv (
    echo Virtual environment already exists.
    goto :install
)

if "%VENV_PY%"=="uv" (
    echo Creating virtual environment with uv - Python 3.10
    uv venv --python 3.10 .venv
) else (
    echo Creating virtual environment with python -m venv...
    python -m venv .venv
)
if errorlevel 1 (
    echo Failed to create virtual environment.
    exit /b 1
)

:install
echo Installing dependencies - this may take several minutes on first run
call .venv\Scripts\activate.bat
if "%VENV_PY%"=="uv" (
    uv pip install -r requirements.txt
) else (
    python -m pip install --upgrade pip
    pip install -r requirements.txt
)
if errorlevel 1 (
    echo Dependency installation failed. See output above.
    exit /b 1
)

echo BookVoice environment ready.
endlocal
