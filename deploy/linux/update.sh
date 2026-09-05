#!/usr/bin/env bash
# Roll a new backend release into an existing BookVoice Linux install.
#
# Copies the backend tree from a checkout (or a staged tarball) into
# <install>/releases/<timestamp>/, refreshes the venv from the new
# requirements, flips the `backend` symlink, restarts the systemd unit and
# smoke-checks /api/health. If the health check fails, it flips back to the
# previous release and restarts again.
#
# Rollback by hand:
#   sudo ln -sfn <install>/releases/<previous> <install>/backend
#   sudo systemctl restart bookvoice        # or: systemctl --user restart bookvoice
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="${BOOKVOICE_INSTALL_DIR:-}"
DO_RESTART=1
DO_SMOKE=1

warn() { echo "warning: $*" >&2; }
fail() { echo "error: $*" >&2; exit 1; }
step() { echo "[update] $*"; }

usage() {
  cat <<EOF
usage: update.sh [options]

  --source DIR     BookVoice checkout with the new backend tree
                   (default: the checkout this script lives in)
  --dir DIR        install root (default: \$BOOKVOICE_INSTALL_DIR, then
                   /opt/bookvoice, then \$HOME/bookvoice — first with backend/)
  --no-restart     copy the new release in but do not restart the unit
  --no-smoke       skip the /api/health check after restart (and auto-rollback)
  -h, --help       show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    --no-smoke) DO_SMOKE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option '$1'" ;;
  esac
done

if [ -z "$INSTALL_DIR" ]; then
  for candidate in /opt/bookvoice "$HOME/bookvoice"; do
    if [ -e "$candidate/backend/main.py" ]; then INSTALL_DIR="$candidate"; break; fi
  done
fi
[ -n "$INSTALL_DIR" ] || fail "no BookVoice install found (looked in /opt/bookvoice and \$HOME/bookvoice) — pass --dir"
[ -e "$INSTALL_DIR/backend/main.py" ] || fail "$INSTALL_DIR/backend is not a BookVoice install"
[ -f "$SOURCE/backend/main.py" ] || fail "backend/main.py not found under $SOURCE — pass --source"
ENV_FILE="$INSTALL_DIR/etc/bookvoice.env"
[ -f "$ENV_FILE" ] || warn "no env file at $ENV_FILE — the unit will fail unless EnvironmentFile points elsewhere"
VENV_PY="$INSTALL_DIR/venv/bin/python"
[ -x "$VENV_PY" ] || fail "venv python missing at $VENV_PY — run deploy/linux/install.sh first"

# Write prefix for release-dir operations (root, or sudo when needed).
if [ "$(id -u)" -eq 0 ] || [ -w "$INSTALL_DIR" ]; then
  W=""
elif command -v sudo >/dev/null 2>&1; then
  W="sudo"
else
  fail "$INSTALL_DIR is not writable and sudo is unavailable — re-run with sudo"
fi

# --- restart command ----------------------------------------------------------
if [ -f /etc/systemd/system/bookvoice.service ]; then
  if [ "$(id -u)" -eq 0 ]; then RESTART_CMD="systemctl restart bookvoice"
  elif command -v sudo >/dev/null 2>&1; then RESTART_CMD="sudo systemctl restart bookvoice"
  else RESTART_CMD=""; warn "no root/sudo — cannot restart the system unit; restart it yourself"
  fi
elif [ -f "$HOME/.config/systemd/user/bookvoice.service" ]; then
  RESTART_CMD="systemctl --user restart bookvoice"
else
  RESTART_CMD=""
  warn "no bookvoice systemd unit found — restart the server manually"
fi

# --- new release ---------------------------------------------------------------
RELEASES_DIR="$INSTALL_DIR/releases"
RELEASE_DIR="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
[ -d "$RELEASE_DIR" ] && RELEASE_DIR="${RELEASE_DIR}-$$"
PREVIOUS="$(readlink -f "$INSTALL_DIR/backend")"
step "previous release: $PREVIOUS"

step "copying backend tree from $SOURCE/backend -> $RELEASE_DIR"
$W mkdir -p "$RELEASE_DIR/data"
if command -v rsync >/dev/null 2>&1; then
  $W rsync -a \
    --exclude '__pycache__/' --exclude '*.pyc' \
    "$SOURCE/backend/main.py" "$SOURCE/backend/routes" "$SOURCE/backend/services" \
    "$SOURCE/backend/static" "$SOURCE/backend/requirements.txt" \
    "$SOURCE/backend/requirements-ci.txt" "$RELEASE_DIR/"
  $W rsync -a --exclude '__pycache__/' --exclude '*.pyc' \
    "$SOURCE/backend/data/default_voices" "$RELEASE_DIR/data/default_voices"
else
  $W cp -R "$SOURCE/backend/main.py" "$SOURCE/backend/routes" "$SOURCE/backend/services" \
    "$SOURCE/backend/static" "$RELEASE_DIR/"
  $W cp -R "$SOURCE/backend/data/default_voices" "$RELEASE_DIR/data/default_voices"
  $W cp -f "$SOURCE/backend/requirements.txt" "$SOURCE/backend/requirements-ci.txt" "$RELEASE_DIR/"
  $W find "$RELEASE_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
fi

# --- venv refresh (profile detected from the installed torch build) ------------
CUDA_PROFILE=0
if "$VENV_PY" - <<'PY' 2>/dev/null
import sys, torch
sys.exit(0 if getattr(torch.version, "cuda", None) else 1)
PY
then CUDA_PROFILE=1; fi
step "refreshing venv deps ($([ "$CUDA_PROFILE" -eq 1 ] && echo "CUDA (requirements.txt + torch 2.5.1+cu121)" || echo "CPU (requirements-ci.txt)"))"
$W "$VENV_PY" -m pip install --upgrade pip >/dev/null
if [ "$CUDA_PROFILE" -eq 1 ]; then
  $W "$VENV_PY" -m pip install -r "$RELEASE_DIR/requirements.txt"
  $W "$VENV_PY" -m pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121
else
  $W "$VENV_PY" -m pip install -r "$RELEASE_DIR/requirements-ci.txt"
fi

# --- flip + restart -------------------------------------------------------------
if [ "$DO_RESTART" -eq 1 ] && [ -n "$RESTART_CMD" ]; then
  step "flipping backend symlink -> $RELEASE_DIR and restarting"
  $W ln -sfn "$RELEASE_DIR" "$INSTALL_DIR/backend"
  if ! $RESTART_CMD; then
    warn "restart failed — flipping back to $PREVIOUS"
    $W ln -sfn "$PREVIOUS" "$INSTALL_DIR/backend"
    $RESTART_CMD || true
    fail "update aborted; previous release is live again"
  fi
else
  step "flip the symlink and restart to activate: ln -sfn $RELEASE_DIR $INSTALL_DIR/backend && $RESTART_CMD"
fi

# --- smoke check with auto-rollback ---------------------------------------------
if [ "$DO_RESTART" -eq 1 ] && [ -n "$RESTART_CMD" ] && [ "$DO_SMOKE" -eq 1 ]; then
  PORT="$(sed -n 's/^BOOKVOICE_PORT=//p' "$ENV_FILE" | tail -n1 | tr -d '\"')"
  PORT="${PORT:-8000}"
  step "smoke check: http://127.0.0.1:$PORT/api/health"
  smoke_ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"status"'; then
      smoke_ok=1; break
    fi
    sleep 3
  done
  if [ "$smoke_ok" -ne 1 ]; then
    warn "health check failed after update — rolling back to $PREVIOUS"
    $W ln -sfn "$PREVIOUS" "$INSTALL_DIR/backend"
    $RESTART_CMD || true
    fail "update rolled back. Check logs: journalctl -u bookvoice -e --no-pager | tail -50"
  fi
  step "smoke check passed"
fi

# --- prune old releases (keep the 5 newest) --------------------------------------
mapfile -t all_releases < <(ls -1d "$RELEASES_DIR"/*/ 2>/dev/null | sort)
if [ "${#all_releases[@]}" -gt 5 ]; then
  for old in "${all_releases[@]:0:${#all_releases[@]}-5}"; do
    case "$(readlink -f "$INSTALL_DIR/backend")" in
      "${old%/}") continue ;;  # never delete the live release
    esac
    step "pruning old release $old"
    $W rm -rf "$old"
  done
fi

step "done. Current release: $(readlink -f "$INSTALL_DIR/backend")"
step "manual rollback: sudo ln -sfn <previous-release-dir> $INSTALL_DIR/backend && $RESTART_CMD"
