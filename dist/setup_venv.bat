@echo off
setlocal EnableDelayedExpansion

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

REM --- CRITICAL: chatterbox pulls a CPU-only torch by default.
REM Without a CUDA wheel, TTS runs at ~5-10 tok/s and a PDF page can take many minutes.
echo.
echo Checking for NVIDIA GPU / installing CUDA PyTorch if needed...
call :install_cuda_torch
if errorlevel 1 (
    echo WARNING: CUDA torch install skipped or failed. TTS will use CPU ^(very slow^).
)

echo.
echo Verifying torch device...
python -c "import torch; print('torch', torch.__version__); print('cuda_available', torch.cuda.is_available()); print('device', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"

echo BookVoice environment ready.
endlocal
exit /b 0

:install_cuda_torch
REM Detect NVIDIA via nvidia-smi
where nvidia-smi >nul 2>nul
if errorlevel 1 (
    echo No nvidia-smi on PATH — leaving CPU torch in place.
    exit /b 1
)
nvidia-smi -L >nul 2>nul
if errorlevel 1 (
    echo nvidia-smi found but no GPU reported — leaving CPU torch.
    exit /b 1
)

echo NVIDIA GPU detected. Installing CUDA build of torch + torchaudio...
REM Prefer cu124 wheels which work with modern Game Ready drivers (incl. RTX 40 series).
if "%VENV_PY%"=="uv" (
    uv pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
) else (
    python -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
)
if errorlevel 1 (
    echo cu124 install failed — trying cu121...
    if "%VENV_PY%"=="uv" (
        uv pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu121
    ) else (
        python -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu121
    )
)
if errorlevel 1 (
    exit /b 1
)

python -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"
if errorlevel 1 (
    echo Installed torch still reports cuda_available=False.
    exit /b 1
)
echo CUDA torch is working.
exit /b 0
