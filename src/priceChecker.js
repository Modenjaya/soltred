// src/priceChecker.js
const fetch = require('node-fetch').default;
const config = require('./config');
const { info, error } = require('./logger');

async function getPriceOnChain(mint) {
  const url = `https://api.coinvera.io/api/v1/price?ca=${mint}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.COINVERA_API
      }
    });
    // Selalu coba parse JSON untuk mendapatkan detail error, bahkan jika !res.ok
    const data = await res.json(); // <-- PENTING: Pindahkan ini ke atas

    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}: ${res.statusText}`;
      if (data && data.error && data.message) {
          errorMessage = `Coinvera API Error: ${data.code} - ${data.message} (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }

    // Jika berhasil, kembalikan SELURUH data yang diterima
    return data; // <-- PENTING: Kembalikan seluruh objek data

  } catch (err) {
    error(`[priceChecker] Failed to fetch price for ${mint}: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getPriceOnChain, sleep };
