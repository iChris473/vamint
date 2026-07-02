'use strict'

/**
 * Async, polling-friendly wrapper around SolVanityCL.
 *
 *   startGenerateJob({ prefix, suffix, caseSensitive }) → job
 *   getGenerateJob(jobId)                               → state | null
 *   cancelGenerateJob(jobId)                            → bool
 *
 * Flow (kind:'wallet' — the default):
 *   1. start creates the job with a FRESH deposit wallet and returns
 *      status:'awaiting-payment' plus the deposit address. Nothing is
 *      ground yet.
 *   2. A payment poller watches the deposit address; once it holds
 *      GENERATE_FEE_LAMPORTS (0.05 SOL) the job flips to 'processing' and
 *      SolVanityCL is spawned. If the window expires unpaid → 'expired'.
 *   3. The frontend polls GET /api/generate/:jobId every ~1.5s.
 *   4. Each tick of an internal 200ms poller looks for the keypair JSON
 *      that SolVanityCL writes to the per-job tmp dir. As soon as the file
 *      lands, we parse it, derive the public key with tweetnacl, verify the
 *      prefix/suffix still hold, store the result, and wipe the file.
 *   5. The polling endpoint sees status:'done' on its next tick and
 *      surfaces { publicKey, secretKey } to the client. The deposit is
 *      swept to OPERATOR_WALLET best-effort.
 *
 * Flow (kind:'token'): unchanged — grinding starts immediately with no
 * deposit; the 0.1 SOL fee is collected at Pump.fun launch time instead.
 *
 * Result and error are held in the in-memory store for JOB_TTL_MS (default
 * 30min) so a flaky network can re-fetch. The secret never touches disk;
 * cancel / done / error / TTL-sweep all rm the output dir immediately.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { nanoid } = require('nanoid')
const nacl = require('tweetnacl')
// bs58 v6 ships ESM-only — `require('bs58')` returns the module namespace.
const bs58raw = require('bs58')
const bs58 = bs58raw && bs58raw.default ? bs58raw.default : bs58raw
const { isValidBase58 } = require('./base58-helpers')
const {
  newDepositWallet,
  paymentReceived,
  forwardBalance,
  LAMPORTS_PER_SOL,
} = require('./solana')

const REPO_DEFAULT = path.resolve(__dirname, '..', 'SolVanityCL')
const PYTHON      = process.env.GRINDER_PYTHON     || 'python3'
const ENGINE_DIR  = process.env.GRINDER_ENGINE_DIR || REPO_DEFAULT
const ENTRY       = process.env.GRINDER_ENTRY      || path.join(ENGINE_DIR, 'main.py')
const WORK_BASE   = process.env.GRINDER_WORK_DIR   || path.join(os.tmpdir(), 'vamint-gen')
const POLL_MS     = 200
const JOB_TTL_MS  = Number(process.env.GENERATE_TTL_MS) || 30 * 60 * 1000

// Wallet generations are gated behind a per-request deposit. A fresh deposit
// wallet is minted for every request; grinding starts only after its balance
// reaches GENERATE_FEE_LAMPORTS.
const GENERATE_FEE_LAMPORTS = Number(process.env.GENERATE_FEE_LAMPORTS) || 50_000_000 // 0.05 SOL
const PAYMENT_TIMEOUT_MS = (Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 900) * 1000
const PAYMENT_POLL_MS = 4000
const OPERATOR_WALLET = process.env.OPERATOR_WALLET || ''

// Character-count limits (mirrored on the frontend):
//   Using BOTH prefix and suffix → 3 chars each.
//   Using only ONE              → up to 5 chars on that side.
const MAX_BOTH   = 3
const MAX_SINGLE = 5

const jobs = new Map() // jobId → JobState

function makeErr(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

function validateSpec({ prefix = '', suffix = '', caseSensitive = true }) {
  prefix = String(prefix || '')
  suffix = String(suffix || '')
  if (!prefix && !suffix) {
    throw makeErr(400, 'at least one of prefix/suffix is required')
  }
  if (!isValidBase58(prefix) || !isValidBase58(suffix)) {
    throw makeErr(400, 'prefix/suffix must use base58 chars only (no 0, O, I, l)')
  }
  if (prefix && suffix) {
    if (prefix.length > MAX_BOTH) {
      throw makeErr(400, `when using both, prefix max ${MAX_BOTH} characters`)
    }
    if (suffix.length > MAX_BOTH) {
      throw makeErr(400, `when using both, suffix max ${MAX_BOTH} characters`)
    }
  } else {
    if (prefix.length > MAX_SINGLE) {
      throw makeErr(400, `prefix max ${MAX_SINGLE} characters`)
    }
    if (suffix.length > MAX_SINGLE) {
      throw makeErr(400, `suffix max ${MAX_SINGLE} characters`)
    }
  }
  return { prefix, suffix, caseSensitive: !!caseSensitive }
}

function startGenerateJob(rawSpec) {
  if (!fs.existsSync(ENTRY)) {
    throw makeErr(500,
      `SolVanityCL entry not found at ${ENTRY}. ` +
      `Set GRINDER_ENTRY or ensure the repo lives at ${REPO_DEFAULT}.`)
  }
  const spec = validateSpec(rawSpec)
  const kind = rawSpec && rawSpec.kind === 'token' ? 'token' : 'wallet'

  fs.mkdirSync(WORK_BASE, { recursive: true })
  const id = nanoid(12)
  const outDir = path.join(WORK_BASE, `gen-${id}`)
  fs.mkdirSync(outDir, { recursive: true })

  const job = {
    id,
    kind,
    status: 'processing',
    prefix: spec.prefix,
    suffix: spec.suffix,
    caseSensitive: spec.caseSensitive,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    grindStartedAt: null,
    outDir,
    publicKey: null,
    secretKey: null,
    error: null,
    proc: null,
    poller: null,
    payPoller: null,
    stderrTail: '',
    depositPubkey: null,
    depositSecret: null,
    paymentDeadline: null,
  }
  jobs.set(id, job)

  if (kind === 'wallet') {
    const deposit = newDepositWallet()
    job.status = 'awaiting-payment'
    job.depositPubkey = deposit.publicKey
    job.depositSecret = deposit.secretKey
    job.paymentDeadline = Date.now() + PAYMENT_TIMEOUT_MS
    console.log(
      `[generate] job ${id} awaiting ${GENERATE_FEE_LAMPORTS / LAMPORTS_PER_SOL} SOL ` +
      `deposit at ${deposit.publicKey}`,
    )
    watchPayment(job)
  } else {
    launchEngine(job)
  }

  return publicView(job)
}

// Poll the job's fresh deposit wallet until the fee lands, then grind.
function watchPayment(job) {
  let inFlight = false
  job.payPoller = setInterval(async () => {
    if (job.status !== 'awaiting-payment') {
      clearInterval(job.payPoller)
      job.payPoller = null
      return
    }
    if (Date.now() > job.paymentDeadline) {
      finalize(job, { status: 'expired', error: 'deposit window expired — no payment received' })
      return
    }
    if (inFlight) return
    inFlight = true
    try {
      const paid = await paymentReceived(job.depositPubkey, GENERATE_FEE_LAMPORTS)
      if (paid && job.status === 'awaiting-payment') {
        clearInterval(job.payPoller)
        job.payPoller = null
        job.status = 'processing'
        job.updatedAt = Date.now()
        console.log(`[generate] job ${job.id} deposit confirmed → grinding`)
        launchEngine(job)
      }
    } catch (err) {
      // transient RPC failures are non-fatal; the next tick retries
      console.warn(`[generate] payment poll failed for ${job.id}: ${err.message}`)
    } finally {
      inFlight = false
    }
  }, PAYMENT_POLL_MS)
}

function sweepDeposit(job) {
  if (!OPERATOR_WALLET || !job.depositSecret) return
  forwardBalance(job.depositSecret, OPERATOR_WALLET)
    .then(r => r && console.log(`[generate] swept ${r.lamports} lamports for ${job.id}`))
    .catch(err => console.warn(`[generate] sweep failed for ${job.id}: ${err.message}`))
}

function launchEngine(job) {
  const spec = { prefix: job.prefix, suffix: job.suffix, caseSensitive: job.caseSensitive }
  const { id, outDir } = job
  job.grindStartedAt = Date.now()

  const args = [ENTRY, 'search-pubkey']
  if (spec.prefix) args.push('--starts-with', spec.prefix)
  if (spec.suffix) args.push('--ends-with', spec.suffix)
  args.push('--count', '1', '--output-dir', outDir)
  args.push('--is-case-sensitive', spec.caseSensitive ? 'true' : 'false')

  console.log(
    `[generate] starting job ${id} ` +
    `prefix=${spec.prefix || '∅'} suffix=${spec.suffix || '∅'} ` +
    `caseSensitive=${spec.caseSensitive}`,
  )
  const proc = spawn(PYTHON, args, {
    cwd: ENGINE_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.proc = proc

  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', chunk => {
    job.stderrTail = (job.stderrTail + chunk).slice(-2048)
  })
  proc.stdout?.on('data', () => {}) // drain

  const tryHarvest = () => {
    if (job.status !== 'processing') return true
    const result = harvest(outDir, spec.prefix, spec.suffix, spec.caseSensitive)
    if (!result) return false
    finalize(job, { status: 'done', publicKey: result.publicKey, secretKey: result.secretKey })
    console.log(`[generate] job ${id} done → ${result.publicKey}`)
    sweepDeposit(job)
    return true
  }

  job.poller = setInterval(tryHarvest, POLL_MS)

  proc.on('error', e => {
    if (job.status !== 'processing') return
    finalize(job, { status: 'error', error: `engine spawn failed: ${e.message}` })
  })

  proc.on('exit', code => {
    // SolVanityCL flushes the JSON ~just as it exits; give the poller a last
    // shot before declaring failure.
    setTimeout(() => {
      if (job.status !== 'processing') return
      if (tryHarvest()) return
      const tail = job.stderrTail.trim().slice(-300)
      finalize(job, {
        status: 'error',
        error:
          `engine exited code=${code} without a result` +
          (tail ? ` (stderr: ${tail})` : ''),
      })
    }, 350)
  })
}

function getGenerateJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  return publicView(job)
}

function cancelGenerateJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return false
  if (job.status === 'processing' || job.status === 'awaiting-payment') {
    finalize(job, { status: 'cancelled', error: 'cancelled' })
  }
  jobs.delete(jobId)
  return true
}

function finalize(job, patch) {
  Object.assign(job, patch)
  job.updatedAt = Date.now()
  if (job.poller) { clearInterval(job.poller); job.poller = null }
  if (job.payPoller) { clearInterval(job.payPoller); job.payPoller = null }
  if (job.proc)   { try { job.proc.kill('SIGTERM') } catch { /* dead already */ }; job.proc = null }
  try { fs.rmSync(job.outDir, { recursive: true, force: true }) } catch { /* swallow */ }
}

function publicView(job) {
  const base = {
    jobId: job.id,
    status: job.status,
    prefix: job.prefix,
    suffix: job.suffix,
    caseSensitive: job.caseSensitive,
    elapsedMs: Date.now() - (job.grindStartedAt || job.createdAt),
  }
  if (job.status === 'awaiting-payment') {
    return {
      ...base,
      deposit: {
        address: job.depositPubkey,
        lamports: GENERATE_FEE_LAMPORTS,
        sol: GENERATE_FEE_LAMPORTS / LAMPORTS_PER_SOL,
      },
      paymentExpiresAt: job.paymentDeadline,
    }
  }
  if (job.status === 'done') {
    if (job.kind === 'token') {
      // Token-CA grinds are free at request time, so the secret must never
      // leave the server — otherwise this endpoint is a free wallet grinder.
      // The CA secret stays escrowed here until launch.
      return { ...base, publicKey: job.publicKey }
    }
    return { ...base, publicKey: job.publicKey, secretKey: job.secretKey }
  }
  if (job.status === 'error' || job.status === 'cancelled' || job.status === 'expired') {
    return { ...base, error: job.error || job.status }
  }
  return base
}

// Periodic TTL sweep — clears finished jobs the client never came back for,
// and stops zombies that somehow never exited.
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.status === 'processing' || job.status === 'awaiting-payment') {
        finalize(job, { status: 'error', error: 'job ttl exceeded' })
      }
      jobs.delete(id)
    }
  }
}, 60_000).unref()

/**
 * Read any *.json files in outDir, parse, verify, and return the first valid
 * keypair. SolVanityCL's save_keypair writes a 64-element JSON array
 * [..32 private bytes.., ..32 public bytes..] under <pubkey>.json.
 */
function harvest(outDir, prefix, suffix, caseSensitive) {
  let files
  try {
    files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'))
  } catch {
    return null
  }
  for (const f of files) {
    const full = path.join(outDir, f)
    let raw
    try { raw = fs.readFileSync(full, 'utf8') }
    catch (e) { console.warn(`[generate] could not read ${f}: ${e.message}`); continue }

    let parsed
    try { parsed = JSON.parse(raw) }
    catch (e) { console.warn(`[generate] bad JSON in ${f}: ${e.message}`); continue }

    if (!Array.isArray(parsed) || parsed.length !== 64) {
      console.warn(`[generate] ${f}: expected 64-int array, got ${typeof parsed}` +
        (Array.isArray(parsed) ? ` length=${parsed.length}` : ''))
      continue
    }

    const fullKey = Uint8Array.from(parsed)
    const address = path.basename(f, '.json')

    let derivedPubBytes
    try { derivedPubBytes = nacl.sign.keyPair.fromSecretKey(fullKey).publicKey }
    catch (e) { console.warn(`[generate] tweetnacl rejected ${f}: ${e.message}`); continue }

    let derivedPub
    try { derivedPub = bs58.encode(derivedPubBytes) }
    catch (e) {
      console.warn(`[generate] bs58.encode threw — check bs58 interop: ${e.message}`)
      continue
    }
    if (derivedPub !== address) {
      console.warn(`[generate] derived pubkey ${derivedPub} != filename ${address}`)
      continue
    }

    const cmp = caseSensitive ? address : address.toLowerCase()
    const pfx = caseSensitive ? prefix  : prefix.toLowerCase()
    const sfx = caseSensitive ? suffix  : suffix.toLowerCase()
    if (pfx && !cmp.startsWith(pfx)) { continue }
    if (sfx && !cmp.endsWith(sfx))   { continue }

    return { publicKey: address, secretKey: bs58.encode(fullKey) }
  }
  return null
}

module.exports = {
  startGenerateJob,
  getGenerateJob,
  cancelGenerateJob,
  MAX_BOTH,
  MAX_SINGLE,
}
