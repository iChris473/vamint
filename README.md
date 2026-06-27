# Vamint backend

Express API that drives the vanity address generator.

GPU grinding is delegated to **[`WincerChan/SolVanityCL`][svcl]** — an
actively maintained Python + OpenCL Solana vanity tool. This backend handles
everything around the engine:

- HTTP + SSE API for the frontend
- Per-job deposit wallet generation (one-time, in-memory)
- Spawning SolVanityCL per job and watching its output dir for the keypair
- Re-verifying every match with tweetnacl before releasing it to the buyer
- Polling the Solana RPC for the 0.1 SOL claim payment
- Revealing the secret exactly once, then wiping it
- CPU fallback (worker_threads + tweetnacl) for local dev

[svcl]: https://github.com/WincerChan/SolVanityCL

## Why SolVanityCL

ChorusOne/solanity is archived and uses a brittle RNG-based derivation. SolVanityCL is current, deterministic, runs on any NVIDIA/AMD GPU via OpenCL (no CUDA-only lock-in), and emits a plain JSON keypair file per match — trivial to integrate without scraping stdout.

The Node bridge file-watches the engine's output dir, parses the keypair JSON
(handling all three common shapes), re-derives the public key from the secret
with tweetnacl, and only emits `{found}` if it matches. Even if the upstream
shape changes, **a wrong key can never reach the buyer** — at worst the job
fails and the deposit isn't collected.

## API

| Method | Path                       | Description                                                                              |
|--------|----------------------------|------------------------------------------------------------------------------------------|
| GET    | `/health`                  | Liveness + grinder mode/queue depth                                                       |
| POST   | `/api/jobs`                | `{ prefix, suffix, caseSensitive }` → `{ job, deposit: { pubkey, lamports } }`            |
| GET    | `/api/jobs/:id`            | Current public state of a job                                                            |
| GET    | `/api/jobs/:id/stream`     | Server-Sent Events: every state change (progress, awaiting-payment, paid, …)             |
| POST   | `/api/jobs/:id/cancel`     | Cancel and wipe the (unrevealed) secret                                                  |
| POST   | `/api/jobs/:id/claim`      | Once `status === 'paid'`, returns `{ address, secretKey }` exactly once, then deletes it |

Job status state machine:

```
queued → grinding → awaiting-payment ──► paid ──► claimed
                          │                 │
                          └─► expired       └─► expired  (PAYMENT_TIMEOUT_SECONDS)
                          │
                          └─► cancelled
```

## Local dev (no GPU)

```bash
cd backend
cp .env.example .env
# In .env: GRINDER_CPU_FALLBACK=true
npm install
npm run dev
```

The CPU fallback uses tweetnacl in a worker_threads pool. Fine for testing
the API + payment flow; **not** representative of GPU performance — 4-char
prefixes take minutes on CPU vs. ~instant on a single consumer GPU.

## Deploying to vast.ai

### 1. Provision the instance

- Pick any **CUDA devel** Docker template (e.g. `nvidia/cuda:12.4.1-devel-ubuntu22.04`, the PyTorch template, or your own).
- Make sure GPU passthrough is enabled when starting the container.
- Note the SSH command vast.ai gives you and a port to open for the API (default 4000).

### 2. Push the backend

From your laptop:

```bash
rsync -avz --delete --exclude node_modules --exclude .env \
  backend/ root@<vast-host>:-p <vast-port>:/opt/vamint/backend/
```

(The exact `ssh`/`rsync` form vast.ai prints will include `-p <port>` — copy
that.)

### 3. Bootstrap

```bash
ssh -p <vast-port> root@<vast-host> 'bash /opt/vamint/backend/deploy.sh'
```

`deploy.sh` is idempotent. It:

1. Verifies `nvidia-smi`.
2. Installs OpenCL headers/ICD loader + clinfo + Python + Node 20 + pm2.
3. Runs `cuda/install-solvanitycl.sh` which clones SolVanityCL, creates a
   venv, installs requirements, smoke-tests PyOpenCL against the GPU.
4. Prints the env vars you copy into `.env`.

### 4. Configure

```bash
ssh -p <vast-port> root@<vast-host>
cd /opt/vamint/backend
cp .env.example .env
nano .env
#   GRINDER_PYTHON=/opt/vamint/engine/.venv/bin/python
#   GRINDER_ENGINE_DIR=/opt/vamint/engine
#   GRINDER_ENTRY=/opt/vamint/engine/main.py
#   SOLANA_RPC_URL=https://your-helius-or-quicknode-url
#   OPERATOR_WALLET=<your fee wallet pubkey>
```

### 5. Smoke test the engine alone

```bash
cd /opt/vamint/engine
.venv/bin/python main.py search-pubkey --starts-with sol --count 1 \
  --output-dir /tmp/probe
ls /tmp/probe
```

A `<address>.json` should appear within seconds. If it doesn't, the issue is
between SolVanityCL and the GPU (driver / OpenCL ICD), not us. Run
`clinfo -l` to confirm the GPU is visible to OpenCL.

### 6. Start the API

```bash
cd /opt/vamint/backend
pm2 start server.js --name vamint-backend
pm2 save && pm2 startup
```

### 7. Verify

```bash
curl http://localhost:4000/health
# { "ok": true, "grinder": "cuda" (== opencl mode), "activeJobs": 0, ... }

curl -X POST http://localhost:4000/api/jobs \
  -H "content-type: application/json" \
  -d '{"prefix":"sol","caseSensitive":true}'
```

## Engine config knobs

`backend/lib/worker.js` defaults to upstream SolVanityCL's CLI:

```
${GRINDER_PYTHON} ${GRINDER_ENTRY} search-pubkey \
  --starts-with <prefix> [--ends-with <suffix>] \
  --count 1 --output-dir <per-job-dir> [<...GRINDER_EXTRA_ARGS...>]
```

Extra flags via `GRINDER_EXTRA_ARGS` if you want to pin a specific OpenCL
device, set a chunk size, etc. Prefix/suffix/count/output-dir are always
constructed by the wrapper.

## Security notes

- The vanity wallet's secret key lives **only in process memory** between
  generation and the buyer's `POST /api/jobs/:id/claim`. The result JSON from
  SolVanityCL is read, parsed, then the file is `rm`'d immediately.
- The deposit wallet's secret is held the same way, only long enough to sweep
  collected fees to `OPERATOR_WALLET` after the claim.
- The old `db.js` previously had a live Mongo connection string. **Rotate those
  credentials in Atlas** — the rewritten file is env-only.
- Cancel/expire branches wipe the secret first, then change status, so a
  late-arriving payment can't redeem a zeroed key.

## File map

```
backend/
├── package.json
├── .env.example
├── deploy.sh                 # vast.ai-friendly bootstrap
├── server.js                 # Express + SSE
├── db.js                     # env-only Mongo (optional)
├── lib/
│   ├── base58-helpers.js
│   ├── solana.js             # deposit gen, balance polling, sweep
│   ├── jobs.js               # in-memory job state machine
│   ├── worker.js             # GrinderClient — spawns SolVanityCL per job
│   └── cpu-grinder.js        # tweetnacl worker_threads fallback
└── cuda/
    ├── install-solvanitycl.sh   # one-shot engine installer
    └── README.md                # engine-specific notes
```
