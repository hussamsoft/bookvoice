#!/usr/bin/env bash
# BookVoice Linux bootstrap: venv + CPU dependencies (+ optional GPU wheels)
# and a frontend bundle if Node is available. Idempotent — safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO_ROOT/.venv-linux"

GPU=0
for arg in "$@"; do
  case "$arg" in
    --gpu) GPU=1 ;;
    -h|--help)
      echo "usage: scripts/setup_linux.sh [--gpu]"
      echo "  --gpu  install backend/requirements.txt plus CUDA torch/torchaudio"
      echo "         instead of the CPU-only requirements-ci.txt profile"
      exit 0
      ;;
    *)
      echo "error: unknown option '$arg'" >&2
      exit 2
      ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------
command -v python3 >/dev/null 2>&1 || fail "python3 not found. Install Python 3.11+ (e.g. sudo apt install python3 python3-venv python3-pip)."
PYVER="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PYMAJ="$(python3 -c 'import sys; print(sys.version_info[0])')"
PYMIN="$(python3 -c 'import sys; print(sys.version_info[1])')"
if [ "$PYMAJ" -lt 3 ] || { [ "$PYMAJ" -eq 3 ] && [ "$PYMIN" -lt 11 ]; }; then
  fail "Python $PYVER is too old; BookVoice needs 3.11+."
fi
echo "[setup] python3 $PYVER ok"

command -v ffmpeg >/dev/null 2>&1 || echo "warning: ffmpeg not on PATH. Install it: sudo apt install ffmpeg" >&2

command -v node >/dev/null 2>&1 && NODE_VER="$(node --version)" || NODE_VER=""

# --- venv + python deps ----------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  echo "[setup] creating virtualenv at $VENV"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install --upgrade pip >/dev/null

REQ="$REPO_ROOT/backend/requirements-ci.txt"
if [ "$GPU" -eq 1 ]; then
  REQ="$REPO_ROOT/backend/requirements.txt"
fi
echo "[setup] installing $(basename "$REQ") (this downloads torch; may take a while)"
pip install -r "$REQ"
if [ "$GPU" -eq 1 ]; then
  # Exact command prescribed by the comment in backend/requirements.txt.
  pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121
fi

# --- frontend bundle -------------------------------------------------------
STATIC="$REPO_ROOT/backend/static"
if command -v node >/dev/null 2>&1 && [ ! -f "$STATIC/index.html" ]; then
  echo "[setup] building frontend bundle with node $NODE_VER"
  (cd "$REPO_ROOT/frontend" && npm ci && npm run build)
  mkdir -p "$STATIC"
  cp -r "$REPO_ROOT/frontend/dist/." "$STATIC/"
elif [ -f "$STATIC/index.html" ]; then
  echo "[setup] backend/static already has a bundle; skipping build (delete it to force a rebuild)"
else
  echo "warning: node not found and no existing bundle in backend/static;" \
       "the UI will be unavailable until you install Node 20 and run:" >&2
  echo "         cd frontend && npm ci && npm run build && cp -r dist/* ../backend/static/" >&2
fi

# --- next steps -------------------------------------------------------------
cat <<EOF

[setup] done. Next steps:

  source "$VENV/bin/activate"
  export DATA_DIR=/var/lib/bookvoice        # or any writable absolute path
  export MODEL_DIR=\$DATA_DIR/models
  export BOOKVOICE_SERVER_MODE=1
  export BOOKVOICE_ACCESS_PASSWORD='<a long password>'
  cd "$REPO_ROOT/backend"
  python -m uvicorn main:app --host 127.0.0.1 --port 8000

Then verify: curl http://127.0.0.1:8000/api/health   # {"status":"ready"}

See deploy/linux.md for model weights, systemd, and TLS notes.
EOF
