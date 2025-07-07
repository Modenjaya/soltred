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

    const data = await res.json();
    
    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}: ${res.statusText}`;
      if (data && data.error && data.message) {
          errorMessage = `Coinvera API Error: ${data.code} - ${data.message} (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }
    
    // PENTING: Konversi string harga menjadi Number di sini
    const priceInSolNum = parseFloat(data.priceInSol); // Menggunakan parseFloat
    const priceInUsdNum = parseFloat(data.priceInUsd); // Menggunakan parseFloat

    // Tambahkan validasi jika hasil konversi adalah NaN
    if (isNaN(priceInSolNum) || isNaN(priceInUsdNum)) {
        throw new Error(`Invalid price format from API: priceInSol or priceInUsd is not a valid number. Raw: ${JSON.stringify(data)}`);
    }

    // Kembalikan seluruh objek data, tapi dengan harga yang sudah dikonversi menjadi Number
    return {
        ...data, // Copy semua properti lain
        priceInSol: priceInSolNum, // Ganti dengan yang sudah dikonversi
        priceInUsd: priceInUsdNum  // Ganti dengan yang sudah dikonversi
    };
    
  } catch (err) {
    error(`[priceChecker] Failed to fetch price for ${mint}: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getPriceOnChain, sleep };
