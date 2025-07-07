// src/bot.js
require('dotenv').config(); // Load environment variables from .env

const TelegramBot = require('node-telegram-bot-api');
const { Keypair, PublicKey } = require('@solana/web3.js'); //
const bs58 = require('bs58'); //

const config = require('./config'); //
const { info, error } = require('./logger'); //
const storage = require('./storage'); //
const { getPriceOnChain } = require('./priceChecker'); //
const { buyToken, sellToken } = require('./tradeExecutor'); //

// Inisialisasi Bot Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  error('TELEGRAM_BOT_TOKEN tidak ditemukan di environment variables.');
  process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// State untuk menyimpan proses pengguna (misalnya, menunggu Private Key)
const userStates = new Map(); // Map<chatId, { step: string, data: any }>

// Inisialisasi penyimpanan
storage.initStorage(); //
info('Bot Telegram dimulai.');

// --- HELPER FUNCTIONS ---

/**
 * Format SOL amount to a readable string.
 */
function formatSolAmount(lamports) {
  return (lamports / 1_000_000_000).toFixed(4); // 1 SOL = 1,000,000,000 lamports
}

/**
 * Generate a new Solana wallet.
 */
function generateWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
  };
}

/**
 * Handle /start command
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const existingWallet = storage.getUserWallet(chatId); //

  let welcomeMessage = `Selamat datang di Solana Swap Bot! 👋\n\n`;

  if (existingWallet) {
    welcomeMessage += `Anda sudah memiliki wallet terdaftar:\nPublic Key: \`${existingWallet.publicKey}\`\n\n`;
    welcomeMessage += `Anda bisa langsung paste alamat kontrak token di sini untuk cek data atau melakukan swap.`;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  } else {
    welcomeMessage += `Untuk memulai, Anda perlu membuat atau mengimpor wallet.\n`;
    welcomeMessage += `Pilih opsi di bawah ini:`;
    bot.sendMessage(chatId, welcomeMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Buat Wallet Baru', callback_data: 'create_wallet' }],
          [{ text: '⬆️ Impor Wallet', callback_data: 'import_wallet' }],
        ],
      },
    });
  }
});

/**
 * Handle button clicks (callback queries)
 */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id); // dismiss the loading state on the button

  if (data === 'create_wallet') {
    const newWallet = generateWallet();
    storage.saveUserWallet(chatId, newWallet.publicKey, newWallet.privateKey); //
    bot.sendMessage(
      chatId,
      `Wallet baru Anda berhasil dibuat!\n\n` +
      `Public Key: \`${newWallet.publicKey}\`\n` +
      `Private Key (simpan baik-baik!): \`${newWallet.privateKey}\`\n\n` +
      `*PENTING: Jangan bagikan Private Key Anda kepada siapapun!*\n\n` +
      `Anda sekarang bisa paste alamat kontrak token untuk cek data atau swap.`,
      { parse_mode: 'Markdown' }
    );
  } else if (data === 'import_wallet') {
    userStates.set(chatId, { step: 'awaiting_private_key' });
    bot.sendMessage(
      chatId,
      `Silakan paste Private Key (base58-encoded) wallet Anda di sini. ` +
      `\n\n*PERINGATAN: Mengimpor Private Key sangat berisiko. Lakukan dengan risiko Anda sendiri!*`
    );
  } else if (data.startsWith('buy_token_')) {
    const [, mint, solAmountStr] = data.split('_');
    const solAmount = parseFloat(solAmountStr);

    const userWallet = storage.getUserWallet(chatId); //
    if (!userWallet) {
      bot.sendMessage(chatId, 'Anda belum memiliki wallet. Silakan /start untuk membuatnya.');
      return;
    }

    try {
      // Re-initialize Keypair with user's private key for the transaction
      const userKeypair = Keypair.fromSecretKey(bs58.decode(userWallet.privateKey)); //
      
      // Override global config PUBLIC_KEY and PRIVATE_KEY for this transaction
      // This is a simplistic way for a single-user bot. For multi-user, 
      // tradeExecutor.js needs to be refactored to accept keypair directly.
      const originalPublicKey = config.PUBLIC_KEY;
      const originalPrivateKey = config.PRIVATE_KEY;
      
      config.PUBLIC_KEY = userKeypair.publicKey.toBase58();
      config.PRIVATE_KEY = bs58.encode(userKeypair.secretKey);

      await bot.sendMessage(chatId, `Mencoba membeli ${solAmount} SOL dari token ${mint}...`);
      const signature = await buyToken({
        mint,
        amountSol: solAmount,
        slippage: config.SLIPPAGE, //
        tip: config.JITO_TIP, //
        dex: config.PREFERRED_DEX === 'none' ? 'jupiter' : config.PREFERRED_DEX, // Default to jupiter if none
      });
      bot.sendMessage(chatId, `✅ Berhasil membeli! Transaksi: https://solscan.io/tx/${signature}`);
    } catch (e) {
      error(`Error buying token: ${e.message}`); //
      bot.sendMessage(chatId, `❌ Gagal membeli token: ${e.message}`);
    } finally {
        // Restore original config values
        config.PUBLIC_KEY = originalPublicKey;
        config.PRIVATE_KEY = originalPrivateKey;
    }

  }
});

/**
 * Handle direct text messages (like pasting CA or Private Key)
 */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore commands
  if (text.startsWith('/')) {
    return;
  }

  // Handle awaiting private key
  const currentState = userStates.get(chatId);
  if (currentState && currentState.step === 'awaiting_private_key') {
    try {
      const decodedPk = bs58.decode(text); //
      const keypair = Keypair.fromSecretKey(decodedPk); //
      storage.saveUserWallet(chatId, keypair.publicKey.toBase58(), text); //
      userStates.delete(chatId); // Clear state
      bot.sendMessage(
        chatId,
        `Wallet Anda berhasil diimpor!\n\n` +
        `Public Key: \`${keypair.publicKey.toBase58()}\`\n\n` +
        `*PENTING: Private Key Anda sekarang disimpan di bot ini. Ini berisiko!*` +
        `\n\nAnda sekarang bisa paste alamat kontrak token untuk cek data atau swap.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      error(`Error importing wallet for ${chatId}: ${e.message}`); //
      bot.sendMessage(chatId, 'Format Private Key tidak valid. Silakan coba lagi.');
    }
    return;
  }

  // Assume user pasted a Contract Address (CA)
  if (text.length >= 32 && text.length <= 44 && !text.includes(' ')) { // Simple check for Solana address length
    const mintAddress = text;
    bot.sendMessage(chatId, `Mencari data untuk token CA: \`${mintAddress}\`...`, { parse_mode: 'Markdown' });

    try {
      const priceData = await getPriceOnChain(mintAddress); //

      if (priceData) {
        let message = `**Data Token ${mintAddress}:**\n`;
        message += `Harga per token (SOL): ${priceData.priceInSol ? priceData.priceInSol.toFixed(9) : 'N/A'}\n`;
        message += `Harga per token (USD): $${priceData.priceInUsd ? priceData.priceInUsd.toFixed(9) : 'N/A'}\n`;
        message += `Dex Utama: ${priceData.dex || 'N/A'}\n`;
        message += `Volume 24h: ${priceData.volume24h ? priceData.volume24h.toFixed(2) : 'N/A'}\n`;
        message += `Market Cap: ${priceData.marketCap ? priceData.marketCap.toFixed(2) : 'N/A'}\n\n`;
        message += `_Data ini berasal dari Coinvera API. Untuk token non-Pump.fun, data mungkin tidak tersedia._`;

        // Add Buy button (example for 0.01 SOL)
        const buyAmountSol = 0.01; // Contoh: Beli 0.01 SOL
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
      error(`Error fetching price for ${mintAddress}: ${e.message}`); //
      bot.sendMessage(chatId, `Terjadi kesalahan saat mengambil data token: ${e.message}`);
    }
  } else {
    // If it's not a CA and not a command, just echo or ignore
    bot.sendMessage(chatId, 'Mohon masukkan alamat kontrak token yang valid atau pilih perintah.');
  }
});