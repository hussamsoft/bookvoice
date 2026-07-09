@echo off
REM Fix an existing BookVoice venv that has CPU-only PyTorch.
REM Run from the folder that contains .venv (e.g. %%LocalAppData%%\BookVoice)
REM or pass the venv python path as arg1.

setlocal
set PY=%~1
if "%PY%"=="" (
  if exist .venv\Scripts\python.exe (
    set PY=.venv\Scripts\python.exe
  ) else if exist "%LOCALAPPDATA%\BookVoice\.venv\Scripts\python.exe" (
    set PY=%LOCALAPPDATA%\BookVoice\.venv\Scripts\python.exe
  ) else (
    echo Could not find BookVoice .venv. Run from the data dir or pass python.exe path.
    exit /b 1
  )
)

echo Using: %PY%
"%PY%" -c "import torch; print('BEFORE', torch.__version__, 'cuda=', torch.cuda.is_available())"

echo Installing CUDA torch (cu124)...
"%PY%" -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
if errorlevel 1 (
  echo cu124 failed, trying cu121...
  "%PY%" -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu121
)

"%PY%" -c "import torch; print('AFTER', torch.__version__, 'cuda=', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
if errorlevel 1 exit /b 1

"%PY%" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)"
if errorlevel 1 (
  echo Still no CUDA. Check NVIDIA drivers and that this is a 64-bit Python.
  exit /b 1
)

echo.
echo SUCCESS. Restart BookVoice so it reloads the model on GPU.
endlocal
