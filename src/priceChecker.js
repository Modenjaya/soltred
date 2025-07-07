// src/priceChecker.js
const fetch = require('node-fetch').default; // ← note the ".default"
const config = require('./config');
const { info, error } = require('./logger');

/**
 * Fetch price data for a given mint address via Coinvera HTTP API.
 * Returns: object with priceInSol (Number), priceInUsd (Number), and other properties from API,
 * or null on failure or invalid data.
 */
async function getPriceOnChain(mint) {
  const url = `https://api.coinvera.io/api/v1/price?ca=${mint}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.COINVERA_API // Menggunakan API Key dari config
      }
    });

    const data = await res.json(); // Selalu coba parse JSON untuk mendapatkan detail error

    // Jika respons HTTP bukan OK, lemparkan error dengan detail dari API jika tersedia
    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}: ${res.statusText}`;
      if (data && data.error && data.message) {
          errorMessage = `Coinvera API Error: ${data.code} - ${data.message} (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }
    
    // PENTING: Konversi string harga menjadi Number
    // API Coinvera mengembalikan priceInSol dan priceInUsd sebagai STRING.
    // Kita harus mengubahnya menjadi Number agar fungsi .toFixed() dapat digunakan.
    const priceInSolNum = parseFloat(data.priceInSol);
    const priceInUsdNum = parseFloat(data.priceInUsd);

    // Tambahkan validasi jika hasil konversi adalah NaN (Not a Number)
    if (isNaN(priceInSolNum) || isNaN(priceInUsdNum)) {
        throw new Error(`Invalid price format from API: priceInSol or priceInUsd is not a valid number. Raw: ${JSON.stringify(data)}`);
    }

    // Kembalikan seluruh objek data yang diterima dari API,
    // tetapi dengan properti priceInSol dan priceInUsd yang sudah dikonversi menjadi Number.
    // Ini memastikan properti lain seperti 'dex', 'volume24h', 'marketCap', 'symbol', 'bondingCurveProgress', 'renounced'
    // tetap tersedia untuk digunakan di bot.js jika API menyediakannya.
    return {
        ...data, // Copy semua properti lain dari respons API
        priceInSol: priceInSolNum, // Timpa dengan versi Number
        priceInUsd: priceInUsdNum  // Timpa dengan versi Number
    };
    
  } catch (err) {
    error(`[priceChecker] Failed to fetch price for ${mint}: ${err.message}`);
    // Jika ada error (HTTP error, parsing error, atau konversi NaN), kembalikan null
    return null;
  }
}

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getPriceOnChain, sleep };
