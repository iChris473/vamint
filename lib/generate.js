'use strict'

/**
 * Async, polling-friendly wrapper around SolVanityCL.
 *
 *   startGenerateJob({ prefix, suffix, caseSensitive }) → job
 *   getGenerateJob(jobId)                               → state | null
 *   cancelGenerateJob(jobId)                            → bool
 *
 * Flow (kind:'wallet' — the default):
 *   1. start creates the job with a FRESH deposit wallet, spawns
 *      SolVanityCL IMMEDIATELY in the background, and returns
 *      status:'awaiting-payment' plus the deposit address. Grinding and
 *      payment race each other so the wallet is ready the moment the
 *      deposit lands.
 *   2. When the grind finishes first, the keypair is HELD server-side
 *      (never surfaced) and the job stays 'awaiting-payment' with
 *      ready:true.
 *   3. Payment confirms via the background poller or the explicit
 *      POST /:jobId/confirm button. Once the deposit holds FEE_USD ($5)
 *      worth of FEE_TOKEN_MINT (quoted at job creation): ground already →
 *      'done' (keys released); still grinding → 'processing' → 'done'.
 *      The deposit is swept to the treasury the moment payment confirms —
 *      the treasury co-signs as fee payer since the deposit holds no SOL.
 *   4. If the window expires unpaid → 'expired' and any held keys are
 *      wiped.
 *
 * Flow (kind:'token'): grinding starts immediately with no deposit; the
 * 0.1 SOL fee is collected at Pump.fun launch time instead. The CA secret
 * never leaves the server (escrowed for the launch).
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
  tokenPaymentReceived,
  getFeeTokenQuote,
  sweepDepositToTreasury,
  FEE_USD,
  FEE_TOKEN_MINT,
} = require('./solana')
const deposits = require('./deposits')

const SWEEP_RETRY_ATTEMPTS = 3
const SWEEP_RETRY_DELAY_MS = 10_000

const REPO_DEFAULT = path.resolve(__dirname, '..', 'SolVanityCL')
const PYTHON      = process.env.GRINDER_PYTHON     || 'python3'
const ENGINE_DIR  = process.env.GRINDER_ENGINE_DIR || REPO_DEFAULT
const ENTRY       = process.env.GRINDER_ENTRY      || path.join(ENGINE_DIR, 'main.py')
const WORK_BASE   = process.env.GRINDER_WORK_DIR   || path.join(os.tmpdir(), 'vamint-gen')
const POLL_MS     = 200
const JOB_TTL_MS  = Number(process.env.GENERATE_TTL_MS) || 30 * 60 * 1000

// Wallet generations are gated behind a per-request deposit of FEE_USD ($5)
// worth of the project token (FEE_TOKEN_MINT), quoted at the market price
// when the job is created. A fresh deposit wallet is minted for every
// request; keys release only after its token balance reaches the quote.
const PAYMENT_TIMEOUT_MS = (Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 900) * 1000
const PAYMENT_POLL_MS = 4000

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

async function startGenerateJob(rawSpec) {
  if (!fs.existsSync(ENTRY)) {
    throw makeErr(500,
      `SolVanityCL entry not found at ${ENTRY}. ` +
      `Set GRINDER_ENTRY or ensure the repo lives at ${REPO_DEFAULT}.`)
  }
  const spec = validateSpec(rawSpec)
  const kind = rawSpec && rawSpec.kind === 'token' ? 'token' : 'wallet'

  // Quote the unlock fee BEFORE creating anything — if pricing is down we
  // want to fail the request, not strand a deposit-less job.
  let feeToken = null
  if (kind === 'wallet') {
    try {
      feeToken = await getFeeTokenQuote()
    } catch (e) {
      throw makeErr(502, `could not price the unlock fee: ${e.message}`)
    }
  }

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
    paid: false,
    ground: false,
    grindMs: null,
    feeToken,
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
    // Durable copy of the deposit secret — a crash or failed sweep must
    // never strand user funds in a wallet only this process could sign for.
    deposits.record({ jobId: id, pubkey: deposit.publicKey, secret: deposit.secretKey })
    console.log(
      `[generate] job ${id} awaiting ~${feeToken.uiAmount} tokens ` +
      `($${feeToken.usd} of ${FEE_TOKEN_MINT.slice(0, 6)}…) at ${deposit.publicKey} ` +
      `(grinding starts now, keys held until paid)`,
    )
    watchPayment(job)
  }
  // Grind immediately for BOTH kinds — wallet keys are simply held until
  // the deposit confirms.
  launchEngine(job)

  return publicView(job)
}

// Deposit confirmed: sweep it to the treasury immediately, then release held
// keys or keep grinding with the gate open.
function markPaid(job) {
  if (job.paid) return
  job.paid = true
  if (job.payPoller) { clearInterval(job.payPoller); job.payPoller = null }
  sweepDeposit(job)
  if (job.ground) {
    job.status = 'done'
    console.log(`[generate] job ${job.id} deposit confirmed → wallet released`)
  } else {
    job.status = 'processing'
    console.log(`[generate] job ${job.id} deposit confirmed → still grinding`)
  }
  job.updatedAt = Date.now()
}

// Poll the job's fresh deposit wallet until the fee lands.
function watchPayment(job) {
  let inFlight = false
  job.payPoller = setInterval(async () => {
    if (job.status !== 'awaiting-payment') {
      clearInterval(job.payPoller)
      job.payPoller = null
      return
    }
    if (Date.now() > job.paymentDeadline) {
      // wipe any held keys — nothing was paid for
      finalize(job, {
        status: 'expired',
        error: 'deposit window expired — no payment received',
        secretKey: null,
      })
      return
    }
    if (inFlight) return
    inFlight = true
    try {
      const paid = await tokenPaymentReceived(job.depositPubkey, job.feeToken.amountRaw)
      if (paid && job.status === 'awaiting-payment') markPaid(job)
    } catch (err) {
      // transient RPC failures are non-fatal; the next tick retries
      console.warn(`[generate] payment poll failed for ${job.id}: ${err.message}`)
    } finally {
      inFlight = false
    }
  }, PAYMENT_POLL_MS)
}

/**
 * Explicit "I've sent it" confirmation from the frontend button — checks the
 * deposit balance right now instead of waiting for the next poller tick.
 * Returns the job's publicView (status tells the caller whether it worked),
 * or null for unknown jobs.
 */
async function confirmGeneratePayment(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  if (job.kind !== 'wallet') throw makeErr(400, 'token jobs have no deposit to confirm')
  if (job.status === 'awaiting-payment') {
    try {
      const paid = await tokenPaymentReceived(job.depositPubkey, job.feeToken.amountRaw)
      if (paid && job.status === 'awaiting-payment') markPaid(job)
    } catch (err) {
      throw makeErr(502, `could not verify payment (Solana RPC error): ${err.message}`)
    }
  }
  return publicView(job)
}

// Forward the deposit's tokens (and any stray SOL / rent) to the treasury.
// The treasury pays the network fee — the deposit wallet holds no SOL.
// Retries a few times in-process; beyond that, the recovery scanner in
// lib/deposits.js keeps retrying from the durable ledger.
function sweepDeposit(job, attempt = 1) {
  if (!job.depositSecret) return
  sweepDepositToTreasury(job.depositSecret)
    .then(r => {
      if (!r) return
      deposits.markSwept(job.depositPubkey, r.signature)
      console.log(
        `[generate] swept deposit for ${job.id}: ${r.tokensRaw} raw tokens, ` +
        `${r.lamports} lamports (${r.signature})`,
      )
    })
    .catch(err => {
      console.warn(`[generate] sweep failed for ${job.id} (attempt ${attempt}/${SWEEP_RETRY_ATTEMPTS}): ${err.message}`)
      if (attempt < SWEEP_RETRY_ATTEMPTS) {
        setTimeout(() => sweepDeposit(job, attempt + 1), SWEEP_RETRY_DELAY_MS).unref?.()
      } else {
        console.warn(`[generate] sweep retries exhausted for ${job.id} — the deposit recovery scanner will keep retrying ${job.depositPubkey}`)
      }
    })
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

  const grindActive = () =>
    !job.ground && (job.status === 'processing' || job.status === 'awaiting-payment')

  const tryHarvest = () => {
    if (!grindActive()) return true
    const result = harvest(outDir, spec.prefix, spec.suffix, spec.caseSensitive)
    if (!result) return false
    job.ground = true
    job.grindMs = Date.now() - job.grindStartedAt
    job.publicKey = result.publicKey
    job.secretKey = result.secretKey
    stopEngine(job)
    if (job.kind === 'token' || job.paid) {
      job.status = 'done'
      console.log(`[generate] job ${id} done → ${result.publicKey}`)
    } else {
      // Ground before the deposit landed — hold the keys server-side and
      // keep awaiting payment. publicView never exposes them until paid.
      console.log(`[generate] job ${id} ground → ${result.publicKey} (held until deposit confirms)`)
    }
    job.updatedAt = Date.now()
    return true
  }

  job.poller = setInterval(tryHarvest, POLL_MS)

  proc.on('error', e => {
    if (!grindActive()) return
    finalize(job, { status: 'error', error: `engine spawn failed: ${e.message}` })
  })

  proc.on('exit', code => {
    // SolVanityCL flushes the JSON ~just as it exits; give the poller a last
    // shot before declaring failure.
    setTimeout(() => {
      if (!grindActive()) return
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

/**
 * Hand the escrowed CA keypair of a finished token-kind job to the deploy
 * flow. Server-side only — this secret never crosses the HTTP API. Returns
 * null if the job is unknown, not a token grind, or not done yet.
 */
function getEscrowedTokenKeypair(jobId) {
  const job = jobs.get(jobId)
  if (!job || job.kind !== 'token') return null
  if (job.status !== 'done' || !job.secretKey) return null
  return { publicKey: job.publicKey, secretKey: job.secretKey }
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

// Stop the engine process/poller and wipe the tmp output dir. Safe to call
// on jobs whose engine already stopped.
function stopEngine(job) {
  if (job.poller) { clearInterval(job.poller); job.poller = null }
  if (job.proc)   { try { job.proc.kill('SIGTERM') } catch { /* dead already */ }; job.proc = null }
  try { fs.rmSync(job.outDir, { recursive: true, force: true }) } catch { /* swallow */ }
}

function finalize(job, patch) {
  Object.assign(job, patch)
  job.updatedAt = Date.now()
  stopEngine(job)
  if (job.payPoller) { clearInterval(job.payPoller); job.payPoller = null }
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
      // ready:true → grind already finished; keys are held and release
      // instantly on payment. Never leak the keys themselves here.
      ready: !!job.ground,
      deposit: {
        address: job.depositPubkey,
        mint: job.feeToken.mint,
        amount: job.feeToken.uiAmount,
        amountRaw: job.feeToken.amountRaw,
        decimals: job.feeToken.decimals,
        usd: job.feeToken.usd,
      },
      paymentExpiresAt: job.paymentDeadline,
    }
  }
  if (job.status === 'done') {
    if (job.kind === 'token') {
      // Token-CA grinds are free at request time, so the secret must never
      // leave the server — otherwise this endpoint is a free wallet grinder.
      // The CA secret stays escrowed here until launch.
      return { ...base, publicKey: job.publicKey, grindMs: job.grindMs }
    }
    // wallet jobs only reach 'done' once paid
    return { ...base, publicKey: job.publicKey, secretKey: job.secretKey, grindMs: job.grindMs }
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
  confirmGeneratePayment,
  getEscrowedTokenKeypair,
  MAX_BOTH,
  MAX_SINGLE,
}
