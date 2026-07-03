const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  sendAndConfirmTransaction,
} = require('@solana/web3.js')
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
} = require('@solana/spl-token')
const bs58raw = require('bs58')
const bs58 = bs58raw && bs58raw.default ? bs58raw.default : bs58raw

// Wallet unlocks are charged in the project's own token, priced in USD at
// request time. Treasury receives every sweep; its secret key must be set so
// it can co-sign sweeps as the FEE PAYER (fresh deposit wallets hold no SOL).
const FEE_TOKEN_MINT =
  process.env.FEE_TOKEN_MINT || '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'
const FEE_USD = Number(process.env.FEE_USD) || 5
// Underpayments within this margin still count as paid (covers price drift
// and rounding on the sender's side). Short by more → refunded to sender.
const FEE_TOLERANCE_USD = Number(process.env.FEE_TOLERANCE_USD) || 0.05
const TREASURY_WALLET =
  process.env.TREASURY_WALLET || 'E96hif2XYbvK4YbHc7wLZBaJoszM7viCUbdSMjappGxR'
const TREASURY_SECRET_KEY = process.env.TREASURY_SECRET_KEY || ''

function rpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL
  const cluster = process.env.SOLANA_CLUSTER || 'mainnet-beta'
  return clusterApiUrl(cluster)
}

const connection = new Connection(rpcUrl(), 'confirmed')

function newDepositWallet() {
  const kp = Keypair.generate()
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKey: bs58.encode(kp.secretKey),
  }
}

async function getBalanceLamports(pubkey) {
  return connection.getBalance(new PublicKey(pubkey), 'confirmed')
}

async function paymentReceived(pubkey, minLamports) {
  const balance = await getBalanceLamports(pubkey)
  return balance >= minLamports
}

// ── Fee-token pricing ────────────────────────────────────────────────────

let priceCache = { at: 0, priceUsd: null }
let mintInfoCache = null

async function fetchFeeTokenPriceUsd() {
  if (priceCache.priceUsd && Date.now() - priceCache.at < 60_000) {
    return priceCache.priceUsd
  }
  let price = null
  // Jupiter price API first, DexScreener as fallback
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${FEE_TOKEN_MINT}`)
    if (r.ok) {
      const j = await r.json()
      const entry = j[FEE_TOKEN_MINT] || j.data?.[FEE_TOKEN_MINT]
      price = Number(entry?.usdPrice ?? entry?.price) || null
    }
  } catch { /* fall through */ }
  if (!price) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${FEE_TOKEN_MINT}`)
      if (r.ok) {
        const j = await r.json()
        const pairs = (j.pairs || []).filter(p => Number(p.priceUsd) > 0)
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
        price = Number(pairs[0]?.priceUsd) || null
      }
    } catch { /* fall through */ }
  }
  if (!price) {
    // serve a stale quote rather than failing the request outright
    if (priceCache.priceUsd) return priceCache.priceUsd
    throw new Error('could not fetch fee token price (Jupiter and DexScreener both failed)')
  }
  priceCache = { at: Date.now(), priceUsd: price }
  return price
}

/**
 * Decimals AND the owning token program of the fee mint, read from the
 * chain once and cached forever (a mint's owner can never change). The
 * program id matters twice over: the spl-token instruction builders default
 * to the CLASSIC token program, and the token program is part of the ATA
 * derivation seeds — pump.fun mints live on Token-2022, so assuming classic
 * both calls the wrong program AND computes the wrong destination address.
 */
async function feeTokenMintInfo() {
  if (mintInfoCache) return mintInfoCache
  const info = await connection.getParsedAccountInfo(new PublicKey(FEE_TOKEN_MINT))
  const decimals = info.value?.data?.parsed?.info?.decimals
  const owner = info.value?.owner
  if (typeof decimals !== 'number' || !owner) {
    throw new Error('could not read fee token mint info')
  }
  mintInfoCache = { decimals, programId: new PublicKey(owner) }
  return mintInfoCache
}

async function feeTokenDecimals() {
  return (await feeTokenMintInfo()).decimals
}

/**
 * Quote the wallet-unlock fee: FEE_USD worth of FEE_TOKEN_MINT at the
 * current market price. amountRaw is a decimal string of base units.
 */
async function getFeeTokenQuote() {
  const [priceUsd, decimals] = await Promise.all([fetchFeeTokenPriceUsd(), feeTokenDecimals()])
  const raw = BigInt(Math.ceil((FEE_USD / priceUsd) * 10 ** decimals))
  // minRaw is what actually gates approval: quote minus the USD tolerance
  const minRaw = BigInt(Math.ceil((Math.max(0, FEE_USD - FEE_TOLERANCE_USD) / priceUsd) * 10 ** decimals))
  return {
    mint: FEE_TOKEN_MINT,
    usd: FEE_USD,
    priceUsd,
    decimals,
    amountRaw: raw.toString(),
    minRaw: minRaw.toString(),
    uiAmount: Number(raw) / 10 ** decimals,
  }
}

// ── Fee-token payments ───────────────────────────────────────────────────

async function tokenBalanceRaw(ownerPubkey, mint = FEE_TOKEN_MINT) {
  const res = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(ownerPubkey),
    { mint: new PublicKey(mint) },
    'confirmed',
  )
  let total = 0n
  for (const { account } of res.value) {
    total += BigInt(account.data.parsed.info.tokenAmount.amount)
  }
  return total
}

async function tokenPaymentReceived(ownerPubkey, minRaw) {
  return (await tokenBalanceRaw(ownerPubkey)) >= BigInt(minRaw)
}

/**
 * Move everything a deposit wallet holds (fee tokens + any SOL + token
 * account rent) to the treasury. The deposit wallet holds no SOL, so the
 * TREASURY signs as fee payer — requires TREASURY_SECRET_KEY.
 */
async function sweepDepositToTreasury(depositSecretBase58) {
  if (!TREASURY_SECRET_KEY) {
    console.warn('[solana] TREASURY_SECRET_KEY not set — cannot sweep deposits (treasury must co-sign as fee payer)')
    return null
  }
  const treasury = Keypair.fromSecretKey(bs58.decode(TREASURY_SECRET_KEY))
  const treasuryPub = new PublicKey(TREASURY_WALLET)
  const deposit = Keypair.fromSecretKey(bs58.decode(depositSecretBase58))
  const mint = new PublicKey(FEE_TOKEN_MINT)
  // classic SPL Token vs Token-2022 — both the instructions and the ATA
  // address derivation depend on it
  const { decimals, programId } = await feeTokenMintInfo()

  const tx = new Transaction()
  let tokensRaw = 0n

  const accounts = await connection.getParsedTokenAccountsByOwner(
    deposit.publicKey,
    { mint },
    'confirmed',
  )
  if (accounts.value.length > 0) {
    const toAta = getAssociatedTokenAddressSync(mint, treasuryPub, false, programId)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey, toAta, treasuryPub, mint, programId,
    ))
    for (const { pubkey, account } of accounts.value) {
      const amount = BigInt(account.data.parsed.info.tokenAmount.amount)
      if (amount > 0n) {
        // transferChecked works on both token programs and stays valid for
        // Token-2022 mints with extensions (e.g. transfer fees)
        tx.add(createTransferCheckedInstruction(
          pubkey, mint, toAta, deposit.publicKey, amount, decimals, [], programId,
        ))
        tokensRaw += amount
      }
      // close the deposit token account so its rent lands in the treasury too
      tx.add(createCloseAccountInstruction(pubkey, treasuryPub, deposit.publicKey, [], programId))
    }
  }

  const lamports = await connection.getBalance(deposit.publicKey, 'confirmed')
  if (lamports > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: deposit.publicKey,
      toPubkey: treasuryPub,
      lamports,
    }))
  }

  if (tx.instructions.length === 0) return null
  tx.feePayer = treasury.publicKey
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [treasury, deposit], {
      commitment: 'confirmed',
    })
    return { signature, tokensRaw: tokensRaw.toString(), lamports }
  } catch (err) {
    const logs = typeof err.getLogs === 'function'
      ? await err.getLogs(connection).catch(() => null)
      : err.logs
    if (Array.isArray(logs) && logs.length) {
      err.message += ` | logs: ${logs.slice(-5).join(' | ')}`
    }
    err.message += ` | feePayer: ${treasury.publicKey.toBase58()}`
    throw err
  }
}

/**
 * Sanity-check the treasury config at boot: the secret key must derive the
 * treasury pubkey (it signs sweeps as fee payer) and the account must hold
 * SOL to pay those fees.
 */
async function treasuryConfigStatus() {
  if (!TREASURY_SECRET_KEY) {
    return { ok: false, reason: 'TREASURY_SECRET_KEY not set — sweeps disabled' }
  }
  let derived
  try {
    derived = Keypair.fromSecretKey(bs58.decode(TREASURY_SECRET_KEY)).publicKey.toBase58()
  } catch (e) {
    return { ok: false, reason: `TREASURY_SECRET_KEY is not a valid base58 secret key: ${e.message}` }
  }
  if (derived !== TREASURY_WALLET) {
    return {
      ok: false,
      reason:
        `TREASURY_SECRET_KEY derives ${derived} but TREASURY_WALLET is ${TREASURY_WALLET} — ` +
        `sweeps will use ${derived} as fee payer and FAIL unless it holds SOL`,
    }
  }
  let lamports = null
  try {
    lamports = await getBalanceLamports(derived)
  } catch { /* RPC hiccup — don't block boot */ }
  if (lamports === 0) {
    return { ok: false, reason: `treasury ${derived} holds 0 SOL — it cannot pay sweep fees; fund it` }
  }
  return { ok: true, derived, lamports }
}

/**
 * Work out who funded a deposit wallet: scan the deposit token account's
 * recent history for an incoming transfer and return the authority (the
 * sender's wallet) — that's where a refund goes. Null if undeterminable.
 */
async function findTokenSender(ownerPubkey) {
  const mint = new PublicKey(FEE_TOKEN_MINT)
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(ownerPubkey),
    { mint },
    'confirmed',
  )
  for (const { pubkey } of accounts.value) {
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 15 }, 'confirmed')
    for (const s of sigs) {
      let tx
      try {
        tx = await connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
      } catch { continue }
      if (!tx) continue
      const instrs = [...tx.transaction.message.instructions]
      for (const inner of tx.meta?.innerInstructions || []) instrs.push(...inner.instructions)
      for (const ix of instrs) {
        const p = ix.parsed
        if (!p || (p.type !== 'transfer' && p.type !== 'transferChecked')) continue
        if (p.info?.destination !== pubkey.toBase58()) continue
        const authority = p.info.authority || p.info.multisigAuthority
        if (authority && authority !== ownerPubkey) return authority
      }
    }
  }
  return null
}

/**
 * Return an underpaid deposit to whoever sent it. Same mechanics as the
 * treasury sweep — the treasury signs as FEE PAYER (network fees are
 * SOL-only, so the SOL-less deposit wallet cannot pay them) — but the
 * tokens go back to the sender. The deposit token account's rent is closed
 * to the treasury, which more than covers the fee it fronts.
 */
async function refundDeposit(depositSecretBase58) {
  if (!TREASURY_SECRET_KEY) {
    console.warn('[solana] TREASURY_SECRET_KEY not set — cannot refund (treasury must co-sign as fee payer)')
    return null
  }
  const treasury = Keypair.fromSecretKey(bs58.decode(TREASURY_SECRET_KEY))
  const treasuryPub = new PublicKey(TREASURY_WALLET)
  const deposit = Keypair.fromSecretKey(bs58.decode(depositSecretBase58))
  const mint = new PublicKey(FEE_TOKEN_MINT)
  const { decimals, programId } = await feeTokenMintInfo()

  const accounts = await connection.getParsedTokenAccountsByOwner(
    deposit.publicKey,
    { mint },
    'confirmed',
  )
  let tokensRaw = 0n
  for (const { account } of accounts.value) {
    tokensRaw += BigInt(account.data.parsed.info.tokenAmount.amount)
  }
  if (tokensRaw === 0n) return null

  const sender = await findTokenSender(deposit.publicKey.toBase58())
  if (!sender) throw new Error('could not determine the sender to refund')
  const senderPub = new PublicKey(sender)

  const tx = new Transaction()
  const toAta = getAssociatedTokenAddressSync(mint, senderPub, false, programId)
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    treasury.publicKey, toAta, senderPub, mint, programId,
  ))
  for (const { pubkey, account } of accounts.value) {
    const amount = BigInt(account.data.parsed.info.tokenAmount.amount)
    if (amount > 0n) {
      tx.add(createTransferCheckedInstruction(
        pubkey, mint, toAta, deposit.publicKey, amount, decimals, [], programId,
      ))
    }
    // rent goes to the treasury to offset the fees it fronts
    tx.add(createCloseAccountInstruction(pubkey, treasuryPub, deposit.publicKey, [], programId))
  }
  const lamports = await connection.getBalance(deposit.publicKey, 'confirmed')
  if (lamports > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: deposit.publicKey,
      toPubkey: treasuryPub,
      lamports,
    }))
  }
  tx.feePayer = treasury.publicKey
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [treasury, deposit], {
      commitment: 'confirmed',
    })
    return { signature, tokensRaw: tokensRaw.toString(), to: sender }
  } catch (err) {
    const logs = typeof err.getLogs === 'function'
      ? await err.getLogs(connection).catch(() => null)
      : err.logs
    if (Array.isArray(logs) && logs.length) {
      err.message += ` | logs: ${logs.slice(-5).join(' | ')}`
    }
    throw err
  }
}

async function forwardBalance(fromSecretBase58, toPubkey) {
  if (!toPubkey) return null
  const from = Keypair.fromSecretKey(bs58.decode(fromSecretBase58))
  const balance = await connection.getBalance(from.publicKey, 'confirmed')
  if (balance === 0) return null
  const { feeCalculator } = await connection.getRecentBlockhash('confirmed')
  const fee = feeCalculator?.lamportsPerSignature ?? 5000
  const sendLamports = balance - fee
  if (sendLamports <= 0) return null
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(toPubkey),
      lamports: sendLamports,
    }),
  )
  const sig = await sendAndConfirmTransaction(connection, tx, [from], {
    commitment: 'confirmed',
  })
  return { signature: sig, lamports: sendLamports }
}

module.exports = {
  LAMPORTS_PER_SOL,
  FEE_TOKEN_MINT,
  FEE_USD,
  TREASURY_WALLET,
  connection,
  newDepositWallet,
  getBalanceLamports,
  paymentReceived,
  forwardBalance,
  getFeeTokenQuote,
  tokenBalanceRaw,
  tokenPaymentReceived,
  sweepDepositToTreasury,
  refundDeposit,
  findTokenSender,
  treasuryConfigStatus,
}
