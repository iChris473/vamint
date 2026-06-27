#!/usr/bin/env bash
# deploy.sh — bootstrap a vast.ai GPU instance for the Vamint backend.
#
# Assumes the instance is an NVIDIA CUDA Docker image (e.g. nvidia/cuda:*-devel
# or the "PyTorch / CUDA" templates vast.ai ships). The driver brings the
# OpenCL ICD; we install OpenCL headers, Python deps, and the engine.
#
# Steps (assuming you rsync'd backend/ to /opt/vamint/backend first):
#   ssh root@<host> 'sudo bash /opt/vamint/backend/deploy.sh'
#
# Idempotent. Rerunning skips installed pieces.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash deploy.sh)" >&2
  exit 1
fi

NODE_MAJOR="${NODE_MAJOR:-20}"
INSTALL_DIR="${INSTALL_DIR:-/opt/vamint}"
APP_USER="${APP_USER:-root}"           # vast.ai containers usually run as root
SERVICE="${SERVICE:-vamint-backend}"

echo "→ confirming NVIDIA GPU"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "✘ nvidia-smi missing. This is not a GPU instance." >&2
  exit 1
fi
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader

echo "→ installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential git curl jq pkg-config ca-certificates \
  python3 python3-pip python3-venv python3-dev \
  ocl-icd-libopencl1 ocl-icd-opencl-dev opencl-headers clinfo

if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  echo "→ installing Node $NODE_MAJOR via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "→ installing pm2"
  npm install -g pm2
fi

mkdir -p "$INSTALL_DIR"
if [ ! -d "$INSTALL_DIR/backend" ]; then
  echo "✘ Expected backend at $INSTALL_DIR/backend (rsync it first)" >&2
  exit 1
fi

echo "→ installing backend npm deps"
cd "$INSTALL_DIR/backend"
npm ci --omit=dev

echo "→ installing SolVanityCL engine"
bash "$INSTALL_DIR/backend/cuda/install-solvanitycl.sh"

cat <<EOF

✔ deploy complete.

Next:
  1. Edit $INSTALL_DIR/backend/.env (start from .env.example).
     The installer above printed the GRINDER_* paths to set.
  2. Smoke-test the engine alone:
       cd $INSTALL_DIR/engine
       .venv/bin/python main.py search-pubkey --starts-with sol --count 1 \\
         --output-dir /tmp/probe && cat /tmp/probe/*.json
  3. Start the API:
       cd $INSTALL_DIR/backend
       pm2 start server.js --name $SERVICE
       pm2 save && pm2 startup
  4. Open the port (vast.ai → instance → "Open Ports" → add the value of PORT).
EOF
