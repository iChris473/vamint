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
  createTransferInstruction,
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
let decimalsCache = null

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

async function feeTokenDecimals() {
  if (decimalsCache != null) return decimalsCache
  const info = await connection.getParsedAccountInfo(new PublicKey(FEE_TOKEN_MINT))
  const d = info.value?.data?.parsed?.info?.decimals
  if (typeof d !== 'number') throw new Error('could not read fee token decimals')
  decimalsCache = d
  return d
}

/**
 * Quote the wallet-unlock fee: FEE_USD worth of FEE_TOKEN_MINT at the
 * current market price. amountRaw is a decimal string of base units.
 */
async function getFeeTokenQuote() {
  const [priceUsd, decimals] = await Promise.all([fetchFeeTokenPriceUsd(), feeTokenDecimals()])
  const raw = BigInt(Math.ceil((FEE_USD / priceUsd) * 10 ** decimals))
  return {
    mint: FEE_TOKEN_MINT,
    usd: FEE_USD,
    priceUsd,
    decimals,
    amountRaw: raw.toString(),
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

  const tx = new Transaction()
  let tokensRaw = 0n

  const accounts = await connection.getParsedTokenAccountsByOwner(
    deposit.publicKey,
    { mint },
    'confirmed',
  )
  if (accounts.value.length > 0) {
    const toAta = getAssociatedTokenAddressSync(mint, treasuryPub)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      treasury.publicKey, toAta, treasuryPub, mint,
    ))
    for (const { pubkey, account } of accounts.value) {
      const amount = BigInt(account.data.parsed.info.tokenAmount.amount)
      if (amount > 0n) {
        tx.add(createTransferInstruction(pubkey, toAta, deposit.publicKey, amount))
        tokensRaw += amount
      }
      // close the deposit token account so its rent lands in the treasury too
      tx.add(createCloseAccountInstruction(pubkey, treasuryPub, deposit.publicKey))
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
  const signature = await sendAndConfirmTransaction(connection, tx, [treasury, deposit], {
    commitment: 'confirmed',
  })
  return { signature, tokensRaw: tokensRaw.toString(), lamports }
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
}
