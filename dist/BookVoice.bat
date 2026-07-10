@echo off
setlocal EnableExtensions

REM ============================================================
REM  BookVoice portable entry (reliable — no PyInstaller).
REM  Double-click this from the dist/ folder.
REM ============================================================

cd /d "%~dp0"
set "APP_DIR=%CD%"

if not exist "%APP_DIR%\main.py" (
  echo ERROR: main.py not found in "%APP_DIR%"
  pause & exit /b 1
)
if not exist "%APP_DIR%\static\index.html" (
  echo ERROR: static\index.html missing. Rebuild with: python build.py
  pause & exit /b 1
)
if not exist "%APP_DIR%\data\models\en\tokenizer.json" (
  echo ERROR: models missing under data\models\en\
  pause & exit /b 1
)

if /i "%BOOKVOICE_PORTABLE%"=="1" (
  set "RUNTIME=%APP_DIR%\.bookvoice"
) else (
  set "RUNTIME=%LOCALAPPDATA%\BookVoice"
)
mkdir "%RUNTIME%" 2>nul
mkdir "%RUNTIME%\data" 2>nul
mkdir "%RUNTIME%\data\voices" 2>nul
mkdir "%RUNTIME%\data\sessions" 2>nul

set "DATA_DIR=%RUNTIME%\data"
set "DEFAULT_VOICES_DIR=%APP_DIR%\data\default_voices"
set "MODEL_DIR=%APP_DIR%\data\models"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONNOUSERSITE=1"

REM Seed voices
if exist "%DEFAULT_VOICES_DIR%\" (
  xcopy /Y /Q /D "%DEFAULT_VOICES_DIR%\*.wav" "%DATA_DIR%\voices\" >nul 2>nul
)

set "VENV_PY=%RUNTIME%\.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
  echo First-time setup in "%RUNTIME%" ...
  copy /Y "%APP_DIR%\requirements.txt" "%RUNTIME%\requirements.txt" >nul
  copy /Y "%APP_DIR%\setup_venv.bat" "%RUNTIME%\setup_venv.bat" >nul
  if exist "%APP_DIR%\fix_cuda_torch.bat" copy /Y "%APP_DIR%\fix_cuda_torch.bat" "%RUNTIME%\fix_cuda_torch.bat" >nul
  pushd "%RUNTIME%"
  call setup_venv.bat
  popd
)

if not exist "%VENV_PY%" (
  echo ERROR: venv not created. See "%RUNTIME%\bookvoice_setup.log"
  pause & exit /b 1
)

where nvidia-smi >nul 2>nul
if not errorlevel 1 (
  "%VENV_PY%" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)" 2>nul
  if errorlevel 1 (
    echo Enabling CUDA PyTorch...
    if exist "%APP_DIR%\fix_cuda_torch.bat" call "%APP_DIR%\fix_cuda_torch.bat" "%VENV_PY%"
  )
)

REM Stop previous BookVoice servers and their full process tree (never other apps on the port).
REM The venv python.exe is a shim; the real uvicorn child may not contain the venv path.
if exist "%APP_DIR%\scripts\kill_stale_bookvoice.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\kill_stale_bookvoice.ps1" -RuntimeDir "%RUNTIME%" >nul 2>nul
) else (
  echo WARNING: scripts\kill_stale_bookvoice.ps1 missing — stale server cleanup skipped.
)

REM Give Windows / the GPU driver a moment to release port 8000 and VRAM.
timeout /t 2 /nobreak >nul

echo Starting server...
echo   APP_DIR=%APP_DIR%
echo   DATA_DIR=%DATA_DIR%
echo   MODEL_DIR=%MODEL_DIR%

REM Write a tiny runner so spaces in paths never break quoting
set "RUNNER=%RUNTIME%\run_server.cmd"
(
  echo @echo off
  echo set "DATA_DIR=%DATA_DIR%"
  echo set "DEFAULT_VOICES_DIR=%DEFAULT_VOICES_DIR%"
  echo set "MODEL_DIR=%MODEL_DIR%"
  echo set "APP_DIR=%APP_DIR%"
  echo set "PYTHONUTF8=1"
  echo set "PYTHONIOENCODING=utf-8"
  echo set "PYTHONNOUSERSITE=1"
  echo cd /d "%APP_DIR%"
  echo "%VENV_PY%" -m uvicorn main:app --host 127.0.0.1 --port 8000
) > "%RUNNER%"

start "BookVoice Server" /MIN cmd /c "\"%RUNNER%\" > \"%RUNTIME%\bookvoice_server.log\" 2>&1"

echo Waiting for backend...
set /a _n=0
:waitloop
timeout /t 1 /nobreak >nul
set /a _n+=1
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/tts/status -TimeoutSec 1; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto ready
if %_n% GEQ 180 (
  echo ERROR: server not ready after 180s
  echo Log: %RUNTIME%\bookvoice_server.log
  type "%RUNTIME%\bookvoice_server.log" 2>nul
  pause & exit /b 1
)
goto waitloop

:ready
echo Ready. Opening http://127.0.0.1:8000
start "" "http://127.0.0.1:8000"
echo.
echo Leave the minimized "BookVoice Server" window running while you use the app.
echo Close that server window to stop BookVoice.
pause
endlocal
