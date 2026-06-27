'use strict'

/**
 * generateVanityKeypair — fire-and-await wrapper around SolVanityCL.
 *
 *   const { publicKey, secretKey } = await generateVanityKeypair({
 *     prefix: 'sol', suffix: '', caseSensitive: true,
 *   })
 *
 * Spawns:
 *   ${GRINDER_PYTHON} ${GRINDER_ENTRY} search-pubkey
 *     --starts-with <prefix>  [--ends-with <suffix>]
 *     --count 1 --output-dir <per-request tmp dir>
 *     --is-case-sensitive <true|false>
 *
 * SolVanityCL writes `<pubkey>.json` into the output dir as soon as it lands
 * a match — a 64-byte array `[..32 secret.., ..32 public..]`. We poll the dir
 * (200ms), read the file, derive the public key from the secret with
 * tweetnacl, and confirm the prefix/suffix still hold before returning. The
 * output dir is rm'd in `finally` so the secret never lingers on disk.
 *
 * Errors thrown carry a `.status` for the route to surface to the client.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { nanoid } = require('nanoid')
const nacl = require('tweetnacl')
const bs58 = require('bs58')
const { isValidBase58 } = require('./base58-helpers')

// Defaults assume the SolVanityCL repo lives at backend/SolVanityCL/
// (matching where you cloned it). Override any of these via env.
const REPO_DEFAULT = path.resolve(__dirname, '..', 'SolVanityCL')
const PYTHON     = process.env.GRINDER_PYTHON     || 'python3'
const ENGINE_DIR = process.env.GRINDER_ENGINE_DIR || REPO_DEFAULT
const ENTRY      = process.env.GRINDER_ENTRY      || path.join(ENGINE_DIR, 'main.py')
const WORK_BASE  = process.env.GRINDER_WORK_DIR   || path.join(os.tmpdir(), 'vamint-gen')
const TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS) || 5 * 60 * 1000
const POLL_MS    = 200

function err(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

async function generateVanityKeypair({
  prefix = '',
  suffix = '',
  caseSensitive = true,
  signal,
} = {}) {
  prefix = String(prefix || '')
  suffix = String(suffix || '')

  // ─── validate ────────────────────────────────────────────────────────────
  if (!prefix && !suffix) {
    throw err(400, 'at least one of prefix/suffix is required')
  }
  if (!isValidBase58(prefix) || !isValidBase58(suffix)) {
    throw err(400, 'prefix/suffix must use base58 chars only (no 0, O, I, l)')
  }
  if (prefix.length + suffix.length > 8) {
    throw err(400, 'combined prefix+suffix may not exceed 8 chars')
  }
  if (!fs.existsSync(ENTRY)) {
    throw err(500,
      `SolVanityCL entry not found at ${ENTRY}. ` +
      `Set GRINDER_ENTRY or ensure the repo lives at ${REPO_DEFAULT}.`)
  }

  // ─── per-request output dir ──────────────────────────────────────────────
  fs.mkdirSync(WORK_BASE, { recursive: true })
  const outDir = path.join(WORK_BASE, `gen-${nanoid(10)}`)
  fs.mkdirSync(outDir, { recursive: true })

  const args = [ENTRY, 'search-pubkey']
  if (prefix) args.push('--starts-with', prefix)
  if (suffix) args.push('--ends-with', suffix)
  args.push('--count', '1')
  args.push('--output-dir', outDir)
  args.push('--is-case-sensitive', caseSensitive ? 'true' : 'false')

  // ─── spawn engine ────────────────────────────────────────────────────────
  const proc = spawn(PYTHON, args, {
    cwd: ENGINE_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderrTail = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2048) })
  // We don't need stdout for correctness; drain it so the pipe doesn't fill.
  proc.stdout?.on('data', () => {})

  try {
    return await new Promise((resolve, reject) => {
      let done = false
      let timer = null
      let abortHandler = null
      const finish = (settle, value) => {
        if (done) return
        done = true
        clearInterval(poller)
        if (timer) clearTimeout(timer)
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
        try { proc.kill('SIGTERM') } catch { /* already gone */ }
        settle(value)
      }

      const tryHarvest = () => {
        if (done) return false
        const result = harvest(outDir, prefix, suffix, caseSensitive)
        if (!result) return false
        finish(resolve, result)
        return true
      }

      const poller = setInterval(tryHarvest, POLL_MS)

      timer = setTimeout(() => {
        finish(reject, err(504,
          `generation timed out after ${Math.round(TIMEOUT_MS / 1000)}s`))
      }, TIMEOUT_MS)

      if (signal) {
        if (signal.aborted) {
          finish(reject, err(499, 'client aborted'))
          return
        }
        abortHandler = () => finish(reject, err(499, 'client aborted'))
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      proc.on('error', e =>
        finish(reject, err(500, `engine spawn failed: ${e.message}`)))

      proc.on('exit', code => {
        // SolVanityCL writes the JSON ~just as it exits; give the poller one
        // last chance before declaring failure.
        setTimeout(() => {
          if (done) return
          if (tryHarvest()) return
          const tail = stderrTail.trim().slice(-300)
          finish(reject, err(500,
            `engine exited code=${code} without a result` +
            (tail ? ` (stderr: ${tail})` : '')))
        }, 350)
      })
    })
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* swallow */ }
  }
}

/**
 * Read any *.json files in outDir, parse, verify, and return the first valid
 * keypair as { publicKey, secretKey } (both base58 strings).
 *
 * SolVanityCL's save_keypair writes a 64-element JSON array of the form
 * [..32 private bytes.., ..32 public bytes..] under <pubkey>.json (see
 * SolVanityCL/core/utils/crypto.py:save_keypair).
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
    try { raw = fs.readFileSync(full, 'utf8') } catch { continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch { continue }
    if (!Array.isArray(parsed) || parsed.length !== 64) continue

    const fullKey = Uint8Array.from(parsed)
    const address = path.basename(f, '.json')

    // tweetnacl wants the 64-byte "secret key" form (seed||pub). SolVanityCL
    // already writes exactly that layout, so we can hand it straight in.
    let derivedPub
    try {
      derivedPub = bs58.encode(nacl.sign.keyPair.fromSecretKey(fullKey).publicKey)
    } catch {
      continue
    }
    if (derivedPub !== address) continue

    const cmp = caseSensitive ? address : address.toLowerCase()
    const pfx = caseSensitive ? prefix : prefix.toLowerCase()
    const sfx = caseSensitive ? suffix : suffix.toLowerCase()
    if (pfx && !cmp.startsWith(pfx)) continue
    if (sfx && !cmp.endsWith(sfx)) continue

    return { publicKey: address, secretKey: bs58.encode(fullKey) }
  }
  return null
}

module.exports = { generateVanityKeypair }
