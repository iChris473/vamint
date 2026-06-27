'use strict'

/**
 * CPU fallback grinder for dev machines without CUDA. Each Worker thread runs
 * this file; the parent posts {type:'start', prefix, suffix, caseSensitive}
 * and we loop generating tweetnacl keypairs until a match. Progress is
 * reported every ~250ms in batches.
 */

const { parentPort } = require('node:worker_threads')
const nacl = require('tweetnacl')
const bs58 = require('bs58')

let running = false
let prefix = ''
let suffix = ''
let caseSensitive = true

parentPort.on('message', msg => {
  if (msg.type === 'start') {
    prefix = msg.caseSensitive ? msg.prefix : msg.prefix.toLowerCase()
    suffix = msg.caseSensitive ? msg.suffix : msg.suffix.toLowerCase()
    caseSensitive = !!msg.caseSensitive
    running = true
    setImmediate(loop)
  } else if (msg.type === 'stop') {
    running = false
  }
})

function loop() {
  const REPORT_MS = 250
  let lastReport = Date.now()
  let sinceReport = 0
  while (running) {
    const kp = nacl.sign.keyPair()
    const address = bs58.encode(kp.publicKey)
    sinceReport++
    const cmp = caseSensitive ? address : address.toLowerCase()
    const hit =
      (prefix.length === 0 || cmp.startsWith(prefix)) &&
      (suffix.length === 0 || cmp.endsWith(suffix))
    if (hit) {
      parentPort.postMessage({
        type: 'found',
        address,
        secretKey: bs58.encode(kp.secretKey),
      })
      running = false
      return
    }
    const now = Date.now()
    if (now - lastReport > REPORT_MS) {
      parentPort.postMessage({ type: 'progress', attempts: sinceReport })
      sinceReport = 0
      lastReport = now
      // yield to the event loop so we can receive stop messages
      setImmediate(loop)
      return
    }
  }
}
