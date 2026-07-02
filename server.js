'use strict'

require('dotenv').config()

const express = require('express')
const cors = require('cors')
const { isValidBase58 } = require('./lib/base58-helpers')
const { JobStore } = require('./lib/jobs')
const { GrinderClient } = require('./lib/worker')
const {
  startGenerateJob,
  getGenerateJob,
  cancelGenerateJob,
  confirmGeneratePayment,
} = require('./lib/generate')
const {
  newDepositWallet,
  paymentReceived,
  forwardBalance,
  treasuryConfigStatus,
  LAMPORTS_PER_SOL,
} = require('./lib/solana')
const deposits = require('./lib/deposits')

const PORT = Number(process.env.PORT) || 4000
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const CLAIM_FEE_LAMPORTS = Number(process.env.CLAIM_FEE_LAMPORTS) || 100_000_000
const PAYMENT_TIMEOUT_SECONDS = Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 900
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS) || 1800
const OPERATOR_WALLET = process.env.OPERATOR_WALLET || ''

const app = express()
// CORS_ORIGIN accepts '*', a single origin, or a comma-separated list. A
// permissive default is fine — the API surface holds no credentials and the
// claim flow is gated by on-chain payment, not browser origin.
const corsOrigins =
  CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({ origin: corsOrigins }))
app.use(express.json({ limit: '8kb' }))

const jobs = new JobStore({ ttlSeconds: JOB_TTL_SECONDS })

const grinder = new GrinderClient({
  onProgress: (id, attempts) => jobs.update(id, { attempts, status: 'grinding' }),
  onFound: (id, result) => {
    jobs.update(id, {
      status: 'awaiting-payment',
      address: result.address,
      secretKey: result.secretKey,
    })
    pollPayment(id).catch(err =>
      console.error(`[server] payment polling crash for ${id}:`, err),
    )
  },
  onError: (id, message) => jobs.update(id, { status: 'failed', error: message }),
})

// Per-job SSE subscribers
const sseClients = new Map() // jobId -> Set<res>

jobs.on('change', job => {
  const subs = sseClients.get(job.id)
  if (!subs) return
  const payload = `data: ${JSON.stringify(jobs.publicView(job))}\n\n`
  for (const res of subs) {
    try {
      res.write(payload)
    } catch {
      subs.delete(res)
    }
  }
})

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    grinder: grinder.cpuFallback ? 'cpu' : grinder.procReady ? 'cuda' : 'cuda-down',
    activeJobs: grinder.active.size,
    queued: grinder.queue.length,
  })
})

/**
 * Asynchronous vanity-key generation.
 *
 *   POST /api/generate { prefix?, suffix?, caseSensitive?, kind? }
 *     kind:'wallet' (default) → 202 { jobId, status:'awaiting-payment',
 *                                     deposit:{ address, mint, amount,
 *                                               amountRaw, decimals, usd } }
 *       A fresh deposit wallet is minted per request. Grinding starts
 *       IMMEDIATELY in the background, but the keys are held server-side
 *       and only released once the deposit holds FEE_USD ($5) worth of
 *       FEE_TOKEN_MINT (quoted at request time) — detected by the
 *       background poller or POST /confirm. On confirmation the deposit
 *       is swept to TREASURY_WALLET, with the treasury paying the fee.
 *     kind:'token'            → 202 { jobId, status:'processing', ... }
 *       Unchanged: grinds immediately, fee collected at Pump.fun launch.
 *
 *   GET  /api/generate/:jobId
 *     → 200 { status:'awaiting-payment', deposit, paymentExpiresAt, ... }
 *           { status:'processing', elapsedMs, ... }
 *           { status:'done', publicKey, secretKey, ... }
 *             (kind:'token' → publicKey only; the CA secret never leaves
 *              the server, so the free token flow can't mint free wallets)
 *           { status:'error' | 'cancelled' | 'expired', error, ... }
 *     → 404 if unknown / expired from the store
 *
 *   DELETE /api/generate/:jobId
 *     → 200 { ok:true } — kills the in-flight Python process and wipes state
 *
 * Validation (mirrored on the frontend):
 *   • base58 charset only (no 0, O, I, l)
 *   • prefix + suffix together → max 3 chars each
 *   • prefix or suffix alone   → max 5 chars
 */
app.post('/api/generate', async (req, res) => {
  try {
    const job = await startGenerateJob(req.body || {})
    res.status(202).json(job)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

app.get('/api/generate/:jobId', (req, res) => {
  const job = getGenerateJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'job not found or expired' })
  res.json(job)
})

// Re-attempt sweeps for every pending deposit in the durable ledger. Safe to
// expose: sweeps can only ever move funds TO the treasury. Also runs
// automatically at boot and every 10 minutes.
app.post('/api/sweeps/retry', async (_req, res) => {
  try {
    res.json(await deposits.retryUnswept())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// "Confirm transaction" button: check the deposit balance right now rather
// than waiting for the background poller. Responds with the fresh job view —
// status 'done'/'processing' means the payment landed, 'awaiting-payment'
// means nothing has arrived yet.
app.post('/api/generate/:jobId/confirm', async (req, res) => {
  try {
    const view = await confirmGeneratePayment(req.params.jobId)
    if (!view) return res.status(404).json({ error: 'job not found or expired' })
    res.json(view)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

app.delete('/api/generate/:jobId', (req, res) => {
  const ok = cancelGenerateJob(req.params.jobId)
  if (!ok) return res.status(404).json({ error: 'job not found' })
  res.json({ ok: true })
})

app.post('/api/jobs', (req, res) => {
  const { prefix = '', suffix = '', caseSensitive = true } = req.body || {}
  if (typeof prefix !== 'string' || typeof suffix !== 'string') {
    return res.status(400).json({ error: 'prefix and suffix must be strings' })
  }
  if (!prefix && !suffix) {
    return res.status(400).json({ error: 'at least one of prefix/suffix is required' })
  }
  if (prefix.length + suffix.length > 8) {
    return res.status(400).json({ error: 'combined prefix+suffix may not exceed 8 chars' })
  }
  if (!isValidBase58(prefix) || !isValidBase58(suffix)) {
    return res.status(400).json({ error: 'prefix/suffix must be base58 (no 0, O, I, l)' })
  }
  const deposit = newDepositWallet()
  const job = jobs.create({
    prefix,
    suffix,
    caseSensitive: !!caseSensitive,
    depositPubkey: deposit.publicKey,
    depositSecret: deposit.secretKey,
  })
  grinder.submit(job)
  res.status(201).json({
    job: jobs.publicView(job),
    deposit: { pubkey: deposit.publicKey, lamports: CLAIM_FEE_LAMPORTS },
  })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'not found' })
  res.json({
    job: jobs.publicView(job),
    deposit: { pubkey: job.depositPubkey, lamports: CLAIM_FEE_LAMPORTS },
  })
})

// Server-Sent Events: live progress + status changes for a single job.
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).end()
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.flushHeaders()
  res.write(`data: ${JSON.stringify(jobs.publicView(job))}\n\n`)
  if (!sseClients.has(job.id)) sseClients.set(job.id, new Set())
  sseClients.get(job.id).add(res)
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n')
    } catch {
      /* connection gone */
    }
  }, 25_000)
  req.on('close', () => {
    clearInterval(keepalive)
    const set = sseClients.get(job.id)
    if (set) {
      set.delete(res)
      if (set.size === 0) sseClients.delete(job.id)
    }
  })
})

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'not found' })
  grinder.cancel(job.id)
  jobs.update(job.id, { status: 'cancelled', secretKey: null })
  res.json({ ok: true })
})

// Reveal the vanity wallet's secret — only valid once, only after payment.
app.post('/api/jobs/:id/claim', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'not found' })
  if (job.status !== 'paid') {
    return res.status(409).json({ error: `job not claimable (status: ${job.status})` })
  }
  const redeemed = jobs.redeemSecret(job.id)
  if (!redeemed) return res.status(410).json({ error: 'secret no longer available' })

  // Best-effort: sweep deposit to operator wallet. Don't fail the claim on this.
  if (OPERATOR_WALLET && job.depositSecret) {
    forwardBalance(job.depositSecret, OPERATOR_WALLET)
      .then(r => r && console.log(`[server] swept ${r.lamports} lamports for ${job.id}`))
      .catch(err => console.warn(`[server] sweep failed for ${job.id}:`, err.message))
  }
  res.json({
    address: redeemed.address,
    secretKey: redeemed.secretKey,
    note: 'Save this secret key NOW. It will not be served again.',
  })
})

// ─── Payment polling ───────────────────────────────────────────────────────

async function pollPayment(jobId) {
  const deadline = Date.now() + PAYMENT_TIMEOUT_SECONDS * 1000
  while (Date.now() < deadline) {
    const job = jobs.get(jobId)
    if (!job || job.status === 'cancelled' || job.status === 'expired') return
    if (job.status === 'paid' || job.status === 'claimed') return
    try {
      const paid = await paymentReceived(job.depositPubkey, CLAIM_FEE_LAMPORTS)
      if (paid) {
        jobs.update(jobId, { status: 'paid', paymentDetectedAt: Date.now() })
        return
      }
    } catch (err) {
      console.warn(`[server] RPC error while polling ${jobId}:`, err.message)
    }
    await new Promise(r => setTimeout(r, 4000))
  }
  const job = jobs.get(jobId)
  if (job && job.status === 'awaiting-payment') {
    jobs.update(jobId, { status: 'expired', secretKey: null })
  }
}


// ── deploy token ──────────────────────────────────────────────────────────────
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage() })
const { mintTokenOnPumpFun } = require('./mintToken')

// POST /api/deploy  (multipart/form-data)
// fields: name, symbol, description, twitter, telegram, website, devBuySol
// file:   image
app.post('/api/deploy', upload.single('image'), async (req, res) => {
  try {
    const {
      name,
      symbol,
      description = '',
      twitter = '',
      telegram = '',
      website = '',
      devBuySol = '0',
      privateKey = '',
    } = req.body
    if (!name || !symbol) return res.status(400).json({ error: 'name and symbol are required' })
    if (!req.file)        return res.status(400).json({ error: 'image is required' })
    if (!privateKey || !isValidBase58(privateKey)) {
      return res.status(400).json({ error: 'valid base58 dev wallet privateKey is required' })
    }

    const result = await mintTokenOnPumpFun(
      req.file,
      name,
      symbol,
      description,
      { twitter, telegram, website },
      privateKey,
      parseFloat(devBuySol) || 0,
    )

    if (result.error) return res.status(500).json({ error: result.message })
    res.json({ ok: true, mint: result.ca, sig: result.signature, link: result.link })
  } catch (err) {
    console.error('[deploy]', err)
    res.status(500).json({ error: err.message })
  }
})

// ─── Boot ──────────────────────────────────────────────────────────────────

grinder.init().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] listening on :${PORT}`)
    console.log(`[server] grinder mode: ${grinder.cpuFallback ? 'CPU' : 'CUDA'}`)
    console.log(`[server] claim fee: ${CLAIM_FEE_LAMPORTS / LAMPORTS_PER_SOL} SOL`)
    const { FEE_USD, FEE_TOKEN_MINT, TREASURY_WALLET } = require('./lib/solana')
    console.log(`[server] wallet unlock fee: $${FEE_USD} of ${FEE_TOKEN_MINT}`)
    treasuryConfigStatus().then(s => {
      if (s.ok) {
        console.log(`[server] treasury: ${TREASURY_WALLET} (fee payer ready, ${s.lamports != null ? s.lamports / LAMPORTS_PER_SOL + ' SOL' : 'balance unknown'})`)
      } else {
        console.warn(`[server] ⚠ TREASURY MISCONFIGURED: ${s.reason}`)
      }
    })
    // Recover any deposits a previous run failed to sweep, then keep
    // scanning in the background.
    setTimeout(() => {
      deposits.retryUnswept()
        .then(r => console.log('[server] deposit recovery pass:', JSON.stringify(r)))
        .catch(e => console.warn('[server] deposit recovery pass failed:', e.message))
    }, 5000).unref()
    setInterval(() => {
      deposits.retryUnswept().catch(e => console.warn('[server] deposit recovery failed:', e.message))
    }, 10 * 60 * 1000).unref()
  })
})

function shutdown(sig) {
  console.log(`[server] ${sig} received, shutting down`)
  grinder.shutdown()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
