#!/usr/bin/env bash
# install-solvanitycl.sh — install WincerChan/SolVanityCL on the GPU box.
#
# Works on any vast.ai instance running an NVIDIA CUDA image — the NVIDIA
# driver ships the OpenCL ICD, so we just need the OpenCL devel headers and
# Python. AMD boxes work too if rocm-opencl-runtime is on the image.
#
# Idempotent. Run as root or under sudo. Override paths via env:
#
#   ENGINE_REPO   default https://github.com/WincerChan/SolVanityCL.git
#   ENGINE_REF    default master
#   ENGINE_DIR    default /opt/vamint/engine

set -euo pipefail

ENGINE_REPO="${ENGINE_REPO:-https://github.com/WincerChan/SolVanityCL.git}"
ENGINE_REF="${ENGINE_REF:-master}"
ENGINE_DIR="${ENGINE_DIR:-/opt/vamint/engine}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash install-solvanitycl.sh)" >&2
  exit 1
fi

echo "→ installing system deps (OpenCL ICD loader, Python, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  git ca-certificates \
  python3 python3-pip python3-venv python3-dev build-essential \
  ocl-icd-libopencl1 ocl-icd-opencl-dev opencl-headers \
  clinfo pkg-config

if ! command -v clinfo >/dev/null 2>&1; then
  echo "✘ clinfo missing after install" >&2; exit 1
fi

echo "→ verifying OpenCL can see the GPU"
if ! clinfo -l | grep -qi 'platform\|device'; then
  echo "  ! clinfo output is empty — your container is missing the NVIDIA OpenCL ICD."
  echo "    On vast.ai, restart the instance with the 'NVIDIA OpenCL' option enabled,"
  echo "    or install the ICD manually: apt-get install -y nvidia-opencl-icd-XXX"
  exit 1
fi
clinfo -l

echo "→ cloning $ENGINE_REPO at $ENGINE_REF"
mkdir -p "$(dirname "$ENGINE_DIR")"
if [ ! -d "$ENGINE_DIR/.git" ]; then
  git clone "$ENGINE_REPO" "$ENGINE_DIR"
fi
cd "$ENGINE_DIR"
git fetch --tags origin
git checkout "$ENGINE_REF"
git pull --ff-only || true

echo "→ creating venv + installing requirements"
python3 -m venv .venv
# shellcheck source=/dev/null
source .venv/bin/activate
pip install --upgrade pip wheel
if [ -f requirements.txt ]; then
  pip install -r requirements.txt
else
  # Fallback if upstream renames the file
  pip install pyopencl click base58 nacl
fi

# Smoke test: list platforms / devices PyOpenCL sees.
echo "→ smoke testing PyOpenCL"
python - <<'PY'
import pyopencl as cl
plats = cl.get_platforms()
if not plats:
    raise SystemExit("PyOpenCL sees no OpenCL platforms")
for p in plats:
    print(f"platform: {p.name}")
    for d in p.get_devices():
        print(f"  device:  {d.name}  ({d.global_mem_size//(1024*1024)} MiB)")
PY

# Detect the main entry point (upstream sometimes uses main.py vs. cli.py).
ENTRY=""
for candidate in main.py cli.py solvanitycl.py; do
  if [ -f "$ENGINE_DIR/$candidate" ]; then ENTRY="$ENGINE_DIR/$candidate"; break; fi
done

cat <<EOF

✔ SolVanityCL ready.

Set these in backend/.env:

  GRINDER_ENGINE_DIR=$ENGINE_DIR
  GRINDER_PYTHON=$ENGINE_DIR/.venv/bin/python
  GRINDER_ENTRY=${ENTRY:-$ENGINE_DIR/main.py}

EOF
