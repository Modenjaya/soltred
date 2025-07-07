// src/priceChecker.js
const fetch = require('node-fetch').default;
const config = require('./config');
const { info, error } = require('./logger');

async function getPriceOnChain(mint) {
    const url = `https://api.coinvera.io/api/v1/price?ca=${mint}`;
    try {
      const res = await fetch(url, { /* ... */ });
      const data = await res.json();

      console.log('[PriceChecker] Raw API response data:', data); // <-- TAMBAHKAN INI

      if (!res.ok) {
        // ... (error handling)
      }

      const priceInSolNum = parseFloat(data.priceInSol);
      const priceInUsdNum = parseFloat(data.priceInUsd);

      if (isNaN(priceInSolNum) || isNaN(priceInUsdNum)) {
          // Ini akan menangkap jika priceInSol/Usd tidak valid Number
          throw new Error(`Invalid price format from API: priceInSol or priceInUsd is not a valid number. Raw: ${JSON.stringify(data)}`);
      }

      return {
          ...data,
          priceInSol: priceInSolNum,
          priceInUsd: priceInUsdNum
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
