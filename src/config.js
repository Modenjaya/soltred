// src/config.js
require('dotenv').config();
const { exit } = require('process');

function requiredEnv(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`[config] ERROR: Missing environment variable ${key}`);
    exit(1);
  }
  return val;
}

const config = {
  SOLANA_RPC:         requiredEnv('SOLANA_RPC'),
  PRIVATE_KEY:        requiredEnv('PRIVATE_KEY'), // Private Key bot sendiri (jika diperlukan untuk internal)
  PUBLIC_KEY:         requiredEnv('PUBLIC_KEY'),  // Public Key bot sendiri (jika diperlukan untuk internal)
  JITO_ENGINE:        process.env.JITO_ENGINE || null, // Opsional jika tidak pakai Jito
  JITO_TIP_ACCOUNT:   process.env.JITO_TIP_ACCOUNT || '96gYZMGz6LgT4b2M775x6JygM8P22sZc5AETXjQcBCzJ', // Default Jito tip account
  COINVERA_API:       requiredEnv('COINVERA_API'),
  PRICE_CHECK_DELAY:  parseInt(process.env.PRICE_CHECK_DELAY || '5000', 10), // Bisa jadi global atau per user

  // Path ke database SQLite
  DATABASE_PATH:      process.env.DATABASE_PATH || './data/bot.db', // Default path

  // Variabel-variabel ini TIDAK lagi requiredEnv secara global
  // Mereka akan disimpan per user di database
  BOT_MODE:           (process.env.BOT_MODE || 'COPY').toUpperCase(), // Default COPY jika tidak disetel global
  COPY_WALLET:        process.env.COPY_WALLET || null,
  TRADE_TYPE:         (process.env.TRADE_TYPE || 'EXACT').toUpperCase(),
  BUY_AMOUNT:         parseFloat(process.env.BUY_AMOUNT || '0'),
  TAKE_PROFIT:        parseFloat(process.env.TAKE_PROFIT || '0'),
  STOP_LOSS:          parseFloat(process.env.STOP_LOSS || '0'),
  SLIPPAGE:           parseFloat(process.env.SLIPPAGE || '10'),
  JITO_TIP:           parseFloat(process.env.JITO_TIP || '0.0001'),
  PREFERRED_DEX:      (process.env.PREFERRED_DEX || 'none').toLowerCase(),

  ENABLE_MULTI_BUY:   (process.env.ENABLE_MULTI_BUY === 'true'),
  ENABLE_TRAILING_STOP: (process.env.ENABLE_TRAILING_STOP === 'true'),
  TRAILING_STOP_DISTANCE: parseFloat(process.env.TRAILING_STOP_DISTANCE || '0'),
  TRAILING_STOP_ACTIVATION: parseFloat(process.env.TRAILING_STOP_ACTIVATION || '0'),
};

const validBotModes   = ['COPY', 'SELLING'];
const validTradeTypes = ['EXACT', 'SAFE'];
const validDexOptions = ['none', 'auto', 'pumpfun', 'meteora', 'raydium', 'moonshot', 'jupiter'];

// Validasi tetap untuk mode bot global
if (!validBotModes.includes(config.BOT_MODE)) {
  console.error(`[config] ERROR: BOT_MODE must be one of: ${validBotModes.join(', ')}`);
  exit(1);
}

// Catatan: Validasi untuk TRADE_TYPE, BUY_AMOUNT, dll, akan dilakukan saat user mengatur di bot
// atau saat memuat setting dari DB.

module.exports = config;
