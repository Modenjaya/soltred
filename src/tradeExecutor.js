// src/tradeExecutor.js
const { Connection, Keypair, VersionedTransaction, SystemProgram, LAMPORTS_PER_SOL, TransactionMessage } = require('@solana/web3.js');
const fetch = require('node-fetch').default;
const config = require('./config');
const { info, error, warn } = require('./logger');

// Import bs58 safely
let bs58;
try {
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
} catch (err) {
  bs58 = require('bs58');
}

// Inisialisasi Solana Connection
const connection = new Connection(config.SOLANA_RPC, 'confirmed');

/**
 * Helper to get Jupiter quote
 */
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps, swapMode = 'ExactIn') {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&swapMode=${swapMode}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get Jupiter quote (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Helper to get Jupiter swap transaction
 */
async function getJupiterSwapTransaction(quoteResponse, userPublicKey) {
    const url = 'https://quote-api.jup.ag/v6/swap';
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey: userPublicKey.toBase58(),
            wrapUnwrapSol: true, // Auto wrap/unwrap SOL
        })
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get Jupiter swap transaction (HTTP ${response.status}): ${text}`);
    }
    const { swapTransaction } = await response.json();
    return swapTransaction;
}

/**
 * Send bundle to Jito (if Jito is enabled)
 */
async function sendBundleToJito(signedTransactions) {
    if (!config.JITO_ENGINE) {
        throw new Error("Jito engine URL not configured in global config.");
    }

    const encodedTxs = signedTransactions.map(tx => bs58.encode(tx.serialize()));

    const response = await fetch(`${config.JITO_ENGINE}/bundles`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [encodedTxs]
        })
    });

    const data = await response.json();
    if (data.error) {
        throw new Error(`Jito error: ${data.error.message}`);
    }
    return data.result.bundleId;
}

/**
 * Buy a token.
 * @param {object} tradeParams - { mint, amountSol }
 * @param {object} userSettings - { slippage, jitoTip, preferredDex }
 * @param {Keypair} payerKeypair - The Keypair of the user's wallet to sign the transaction
 * @returns {Promise<string>} Transaction signature
 */
async function buyToken(tradeParams, userSettings, payerKeypair) {
    const { mint, amountSol } = tradeParams;
    const { slippage, jitoTip, preferredDex } = userSettings; // Ambil dari userSettings

    info(`Attempting to buy ${amountSol} SOL worth of ${mint} for user ${payerKeypair.publicKey.toBase58()} on ${preferredDex}...`);

    const inputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL mint address
    const outputMint = new PublicKey(mint);
    const amountInLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    const slippageBps = slippage * 100;

    try {
        // 1. Get quote from Jupiter
        const quoteResponse = await getJupiterQuote(inputMint.toBase58(), outputMint.toBase58(), amountInLamports, slippageBps);
        info(`Jupiter quote received. Estimated out amount: ${quoteResponse.outAmount / (10 ** quoteResponse.outputMint.decimals)}`);

        // 2. Get swap transaction from Jupiter
        const swapTransaction = await getJupiterSwapTransaction(quoteResponse, payerKeypair.publicKey);
        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

        // 3. Add Jito tip if configured
        let transactionsToBundle = [transaction];
        if (jitoTip > 0 && config.JITO_ENGINE && config.JITO_TIP_ACCOUNT) {
            const tipLamports = Math.round(jitoTip * LAMPORTS_PER_SOL);
            const tipAccount = new PublicKey(config.JITO_TIP_ACCOUNT);
            
            const tipTx = new VersionedTransaction(new TransactionMessage({
                payerKey: payerKeypair.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash('finalized')).blockhash,
                instructions: [
                    SystemProgram.transfer({
                        fromPubkey: payerKeypair.publicKey,
                        toPubkey: tipAccount,
                        lamports: tipLamports,
                    })
                ]
            }).compileToLegacyMessage());

            transactionsToBundle.push(tipTx);
            info(`Adding Jito tip of ${jitoTip} SOL.`);
        }

        // 4. Sign all transactions in the bundle
        transactionsToBundle = transactionsToBundle.map(tx => {
            tx.sign([payerKeypair]);
            return tx;
        });

        // 5. Send transaction (either directly to RPC or via Jito)
        let signature;
        if (config.JITO_ENGINE) {
            info('Sending transaction via Jito bundle...');
            const bundleId = await sendBundleToJito(transactionsToBundle);
            info(`Bundle sent to Jito: ${bundleId}`);
            signature = transactionsToBundle[0].signatures[0].toBase58();
        } else {
            info('Sending transaction directly to Solana RPC (Jito not configured or disabled)...');
            if (transactionsToBundle.length > 1) {
                warn('Multiple transactions (swap + tip) cannot be sent atomically without Jito bundle or other services.');
                const swapSig = await connection.sendTransaction(transactionsToBundle[0], { skipPreflight: false });
                info(`Swap transaction sent: ${swapSig}`);
                await connection.confirmTransaction(swapSig, 'confirmed');
                signature = swapSig;
            } else {
                const swapSig = await connection.sendTransaction(transactionsToBundle[0], { skipPreflight: false });
                info(`Transaction sent: ${swapSig}`);
                await connection.confirmTransaction(swapSig, 'confirmed');
                signature = swapSig;
            }
        }

        info(`Buy transaction confirmed: ${signature}`);
        return signature;

    } catch (e) {
        error(`Failed to execute buy trade for ${mint}: ${e.message}`);
        throw e;
    }
}

/**
 * Sell a token.
 * @param {object} tradeParams - { mint, tokenAmount }
 * @param {object} userSettings - { slippage, jitoTip, preferredDex }
 * @param {Keypair} payerKeypair - The Keypair of the user's wallet to sign the transaction
 * @returns {Promise<string>} Transaction signature
 */
async function sellToken(tradeParams, userSettings, payerKeypair) {
    const { mint, tokenAmount } = tradeParams;
    const { slippage, jitoTip, preferredDex } = userSettings; // Ambil dari userSettings

    info(`Attempting to sell ${tokenAmount} of ${mint} for user ${payerKeypair.publicKey.toBase58()} on ${preferredDex}...`);

    const inputMint = new PublicKey(mint);
    const outputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL mint address
    const slippageBps = slippage * 100;

    try {
        // Get token's decimals
        const tokenMintAccount = await connection.getParsedAccountInfo(inputMint);
        if (!tokenMintAccount || !tokenMintAccount.value || !tokenMintAccount.value.data.parsed) {
            throw new Error(`Could not find token mint account info for ${mint}`);
        }
        const decimals = tokenMintAccount.value.data.parsed.info.decimals;
        const amountInLamports = Math.round(tokenAmount * (10 ** decimals));

        // 1. Get quote from Jupiter
        const quoteResponse = await getJupiterQuote(inputMint.toBase58(), outputMint.toBase58(), amountInLamports, slippageBps);
        info(`Jupiter quote received. Estimated out amount (SOL): ${quoteResponse.outAmount / LAMPORTS_PER_SOL}`);

        // 2. Get swap transaction from Jupiter
        const swapTransaction = await getJupiterSwapTransaction(quoteResponse, payerKeypair.publicKey);
        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

        // 3. Add Jito tip (similar logic as buyToken)
        let transactionsToBundle = [transaction];
        if (jitoTip > 0 && config.JITO_ENGINE && config.JITO_TIP_ACCOUNT) {
            const tipLamports = Math.round(jitoTip * LAMPORTS_PER_SOL);
            const tipAccount = new PublicKey(config.JITO_TIP_ACCOUNT);
            
            const tipTx = new VersionedTransaction(new TransactionMessage({
                payerKey: payerKeypair.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash('finalized')).blockhash,
                instructions: [
                    SystemProgram.transfer({
                        fromPubkey: payerKeypair.publicKey,
                        toPubkey: tipAccount,
                        lamports: tipLamports,
                    })
                ]
            }).compileToLegacyMessage());

            transactionsToBundle.push(tipTx);
            info(`Adding Jito tip of ${jitoTip} SOL.`);
        }

        // 4. Sign all transactions in the bundle
        transactionsToBundle = transactionsToBundle.map(tx => {
            tx.sign([payerKeypair]);
            return tx;
        });

        // 5. Send transaction
        let signature;
        if (config.JITO_ENGINE) {
            info('Sending transaction via Jito bundle...');
            const bundleId = await sendBundleToJito(transactionsToBundle);
            info(`Bundle sent to Jito: ${bundleId}`);
            signature = transactionsToBundle[0].signatures[0].toBase58();
        } else {
             info('Sending transaction directly to Solana RPC (Jito not configured or disabled)...');
            if (transactionsToBundle.length > 1) {
                warn('Multiple transactions (swap + tip) cannot be sent atomically without Jito bundle or other services.');
                const swapSig = await connection.sendTransaction(transactionsToBundle[0], { skipPreflight: false });
                info(`Swap transaction sent: ${swapSig}`);
                await connection.confirmTransaction(swapSig, 'confirmed');
                signature = swapSig;
            } else {
                const swapSig = await connection.sendTransaction(transactionsToBundle[0], { skipPreflight: false });
                info(`Transaction sent: ${swapSig}`);
                await connection.confirmTransaction(swapSig, 'confirmed');
                signature = swapSig;
            }
        }

        info(`Sell transaction confirmed: ${signature}`);
        return signature;

    } catch (e) {
        error(`Failed to execute sell trade for ${mint}: ${e.message}`);
        throw e;
    }
}

module.exports = {
    buyToken,
    sellToken,
};
