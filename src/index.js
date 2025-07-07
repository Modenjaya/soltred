// src/bot.js
require('dotenv').config(); // Load environment variables from .env

const TelegramBot = require('node-telegram-bot-api');
const { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js'); // Tambah Connection dan LAMPORTS_PER_SOL

// Import bs58 safely
let bs58;
try {
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
} catch (err) {
  bs58 = require('bs58');
}

const config = require('./config');
const { info, error, warn } = require('./logger'); // Tambah warn
const storage = require('./storage');
const { getPriceOnChain } = require('./priceChecker');
const { buyToken, sellToken } = require('./tradeExecutor'); // sellToken juga diimpor

// Inisialisasi Bot Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  error('TELEGRAM_BOT_TOKEN tidak ditemukan di environment variables.');
  process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// State sementara untuk melacak input pengguna yang sedang ditunggu (misal: menunggu Private Key)
const userStates = new Map(); // Map<chatId, { step: string, data: any }>

// Default Settings (jika user belum mengaturnya)
const DEFAULT_USER_SETTINGS = {
    tradeMode: 'EXACT',
    buyAmount: 0.01, // SOL
    takeProfit: 100, // %
    stopLoss: 50,    // %
    slippage: 10,    // %
    jitoTip: 0.0001, // SOL
    preferredDex: 'jupiter', // Default Jupiter
    copyWallet: null,
    enableMultiBuy: false,
    enableTrailingStop: false,
    trailingStopDistance: 0,
    trailingStopActivation: 0,
};

// Validasi untuk opsi DEX yang bisa dipilih user
const VALID_DEX_OPTIONS = ['auto', 'pumpfun', 'meteora', 'raydium', 'moonshot', 'jupiter'];

// Inisialisasi penyimpanan (SQLite)
storage.initStorage();
info('Bot Telegram dimulai.');

// --- HELPER FUNCTIONS ---

function formatSolAmount(lamports) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4); // Gunakan LAMPORTS_PER_SOL dari web3.js
}

function generateWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
  };
}

// --- TELEGRAM COMMAND HANDLERS ---

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userData = await storage.getUserData(chatId);

  let welcomeMessage = `Selamat datang di Solana Swap Bot! 👋\n\n`;

  if (userData && userData.publicKey) {
    welcomeMessage += `Wallet Anda yang terdaftar:\nPublic Key: \`${userData.publicKey}\`\n\n`;
    welcomeMessage += `Gunakan /settings untuk melihat atau mengubah konfigurasi trade Anda.\n`;
    welcomeMessage += `Sekarang Anda bisa paste alamat kontrak token di sini untuk cek data atau melakukan swap.`;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  } else {
    welcomeMessage += `Untuk memulai, Anda perlu membuat atau mengimpor wallet.\n`;
    welcomeMessage += `*PENTING: Private Key Anda akan disimpan di bot ini.* Ini berisiko. Lakukan dengan risiko Anda sendiri.\n`; // Hapus (terenkripsi) untuk kejujuran
    welcomeMessage += `Pilih opsi di bawah ini:`;
    bot.sendMessage(chatId, welcomeMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Buat Wallet Baru', callback_data: 'create_wallet' }],
          [{ text: '⬆️ Impor Wallet', callback_data: 'import_wallet' }],
        ],
      },
    });
  }
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    const userData = await storage.getUserData(chatId);
    let userSettings = userData ? userData.settings : DEFAULT_USER_SETTINGS;

    let settingsMessage = `⚙️ **Pengaturan Anda:**\n\n`;
    settingsMessage += `*Mode Trade*: ${userSettings.tradeMode}\n`;
    settingsMessage += `*Jumlah Beli (SOL)*: ${userSettings.buyAmount}\n`;
    settingsMessage += `*Take Profit (%)*: ${userSettings.takeProfit}\n`;
    settingsMessage += `*Stop Loss (%)*: ${userSettings.stopLoss}\n`;
    settingsMessage += `*Slippage (%)*: ${userSettings.slippage}\n`;
    settingsMessage += `*Jito Tip (SOL)*: ${userSettings.jitoTip}\n`;
    settingsMessage += `*Preferred DEX*: ${userSettings.preferredDex}\n`;
    settingsMessage += `*Copy Wallet*: \`${userSettings.copyWallet || 'Belum diatur'}\`\n`;
    settingsMessage += `*Multi Buy Aktif*: ${userSettings.enableMultiBuy ? 'Ya' : 'Tidak'}\n`;
    settingsMessage += `*Trailing Stop Aktif*: ${userSettings.enableTrailingStop ? 'Ya' : 'Tidak'}\n`;
    if (userSettings.enableTrailingStop) {
        settingsMessage += `  *Jarak TSL (%)*: ${userSettings.trailingStopDistance}\n`;
        settingsMessage += `  *Aktivasi TSL (%)*: ${userSettings.trailingStopActivation}\n`;
    }

    bot.sendMessage(chatId, settingsMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Ubah Buy Amount', callback_data: 'set_buy_amount' }],
                [{ text: 'Ubah Slippage', callback_data: 'set_slippage' }],
                [{ text: 'Ubah Take Profit', callback_data: 'set_take_profit' }],
                [{ text: 'Ubah Stop Loss', callback_data: 'set_stop_loss' }],
                [{ text: 'Ubah Jito Tip', callback_data: 'set_jito_tip' }],
                [{ text: 'Ubah Preferred DEX', callback_data: 'set_preferred_dex' }],
                [{ text: 'Ubah Copy Wallet', callback_data: 'set_copy_wallet' }],
                [{ text: 'Toggle Multi Buy', callback_data: 'toggle_multi_buy' }],
                [{ text: 'Toggle Trailing Stop', callback_data: 'toggle_trailing_stop' }],
                ...(userSettings.enableTrailingStop ? [
                    [{ text: 'Ubah TSL Distance', callback_data: 'set_tsl_distance' }],
                    [{ text: 'Ubah TSL Activation', callback_data: 'set_tsl_activation' }]
                ] : [])
            ]
        }
    });
});

/**
 * Handle button clicks (callback queries)
 */
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    await bot.answerCallbackQuery(query.id);

    if (data === 'create_wallet') {
        const newWallet = generateWallet();
        const userSettings = await storage.getUserSettings(chatId) || DEFAULT_USER_SETTINGS;
        await storage.saveUserData(chatId, newWallet.publicKey, newWallet.privateKey, userSettings);
        bot.sendMessage(
            chatId,
            `Wallet baru Anda berhasil dibuat!\n\n` +
            `Public Key: \`${newWallet.publicKey}\`\n` +
            `Private Key (simpan baik-baik!): \`${newWallet.privateKey}\`\n\n` +
            `*PENTING: Jangan bagikan Private Key Anda kepada siapapun!*\n\n` +
            `Anda sekarang bisa paste alamat kontrak token untuk cek data atau swap. Gunakan /settings untuk konfigurasi trade.`,
            { parse_mode: 'Markdown' }
        );
    } else if (data === 'import_wallet') {
        userStates.set(chatId, { step: 'awaiting_private_key_import' });
        bot.sendMessage(
            chatId,
            `Silakan paste Private Key (base58-encoded) wallet Anda di sini. ` +
            `\n\n*PERINGATAN: Mengimpor Private Key sangat berisiko. Lakukan dengan risiko Anda sendiri!*`
        );
    } else if (data.startsWith('buy_token_') && !data.endsWith('_X_custom')) { // Handles fixed amount buy buttons
        const userData = await storage.getUserData(chatId);
        if (!userData || !userData.publicKey || !userData.privateKey) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet atau wallet Anda tidak lengkap. Silakan /start untuk membuatnya.');
            return;
        }

        const parts = data.split('_');
        if (parts.length < 4) {
            error(`Invalid callback_data for fixed buy_token: ${data}`);
            bot.sendMessage(chatId, 'Terjadi kesalahan internal pada tombol beli. Mohon coba lagi.');
            return;
        }
        const mint = parts[2];
        const solAmountStr = parts[3];
        const solAmount = parseFloat(solAmountStr);

        if (isNaN(solAmount) || solAmount <= 0) {
            bot.sendMessage(chatId, 'Jumlah beli tidak valid. Mohon coba lagi atau atur ulang /settings.');
            return;
        }
        
        const userKeypair = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
        const userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        await bot.sendMessage(chatId, `Mencoba membeli ${solAmount} SOL dari token \`${mint}\` menggunakan wallet Anda...`);
        
        try {
            const signature = await buyToken(
                { mint, amountSol: solAmount }, 
                userSettings, 
                userKeypair
            );
            bot.sendMessage(chatId, `✅ Berhasil membeli! Transaksi: https://solscan.io/tx/${signature}`);
        } catch (e) {
            error(`Error buying token: ${e.message}`);
            bot.sendMessage(chatId, `❌ Gagal membeli token: ${e.message}.`);
        }
    } else if (data.startsWith('buy_token_') && data.endsWith('_X_custom')) { // Untuk Buy X SOL
        const mintAddress = data.split('_')[2];
        userStates.set(chatId, { step: 'awaiting_custom_buy_amount', data: { mint: mintAddress } });
        bot.sendMessage(chatId, `Masukkan jumlah SOL yang ingin Anda beli untuk token \`${mintAddress}\` (contoh: 0.05):`);
    } else if (data === 'back_to_main') {
        bot.sendMessage(chatId, 'Silakan masukkan alamat kontrak token lain atau gunakan perintah lain.');
    } else if (data.startsWith('refresh_token_')) {
        const mintAddress = data.split('_')[2];
        bot.sendMessage(chatId, `Mencari data terbaru untuk token CA: \`${mintAddress}\`...`, { parse_mode: 'Markdown' });
        // Panggil kembali logika yang sama seperti saat paste CA
        bot.emit('message', { chat: { id: chatId }, text: mintAddress });
    }
    // --- Setting Buttons ---
    else if (data.startsWith('set_')) {
        const userData = await storage.getUserData(chatId);
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return;
        }
        let userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        const settingKey = data.replace('set_', '');
        userStates.set(chatId, { step: `awaiting_input_${settingKey}`, data: { settingKey } });
        let promptMessage = '';
        if (settingKey === 'preferred_dex') {
            promptMessage = `Masukkan nama DEX yang diinginkan (${VALID_DEX_OPTIONS.join(', ')}):`;
        } else if (settingKey === 'copy_wallet') {
            promptMessage = `Masukkan alamat Public Key wallet yang ingin Anda copy tradenya:`;
        } else {
            promptMessage = `Masukkan nilai baru untuk ${settingKey.replace(/_/g, ' ')}:`;
        }
        bot.sendMessage(chatId, promptMessage);
    } else if (data === 'toggle_multi_buy') {
        const userData = await storage.getUserData(chatId);
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return;
        }
        let userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        const newStatus = !userSettings.enableMultiBuy;
        await storage.updateUserSettings(chatId, { enableMultiBuy: newStatus });
        bot.sendMessage(chatId, `Multi Buy berhasil diubah menjadi: ${newStatus ? 'Aktif' : 'Nonaktif'}.`);
        await bot.sendMessage(chatId, 'Gunakan /settings untuk melihat pengaturan terbaru.');
    } else if (data === 'toggle_trailing_stop') {
        const userData = await storage.getUserData(chatId);
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return;
        }
        let userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        const newStatus = !userSettings.enableTrailingStop;
        await storage.updateUserSettings(chatId, { enableTrailingStop: newStatus });
        bot.sendMessage(chatId, `Trailing Stop berhasil diubah menjadi: ${newStatus ? 'Aktif' : 'Nonaktif'}.`);
        await bot.sendMessage(chatId, 'Gunakan /settings untuk melihat pengaturan terbaru.');
    }
});

/**
 * Handle direct text messages (like pasting CA or Private Key or setting values)
 */
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands
    if (text.startsWith('/')) {
        return;
    }

    const currentState = userStates.get(chatId);

    // --- Handle awaiting private key for import ---
    if (currentState && currentState.step === 'awaiting_private_key_import') {
        try {
            const userKeypair = Keypair.fromSecretKey(bs58.decode(text));
            const userSettings = await storage.getUserSettings(chatId) || DEFAULT_USER_SETTINGS;
            await storage.saveUserData(chatId, userKeypair.publicKey.toBase58(), text, userSettings);
            userStates.delete(chatId); // Clear state
            bot.sendMessage(
                chatId,
                `Wallet Anda berhasil diimpor!\n\n` +
                `Public Key: \`${userKeypair.publicKey.toBase58()}\`\n` +
                `Private Key (simpan baik-baik!): \`${text}\`\n\n` + // Tampilkan Private Key yang diimpor
                `*PENTING: Private Key Anda sekarang disimpan di bot ini. Ini berisiko!*` +
                `\n\nAnda sekarang bisa paste alamat kontrak token untuk cek data atau swap. Gunakan /settings untuk konfigurasi trade.`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            error(`Error importing wallet for ${chatId}: ${e.message}`);
            bot.sendMessage(chatId, 'Format Private Key tidak valid. Silakan coba lagi.');
        }
        return;
    }

    // --- Handle custom buy amount input ---
    if (currentState && currentState.step === 'awaiting_custom_buy_amount') {
        const { mint } = currentState.data;
        const customAmount = parseFloat(text);

        if (isNaN(customAmount) || customAmount <= 0) {
            bot.sendMessage(chatId, 'Jumlah SOL yang dimasukkan tidak valid. Mohon masukkan angka positif (contoh: 0.05).');
            return;
        }

        const userData = await storage.getUserData(chatId);
        if (!userData || !userData.privateKey) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            userStates.delete(chatId); // Clear state
            return;
        }

        const userKeypair = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
        const userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        await bot.sendMessage(chatId, `Mencoba membeli ${customAmount} SOL dari token \`${mint}\` menggunakan wallet Anda...`);
        
        try {
            const signature = await buyToken(
                { mint, amountSol: customAmount }, 
                userSettings, 
                userKeypair
            );
            bot.sendMessage(chatId, `✅ Berhasil membeli! Transaksi: https://solscan.io/tx/${signature}`);
        } catch (e) {
            error(`Error buying token: ${e.message}`);
            bot.sendMessage(chatId, `❌ Gagal membeli token: ${e.message}.`);
        } finally {
            userStates.delete(chatId); // Clear state after attempt
        }
        return;
    }

    // --- Handle awaiting input for settings ---
    if (currentState && currentState.step.startsWith('awaiting_input_')) {
        const settingKey = currentState.data.settingKey;
        let valueToSave = text;
        let isValid = true;
        let errorMessage = '';

        if (['buy_amount', 'take_profit', 'stop_loss', 'slippage', 'jito_tip', 'trailing_stop_distance', 'trailing_stop_activation'].includes(settingKey)) {
            const numValue = parseFloat(text);
            if (isNaN(numValue) || numValue < 0) {
                isValid = false;
                errorMessage = `Nilai ${settingKey.replace(/_/g, ' ')} harus angka positif.`;
            } else {
                valueToSave = numValue;
            }
        } else if (settingKey === 'preferred_dex') {
            if (!VALID_DEX_OPTIONS.includes(text.toLowerCase())) {
                isValid = false;
                errorMessage = `DEX tidak valid. Pilih dari: ${VALID_DEX_OPTIONS.join(', ')}.`;
            } else {
                valueToSave = text.toLowerCase();
            }
        } else if (settingKey === 'copy_wallet') {
            try {
                new PublicKey(text); // Coba validasi sebagai Public Key Solana
            } catch (e) {
                isValid = false;
                errorMessage = `Alamat Public Key tidak valid.`;
            }
        }

        if (isValid) {
            try {
                await storage.updateUserSettings(chatId, { [settingKey]: valueToSave });
                bot.sendMessage(chatId, `${settingKey.replace(/_/g, ' ')} berhasil diperbarui menjadi: \`${valueToSave}\`.`);
                userStates.delete(chatId); // Clear state
                await bot.sendMessage(chatId, 'Gunakan /settings untuk melihat pengaturan terbaru.');
            } catch (storageErr) {
                 error(`Error updating user settings for ${chatId}: ${storageErr.message}`);
                 bot.sendMessage(chatId, `❌ Gagal memperbarui pengaturan: ${storageErr.message}.`);
            }
        } else {
            bot.sendMessage(chatId, `❌ Gagal memperbarui ${settingKey.replace(/_/g, ' ')}: ${errorMessage}\nSilakan coba lagi.`);
        }
        return;
    }

    // --- Assume user pasted a Contract Address (CA) ---
    if (text.length >= 32 && text.length <= 44 && !text.includes(' ')) {
        const mintAddress = text;
        bot.sendMessage(chatId, `Mencari data untuk token CA: \`${mintAddress}\`...`, { parse_mode: 'Markdown' });

        try {
            const priceData = await getPriceOnChain(mintAddress); // priceData sekarang seharusnya sudah angka
            const userData = await storage.getUserData(chatId);
            const userSettings = userData ? userData.settings : DEFAULT_USER_SETTINGS;
            const userWalletPublicKey = userData ? userData.publicKey : null;

            let userSolBalance = '0.0000';
            if (userWalletPublicKey) {
                try {
                    const connection = new Connection(config.SOLANA_RPC, 'confirmed');
                    const balanceLamports = await connection.getBalance(new PublicKey(userWalletPublicKey));
                    userSolBalance = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4); // Gunakan LAMPORTS_PER_SOL
                } catch (balanceErr) {
                    warn(`[Bot] Gagal mendapatkan balance SOL untuk ${userWalletPublicKey}: ${balanceErr.message}`);
                }
            }
            
            // --- UI/DISPLAY LOGIC ---
            // priceData.priceInSol dan priceData.priceInUsd seharusnya sudah Number dari priceChecker.js
            if (priceData && typeof priceData.priceInSol === 'number' && typeof priceData.priceInUsd === 'number') {
                const tokenName = priceData.symbol || 'Token'; 
                const tokenAddressShort = mintAddress.substring(0, 4) + '...' + mintAddress.substring(mintAddress.length - 4);
                const liq = priceData.volume24h ? (parseFloat(priceData.volume24h) / 1000).toFixed(1) : 'N/A';
                const mc = priceData.marketCap ? (parseFloat(priceData.marketCap) / 1000).toFixed(1) : 'N/A';
                // Asumsi Coinvera API mengembalikan properti 'renounced' (boolean)
                const renouncedStatus = priceData.renounced === true ? '✅' : (priceData.renounced === false ? '❌' : '❓'); // Handle null/undefined juga

                let message = `*${tokenName}* (${tokenAddressShort})\n`;
                message += `[Buy ${tokenName}](https://dexscreener.com/solana/${mintAddress})\n`; 
                message += `Share token with your Reflink\n\n`; 

                message += `Balance: ${userSolBalance} SOL — W1 ✏️\n`; 
                message += `Price: $${priceData.priceInUsd.toFixed(5)} — LIQ: $${liq}K — MC: $${mc}K\n`; 
                message += `Renounced ${renouncedStatus}\n\n`; 

                const progress = parseFloat(priceData.bondingCurveProgress);
                if (!isNaN(progress)) {
                    message += `💊 Bonding Curve Progression: ${progress.toFixed(2)}%\n`;
                    const filledBlocks = Math.round(progress / 10); 
                    const emptyBlocks = 10 - filledBlocks;
                    message += `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]\n\n`;
                } else {
                    message += `Bonding Curve Progression: N/A\n\n`;
                }
                
                // Estimasi token dan USD untuk buyAmount default user
                const buyAmountForDisplay = userSettings.buyAmount || DEFAULT_USER_SETTINGS.buyAmount;
                const estimatedTokens = priceData.priceInSol > 0 ? (buyAmountForDisplay / priceData.priceInSol).toFixed(2) : 'N/A';
                const estimatedUsd = priceData.priceInUsd > 0 && priceData.priceInSol > 0 ? (buyAmountForDisplay * (priceData.priceInUsd / priceData.priceInSol)).toFixed(2) : 'N/A';

                message += `${buyAmountForDisplay} SOL ↔️ ${estimatedTokens} ${tokenName} ($${estimatedUsd})\n`;
                message += `Price Impact: N/A\n`; // Masih placeholder

                bot.sendMessage(chatId, message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '← Back', callback_data: 'back_to_main' }, { text: '↻ Refresh', callback_data: `refresh_token_${mintAddress}` }],
                            [{ text: 'Buy 0.5 SOL', callback_data: `buy_token_${mintAddress}_0.5` }],
                            [{ text: 'Buy 1 SOL', callback_data: `buy_token_${mintAddress}_1` }],
                            [{ text: 'Buy X SOL ✏️', callback_data: `buy_token_${mintAddress}_X_custom` }]
                        ],
                    },
                });

            } else {
                bot.sendMessage(
                    chatId,
                    `❌ Gagal mendapatkan data harga yang valid untuk token ini. ` +
                    `Mungkin token ini tidak didukung oleh Coinvera API (terutama jika bukan token Pump.fun), ` +
                    `ada masalah dengan API key Anda, atau format data tidak terduga.`
                );
            }
        } catch (e) {
            error(`Error fetching price for ${mintAddress}: ${e.message}`);
            bot.sendMessage(chatId, `Terjadi kesalahan saat mengambil data token: ${e.message}`);
        }
    } else {
        bot.sendMessage(chatId, 'Mohon masukkan alamat kontrak token yang valid atau pilih perintah.');
    }
});
