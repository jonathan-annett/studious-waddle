/**
 * auth.js — 4-tier authentication module for the sACN DMX hub.
 *
 * Tier 1: Open (no auth)
 * Tier 2: Device-based with shared venue TOTP
 * Tier 3: User-based (scaffold — not yet implemented)
 * Tier 4: Corporate / OAuth (scaffold — not yet implemented)
 *
 * This module manages:
 * - Express middleware for HTTP auth
 * - WebSocket upgrade validation
 * - Session lifecycle (create, validate, revoke, cleanup)
 * - TOTP secret generation and verification
 * - Magic link token cleanup
 */

import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

// otplib is CommonJS — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

// ─────────────────────────────────────────────────────────────────────────────
// Session Store
// ─────────────────────────────────────────────────────────────────────────────

let sessions = {};       // sessionId → session object
let sessionFile = null;  // resolved path, set by init()
const sessionWebSockets = new Map();  // sessionId → Set<WebSocket>

function loadSessions(filePath) {
    sessionFile = filePath;
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            sessions = data.sessions || {};
        } catch (err) {
            console.warn(`[auth] Failed to load ${filePath}: ${err.message}`);
            sessions = {};
        }
    }
}

function saveSessions() {
    if (!sessionFile) return;
    fs.writeFileSync(sessionFile, JSON.stringify({ sessions }, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization — call once at startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the auth module. Generates secrets if missing, loads sessions.
 * @param {object} config - From config.js
 * @param {function} saveConfig - Callback to persist config changes
 * @returns {object} config (possibly modified with new secrets)
 */
function init(config, saveConfig) {
    loadSessions(config.sessionFile);

    let configChanged = false;

    // Generate cookie signing secret if missing
    if (!config.cookieSecret) {
        config.cookieSecret = crypto.randomBytes(32).toString('base64url');
        configChanged = true;
        console.log('[auth] Generated cookie signing secret.');
    }

    // Generate shared venue TOTP secret if missing (Tier 2+)
    if (!config.totpSecret && config.securityTier >= 2) {
        config.totpSecret = authenticator.generateSecret();
        configChanged = true;

        const otpauthUri = authenticator.keyuri(
            config.totpLabel,
            config.totpIssuer,
            config.totpSecret
        );

        console.log('');
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║           TOTP SECRET — SCAN INTO AUTHENTICATOR APP         ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║  Secret: ${config.totpSecret.padEnd(49)}║`);
        console.log('║                                                              ║');
        console.log('║  otpauth URI (paste into authenticator if QR unavailable):   ║');
        console.log(`║  ${otpauthUri.substring(0, 58).padEnd(58)}║`);
        if (otpauthUri.length > 58) {
            console.log(`║  ${otpauthUri.substring(58).padEnd(58)}║`);
        }
        console.log('║                                                              ║');
        console.log('║  This secret is saved to config.json and won\'t be shown      ║');
        console.log('║  again. Delete totpSecret from config.json to regenerate.    ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        console.log('');
    }

    if (configChanged) {
        saveConfig(config);
    }

    // Clean up expired sessions on load
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of Object.entries(sessions)) {
        if (session.revoked || new Date(session.expiresAt).getTime() < now) {
            delete sessions[id];
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[auth] Cleaned ${cleaned} expired/revoked sessions.`);
        saveSessions();
    }

    return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Path Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a request path should bypass authentication.
 */
function isPublicPath(reqPath, rootPath) {
    return reqPath.startsWith(rootPath + '/gateway/') ||
           reqPath.startsWith(rootPath + '/s/') ||
           reqPath === rootPath + '/login' ||
           reqPath === rootPath + '/register' ||
           reqPath === rootPath + '/api/ping' ||
           reqPath === rootPath + '/manifest.json' ||
           reqPath === rootPath + '/sw.js';
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new device session.
 * @param {string} deviceName - Human-readable device name
 * @returns {{ sessionId: string, session: object }}
 */
function createSession(deviceName) {
    const sessionId = crypto.randomUUID();
    const deviceId = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const session = {
        deviceId,
        deviceName: (deviceName || 'Unknown Device').substring(0, 64).trim(),
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastSeen: now.toISOString(),
        revoked: false,
    };

    sessions[sessionId] = session;
    saveSessions();
    console.log(`[auth] New session: "${session.deviceName}" (${sessionId.substring(0, 8)}...)`);
    return { sessionId, session };
}

/**
 * Validate a session ID. Returns the session object if valid, null otherwise.
 * Updates lastSeen on successful validation.
 */
function validateSession(sessionId) {
    if (!sessionId) return null;
    const session = sessions[sessionId];
    if (!session) return null;
    if (session.revoked) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
        // Expired — clean up
        delete sessions[sessionId];
        saveSessions();
        return null;
    }

    session.lastSeen = new Date().toISOString();
    // Don't save on every request — batch saves happen elsewhere
    return session;
}

/**
 * Revoke a session. Disconnects any associated WebSockets.
 * @returns {boolean} true if session existed and was revoked
 */
function revokeSession(sessionId) {
    const session = sessions[sessionId];
    if (!session) return false;

    session.revoked = true;
    saveSessions();

    // Disconnect associated WebSockets
    const sockets = sessionWebSockets.get(sessionId);
    if (sockets) {
        for (const ws of sockets) {
            try { ws.close(1008, 'Session revoked'); } catch {}
        }
        sessionWebSockets.delete(sessionId);
    }

    console.log(`[auth] Revoked session: "${session.deviceName}" (${sessionId.substring(0, 8)}...)`);
    return true;
}

/**
 * Get all active (non-revoked, non-expired) sessions.
 */
function getActiveSessions() {
    const now = Date.now();
    const active = [];
    for (const [id, session] of Object.entries(sessions)) {
        if (!session.revoked && new Date(session.expiresAt).getTime() > now) {
            active.push({
                sessionId: id,
                deviceName: session.deviceName,
                createdAt: session.createdAt,
                expiresAt: session.expiresAt,
                lastSeen: session.lastSeen,
                connectedWebSockets: sessionWebSockets.get(id)?.size || 0,
            });
        }
    }
    return active;
}

/**
 * Track a WebSocket connection against its session.
 */
function trackWebSocket(sessionId, ws) {
    if (!sessionId) return;
    if (!sessionWebSockets.has(sessionId)) {
        sessionWebSockets.set(sessionId, new Set());
    }
    sessionWebSockets.get(sessionId).add(ws);

    ws.on('close', () => {
        const sockets = sessionWebSockets.get(sessionId);
        if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) sessionWebSockets.delete(sessionId);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TOTP Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a TOTP code against the shared venue secret.
 */
function verifyTOTP(code, config) {
    if (!config.totpSecret) return false;
    try {
        return authenticator.verify({ token: String(code).trim(), secret: config.totpSecret });
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Middleware Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create Express middleware for the configured security tier.
 * @param {object} config - From config.js
 * @returns {function} Express middleware (req, res, next)
 */
function createAuthMiddleware(config) {
    return (req, res, next) => {
        // Tier 1: Open — everything passes
        if (config.securityTier === 1) return next();

        // Public paths always pass
        if (isPublicPath(req.path, config.rootPath)) return next();

        // Tier 2+: Check session cookie
        if (config.securityTier >= 2) {
            const sessionId = req.cookies?.[config.cookieName];
            const session = validateSession(sessionId);

            if (session) {
                // Attach session info to request for downstream use
                req.sessionId = sessionId;
                req.deviceSession = session;
                return next();
            }

            // Not authenticated — redirect or reject
            if (req.headers.accept?.includes('application/json')) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            return res.redirect(config.rootPath + '/register');
        }

        next();
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a WebSocket upgrade request.
 * @param {object} request - HTTP upgrade request
 * @param {object} config - From config.js
 * @returns {{ valid: boolean, sessionId?: string }}
 */
function validateWebSocket(request, config) {
    // Tier 1: Always valid
    if (config.securityTier === 1) return { valid: true };

    // Parse cookies from the upgrade request
    const cookieStr = request.headers.cookie || '';
    const cookies = {};
    cookieStr.split(';').forEach(pair => {
        const [key, ...val] = pair.trim().split('=');
        if (key) cookies[key] = val.join('=');
    });

    const sessionId = cookies[config.cookieName];
    const session = validateSession(sessionId);

    if (session) return { valid: true, sessionId };
    return { valid: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Magic Token Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sweep expired magic link tokens from the Map.
 * Call periodically via setInterval.
 */
function cleanupExpiredTokens(magicTokens) {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, data] of magicTokens) {
        if (data.expires < now) {
            magicTokens.delete(token);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[auth] Cleaned ${cleaned} expired magic token(s). ${magicTokens.size} remaining.`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration / Login Page Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the registration page HTML for Tier 2.
 */
function registrationPageHTML(rootPath, error = null) {
    const errorHtml = error
        ? `<div style="color:#f38ba8;margin-bottom:16px;font-size:0.9em;">${error}</div>`
        : '';

    return `<!DOCTYPE html><html><head>
        <title>Register Device</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { background:#11111b; color:#cdd6f4; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
            .box { background:#1e1e2e; padding:40px; border-radius:12px; border:1px solid #45475a; text-align:center; max-width:360px; width:90%; }
            h2 { margin:0 0 8px; color:#cdd6f4; }
            p { color:#a6adc8; font-size:0.85em; margin:0 0 24px; }
            input { width:100%; padding:12px; background:#313244; color:#cdd6f4; border:1px solid #45475a; border-radius:6px; box-sizing:border-box; margin-bottom:12px; font-size:1em; }
            input:focus { outline:none; border-color:#89b4fa; }
            input::placeholder { color:#6c7086; }
            button { width:100%; padding:14px; background:#a6e3a1; color:#11111b; border:none; border-radius:6px; cursor:pointer; font-weight:bold; font-size:1em; }
            button:hover { background:#94e2d5; }
            .help { color:#6c7086; font-size:0.75em; margin-top:16px; }
        </style>
    </head><body><div class="box">
        <h2>DMX Console</h2>
        <p>Enter your device name and the current access code from your authenticator app.</p>
        ${errorHtml}
        <form method="POST" action="${rootPath}/register">
            <input type="text" name="deviceName" placeholder="Device Name (e.g. My iPhone)" required maxlength="64" autocomplete="off">
            <input type="text" name="totp" placeholder="6-digit Access Code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code">
            <button type="submit">REGISTER</button>
        </form>
        <div class="help">Ask the venue admin for the access code.</div>
    </div></body></html>`;
}

/**
 * Generate a placeholder page for unimplemented tiers.
 */
function notImplementedPageHTML(tier) {
    return `<!DOCTYPE html><html><head>
        <title>Not Available</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { background:#11111b; color:#cdd6f4; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
            .box { background:#1e1e2e; padding:40px; border-radius:12px; border:1px solid #45475a; text-align:center; max-width:400px; }
        </style>
    </head><body><div class="box">
        <h2>Security Tier ${tier}</h2>
        <p style="color:#a6adc8;">This authentication mode is not yet implemented.</p>
        <p style="color:#6c7086; font-size:0.85em;">Tier ${tier} requires ${tier === 3 ? 'user-based authentication with multi-device support' : 'corporate OAuth / email verification'}.</p>
    </div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export {
    init,
    isPublicPath,
    createSession,
    validateSession,
    revokeSession,
    getActiveSessions,
    trackWebSocket,
    verifyTOTP,
    createAuthMiddleware,
    validateWebSocket,
    cleanupExpiredTokens,
    registrationPageHTML,
    notImplementedPageHTML,
};
