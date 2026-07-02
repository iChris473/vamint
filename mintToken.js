const dotenv = require("dotenv");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require("@pump-fun/pump-sdk");
const { AnchorProvider } = require("@coral-xyz/anchor");
const NodeWallet = require("@coral-xyz/anchor/dist/cjs/nodewallet");
const bs58 = require('bs58');
dotenv.config();

const BN = require("bn.js");
const { PinataSDK } = require('pinata');

const pinataAPIKey = "205889c11e094e6ce3a9"
const pinataAPISecret = "6e7c5b6d7e0914f3df44d867c3b88e4d2cda29cede344d155b805533ef1fa5ac"
const pinataJWTKey = process.env.PINATA_JWT;

const pinata = new PinataSDK({
    pinataJwt: pinataJWTKey,
    // pinataGateway: "violet-odd-coyote-404.mypinata.cloud",
    pinataGateway: "red-cheerful-unicorn-465.mypinata.cloud",
});

const fs = require('fs');
const path = require('path');
const SLIPPAGE_BASIS_POINTS = 500n;
const defaultPrivateKey = '' // load private key from server

// Custom-CA launch fee: 0.1 SOL from the dev wallet to the treasury, added
// to the mint transaction itself so it's atomic — fee charged iff the mint
// lands.
const TREASURY_WALLET = process.env.TREASURY_WALLET || 'E96hif2XYbvK4YbHc7wLZBaJoszM7viCUbdSMjappGxR';
const MINT_FEE_LAMPORTS = Number(process.env.MINT_FEE_LAMPORTS) || 100_000_000;

const launchFeeInstruction = (fromPubkey) => SystemProgram.transfer({
    fromPubkey,
    toPubkey: new PublicKey(TREASURY_WALLET),
    lamports: MINT_FEE_LAMPORTS,
});

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

const getProvider = (privateKey) => {
    const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;
    console.log(privateKey, QUICKNODE_RPC_URL);
    const connection = new Connection(QUICKNODE_RPC_URL || "");
    const privateKeyBuffer = bs58.decode(privateKey);
    const FROM_KEYPAIR = Keypair.fromSecretKey(privateKeyBuffer);
    console.log(FROM_KEYPAIR.publicKey.toBase58());
    // const wallet = new NodeWallet.default(FROM_KEYPAIR);
    const wallet = createWallet(FROM_KEYPAIR);
    return new AnchorProvider(connection, wallet, { commitment: "finalized" });
};

const mintTokenOnPumpFun = async (imageFile, name, ticker, description, links, privateKey, buyAmount = 0) => {

    // ── shared setup ──────────────────────────────────────────────────────────
    if (!privateKey) return { error: true, message: 'No private key provided' };
    const provider = getProvider(privateKey);
    const sdk = new PumpSdk(provider);
    const connection = provider.connection;

    const privateKeyBuffer = bs58.decode(privateKey);
    const walletAccount = Keypair.fromSecretKey(privateKeyBuffer);
    console.log("🔵 Dev Wallet public key:", walletAccount.publicKey.toBase58());

    const mint = Keypair.generate();
    const ca = mint.publicKey.toBase58();
    console.log("🎯 Mint address:", ca);

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
        image: "https://red-cheerful-unicorn-465.mypinata.cloud/ipfs/" + uploadImg.cid,
        showName: true,
        twitter: links.twitter,
        telegram: links.telegram,
        website: links.website,
        createdOn: "https://pump.fun",
    };
    
    console.log(tokenMetadata);
    
    const upload = await pinata.upload.public.json(tokenMetadata);
    const uri = "https://red-cheerful-unicorn-465.mypinata.cloud/ipfs/" + upload.cid;

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
        transaction.add(launchFeeInstruction(walletAccount.publicKey));

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