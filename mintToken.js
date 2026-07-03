const dotenv = require("dotenv");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction, clusterApiUrl } = require("@solana/web3.js");
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require("@pump-fun/pump-sdk");
const { AnchorProvider } = require("@coral-xyz/anchor");
const NodeWallet = require("@coral-xyz/anchor/dist/cjs/nodewallet");
const bs58 = require('bs58');
dotenv.config();

const BN = require("bn.js");
const { PinataSDK } = require('pinata');

const pinataAPIKey = process.env.PINATA_API_KEY;
const pinataAPISecret = process.env.PINATA_API_SECRET;
const pinataJWTKey = process.env.PINATA_JWT;

// Dedicated Pinata gateways only serve content pinned to THEIR OWN account —
// set PINATA_GATEWAY to the gateway domain of the same account the JWT
// belongs to, or leave unset for the public gateway.
const pinataGateway = process.env.PINATA_GATEWAY || "gateway.pinata.cloud";

const pinata = new PinataSDK({
    pinataJwt: pinataJWTKey,
    pinataGateway,
});

const fs = require('fs');
const path = require('path');
const SLIPPAGE_BASIS_POINTS = 500n;
const defaultPrivateKey = '' // load private key from server

// Custom-CA launch fee: 0.05 SOL from the dev wallet to the treasury, added
// to the mint transaction itself so it's atomic — fee charged iff the mint
// lands.
const TREASURY_WALLET = process.env.TREASURY_WALLET || 'E96hif2XYbvK4YbHc7wLZBaJoszM7viCUbdSMjappGxR';
const MINT_FEE_LAMPORTS = Number(process.env.MINT_FEE_LAMPORTS) || 50_000_000;

const launchFeeInstruction = (fromPubkey) => SystemProgram.transfer({
    fromPubkey,
    toPubkey: new PublicKey(TREASURY_WALLET),
    lamports: MINT_FEE_LAMPORTS,
});

// The mint+buy transaction sits right at Solana's 1232-byte cap, so the fee
// can't ride inside it — charge it as an immediate follow-up transfer.
const payLaunchFee = async (connection, walletAccount) => {
    const tx = new Transaction().add(launchFeeInstruction(walletAccount.publicKey));
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletAccount.publicKey;
    const sig = await sendAndConfirmTransaction(connection, tx, [walletAccount], {
        commitment: 'confirmed',
        maxRetries: 3,
    });
    console.log("💰 Launch fee paid:", sig);
    return sig;
};

const createWallet = (keypair) => {
    return {
        publicKey: keypair.publicKey,
        signTransaction: async (tx) => {
            tx.partialSign(keypair);
            return tx;
        },
        signAllTransactions: async (txs) => {
            return txs.map(tx => {
                tx.partialSign(keypair);
                return tx;
            });
        }
    };
};

// QUICKNODE_RPC_URL if set, otherwise the same RPC the rest of the backend
// uses (SOLANA_RPC_URL / SOLANA_CLUSTER, defaulting to public mainnet).
const deployRpcUrl = () =>
    process.env.QUICKNODE_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    clusterApiUrl(process.env.SOLANA_CLUSTER || "mainnet-beta");

const getProvider = (privateKey) => {
    const rpc = deployRpcUrl();
    console.log("[deploy] rpc:", rpc);
    const connection = new Connection(rpc);
    const privateKeyBuffer = bs58.default.decode(privateKey);
    const FROM_KEYPAIR = Keypair.fromSecretKey(privateKeyBuffer);
    console.log("[deploy] dev wallet:", FROM_KEYPAIR.publicKey.toBase58());
    // const wallet = new NodeWallet.default(FROM_KEYPAIR);
    const wallet = createWallet(FROM_KEYPAIR);
    return new AnchorProvider(connection, wallet, { commitment: "finalized" });
};

const mintTokenOnPumpFun = async (imageFile, name, ticker, description, links, privateKey, buyAmount = 0, mintSecretKey = null) => {

    // ── shared setup ──────────────────────────────────────────────────────────
    if (!privateKey) return { error: true, message: 'No private key provided' };
    const provider = getProvider(privateKey);
    const sdk = new PumpSdk(provider);
    const connection = provider.connection;

    const privateKeyBuffer = bs58.default.decode(privateKey);
    const walletAccount = Keypair.fromSecretKey(privateKeyBuffer);
    console.log("🔵 Dev Wallet public key:", walletAccount.publicKey.toBase58());

    // The whole point of Vamint: mint at the user's ground vanity CA. The
    // escrowed keypair comes from the generate job; random only as fallback
    // for direct API calls without a jobId.
    const mint = mintSecretKey
        ? Keypair.fromSecretKey(bs58.default.decode(mintSecretKey))
        : Keypair.generate();
    const ca = mint.publicKey.toBase58();
    console.log(`🎯 Mint address: ${ca}${mintSecretKey ? ' (vanity CA from escrow)' : ' (random)'}`);

    const currentSolBalance = await connection.getBalance(walletAccount.publicKey);

    console.log("🟢 SOL in dev wallet:", currentSolBalance / LAMPORTS_PER_SOL);
    
    // if (currentSolBalance === 0) return { insufficientFunds: true, error: true, message: "Deployer wallet has 0 SOL. Please fund it to mint tokens." };

    // upload image
    let file;
    if (!imageFile) {
        const imagePath = path.join(__dirname, "..", "tweetlogo.png");
        file = new File([fs.readFileSync(imagePath)], "image.png", { type: "image/png" });
    } else {
        file = new File([imageFile.buffer], imageFile.originalname || "image.png", { type: imageFile.mimetype });
    }

    const uploadImg = await pinata.upload.public.file(file);

    const tokenMetadata = {
        name,
        symbol: ticker,
        description,
        image: `https://${pinataGateway}/ipfs/` + uploadImg.cid,
        showName: true,
        twitter: links.twitter,
        telegram: links.telegram,
        website: links.website,
        createdOn: "https://pump.fun",
    };
    
    console.log(tokenMetadata);
    
    const upload = await pinata.upload.public.json(tokenMetadata);
    const uri = `https://${pinataGateway}/ipfs/` + upload.cid;

    const onlineSdk = new OnlinePumpSdk(connection);

    // ── subfunction: mint only ────────────────────────────────────────────────
    const mintOnly = async () => {
        const createInstruction = await sdk.createV2Instruction({
            mint: mint.publicKey,
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            uri,
            creator: walletAccount.publicKey,
            user: walletAccount.publicKey,
            mayhemMode: false,
        });

        const transaction = new Transaction().add(createInstruction);
        transaction.add(launchFeeInstruction(walletAccount.publicKey));
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletAccount.publicKey;

        const signers = [walletAccount];
        const mintNeedsSigning = createInstruction.keys.some(
            k => k.pubkey.equals(mint.publicKey) && k.isSigner
        );
        if (mintNeedsSigning) signers.push(mint);

        const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
            commitment: 'confirmed',
            maxRetries: 3,
            preflightCommitment: 'processed',
        });

        console.log("✅ Token minted:", signature);
        return signature;
    };

    // ── subfunction: mint + buy ───────────────────────────────────────────────
    const mintAndBuy = async (solAmount) => {
        const global = await onlineSdk.fetchGlobal();
        const solBN = new BN(Math.floor(solAmount * 10 ** 9));

        const instructions = await sdk.createV2AndBuyInstructions({
            global,
            mint: mint.publicKey,
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            uri,
            creator: walletAccount.publicKey,
            user: walletAccount.publicKey,
            solAmount: solBN,
            amount: getBuyTokenAmountFromSolAmount({ global, feeConfig: null, mintSupply: null, bondingCurve: null, amount: solBN }),
            mayhemMode: false,
        });

        const transaction = new Transaction();
        for (const ix of instructions) transaction.add(ix);

        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = walletAccount.publicKey;

        const signers = [walletAccount, mint];
        const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
            commitment: 'confirmed',
            maxRetries: 3,
            preflightCommitment: 'processed',
        });

        console.log("✅ Token minted + bought:", signature);
        try {
            await payLaunchFee(connection, walletAccount);
        } catch (err) {
            console.warn("⚠ launch fee transfer failed (mint already live):", err.message);
        }
        return signature;
    };

    // ── execute ───────────────────────────────────────────────────────────────
    try {
        const signature = buyAmount > 0
            ? await mintAndBuy(buyAmount)
            : await mintOnly();

        // await tokenModel.create({
        //     ca,
        //     name: tokenMetadata.name,
        //     symbol: tokenMetadata.symbol,
        //     image: tokenMetadata.image,
        //     website: tokenMetadata.website,
        //     twitter: tokenMetadata.twitter,
        //     telegram: tokenMetadata.telegram,
        //     deployer,
        //     username: user.twitterUsername,
        //     fee: feeType || "creator",
        // });

        console.log("🔗 Pump.fun URL:", `https://pump.fun/coin/${ca}`);
        return { link: `https://pump.fun/coin/${ca}`, ca, signature, error: false, message: "Token minted successfully" };
    } catch (error) {
        console.error("An error occurred:", error);
        return { error: true, message: "An error occurred" };
    }
};

module.exports = { mintTokenOnPumpFun };