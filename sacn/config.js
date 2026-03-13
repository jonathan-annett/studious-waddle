/**
 * config.js — Configuration loader for the sACN DMX hub.
 *
 * Loads from config.json in the same directory, with sensible defaults.
 * Environment variables override config file values where applicable.
 * If config.json doesn't exist, defaults are used and the file is NOT
 * auto-created (keeps the repo clean — admin creates it when needed).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- Defaults ---
const defaults = {
    port: 4004,
    relayHost: 'dev-drop.sophtwhere.com',
    rootPath: '/the-venue-club',

    // Security tier: 1=open, 2=device+TOTP, 3=user-based (future), 4=corporate (future)
    securityTier: 2,

    // Session / cookie settings
    cookieName: 'venue_session',
    cookieMaxAge: 30 * 24 * 60 * 60 * 1000,   // 30 days in ms
    cookieSecret: null,                         // auto-generated on first boot if null

    // TOTP (Tier 2+)
    totpSecret: null,                           // auto-generated on first boot if null
    totpIssuer: 'DMX Console',
    totpLabel: 'Venue',

    // Magic link tokens
    magicTokenTTL: {
        qr: 45000,          // 45 seconds
        clipboard: 300000,  // 5 minutes
    },
    magicTokenCleanupInterval: 60000,   // sweep expired tokens every 60s

    // File paths (relative to sacn/ directory)
    sessionFile: 'sessions.json',
    stateFile: 'dmx-state.json',
    presetsFile: 'dmx-presets.json',
    whitelistFile: 'whitelist.json',
};

/**
 * Load configuration. Priority: env vars > config.json > defaults.
 * Writes back to config.json if secrets were auto-generated.
 */
function loadConfig() {
    let fileConfig = {};

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (err) {
            console.warn(`[config] Failed to parse ${CONFIG_FILE}: ${err.message} — using defaults`);
        }
    }

    const config = { ...defaults, ...fileConfig };

    // Environment variable overrides
    if (process.env.RELAY_HOST) config.relayHost = process.env.RELAY_HOST;
    if (process.env.RELAY_ROOT_PATH) config.rootPath = process.env.RELAY_ROOT_PATH;
    if (process.env.PORT) config.port = parseInt(process.env.PORT, 10);
    if (process.env.SECURITY_TIER) config.securityTier = parseInt(process.env.SECURITY_TIER, 10);

    // Resolve file paths to absolute
    config.sessionFile = path.resolve(__dirname, config.sessionFile);
    config.stateFile = path.resolve(__dirname, config.stateFile);
    config.presetsFile = path.resolve(__dirname, config.presetsFile);
    config.whitelistFile = path.resolve(__dirname, config.whitelistFile);

    return config;
}

/**
 * Save the current config back to config.json (e.g. after generating secrets).
 * Only saves fields that differ from defaults or are secrets.
 */
function saveConfig(config) {
    // Build a clean object with non-default and secret values
    const toSave = {};
    for (const [key, val] of Object.entries(config)) {
        // Always save secrets
        if (key === 'totpSecret' || key === 'cookieSecret') {
            if (val !== null) toSave[key] = val;
            continue;
        }
        // Save non-default values (skip resolved paths — save relative originals)
        if (key === 'sessionFile' || key === 'stateFile' || key === 'presetsFile' || key === 'whitelistFile') {
            continue; // these are resolved at runtime, not saved
        }
        if (JSON.stringify(val) !== JSON.stringify(defaults[key])) {
            toSave[key] = val;
        }
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2) + '\n');
}

const config = loadConfig();

export { config, saveConfig };
