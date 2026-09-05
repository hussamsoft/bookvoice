#!/usr/bin/env bash
# BookVoice Linux server installer.
#
# Installs a self-contained server layout from a BookVoice checkout:
#   - system packages (python3-venv, python3-dev, ffmpeg, OpenCV libs)
#   - /opt/bookvoice (root) or $HOME/bookvoice (user) with a backend release
#     tree under releases/<timestamp> and a `backend` symlink pointing at it
#   - a Python venv built from backend/requirements-ci.txt (CPU) or
#     requirements.txt + CUDA torch (--cuda / --gpu)
#   - an env file at <install>/etc/bookvoice.env (kept if it already exists)
#   - a hardened systemd unit (system or user, see --system-unit/--user-unit)
#   - a smoke check against GET /api/health
#
# Idempotent: safe to re-run. Existing env files are never overwritten.
# Updates: use deploy/linux/update.sh (same release layout, keeps rollback).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$SCRIPT_DIR/../.." && pwd)"

INSTALL_DIR=""
DATA_DIR=""
MODELS_SRC=""
PASSWORD=""
BIND_HOST="0.0.0.0"
PORT="8000"
UNIT_MODE=""          # system | user (default: system as root, user otherwise)
CUDA=0
DO_APT=1
DO_SERVICE=1
SVC_USER="bookvoice"

warn() { echo "warning: $*" >&2; }
fail() { echo "error: $*" >&2; exit 1; }
step() { echo "[install] $*"; }

usage() {
  cat <<EOF
usage: install.sh [options]

  --dir DIR          install root (default: /opt/bookvoice as root, else \$HOME/bookvoice)
  --data-dir DIR     data root for sessions/voices/models (default: <install>/data)
  --user NAME        service account for a system unit (default: dedicated 'bookvoice' user)
  --system-unit      install a system-wide systemd unit (default when root)
  --user-unit        install a systemd user unit for the current user (default when not root)
  --cuda             CUDA torch/torchaudio wheels (alias: --gpu); default is the CPU profile
  --host ADDR        bind address written to the env file (default: 0.0.0.0)
  --port PORT        port written to the env file (default: 8000)
  --password PW      access password to write into the env file
                     (default: a random one, printed once at the end)
  --models-src DIR   existing English TTS weights dir to copy (default: auto-detect
                     <source>/backend/data/models/en)
  --source DIR       BookVoice checkout to install from (default: the checkout this
                     script lives in)
  --no-apt           skip system package installation
  --no-service       install files only; skip the systemd unit
  -h, --help         show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    --system-unit) UNIT_MODE="system"; shift ;;
    --user-unit) UNIT_MODE="user"; shift ;;
    --cuda|--gpu) CUDA=1; shift ;;
    --host) BIND_HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --models-src) MODELS_SRC="$2"; shift 2 ;;
    --source) SOURCE="$(cd "$2" && pwd)"; shift 2 ;;
    --no-apt) DO_APT=0; shift ;;
    --no-service) DO_SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option '$1'" ;;
  esac
done

# --- privileges -------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  CAN_ROOT=1
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
  CAN_ROOT=1
else
  SUDO=""
  CAN_ROOT=0
fi

[ -f "$SOURCE/backend/main.py" ] || fail "backend/main.py not found under $SOURCE — pass --source"

# --- defaults per mode ------------------------------------------------------
if [ -z "$UNIT_MODE" ]; then
  if [ "$(id -u)" -eq 0 ]; then UNIT_MODE="system"; else UNIT_MODE="user"; fi
fi
if [ -z "$INSTALL_DIR" ]; then
  if [ "$UNIT_MODE" = "system" ]; then INSTALL_DIR="/opt/bookvoice"; else INSTALL_DIR="$HOME/bookvoice"; fi
fi
if [ -z "$DATA_DIR" ]; then DATA_DIR="$INSTALL_DIR/data"; fi
MODEL_DIR="$DATA_DIR/models"
VOICE_DATA_DIR="$DATA_DIR/voices"
DEFAULT_VOICES_DIR="$INSTALL_DIR/backend/data/default_voices"
VENV_DIR="$INSTALL_DIR/venv"
ENV_FILE="$INSTALL_DIR/etc/bookvoice.env"
VENV_PY="$VENV_DIR/bin/python"
APP_DIR="$INSTALL_DIR/backend"
if [ "$UNIT_MODE" = "system" ] && [ "$CAN_ROOT" -ne 1 ]; then
  fail "--system-unit needs root (re-run with sudo) or use --user-unit"
fi
# Write prefix: system installs live outside $HOME and go through sudo; user
# installs live under $HOME and must NOT (sudo would leave root-owned files).
if [ "$UNIT_MODE" = "system" ]; then W="$SUDO"; else W=""; fi

# --- distro check -----------------------------------------------------------
version_ge() { [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

check_distro() {
  if [ ! -r /etc/os-release ]; then
    warn "cannot read /etc/os-release; assuming a generic systemd distro and continuing"
    return
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  local id_like="${ID_LIKE:-}"
  case "${ID:-unknown}" in
    ubuntu) version_ge "${VERSION_ID:-0}" "22.04" || fail "Ubuntu ${VERSION_ID:-?} is too old; need 22.04+" ;;
    debian) version_ge "${VERSION_ID:-0}" "12" || fail "Debian ${VERSION_ID:-?} is too old; need 12+" ;;
    *)
      if command -v systemctl >/dev/null 2>&1; then
        warn "untested distro '${PRETTY_NAME:-$ID}' — proceeding; needs systemd, Python 3.11+, ffmpeg"
      else
        fail "'$ID' has no systemd and no apt support in this installer"
      fi
      return
      ;;
  esac
  # Derivatives that look like ubuntu/debian get the same baseline, loosely.
  if [ -n "$id_like" ] && [[ "$id_like" == *debian* || "$id_like" == *ubuntu* ]]; then
    warn "derivative distro '${PRETTY_NAME:-$ID}'; package names may differ from the ubuntu/debian baseline"
  fi
}
check_distro
command -v systemctl >/dev/null 2>&1 || warn "systemd not found; unit installation will be skipped"

# --- system packages --------------------------------------------------------
if [ "$DO_APT" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1 && [ "$CAN_ROOT" -eq 1 ]; then
    step "installing system packages via apt (python3-venv, python3-dev, ffmpeg, OpenCV libs)"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -y
    PKGS=(python3 python3-venv python3-dev ffmpeg libgl1 libglib2.0-0 curl rsync)
    if ! $SUDO apt-get install -y "${PKGS[@]}"; then
      # Ubuntu 24.04 renamed libglib2.0-0 to libglib2.0-0t64.
      step "retrying apt install with t64 package names (Ubuntu 24.04)"
      $SUDO apt-get install -y "${PKGS[@]/libglib2.0-0/libglib2.0-0t64}"
    fi
  else
    warn "apt unavailable (no root?) — skipping package installation; ensure python3(3.11+), python3-venv, python3-dev, ffmpeg, libgl1, libglib2.0-0, curl are installed"
  fi
fi

command -v python3 >/dev/null 2>&1 || fail "python3 not found. Install Python 3.11+ and python3-venv."
PYVER="$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python $PYVER is too old; BookVoice needs 3.11+."
step "python3 $PYVER ok"
command -v ffmpeg >/dev/null 2>&1 || warn "ffmpeg not on PATH — install it (sudo apt install ffmpeg); audio conversion will fail without it"

# --- service account (system unit only) -------------------------------------
SVC_GROUP="$SVC_USER"
SERVICE_USER_LINES="# (user unit: runs as the invoking user)"
SERVICE_GROUP_LINES="# (user unit: runs as the invoking user)"
if [ "$UNIT_MODE" = "system" ]; then
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    step "creating system user '$SVC_USER'"
    $SUDO useradd --system --user-group --home-dir "$INSTALL_DIR" --no-create-home \
      --shell /usr/sbin/nologin "$SVC_USER"
  fi
  SERVICE_USER_LINES="User=$SVC_USER"
  SERVICE_GROUP_LINES="Group=$SVC_GROUP"
fi

# --- layout -----------------------------------------------------------------
step "install root: $INSTALL_DIR (unit mode: $UNIT_MODE, profile: $([ "$CUDA" -eq 1 ] && echo cuda || echo cpu))"
RELEASES_DIR="$INSTALL_DIR/releases"
RELEASE_DIR="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)"
[ -d "$RELEASE_DIR" ] && RELEASE_DIR="${RELEASE_DIR}-$$"
$W mkdir -p "$RELEASES_DIR" "$INSTALL_DIR/etc" "$DATA_DIR" "$MODEL_DIR" "$VOICE_DATA_DIR" \
  "$DATA_DIR/hf" "$DATA_DIR/easyocr" "$DATA_DIR/sessions" "$DATA_DIR/default_voices"

# --- backend tree into a fresh release dir ----------------------------------
copy_backend_tree() {
  local src="$SOURCE/backend" dest="$1"
  mkdir -p "$dest/data"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude '__pycache__/' --exclude '*.pyc' \
      "$src/main.py" "$src/routes" "$src/services" "$src/static" "$src/requirements.txt" \
      "$src/requirements-ci.txt" "$dest/"
    rsync -a --exclude '__pycache__/' --exclude '*.pyc' \
      "$src/data/default_voices" "$dest/data/default_voices"
  else
    cp -R "$src/main.py" "$src/routes" "$src/services" "$src/static" "$dest/"
    cp -R "$src/data/default_voices" "$dest/data/default_voices"
    cp -f "$src/requirements.txt" "$src/requirements-ci.txt" "$dest/"
    find "$dest" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  fi
}

step "copying backend tree from $SOURCE/backend"
copy_backend_tree "$RELEASE_DIR"
# Adopt an older manual layout: a real backend/ dir is moved into releases/.
if [ -e "$APP_DIR" ] && [ ! -L "$APP_DIR" ]; then
  LEGACY="$RELEASES_DIR/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  warn "$APP_DIR is a real directory — moving it to $LEGACY (data is untouched)"
  $W mv "$APP_DIR" "$LEGACY"
fi
$W ln -sfn "$RELEASE_DIR" "$APP_DIR"

# --- model weights ----------------------------------------------------------
if [ -z "$MODELS_SRC" ]; then MODELS_SRC="$SOURCE/backend/data/models/en"; fi
if [ -f "$MODELS_SRC/tokenizer.json" ]; then
  step "copying English TTS weights from $MODELS_SRC -> $MODEL_DIR/en"
  if command -v rsync >/dev/null 2>&1; then
    $W rsync -a "$MODELS_SRC/" "$MODEL_DIR/en/"
  else
    $W mkdir -p "$MODEL_DIR/en"
    $W cp -R "$MODELS_SRC/." "$MODEL_DIR/en/"
  fi
else
  warn "English TTS weights not found at $MODELS_SRC (no tokenizer.json)."
  warn "  Multilingual narration still works — it downloads (~3 GB) on first use."
  warn "  For English narration, copy data/models/en/ from a Windows install into $MODEL_DIR/en"
fi

# --- venv + python deps -----------------------------------------------------
if [ ! -x "$VENV_PY" ]; then
  step "creating virtualenv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi
if [ "$CUDA" -eq 1 ]; then
  step "installing backend/requirements.txt + CUDA torch/torchaudio 2.5.1+cu121 (large download)"
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r "$RELEASE_DIR/requirements.txt"
  # Exact command prescribed by the comment in backend/requirements.txt.
  "$VENV_PY" -m pip install torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
    --index-url https://download.pytorch.org/whl/cu121
else
  step "installing backend/requirements-ci.txt (CPU torch; large download)"
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r "$RELEASE_DIR/requirements-ci.txt"
fi

# --- env file (never overwrite an existing one) ------------------------------
if [ -f "$ENV_FILE" ]; then
  step "env file already exists at $ENV_FILE — keeping it (edit it to change config)"
else
  if [ -z "$PASSWORD" ]; then
    PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    GENERATED_PASSWORD=1
  fi
  OCR_GPU_DEFAULT=0; [ "$CUDA" -eq 1 ] && OCR_GPU_DEFAULT=1
  step "writing env file $ENV_FILE (from bookvoice.env.template)"
  $W mkdir -p "$(dirname "$ENV_FILE")"
  sed \
    -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
    -e "s|{{MODEL_DIR}}|$MODEL_DIR|g" \
    -e "s|{{DEFAULT_VOICES_DIR}}|$DEFAULT_VOICES_DIR|g" \
    -e "s|{{VOICE_DATA_DIR}}|$VOICE_DATA_DIR|g" \
    -e "s|{{ACCESS_PASSWORD}}|$PASSWORD|g" \
    -e "s|{{HOST}}|$BIND_HOST|g" \
    -e "s|{{PORT}}|$PORT|g" \
    -e "s|{{OCR_USE_GPU}}|$OCR_GPU_DEFAULT|g" \
    "$SCRIPT_DIR/bookvoice.env.template" | $W tee "$ENV_FILE" >/dev/null
  $W chmod 600 "$ENV_FILE"
fi

# --- systemd unit ------------------------------------------------------------
if [ "$DO_SERVICE" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_FILE="/etc/systemd/system/bookvoice.service"
  if [ "$UNIT_MODE" = "user" ]; then UNIT_FILE="$HOME/.config/systemd/user/bookvoice.service"; fi
  WANTED_BY="multi-user.target"
  [ "$UNIT_MODE" = "user" ] && WANTED_BY="default.target"
  step "installing systemd unit -> $UNIT_FILE"
  $W mkdir -p "$(dirname "$UNIT_FILE")"
  sed \
    -e "s|{{SERVICE_USER}}|$SERVICE_USER_LINES|g" \
    -e "s|{{SERVICE_GROUP}}|$SERVICE_GROUP_LINES|g" \
    -e "s|{{WANTED_BY}}|$WANTED_BY|g" \
    -e "s|{{APP_DIR}}|$APP_DIR|g" \
    -e "s|{{ENV_FILE}}|$ENV_FILE|g" \
    -e "s|{{VENV_PYTHON}}|$VENV_PY|g" \
    -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
    -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
    -e "s|{{MODEL_DIR}}|$MODEL_DIR|g" \
    "$SCRIPT_DIR/bookvoice.service.template" | $W tee "$UNIT_FILE" >/dev/null
  $W chmod 644 "$UNIT_FILE"

  if [ "$UNIT_MODE" = "system" ]; then
    $W chown -R "$SVC_USER:$SVC_GROUP" "$DATA_DIR"
    $W chown -R "$SVC_USER:$SVC_GROUP" "$RELEASE_DIR"
    step "enabling + starting bookvoice.service (system)"
    $W systemctl daemon-reload
    $W systemctl enable --now bookvoice.service
  else
    step "enabling + starting bookvoice.service (user)"
    systemctl --user daemon-reload
    systemctl --user enable --now bookvoice.service
    if command -v loginctl >/dev/null 2>&1 \
      && [ "$(loginctl show-user "$USER" -p Linger 2>/dev/null | tr -d ' ' | cut -d= -f2)" != "yes" ]; then
      warn "user units stop at logout. For a headless box run once: sudo loginctl enable-linger $USER"
    fi
  fi
else
  step "skipping systemd unit (see deploy/linux/README.md for a manual run line)"
fi

# --- smoke check -------------------------------------------------------------
smoke_ok=0
if [ "$DO_SERVICE" -eq 1 ] && command -v systemctl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  step "smoke check: waiting for http://127.0.0.1:$PORT/api/health (first start imports torch; can take a minute)"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"status"'; then
      smoke_ok=1
      break
    fi
    sleep 3
  done
  if [ "$smoke_ok" -eq 1 ]; then
    step "smoke check passed: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
  else
    warn "health endpoint did not answer within 180s. Inspect logs:"
    if [ "$UNIT_MODE" = "system" ]; then
      warn "  sudo journalctl -u bookvoice -e --no-pager | tail -50"
    else
      warn "  journalctl --user -u bookvoice -e --no-pager | tail -50"
    fi
  fi
fi

# --- summary ------------------------------------------------------------------
cat <<EOF

[install] done.

  Install root : $INSTALL_DIR
  Backend      : $APP_DIR -> $(readlink -f "$APP_DIR")
  Data         : $DATA_DIR   (models: $MODEL_DIR)
  Env file     : $ENV_FILE
  Unit         : $([ "$DO_SERVICE" -eq 1 ] && echo "$UNIT_FILE ($UNIT_MODE)" || echo "not installed")

Next steps:
  1. Read $ENV_FILE and replace the access password if you did not pass --password.
     ${GENERATED_PASSWORD:+A random password was generated for you: $PASSWORD
     (also written into the env file.)}
  2. Restart after editing the env file:
     $([ "$UNIT_MODE" = "system" ] && echo "sudo systemctl restart bookvoice" || echo "systemctl --user restart bookvoice")
  3. Expose it safely: put TLS in front (nginx/Caddy) or use a tunnel, then set
     BOOKVOICE_PUBLIC_ORIGIN in the env file. See deploy/linux/README.md.
  4. English narration needs weights at $MODEL_DIR/en (see the warning above if it was skipped).
  5. Updates later: sudo deploy/linux/update.sh  (keeps the previous release for rollback)
EOF
[ -f "$ENV_FILE" ] || true
exit 0
