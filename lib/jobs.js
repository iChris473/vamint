const { EventEmitter } = require('node:events')
const { nanoid } = require('nanoid')

const TERMINAL = new Set(['found', 'failed', 'expired', 'cancelled'])

class JobStore extends EventEmitter {
  constructor({ ttlSeconds = 1800 } = {}) {
    super()
    this.jobs = new Map()
    this.ttlMs = ttlSeconds * 1000
    setInterval(() => this.sweep(), 60_000).unref()
  }

  create(spec) {
    const id = nanoid(12)
    const now = Date.now()
    const job = {
      id,
      prefix: spec.prefix || '',
      suffix: spec.suffix || '',
      caseSensitive: !!spec.caseSensitive,
      status: 'queued',
      attempts: 0,
      address: null,
      // The vanity wallet's secret key is held ONLY in memory and is wiped
      // the moment it's claimed or the job is purged. Never persisted.
      secretKey: null,
      depositPubkey: spec.depositPubkey || null,
      depositSecret: spec.depositSecret || null,
      paymentDetectedAt: null,
      claimedAt: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.jobs.set(id, job)
    this.emit('change', job)
    return job
  }

  get(id) {
    return this.jobs.get(id) || null
  }

  update(id, patch) {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch, { updatedAt: Date.now() })
    this.emit('change', job)
    return job
  }

  /** Returns a redacted view safe to send to the client (no secrets). */
  publicView(job) {
    if (!job) return null
    return {
      id: job.id,
      prefix: job.prefix,
      suffix: job.suffix,
      caseSensitive: job.caseSensitive,
      status: job.status,
      attempts: job.attempts,
      address: job.address,
      depositPubkey: job.depositPubkey,
      paymentDetectedAt: job.paymentDetectedAt,
      claimedAt: job.claimedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
    }
  }

  /** Mark a job claimed and return the secret exactly once. */
  redeemSecret(id) {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'paid' || !job.secretKey) return null
    const secret = job.secretKey
    job.secretKey = null
    job.status = 'claimed'
    job.claimedAt = Date.now()
    this.emit('change', job)
    return { address: job.address, secretKey: secret }
  }

  sweep() {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (job.expiresAt < now && !TERMINAL.has(job.status)) {
        job.status = 'expired'
        job.secretKey = null
        this.emit('change', job)
      }
      if (TERMINAL.has(job.status) && now - job.updatedAt > 10 * 60_000) {
        this.jobs.delete(job.id)
      }
    }
  }
}

module.exports = { JobStore }
