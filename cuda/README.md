# Grinder engine — SolVanityCL

We use [`WincerChan/SolVanityCL`](https://github.com/WincerChan/SolVanityCL) as
the GPU vanity engine. OpenCL + Python; runs on any modern NVIDIA card (and
AMD if `rocm-opencl-runtime` is on the image). Fast enough that 4-character
prefixes resolve effectively instantly on consumer GPUs and large prefixes
finish in seconds on an A100.

## Install (one-shot)

On the GPU instance:

```bash
sudo bash install-solvanitycl.sh
```

The script:

1. Installs the OpenCL ICD loader, headers, Python, and clinfo.
2. Verifies the GPU is visible to OpenCL (`clinfo -l`).
3. Clones SolVanityCL into `/opt/vamint/engine`.
4. Creates a venv at `/opt/vamint/engine/.venv` and pip-installs requirements.
5. Smoke-tests PyOpenCL (lists platforms + devices).
6. Prints the three env vars you copy into `backend/.env`:
   ```
   GRINDER_PYTHON=/opt/vamint/engine/.venv/bin/python
   GRINDER_ENGINE_DIR=/opt/vamint/engine
   GRINDER_ENTRY=/opt/vamint/engine/main.py
   ```

## Vast.ai notes

- Pick a CUDA template (any `nvidia/cuda:*-devel` image works). The driver
  ships the NVIDIA OpenCL ICD, so PyOpenCL sees the GPU without extra setup.
- If `clinfo -l` returns nothing, the container was started without GPU
  passthrough — recreate the instance with `--gpus all` / vast.ai's GPU option.
- Vast.ai instances run as root by default; `deploy.sh` is written for that.

## How the Node side calls it

`backend/lib/worker.js` spawns one Python process per job:

```
${GRINDER_PYTHON} ${GRINDER_ENTRY} search-pubkey \
  --starts-with <prefix> [--ends-with <suffix>] \
  --count 1 --output-dir /tmp/vamint/vamint-<jobId> \
  [<...GRINDER_EXTRA_ARGS...>]
```

SolVanityCL writes the keypair JSON into that dir as soon as it lands on a
match. The wrapper file-watches the dir, parses the JSON (accepting all three
common keypair shapes — bare 64-byte array, `{publicKey, secretKey:[..]}`, and
`{publicKey, secretKey:"<base58>"}`), re-derives the public key from the
secret with **tweetnacl**, and only then emits `{found, address, secret}` to
the API layer. The result file is then wiped from disk — secret never persists.

## Override the upstream

If you need a fork or a specific revision:

```bash
ENGINE_REPO=https://github.com/your/fork.git \
ENGINE_REF=main \
ENGINE_DIR=/opt/vamint/engine \
sudo bash install-solvanitycl.sh
```

If your fork's CLI differs from upstream's click subcommands, you can either
pass replacements via `GRINDER_EXTRA_ARGS` or symlink a small shim at
`$GRINDER_ENGINE_DIR/main.py` that re-exposes the canonical interface.

## Why this engine

- **Maintained.** Active commits, real users.
- **Deterministic seed handling.** No "RNG-derived" key surprises like in
  the old solanity flow.
- **Cross-vendor.** OpenCL works on both NVIDIA and AMD — useful when you
  shop vast.ai for the cheapest GPU/hour.
- **Plain JSON output.** Trivial to integrate without parsing stdout.
- **CPU is not viable for prefixes ≥ 4 chars** — minutes vs. seconds. GPU
  is the whole point of this backend.
