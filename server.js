'use strict'

require('dotenv').config()

const express = require('express')
const cors = require('cors')
const { isValidBase58 } = require('./lib/base58-helpers')
const { JobStore } = require('./lib/jobs')
const { GrinderClient } = require('./lib/worker')
const { generateVanityKeypair } = require('./lib/generate')
const {
  newDepositWallet,
  paymentReceived,
  forwardBalance,
  LAMPORTS_PER_SOL,
} = require('./lib/solana')

const PORT = Number(process.env.PORT) || 4000
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const CLAIM_FEE_LAMPORTS = Number(process.env.CLAIM_FEE_LAMPORTS) || 100_000_000
const PAYMENT_TIMEOUT_SECONDS = Number(process.env.PAYMENT_TIMEOUT_SECONDS) || 900
const JOB_TTL_SECONDS = Number(process.env.JOB_TTL_SECONDS) || 1800
const OPERATOR_WALLET = process.env.OPERATOR_WALLET || ''

const app = express()
app.use(cors({ origin: CORS_ORIGIN }))
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
 * Direct, synchronous vanity-key generation. Spawns SolVanityCL, waits for
 * the keypair, returns base58 publicKey + secretKey strings to the client.
 *
 * No deposit address, no payment flow, no SSE — useful for testing the
 * GPU pipeline end-to-end and for free/internal flows. The paid flow still
 * lives under POST /api/jobs.
 *
 * Body: { prefix?: string, suffix?: string, caseSensitive?: boolean }
 * 200:  { publicKey: string, secretKey: string }
 * 4xx/5xx: { error: string }
 */
app.post('/api/generate', async (req, res) => {
  const { prefix = '', suffix = '', caseSensitive = true } = req.body || {}
  const ac = new AbortController()
  // Two distinct close signals — guarded so a *normal* completion doesn't abort:
  //   req fires when the request stream ends (normal POST body finish), so we
  //     only abort if the body was cut off mid-upload (req.complete = false).
  //   res fires when the response socket closes; abort if we hadn't written
  //     the full response yet (writableEnded = false → client disconnected).
  req.on('close', () => { if (!req.complete) ac.abort() })
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  try {
    const result = await generateVanityKeypair({
      prefix, suffix, caseSensitive: !!caseSensitive, signal: ac.signal,
    })
    res.json(result)
  } catch (e) {
    const status = e.status || 500
    res.status(status).json({ error: e.message })
  }
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

// ─── Boot ──────────────────────────────────────────────────────────────────

grinder.init().then(() => {
  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`)
    console.log(`[server] grinder mode: ${grinder.cpuFallback ? 'CPU' : 'CUDA'}`)
    console.log(`[server] claim fee: ${CLAIM_FEE_LAMPORTS / LAMPORTS_PER_SOL} SOL`)
  })
})

function shutdown(sig) {
  console.log(`[server] ${sig} received, shutting down`)
  grinder.shutdown()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
