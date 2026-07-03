'use strict'

/**
 * Durable record of every fresh deposit wallet, so a crash, restart, or
 * failed sweep can never strand funds. Entries are appended at job creation
 * and written through to a JSON file (secrets inside — keep it out of git
 * and readable only by the service user).
 *
 *   { jobId, pubkey, secret, minRaw, deadline, createdAt, paid?, status,
 *     sweptSig?, sweptAt?, refundSig?, refundedTo?, refundedAt? }
 *   status: 'pending' → 'swept' | 'refunded' | 'empty'
 *
 * retryUnswept() re-checks every pending deposit. The paid flag decides
 * where a balance goes: paid → treasury sweep; NOT paid (expired
 * underpayment, or a crash before the job could confirm) → refund back to
 * the sender. Zero-balance entries close as 'empty' once old enough.
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  sweepDepositToTreasury,
  refundDeposit,
  tokenBalanceRaw,
  getBalanceLamports,
} = require('./solana')

const FILE = process.env.DEPOSITS_FILE || path.join(__dirname, '..', 'deposits.json')
// Zero-balance deposits younger than this stay 'pending' (a payment may
// still be in flight); older ones are closed as 'empty'.
const EMPTY_AFTER_MS = 24 * 60 * 60 * 1000

let entries = null

function load() {
  if (entries) return entries
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    entries = Array.isArray(parsed) ? parsed : []
  } catch {
    entries = []
  }
  return entries
}

function persist() {
  fs.writeFileSync(FILE, JSON.stringify(entries, null, 2), { mode: 0o600 })
}

function record({ jobId, pubkey, secret, minRaw = null, deadline = null }) {
  load()
  entries.push({
    jobId, pubkey, secret, minRaw, deadline,
    createdAt: Date.now(), paid: false, status: 'pending',
  })
  persist()
}

function markPaid(pubkey) {
  load()
  const e = entries.find(x => x.pubkey === pubkey && x.status === 'pending')
  if (!e) return
  e.paid = true
  persist()
}

function markSwept(pubkey, signature) {
  load()
  const e = entries.find(x => x.pubkey === pubkey && x.status === 'pending')
  if (!e) return
  e.status = 'swept'
  e.sweptSig = signature
  e.sweptAt = Date.now()
  persist()
}

function markRefunded(pubkey, signature, to) {
  load()
  const e = entries.find(x => x.pubkey === pubkey && x.status === 'pending')
  if (!e) return
  e.status = 'refunded'
  e.refundSig = signature
  e.refundedTo = to
  e.refundedAt = Date.now()
  persist()
}

let running = false

async function retryUnswept() {
  if (running) return { skipped: 'a recovery pass is already running' }
  running = true
  const summary = { checked: 0, swept: 0, refunded: 0, empty: 0, failed: 0 }
  try {
    load()
    for (const e of entries) {
      if (e.status !== 'pending') continue
      summary.checked++
      try {
        const [tokens, lamports] = await Promise.all([
          tokenBalanceRaw(e.pubkey),
          getBalanceLamports(e.pubkey),
        ])
        if (tokens === 0n && lamports === 0) {
          if (Date.now() - e.createdAt > EMPTY_AFTER_MS) {
            e.status = 'empty'
            persist()
            summary.empty++
          }
          continue
        }
        // Where the balance goes depends on whether the payment was ever
        // accepted AND the wallet released (the paid flag). Unpaid money is
        // NOT ours — an underpayment, or a payment the process died before
        // confirming (user got nothing) — it goes back to the sender.
        if (e.paid) {
          const r = await sweepDepositToTreasury(e.secret)
          if (r) {
            e.status = 'swept'
            e.sweptSig = r.signature
            e.sweptAt = Date.now()
            persist()
            summary.swept++
            console.log(
              `[deposits] recovered sweep for ${e.pubkey}: ` +
              `${r.tokensRaw} raw tokens, ${r.lamports} lamports (${r.signature})`,
            )
          }
        } else {
          // don't refund while the user may still be mid-payment
          const deadline = e.deadline || e.createdAt + 15 * 60 * 1000
          if (Date.now() < deadline + 60_000) continue
          const r = await refundDeposit(e.secret)
          if (r) {
            e.status = 'refunded'
            e.refundSig = r.signature
            e.refundedTo = r.to
            e.refundedAt = Date.now()
            persist()
            summary.refunded++
            console.log(
              `[deposits] refunded underpayment for ${e.pubkey}: ` +
              `${r.tokensRaw} raw tokens → ${r.to} (${r.signature})`,
            )
          }
        }
      } catch (err) {
        summary.failed++
        console.warn(`[deposits] recovery failed for ${e.pubkey}: ${err.message}`)
      }
    }
  } finally {
    running = false
  }
  return summary
}

module.exports = { record, markPaid, markSwept, markRefunded, retryUnswept, FILE }
