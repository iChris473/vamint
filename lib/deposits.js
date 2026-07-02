'use strict'

/**
 * Durable record of every fresh deposit wallet, so a crash, restart, or
 * failed sweep can never strand funds. Entries are appended at job creation
 * and written through to a JSON file (secrets inside — keep it out of git
 * and readable only by the service user).
 *
 *   { jobId, pubkey, secret, createdAt, status, sweptSig?, sweptAt? }
 *   status: 'pending' → 'swept' | 'empty'
 *
 * retryUnswept() re-checks every pending deposit: sweeps anything holding
 * tokens or SOL, and closes zero-balance entries once they're old enough
 * that no payment is coming.
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  sweepDepositToTreasury,
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

function record({ jobId, pubkey, secret }) {
  load()
  entries.push({ jobId, pubkey, secret, createdAt: Date.now(), status: 'pending' })
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

let running = false

async function retryUnswept() {
  if (running) return { skipped: 'a recovery pass is already running' }
  running = true
  const summary = { checked: 0, swept: 0, empty: 0, failed: 0 }
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
      } catch (err) {
        summary.failed++
        console.warn(`[deposits] retry sweep failed for ${e.pubkey}: ${err.message}`)
      }
    }
  } finally {
    running = false
  }
  return summary
}

module.exports = { record, markSwept, retryUnswept, FILE }
