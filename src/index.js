// src/bot.js
require('dotenv').config(); // Load environment variables from .env

const TelegramBot = require('node-telegram-bot-api');
const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');

const config = require('./config');
const { info, error } = require('./logger');
const storage = require('./storage'); // Menggunakan storage baru berbasis SQLite
const { getPriceOnChain } = require('./priceChecker');
const { buyToken, sellToken } = require('./tradeExecutor');

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
  return (lamports / 1_000_000_000).toFixed(4);
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
    welcomeMessage += `*PENTING: Private Key Anda akan disimpan di bot ini (terenkripsi).* Ini berisiko. Lakukan dengan risiko Anda sendiri.\n`;
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
                // Tambahkan tombol untuk TSL distance dan activation jika TSL diaktifkan
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
    await bot.answerCallbackQuery(query.id); // dismiss the loading state on the button

    // Pindahkan pengecekan userData ke dalam blok yang relevan
    // Artinya, logika create_wallet dan import_wallet TIDAK PERLU cek userData di awal

    if (data === 'create_wallet') {
        const newWallet = generateWallet();
        // Ambil pengaturan yang ada atau default jika baru
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
    } else if (data.startsWith('buy_token_')) {
        // Pengecekan userData diperlukan di sini karena ini adalah aksi yang memerlukan wallet
        const userData = await storage.getUserData(chatId); // Cek userData DI SINI
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return; // Penting: keluar dari fungsi jika tidak ada wallet
        }

        const [, mint, solAmountStr] = data.split('_');
        const solAmount = parseFloat(solAmountStr);

        userStates.set(chatId, { 
            step: 'confirm_private_key_for_buy', 
            data: { mint, solAmount } 
        });

        bot.sendMessage(
            chatId,
            `Untuk membeli ${solAmount} SOL dari token \`${mint}\`, ` +
            `silakan paste Private Key (base58-encoded) wallet Anda di sini untuk konfirmasi.\n\n` +
            `*PERINGATAN: Private Key Anda akan digunakan untuk menandatangani transaksi ini. ` +
            `Jangan berikan kepada siapapun yang tidak Anda percaya!*`,
            { parse_mode: 'Markdown' }
        );
    } 
    // --- Setting Buttons ---
    else if (data.startsWith('set_')) {
        // Pengecekan userData diperlukan di sini karena ini adalah aksi yang memerlukan wallet
        const userData = await storage.getUserData(chatId); // Cek userData DI SINI
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return; // Penting: keluar dari fungsi jika tidak ada wallet
        }
        let userSettings = userData.settings || DEFAULT_USER_SETTINGS; // Ambil setting yang sudah ada

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
        // Pengecekan userData diperlukan di sini
        const userData = await storage.getUserData(chatId); // Cek userData DI SINI
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return; // Penting: keluar dari fungsi jika tidak ada wallet
        }
        let userSettings = userData.settings || DEFAULT_USER_SETTINGS;

        const newStatus = !userSettings.enableMultiBuy;
        await storage.updateUserSettings(chatId, { enableMultiBuy: newStatus });
        bot.sendMessage(chatId, `Multi Buy berhasil diubah menjadi: ${newStatus ? 'Aktif' : 'Nonaktif'}.`);
        await bot.sendMessage(chatId, 'Gunakan /settings untuk melihat pengaturan terbaru.');
    } else if (data === 'toggle_trailing_stop') {
        // Pengecekan userData diperlukan di sini
        const userData = await storage.getUserData(chatId); // Cek userData DI SINI
        if (!userData) {
            bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
            return; // Penting: keluar dari fungsi jika tidak ada wallet
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
                `Public Key: \`${userKeypair.publicKey.toBase58()}\`\n\n` +
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

    // --- Handle awaiting private key for transaction confirmation ---
    if (currentState && currentState.step === 'confirm_private_key_for_buy') {
        const { mint, solAmount } = currentState.data;
        try {
            const userKeypair = Keypair.fromSecretKey(bs58.decode(text));
            userStates.delete(chatId); // Clear state

            // Pastikan private key yang dimasukkan sesuai dengan yang tersimpan
            const userData = await storage.getUserData(chatId);
            if (!userData || userData.privateKey !== text) {
                bot.sendMessage(chatId, 'Private Key yang dimasukkan tidak cocok dengan wallet Anda yang terdaftar. Transaksi dibatalkan.');
                return;
            }

            // Ambil pengaturan trade spesifik user
            const userSettings = userData.settings || DEFAULT_USER_SETTINGS;

            await bot.sendMessage(chatId, `Mencoba membeli ${solAmount} SOL dari token \`${mint}\` menggunakan wallet Anda...`);
            
            // Panggil buyToken dengan Keypair pengguna dan setting spesifik user
            const signature = await buyToken(
                { mint, amountSol: solAmount }, 
                userSettings, // Kirim userSettings ke tradeExecutor
                userKeypair
            );

            bot.sendMessage(chatId, `✅ Berhasil membeli! Transaksi: https://solscan.io/tx/${signature}`);
        } catch (e) {
            error(`Error buying token for ${chatId}: ${e.message}`);
            bot.sendMessage(chatId, `❌ Gagal membeli token: ${e.message}. Pastikan Private Key valid dan Anda memiliki cukup SOL.`);
        }
        return;
    }

    // --- Handle awaiting input for settings ---
    if (currentState && currentState.step.startsWith('awaiting_input_')) {
        const settingKey = currentState.data.settingKey;
        let valueToSave = text;
        let isValid = true;
        let errorMessage = '';

        // Validasi input berdasarkan settingKey
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
            await storage.updateUserSettings(chatId, { [settingKey]: valueToSave });
            bot.sendMessage(chatId, `${settingKey.replace(/_/g, ' ')} berhasil diperbarui menjadi: \`${valueToSave}\`.`);
            userStates.delete(chatId); // Clear state
            await bot.sendMessage(chatId, 'Gunakan /settings untuk melihat pengaturan terbaru.');
        } else {
            bot.sendMessage(chatId, `❌ Gagal memperbarui ${settingKey.replace(/_/g, ' ')}: ${errorMessage}\nSilakan coba lagi.`);
        }
        return;
    }

    // --- Assume user pasted a Contract Address (CA) ---
    if (text.length >= 32 && text.length <= 44 && !text.includes(' ')) { // Simple check for Solana address length
        const mintAddress = text;
        bot.sendMessage(chatId, `Mencari data untuk token CA: \`${mintAddress}\`...`, { parse_mode: 'Markdown' });

        try {
            const priceData = await getPriceOnChain(mintAddress);

            if (priceData) {
                let message = `**Data Token ${mintAddress}:**\n`;
                message += `Harga per token (SOL): ${priceData.priceInSol ? priceData.priceInSol.toFixed(9) : 'N/A'}\n`;
                message += `Harga per token (USD): $${priceData.priceInUsd ? priceData.priceInUsd.toFixed(9) : 'N/A'}\n`;
                message += `Dex Utama: ${priceData.dex || 'N/A'}\n`;
                message += `Volume 24h: ${priceData.volume24h ? priceData.volume24h.toFixed(2) : 'N/A'}\n`;
                message += `Market Cap: ${priceData.marketCap ? priceData.marketCap.toFixed(2) : 'N/A'}\n\n`;
                message += `_Data ini berasal dari Coinvera API. Untuk token non-Pump.fun, data mungkin tidak tersedia._`;

                // Get user's buy amount setting
                const userData = await storage.getUserData(chatId);
                const userSettings = userData ? userData.settings : DEFAULT_USER_SETTINGS;
                const buyAmountSol = userSettings.buyAmount || DEFAULT_USER_SETTINGS.buyAmount; 

                // Add Buy button
                bot.sendMessage(chatId, message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `💰 Beli ${buyAmountSol} SOL`, callback_data: `buy_token_${mintAddress}_${buyAmountSol}` }],
                            // Anda bisa menambahkan tombol lain seperti 'Jual', 'Lihat di Solscan', dll.
                        ],
                    },
                });

            } else {
                bot.sendMessage(
                    chatId,
                    `❌ Gagal mendapatkan data harga untuk token ini. ` +
                    `Mungkin token ini tidak didukung oleh Coinvera API (terutama jika bukan token Pump.fun), ` +
                    `atau ada masalah dengan API key Anda.`
                );
            }
        } catch (e) {
            error(`Error fetching price for ${mintAddress}: ${e.message}`);
            bot.sendMessage(chatId, `Terjadi kesalahan saat mengambil data token: ${e.message}`);
        }
    } else {
        // If it's not a CA and not a command, just echo or ignore
        bot.sendMessage(chatId, 'Mohon masukkan alamat kontrak token yang valid atau pilih perintah.');
    }
});
