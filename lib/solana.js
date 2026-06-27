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
const bs58 = require('bs58')

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
  connection,
  newDepositWallet,
  getBalanceLamports,
  paymentReceived,
  forwardBalance,
}
