'use strict'

const { spawn } = require('node:child_process')
const { Worker } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const nacl = require('tweetnacl')
const bs58raw = require('bs58')
const bs58 = bs58raw && bs58raw.default ? bs58raw.default : bs58raw

/**
 * GrinderClient — orchestrates ed25519 vanity address generation.
 *
 * Engines
 *   • opencl: spawns WincerChan/SolVanityCL (Python + PyOpenCL) per job. The
 *             tool writes a JSON keypair file to its output dir as soon as a
 *             match is found; we file-watch that dir, convert the byte-array
 *             secret to base58, verify the keypair with tweetnacl, and emit.
 *   • cpu   : Node worker_threads pool using tweetnacl. Dev fallback only —
 *             4-char prefixes take ~minutes on CPU vs. ~instant on a GPU.
 *
 * Why SolVanityCL: deterministic, well-maintained, OpenCL works on any
 * NVIDIA/AMD GPU on vast.ai (NVIDIA ships the OpenCL ICD with the driver).
 *
 * Outbound events:
 *   onProgress(jobId, attempts)
 *   onFound(jobId, { address, secretKey })
 *   onError(jobId, message)
 *
 * Every {found} is re-verified with tweetnacl on the host before being
 * emitted — guarantees the secret actually corresponds to the address
 * regardless of upstream changes.
 */
class GrinderClient {
  constructor({
    pythonBin   = process.env.GRINDER_PYTHON,
    engineDir   = process.env.GRINDER_ENGINE_DIR,
    entry       = process.env.GRINDER_ENTRY,
    extraArgs   = process.env.GRINDER_EXTRA_ARGS || '',
    workDir     = process.env.GRINDER_WORK_DIR || os.tmpdir(),
    cpuFallback = process.env.GRINDER_CPU_FALLBACK === 'true',
    cpuThreads  = Number(process.env.GRINDER_CPU_THREADS) || os.cpus().length,
    concurrency = Number(process.env.GRINDER_CONCURRENCY) || 1,
    onProgress  = () => {},
    onFound     = () => {},
    onError     = () => {},
  } = {}) {
    this.pythonBin   = pythonBin
    this.engineDir   = engineDir
    this.entry       = entry || (engineDir ? path.join(engineDir, 'main.py') : null)
    this.extraArgs   = extraArgs ? extraArgs.split(/\s+/).filter(Boolean) : []
    this.workDir     = workDir
    this.cpuFallback = cpuFallback
    this.cpuThreads  = Math.max(1, Math.min(32, cpuThreads))
    this.concurrency = Math.max(1, concurrency)
    this.onProgress  = onProgress
    this.onFound     = onFound
    this.onError     = onError

    this.active    = new Map()  // jobId -> { kind, proc?, cpuWorkers?, watcher?, outDir?, poller? }
    this.queue     = []
    this.procReady = false      // surfaced via /health
  }

  async init() {
    if (this.cpuFallback) {
      console.log('[grinder] CPU fallback explicitly enabled')
      return
    }
    if (!this.pythonBin || !this.entry) {
      console.warn('[grinder] GRINDER_PYTHON / GRINDER_ENTRY unset — CPU fallback')
      this.cpuFallback = true
      return
    }
    if (!fs.existsSync(this.entry)) {
      console.warn(`[grinder] entry script not found at ${this.entry} — CPU fallback`)
      this.cpuFallback = true
      return
    }
    fs.mkdirSync(this.workDir, { recursive: true })
    this.procReady = true
    console.log(`[grinder] OpenCL engine ready (${this.entry})`)
  }

  submit(job) {
    if (this.active.size >= this.concurrency) {
      this.queue.push(job)
      return
    }
    if (this.cpuFallback) this.runCpuJob(job)
    else this.runGpuJob(job)
  }

  cancel(jobId) {
    if (!this.active.has(jobId)) {
      const idx = this.queue.findIndex(j => j.id === jobId)
      if (idx >= 0) this.queue.splice(idx, 1)
      return
    }
    const entry = this.active.get(jobId)
    this.teardown(jobId, entry)
    this.pump()
  }

  pump() {
    while (this.queue.length && this.active.size < this.concurrency) {
      const job = this.queue.shift()
      if (this.cpuFallback) this.runCpuJob(job)
      else this.runGpuJob(job)
    }
  }

  /**
   * SolVanityCL invocation:
   *   python main.py search-pubkey --starts-with <prefix> [--ends-with <suffix>]
   *                                --count 1 --output-dir <dir>
   *
   * The subcommand name and flags follow the upstream click CLI. Operators
   * can override the entire arg list via GRINDER_EXTRA_ARGS (positional flags
   * only — prefix/suffix/output-dir/count are still constructed by us).
   */
  buildArgs(job, outDir) {
    const args = [this.entry, 'search-pubkey']
    if (job.prefix) args.push('--starts-with', job.prefix)
    if (job.suffix) args.push('--ends-with', job.suffix)
    args.push('--count', '1')
    args.push('--output-dir', outDir)
    if (this.extraArgs.length) args.push(...this.extraArgs)
    return args
  }

  runGpuJob(job) {
    const outDir = path.join(this.workDir, `vamint-${job.id}`)
    fs.mkdirSync(outDir, { recursive: true })

    const proc = spawn(this.pythonBin, this.buildArgs(job, outDir), {
      cwd: this.engineDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })

    const entry = {
      kind: 'gpu',
      proc,
      outDir,
      watcher: null,
      poller: null,
      attempts: 0,
      done: false,
    }
    this.active.set(job.id, entry)

    const finish = (kind, payload) => {
      if (entry.done) return
      entry.done = true
      this.teardown(job.id, entry)
      if (kind === 'found') this.onFound(job.id, payload)
      else this.onError(job.id, payload)
      this.pump()
    }

    const tryHarvest = () => {
      if (entry.done) return false
      const result = harvestKeypair(outDir, job)
      if (!result) return false
      finish('found', result)
      return true
    }

    // Watch the output dir; fall back to a 250ms poll because fs.watch can
    // miss events on some shared filesystems and inside containers.
    try {
      entry.watcher = fs.watch(outDir, () => { tryHarvest() })
    } catch { /* watcher unsupported — poller will handle it */ }
    entry.poller = setInterval(tryHarvest, 250)

    // Progress parsing is best-effort. SolVanityCL logs lines like
    //   "INFO - 12,345,678 keys checked (8.4M/s)"
    // or                 "[INFO] Found ... after 1234567 iterations".
    // We accept any line whose largest integer-with-commas is plausibly
    // an attempts counter and surface it.
    const PROGRESS_RE = /([\d][\d,]{3,})\s*(?:keys|iter|attempt)/i
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    let stdoutBuf = ''
    let stderrTail = ''
    const onLog = chunk => {
      stdoutBuf += chunk
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        const m = line.match(PROGRESS_RE)
        if (m) {
          const n = Number(m[1].replaceAll(',', ''))
          if (Number.isFinite(n) && n > entry.attempts) {
            entry.attempts = n
            this.onProgress(job.id, n)
          }
        }
      }
    }
    proc.stdout.on('data', onLog)
    proc.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk).slice(-1024)
      onLog(chunk)
    })

    proc.on('error', err => finish('error', `engine spawn failed: ${err.message}`))
    proc.on('exit', code => {
      if (entry.done) return
      // Last-chance harvest before declaring failure (the JSON file is often
      // written exactly as the process is exiting).
      if (tryHarvest()) return
      finish('error',
        `engine exited code=${code} without a match` +
        (stderrTail.trim() ? ` (stderr tail: ${stderrTail.trim().slice(-300)})` : ''))
    })
  }

  runCpuJob(job) {
    const workers = []
    let aggregated = 0
    let done = false
    const finish = (result, err) => {
      if (done) return
      done = true
      for (const w of workers) { try { w.postMessage({ type: 'stop' }) } catch { /**/ } }
      this.active.delete(job.id)
      if (err) this.onError(job.id, err)
      else this.onFound(job.id, result)
      this.pump()
    }
    for (let i = 0; i < this.cpuThreads; i++) {
      const w = new Worker(path.join(__dirname, 'cpu-grinder.js'))
      w.on('message', msg => {
        if (msg.type === 'progress') {
          aggregated += msg.attempts
          this.onProgress(job.id, aggregated)
        } else if (msg.type === 'found') {
          finish({ address: msg.address, secretKey: msg.secretKey })
        }
      })
      w.on('error', err => finish(null, err.message))
      w.postMessage({
        type: 'start',
        prefix: job.prefix,
        suffix: job.suffix,
        caseSensitive: !!job.caseSensitive,
      })
      workers.push(w)
    }
    this.active.set(job.id, { kind: 'cpu', cpuWorkers: workers })
  }

  teardown(jobId, entry) {
    if (entry.watcher) { try { entry.watcher.close() } catch { /**/ } }
    if (entry.poller) clearInterval(entry.poller)
    if (entry.proc) { try { entry.proc.kill('SIGTERM') } catch { /**/ } }
    if (entry.cpuWorkers) {
      for (const w of entry.cpuWorkers) {
        try { w.postMessage({ type: 'stop' }) } catch { /**/ }
      }
    }
    if (entry.outDir) {
      // Wipe the result JSON from disk the instant we've consumed it. The
      // secret only lives in process memory after this point.
      try { fs.rmSync(entry.outDir, { recursive: true, force: true }) } catch { /**/ }
    }
    this.active.delete(jobId)
  }

  shutdown() {
    for (const [id, entry] of this.active) this.teardown(id, entry)
    this.active.clear()
  }
}

/**
 * Look for a SolVanityCL keypair JSON in outDir, parse it, and return
 * { address, secretKey } in our wire format. Returns null if there's no
 * match yet, or null + side-effect if the file is malformed.
 *
 * SolVanityCL writes one file per match. The format varies a bit between
 * versions; we accept all of:
 *   • Solana keygen JSON: [byte0, byte1, ..., byte63]   (filename = address)
 *   • { "publicKey": "...", "secretKey": [..64..] }
 *   • { "publicKey": "...", "secretKey": "<base58>" }
 */
function harvestKeypair(outDir, job) {
  let files
  try {
    files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'))
  } catch {
    return null
  }
  for (const f of files) {
    const full = path.join(outDir, f)
    let raw
    try { raw = fs.readFileSync(full, 'utf8') } catch { continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch { continue }

    let address = null
    let secretBytes = null

    if (Array.isArray(parsed) && parsed.length === 64) {
      secretBytes = Uint8Array.from(parsed)
      address = path.basename(f, '.json')
    } else if (parsed && typeof parsed === 'object') {
      address = parsed.publicKey || parsed.public_key || parsed.address || null
      const sk = parsed.secretKey ?? parsed.secret_key ?? parsed.privateKey
      if (Array.isArray(sk) && sk.length === 64) secretBytes = Uint8Array.from(sk)
      else if (typeof sk === 'string') {
        try { secretBytes = bs58.decode(sk) } catch { /* not base58 */ }
      }
    }
    if (!address || !secretBytes || secretBytes.length !== 64) continue

    // Re-derive the public key from the secret and confirm it matches.
    const derived = bs58.encode(nacl.sign.keyPair.fromSecretKey(secretBytes).publicKey)
    if (derived !== address) continue

    // Confirm the address actually satisfies the job's constraints (defence
    // in depth against an engine that returns the wrong keypair file).
    const cmp = job.caseSensitive ? address : address.toLowerCase()
    const pfx = job.caseSensitive ? job.prefix : (job.prefix || '').toLowerCase()
    const sfx = job.caseSensitive ? job.suffix : (job.suffix || '').toLowerCase()
    if (pfx && !cmp.startsWith(pfx)) continue
    if (sfx && !cmp.endsWith(sfx)) continue

    return { address, secretKey: bs58.encode(secretBytes) }
  }
  return null
}

module.exports = { GrinderClient }
