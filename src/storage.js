// src/storage.js
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const getTimestamp = require('../utils/getTimestamp');
const { info, error } = require('./logger');
const config = require('./config');

// Import bs58 safely
let bs58;
try {
  const imported = require('bs58');
  bs58 = imported.default ? imported.default : imported;
} catch (err) {
  bs58 = require('bs58');
}

const positionsFilePath = path.join(__dirname, '../data/positions.json');
let db; // Deklarasi variabel database

/**
 * Initialize storage:
 * 1. Ensure data/positions.json exists (old system for positions)
 * 2. Connect to SQLite database and create tables if they don't exist
 */
function initStorage() {
  // --- Initialize old positions.json (if still needed) ---
  if (!fs.existsSync(positionsFilePath)) {
    const dir = path.dirname(positionsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writePositionsData({ positions: [] });
  } else {
    const data = readPositionsData();
    if (!data || typeof data !== 'object' || !Array.isArray(data.positions)) {
      writePositionsData({ positions: [] });
    }
  }

  // --- Initialize SQLite Database ---
  const dbDir = path.dirname(config.DATABASE_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database(config.DATABASE_PATH, (err) => {
    if (err) {
      error(`[Storage] Error connecting to SQLite database: ${err.message}`);
      process.exit(1);
    }
    info(`[Storage] Connected to SQLite database: ${config.DATABASE_PATH}`);
    db.run(`
      CREATE TABLE IF NOT EXISTS user_settings (
        telegram_id TEXT PRIMARY KEY,
        public_key TEXT,
        private_key TEXT, -- WARNING: Storing private keys directly is a security risk. CONSIDER DEEP LINKING
        settings_json TEXT
      )
    `, (err) => {
      if (err) {
        error(`[Storage] Error creating user_settings table: ${err.message}`);
        process.exit(1);
      }
      info('[Storage] user_settings table ensured.');
    });
  });
}

/**
 * Read the entire JSON from disk (synchronously).
 * If the file is missing or corrupted, return { positions: [] }.
 */
function readPositionsData() {
  try {
    const raw = fs.readFileSync(positionsFilePath, 'utf-8');
    const json = JSON.parse(raw);
    if (!json || typeof json !== 'object' || !Array.isArray(json.positions)) {
      return { positions: [] };
    }
    return json;
  } catch (err) {
    return { positions: [] };
  }
}

/**
 * Write the entire data object back to disk (synchronously).
 * @param {object} data - should be of shape { positions: [ ... ] }
 */
function writePositionsData(data) {
  fs.writeFileSync(positionsFilePath, JSON.stringify(data, null, 2), 'utf-8');
}

// --- User Settings and Wallet (SQLite) ---

/**
 * Get user settings and wallet from DB.
 * @param {string} telegramId
 * @returns {Promise<object|null>} { publicKey, privateKey, settings: { ... } } or null
 */
async function getUserData(telegramId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM user_settings WHERE telegram_id = ?`, [telegramId], (err, row) => {
      if (err) {
        error(`[Storage] Error getting user data for ${telegramId}: ${err.message}`);
        return reject(err);
      }
      if (row) {
        try {
          const settings = row.settings_json ? JSON.parse(row.settings_json) : {};
          resolve({
            publicKey: row.public_key,
            privateKey: row.private_key, // Still warning about this
            settings: settings
          });
        } catch (parseErr) {
          error(`[Storage] Error parsing settings_json for ${telegramId}: ${parseErr.message}`);
          resolve(null); // Corrupted data, treat as not found
        }
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Save or update user settings and wallet in DB.
 * @param {string} telegramId
 * @param {string} publicKey
 * @param {string} privateKey - WARNING: Storing private keys directly is a security risk.
 * @param {object} settings - JSON object of user-specific trade settings
 * @returns {Promise<void>}
 */
async function saveUserData(telegramId, publicKey, privateKey, settings) {
  const settingsJson = JSON.stringify(settings);
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO user_settings (telegram_id, public_key, private_key, settings_json) VALUES (?, ?, ?, ?)`,
      [telegramId, publicKey, privateKey, settingsJson],
      function (err) {
        if (err) {
          error(`[Storage] Error saving user data for ${telegramId}: ${err.message}`);
          return reject(err);
        }
        info(`[Storage] User data saved for ${telegramId}.`);
        resolve();
      }
    );
  });
}

/**
 * Get only user's trade settings.
 * @param {string} telegramId
 * @returns {Promise<object|null>} settings object or null
 */
async function getUserSettings(telegramId) {
  const userData = await getUserData(telegramId);
  return userData ? userData.settings : null;
}

/**
 * Update specific settings for a user.
 * @param {string} telegramId
 * @param {object} updates - Partial object of settings to update
 * @returns {Promise<void>}
 */
async function updateUserSettings(telegramId, updates) {
    const userData = await getUserData(telegramId);
    let currentSettings = userData ? userData.settings : {};
    const newSettings = { ...currentSettings, ...updates };
    
    // We need publicKey and privateKey from existing data to re-save all fields
    const publicKey = userData ? userData.publicKey : null;
    const privateKey = userData ? userData.privateKey : null;

    if (!publicKey || !privateKey) {
        error(`[Storage] Cannot update settings for ${telegramId}: Wallet not found.`);
        throw new Error("User wallet not initialized. Please /start first.");
    }

    return saveUserData(telegramId, publicKey, privateKey, newSettings);
}

// --- Existing Positions Management (JSON file remains) ---

/**
 * Add a new open position.
 * positionData must include:
 * mint, buy_amount, token_amount, entry_price,
 * trade_mode, dex, parent_signature?, stop_loss_pct?, take_profit_pct?
 */
function addPosition(positionData) {
  const data = readPositionsData();

  const newPosition = {
    id: uuidv4(),
    time: getTimestamp(),
    mint: positionData.mint,
    buy_amount: positionData.buy_amount,
    token_amount: positionData.token_amount,
    entry_price: positionData.entry_price,
    current_price: positionData.entry_price,
    status: 'active',
    trade_mode: positionData.trade_mode,
    parent_signature: positionData.parent_signature || null,
    stop_loss_pct: positionData.stop_loss_pct || null,
    take_profit_pct: positionData.take_profit_pct || null,
    dex: positionData.dex,
    
    highest_price: positionData.entry_price,
    trailing_stop_price: null,
    trailing_stop_activated: false,
    trailing_stop_distance: positionData.trailing_stop_distance || null,
    trailing_stop_activation: positionData.trailing_stop_activation || null
  };

  data.positions.push(newPosition);
  writePositionsData(data);
  return newPosition;
}

/** Return all positions (active + closed). */
function getAllPositions() {
  const data = readPositionsData();
  return data.positions;
}

/** Return only active positions (status === 'active'). */
function getActivePositions() {
  const data = readPositionsData();
  return data.positions.filter((p) => p.status === 'active');
}

/**
 * Update a position by ID (e.g. { current_price: 0.0000025 } or { status: 'closed' }).
 * Throws an error if the ID is not found.
 */
function updatePosition(id, updates) {
  const data = readPositionsData();
  const idx = data.positions.findIndex((p) => p.id === id);
  if (idx === -1) {
    throw new Error(`Position with id ${id} not found`);
  }
  data.positions[idx] = { ...data.positions[idx], ...updates };
  writeData(data);
  return data.positions[idx];
}

/**
 * Find a single EXACT-mode active position by mint.
 * Returns the position object or undefined if not found.
 */
function findExactActiveByMint(mint) {
  const data = readPositionsData();
  return data.positions.find(
    (p) => p.mint === mint && p.status === 'active' && p.trade_mode === 'EXACT'
  );
}

module.exports = {
  initStorage,
  addPosition,
  getAllPositions,
  getActivePositions,
  updatePosition,
  findExactActiveByMint,
  getUserData,
  saveUserData,
  getUserSettings,
  updateUserSettings,
};
