/**
 * simulator/server.js
 *
 * Main orchestrator for the NEC display simulator.
 * Loads devices.json, starts NEC + TV-HTTP + Player-HTTP servers for each device,
 * and exposes a web UI + REST API on simPort (default 4001).
 *
 * Usage:
 *   node simulator/server.js [port]
 *
 * Requires elevated privileges if tvHttpPort or playerHttpPort is 80.
 * For development without root, set ports to 7580/7581 in devices.json.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

import http      from 'node:http';
import fs        from 'node:fs';
import path      from 'node:path';
import { URL }   from 'node:url';
import { createNecServer }        from './nec-responder.js';
import { createTvHttpServer }     from './tv-http.js';
import { createPlayerHttpServer } from './player-http.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config loading
// ─────────────────────────────────────────────────────────────────────────────

const __dir     = path.dirname(new URL(import.meta.url).pathname);
const cfgPath   = path.join(__dir, 'devices.json');
const rawCfg    = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const config = {
  simPort:          rawCfg.config?.simPort          ?? 4001,
  necPort:          rawCfg.config?.necPort          ?? 7142,
  tvHttpPort:       rawCfg.config?.tvHttpPort       ?? 80,
  playerHttpPort:   rawCfg.config?.playerHttpPort   ?? 80,
  server:           rawCfg.config?.server           ?? "127.0.0.1"
};

// Merge devices from JSON into live state objects
const devices = (rawCfg.devices || []).map(d => ({
  ...d,
  power:       d.power ?? 'on',
  input:       typeof d.input === 'number' ? d.input : 0x11,
  vcpValues:   {},
  emergency:   false,
  replyDelayMs: d.replyDelayMs ?? 5,
  // player state is initialised by createPlayerHttpServer
  player: null,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Log ring buffer + WebSocket broadcast
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 500;
const logLines = [];
const wsClients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of wsClients) {
    try { ws.write(str); } catch { wsClients.delete(ws); }
  }
}

function log(msg) {
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `${ts} ${msg}`;
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  process.stdout.write(line + '\n');
  broadcast({ type: 'log', line });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start per-device servers
// ─────────────────────────────────────────────────────────────────────────────

for (const device of devices) {
  const onLog = (msg) => log(msg);

  createNecServer(device, { port: config.necPort, onLog });
  createTvHttpServer(device, { port: config.tvHttpPort, onLog });
  createPlayerHttpServer(device, { port: config.playerHttpPort, onLog });
}

log(`[sim] started ${devices.length} virtual device(s)`);

// ─────────────────────────────────────────────────────────────────────────────
// Minimal WebSocket server (no npm — hand-rolled upgrade / framing)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

function wsHandshake(req, socket) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

/** Encode a UTF-8 string as a WebSocket text frame (server→client, no masking). */
function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len     = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, len >> 8, len & 0xFF]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Thin wrapper so broadcast can call ws.write(str) */
function makeWsClient(socket) {
  return {
    write(str) { socket.write(wsFrame(str)); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function devicePublic(d) {
  return {
    id:          d.id,
    name:        d.name,
    tvIP:        d.tvIP,
    playerIP:    d.playerIP,
    mac:         d.mac,
    model:       d.model,
    serial:      d.serial,
    firmware:    d.firmware,
    power:       d.power,
    input:       d.input,
    emergency:   d.emergency,
    replyDelayMs: d.replyDelayMs,
    player: d.player ? {
      cwdPath:        d.player.cwdPath,
      autoPlayMode:   d.player.settings.autoPlayMode,
      autoPlayFolder: d.player.settings.autoPlayFolder,
      slideInterval:  d.player.settings.slideInterval,
      restartingUntil: d.player.restartingUntil,
      serveHtmlFor:   d.player.serveHtmlFor,
    } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web UI static handler
// ─────────────────────────────────────────────────────────────────────────────

const indexHtml = fs.readFileSync(path.join(__dir, 'index.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (web UI + REST API)
// ─────────────────────────────────────────────────────────────────────────────

const simServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost`);

  // ── Web UI ──
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(indexHtml);
    return;
  }

  // ── GET /api/devices — list all virtual devices ──
  if (req.method === 'GET' && pathname === '/api/devices') {
    sendJson(res, 200, { devices: devices.map(devicePublic) });
    return;
  }

  // ── GET /api/logs — last N log lines ──
  if (req.method === 'GET' && pathname === '/api/logs') {
    sendJson(res, 200, { lines: logLines });
    return;
  }

  // ── PUT /api/devices/:id — update device state (fault injection) ──
  const putMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (req.method === 'PUT' && putMatch) {
    const id     = decodeURIComponent(putMatch[1]);
    const device = devices.find(d => d.id === id);
    if (!device) { sendJson(res, 404, { error: 'not found' }); return; }

    const body = await readBodyJson(req);

    // Apply safe subset of updates
    if (body.power       !== undefined) device.power        = body.power;
    if (body.input       !== undefined) device.input        = body.input;
    if (body.firmware    !== undefined) device.firmware     = body.firmware;
    if (body.replyDelayMs !== undefined) device.replyDelayMs = body.replyDelayMs;

    if (body.serveHtmlFor !== undefined && device.player) {
      device.player.serveHtmlFor = body.serveHtmlFor;
    }
    if (body.triggerRestart === true && device.player) {
      device.player.restartingUntil = Date.now() + (device.player.serveHtmlFor || 3000);
      log(`[sim] fault injection: ${device.name} player restarting for ${device.player.serveHtmlFor || 3000}ms`);
    }

    broadcast({ type: 'device-update', device: devicePublic(device) });
    log(`[sim] device ${device.name} updated: ${JSON.stringify(body)}`);
    sendJson(res, 200, { device: devicePublic(device) });
    return;
  }

  // ── PUT /api/devices/:id/fs — wipe player filesystem ──
  const fsMatch = pathname.match(/^\/api\/devices\/([^/]+)\/fs$/);
  if (req.method === 'PUT' && fsMatch) {
    const id     = decodeURIComponent(fsMatch[1]);
    const device = devices.find(d => d.id === id);
    if (!device || !device.player) { sendJson(res, 404, { error: 'not found' }); return; }

    // Reset filesystem to default
    const { makeDefaultFilesystem: mdf } = await import('./player-http.js').catch(() => ({ makeDefaultFilesystem: null }));
    // Re-import is awkward, so just wipe children and re-populate
    const root = device.player.fs;
    root.children.clear();
    const folders = ['folder1', 'folder2', 'folder3', 'folder4', 'all'];
    for (const f of folders) {
      const dir = { name: f, size: 0, date: '2026/01/01 00:00:00', type: 0, children: new Map() };
      dir.children.set('sim-content.txt', { name: 'sim-content.txt', size: 2048, date: '2026/01/01 00:00:00', type: 1 });
      root.children.set(f, dir);
    }
    device.player.cwd     = root;
    device.player.cwdPath = '/mnt/usb1';
    device.player.cwdParents = [];
    log(`[sim] device ${device.name} filesystem reset to default`);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── GET /api/devices/:id/filelist — return current filelist ──
  const flMatch = pathname.match(/^\/api\/devices\/([^/]+)\/filelist$/);
  if (req.method === 'GET' && flMatch) {
    const id     = decodeURIComponent(flMatch[1]);
    const device = devices.find(d => d.id === id);
    if (!device || !device.player) { sendJson(res, 404, { error: 'not found' }); return; }

    const entries = Array.from(device.player.cwd.children.values()).map(e => ({
      name: e.name, size: e.type === 0 ? 0 : e.size, date: e.date, type: e.type,
    }));
    sendJson(res, 200, { dirPath: device.player.cwdPath, entries });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket upgrade
// ─────────────────────────────────────────────────────────────────────────────

simServer.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  wsHandshake(req, socket);
  const client = makeWsClient(socket);
  wsClients.add(client);

  // Send current device state and recent logs on connect
  client.write(JSON.stringify({ type: 'init', devices: devices.map(devicePublic), logs: logLines }));

  socket.on('close', () => wsClients.delete(client));
  socket.on('error', () => wsClients.delete(client));
});

const simPort = parseInt(process.argv[2] || String(config.simPort), 10);
simServer.listen(simPort, '0.0.0.0', () => {
  log(`[sim] Web UI + API listening on http://0.0.0.0:${simPort}`);
  log(`[sim] NEC port: ${config.necPort}  |  TV HTTP: ${config.tvHttpPort}  |  Player HTTP: ${config.playerHttpPort}`);
  log(`[sim] Open http://${config.server}:${simPort} in your browser`);
});
