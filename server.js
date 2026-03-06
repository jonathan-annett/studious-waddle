/**
 * server.js  —  NEC Monitor Control Test Console
 *
 * Pure Node.js: http, net, fs, url, path, crypto  (zero npm deps)
 * WebSocket implementation is hand-rolled per RFC 6455.
 *
 * Usage:
 *   node server.js [port]          # default port 3000
 *
 * Then open http://localhost:3000 in a browser.
 */

import http    from 'node:http';
import crypto  from 'node:crypto';
import fs      from 'node:fs';
import net     from 'node:net';
import os      from 'node:os';
import path    from 'node:path';
import { URL } from 'node:url';

import {
  openTcpSession,
  Session,
  NecError,
  decodeWeekMask,
  encodeWeekMask,
} from './nec-protocol.js';

const PORT      = parseInt(process.argv[2] ?? '3000', 10);
const CACHE_DIR = process.env.NEC_CACHE_DIR
  ? path.resolve(process.env.NEC_CACHE_DIR)
  : path.join(path.dirname(new URL(import.meta.url).pathname), 'cache');

// Ensure cache directory exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Registry — groups & device assignments
// Stored as CACHE_DIR/registry.json:
//   { groups: { <id> → { name, assets: [sha256, ...] } },
//     devices: { <mac> → { name, tvIp, playerMac?, groups: [id, ...] } } }
// The "all" pseudo-group is never stored here — it is computed on demand
// as every sha256 currently in the cache.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_FILE = path.join(CACHE_DIR, 'registry.json');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
  catch { return { groups: {}, devices: {}, players: {} }; }
}

function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

/** Normalise any MAC format to lowercase colon-separated aa:bb:cc:dd:ee:ff. */
function normalizeMac(mac) {
  if (!mac) return '';
  const digits = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (digits.length !== 12) return String(mac).toLowerCase();
  return digits.match(/.{2}/g).join(':');
}

// ─────────────────────────────────────────────────────────────────────────────
// Active session store  { id → Session }
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();

function newId() { return crypto.randomBytes(6).toString('hex'); }

// ─────────────────────────────────────────────────────────────────────────────
// Minimal hand-rolled WebSocket server (RFC 6455)
// ─────────────────────────────────────────────────────────────────────────────

const wsClients = new Set();

function wsUpgrade(req, socket) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  socket.on('error', () => wsClients.delete(socket));
  socket.on('close', () => wsClients.delete(socket));
  wsClients.add(socket);

  // We don't need to receive WS frames — server only pushes logs
}

function wsBroadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const frame   = wsFrame(payload);
  for (const s of wsClients) {
    try { s.write(frame); } catch { wsClients.delete(s); }
  }
}

function wsFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger — sends to WebSocket clients and stdout
// ─────────────────────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const entry = { ts: Date.now(), level, msg, data: data ?? null };
  console.log(`[${level}] ${msg}`, data ?? '');
  wsBroadcast({ type: 'log', entry });
}

// ─────────────────────────────────────────────────────────────────────────────
// API handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleApi(method, pathname, body, req) {
  // POST /api/connect  { host, port?, monitorId? }
  if (method === 'POST' && pathname === '/api/connect') {
    const { host, port, monitorId } = body;
    if (!host) return { error: 'host required' };
    log('info', `Connecting to ${host}:${port ?? 7142} …`);
    const session = await openTcpSession(host, {
      port:             port ?? 7142,
      defaultMonitorId: monitorId ?? 1,
      keepAlive:        true,
    });
    const id = newId();
    sessions.set(id, { session, host, monitorId: monitorId ?? 1 });
    log('info', `Connected — session ${id}`);
    return { sessionId: id };
  }

  // DELETE /api/connect/:id
  if (method === 'DELETE' && pathname.startsWith('/api/connect/')) {
    const id = pathname.split('/').pop();
    const s  = sessions.get(id);
    if (!s) return { error: 'session not found' };
    await s.session.close();
    sessions.delete(id);
    log('info', `Session ${id} closed`);
    return { ok: true };
  }

  // POST /api/interrogate  { sessionId }  — read everything at once
  if (method === 'POST' && pathname === '/api/interrogate') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const mid = monitorId ?? s.monitorId;
    return interrogateAll(s.session, mid);
  }

  // POST /api/vcp/get  { sessionId, monitorId?, opPage, opCode }
  if (method === 'POST' && pathname === '/api/vcp/get') {
    const { sessionId, monitorId, opPage, opCode } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `VCP get  page=${hex(opPage)} code=${hex(opCode)}`);
    const r = await s.session.vcpGet(monitorId ?? s.monitorId, opPage, opCode);
    log('info', `VCP get reply`, r);
    return r;
  }

  // POST /api/vcp/set  { sessionId, monitorId?, opPage, opCode, value, persist? }
  if (method === 'POST' && pathname === '/api/vcp/set') {
    const { sessionId, monitorId, opPage, opCode, value, persist } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `VCP set  page=${hex(opPage)} code=${hex(opCode)} value=${value}`);
    let r;
    if (persist) {
      r = await s.session.vcpSetPersisted(monitorId ?? s.monitorId, opPage, opCode, value);
    } else {
      r = await s.session.vcpSet(monitorId ?? s.monitorId, opPage, opCode, value);
    }
    log('info', `VCP set reply`, r);
    return r;
  }

  // POST /api/save  { sessionId }
  if (method === 'POST' && pathname === '/api/save') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'Save current settings');
    const r = await s.session.saveCurrentSettings(monitorId ?? s.monitorId);
    log('info', 'Save reply', r);
    return r;
  }

  // POST /api/timing  { sessionId }
  if (method === 'POST' && pathname === '/api/timing') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'Get timing report');
    const r = await s.session.getTimingReport(monitorId ?? s.monitorId);
    log('info', 'Timing report', r);
    return r;
  }

  // POST /api/power/status  { sessionId }
  if (method === 'POST' && pathname === '/api/power/status') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const r = await s.session.powerStatus(monitorId ?? s.monitorId);
    log('info', 'Power status', r);
    return r;
  }

  // POST /api/power/set  { sessionId, state: 'on'|'off' }
  if (method === 'POST' && pathname === '/api/power/set') {
    const { sessionId, monitorId, state } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Power set → ${state}`);
    const r = await s.session.powerSet(monitorId ?? s.monitorId, state);
    log('info', 'Power set reply', r);
    return r;
  }

  // POST /api/asset/read  { sessionId, offset, length }
  if (method === 'POST' && pathname === '/api/asset/read') {
    const { sessionId, monitorId, offset, length } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Asset read offset=${hex(offset)} len=${hex(length)}`);
    const r = await s.session.assetRead(monitorId ?? s.monitorId, offset, length);
    const text = r.data.toString('ascii').replace(/\x00/g, '');
    log('info', `Asset data: "${text}"`);
    return { offset: r.offset, hex: r.data.toString('hex'), text };
  }

  // POST /api/asset/readall  { sessionId }
  if (method === 'POST' && pathname === '/api/asset/readall') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'Asset read all (64 bytes)');
    const data = await s.session.assetReadAll(monitorId ?? s.monitorId);
    const text = data.toString('ascii').replace(/\x00/g, '');
    log('info', `Asset data: "${text}"`);
    return { hex: data.toString('hex'), text };
  }

  // POST /api/asset/write  { sessionId, offset, text }
  if (method === 'POST' && pathname === '/api/asset/write') {
    const { sessionId, monitorId, offset, text } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const data = Buffer.from(text, 'ascii');
    log('info', `Asset write offset=${hex(offset)} data="${text}"`);
    const r = await s.session.assetWrite(monitorId ?? s.monitorId, offset, data);
    log('info', 'Asset write reply', r);
    return r;
  }

  // POST /api/datetime/read  { sessionId }
  if (method === 'POST' && pathname === '/api/datetime/read') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'DateTime read');
    const r = await s.session.dateTimeRead(monitorId ?? s.monitorId);
    log('info', 'DateTime', r);
    return r;
  }

  // POST /api/datetime/write  { sessionId, year, month, day, weekday, hour, minute, dst }
  if (method === 'POST' && pathname === '/api/datetime/write') {
    const { sessionId, monitorId, ...dt } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'DateTime write', dt);
    const r = await s.session.dateTimeWrite(monitorId ?? s.monitorId, dt);
    log('info', 'DateTime write reply', r);
    return r;
  }

  // POST /api/schedule/read  { sessionId, programNo }
  if (method === 'POST' && pathname === '/api/schedule/read') {
    const { sessionId, monitorId, programNo } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Schedule read slot ${programNo}`);
    const r = await s.session.scheduleRead(monitorId ?? s.monitorId, programNo);
    log('info', `Schedule slot ${programNo}`, r);
    return r;
  }

  // POST /api/schedule/write  { sessionId, entry }
  if (method === 'POST' && pathname === '/api/schedule/write') {
    const { sessionId, monitorId, entry } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Schedule write slot ${entry.programNo}`, entry);
    const r = await s.session.scheduleWrite(monitorId ?? s.monitorId, entry);
    log('info', 'Schedule write reply', r);
    return r;
  }

  // POST /api/holiday/read  { sessionId, programNo }
  if (method === 'POST' && pathname === '/api/holiday/read') {
    const { sessionId, monitorId, programNo } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Holiday read slot ${programNo}`);
    const r = await s.session.holidayRead(monitorId ?? s.monitorId, programNo);
    log('info', `Holiday slot ${programNo}`, r);
    return r;
  }

  // POST /api/holiday/write  { sessionId, entry }
  if (method === 'POST' && pathname === '/api/holiday/write') {
    const { sessionId, monitorId, entry } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Holiday write slot ${entry.programNo}`, entry);
    const r = await s.session.holidayWrite(monitorId ?? s.monitorId, entry);
    log('info', 'Holiday write reply', r);
    return r;
  }

  // POST /api/weekend/read  { sessionId }
  if (method === 'POST' && pathname === '/api/weekend/read') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', 'Weekend read');
    const r = await s.session.weekendRead(monitorId ?? s.monitorId);
    log('info', 'Weekend', r);
    return r;
  }

  // POST /api/weekend/write  { sessionId, weekMask }
  if (method === 'POST' && pathname === '/api/weekend/write') {
    const { sessionId, monitorId, weekMask } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    log('info', `Weekend write mask=0x${weekMask.toString(16)}`);
    const r = await s.session.weekendWrite(monitorId ?? s.monitorId, weekMask);
    log('info', 'Weekend write reply', r);
    return r;
  }

  // POST /api/emergency/display  { sessionId }
  // Saves current input source then activates emergency mode.
  if (method === 'POST' && pathname === '/api/emergency/display') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const mid = monitorId ?? s.monitorId;
    // Save current input so we can restore it on stop
    try {
      const inp = await s.session.vcpGet(mid, 0x00, 0x60);
      s.savedInput = inp.current;
      log('info', `Saved input source 0x${inp.current.toString(16)} before emergency mode`);
    } catch {
      s.savedInput = null;
    }
    log('warn', `EMERGENCY CONTENTS DISPLAY activated on monitor ${mid}`);
    const r = await s.session.emergencyDisplay(mid);
    return { ...r, savedInput: s.savedInput };
  }

  // POST /api/emergency/stop  { sessionId }
  // Exits emergency mode by restoring the saved input (which implicitly exits
  // emergency mode). Falls back to formal emergencyDelete if no input was saved
  // or if saved input is media player (0x87).
  if (method === 'POST' && pathname === '/api/emergency/stop') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const mid = monitorId ?? s.monitorId;
    const MEDIA_PLAYER = 0x87;
    const saved = s.savedInput;
    if (saved != null && saved !== MEDIA_PLAYER) {
      log('info', `Restoring input 0x${saved.toString(16)} to exit emergency mode on monitor ${mid}`);
      const r = await s.session.vcpSet(mid, 0x00, 0x60, saved);
      s.savedInput = null;
      return { ok: true, method: 'input-restore', restoredInput: saved };
    }
    // Fallback: formal stop command
    log('info', `Emergency contents stopped on monitor ${mid} (formal delete)`);
    const r = await s.session.emergencyDelete(mid);
    s.savedInput = null;
    return { ...r, method: 'formal-delete' };
  }

  // POST /api/player/play  { sessionId, tvIP, folder, restoreInput?, interval? }
  // Sets the media player autoplay folder, restarts playback, switches TV input to MP.
  // Bounces input if already on MP so the player picks up the new folder.
  // interval: seconds per slide. Omit to use server default (30s).
  //           Automatically overridden to 99999 if folder has only 1 file.
  //           Returns { error } if folder is empty.
  if (method === 'POST' && pathname === '/api/player/play') {
    const { sessionId, monitorId, tvIP, folder, restoreInput, interval } = body;
    if (!tvIP)    return { error: 'tvIP required' };
    if (!folder)  return { error: 'folder required' };
    const s   = sessions.get(sessionId);
    const mid = monitorId ?? s?.monitorId;
    return playFolder(tvIP, folder, s?.session ?? null, mid, restoreInput ?? 0x11, interval ?? INTERVAL_DEFAULT);
  }

  // POST /api/player/filelist  { tvIP, folder }
  // Returns the file count and names inside a named folder on the player SD card.
  if (method === 'POST' && pathname === '/api/player/filelist') {
    const { tvIP, folder } = body;
    if (!tvIP)   return { error: 'tvIP required' };
    if (!folder) return { error: 'folder required' };
    const playerIP = await getPlayerIP(tvIP);
    const result   = await getPlayerFolderContents(playerIP, folder);
    return { ok: true, playerIP, folder, ...result };
  }

  // POST /api/player/stop  { sessionId, tvIP, restoreInput? }
  // Restores TV input to whatever was active before playing (falls back to HDMI1).
  if (method === 'POST' && pathname === '/api/player/stop') {
    const { sessionId, monitorId, tvIP, restoreInput } = body;
    const s   = sessions.get(sessionId);
    const mid = monitorId ?? s?.monitorId;
    const inp = restoreInput ?? s?.savedInput ?? 0x11;
    if (s?.session) {
      const r = await s.session.vcpSet(mid, 0x00, 0x60, inp);
      log('info', `[player/stop] input restored to 0x${inp.toString(16)}`);
      return { ok: true, restoredInput: inp, reply: r };
    }
    return { error: 'no session — cannot switch input' };
  }

  // POST /api/player/folder  { tvIP }
  // Reads the current autoplay folder setting from the media player.
  if (method === 'POST' && pathname === '/api/player/folder') {
    const { tvIP } = body;
    if (!tvIP) return { error: 'tvIP required' };
    const playerIP = await getPlayerIP(tvIP);
    const raw      = await playerRequest(playerIP, `/cgi-bin/cgictrl?V=G,2B,1,0,%00,`, 'POST');
    const parts    = raw.split(',');
    const folder   = parts[5] ?? null;
    return { ok: true, playerIP, folder, raw };
  }

  // POST /api/player/folders  { tvIP }
  // Returns the list of top-level folder names on the media player SD card.
  if (method === 'POST' && pathname === '/api/player/folders') {
    const { tvIP } = body;
    if (!tvIP) return { error: 'tvIP required' };
    const playerIP = await getPlayerIP(tvIP);
    // Navigate to root
    await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');
    const raw   = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET',
      null, { referer: `http://${playerIP}/sd_card_viewer.html` });
    const fixed = raw.replace(/,(\s*\])/g, '$1');
    const list  = JSON.parse(fixed);
    const folders = (list.fileinfo || [])
      .filter(f => f.name !== '..' && f.type === 0)
      .map(f => f.name);
    return { ok: true, playerIP, folders };
  }

  // GET /api/cache  — list all cached assets (reads sidecars)
  if (method === 'GET' && pathname === '/api/cache') {
    return cacheList();
  }

  // POST /api/cache/store  — store uploaded file(s) to cache, no TV interaction
  // Body: multipart/form-data
  if (method === 'POST' && pathname === '/api/cache/store') {
    const rawBody    = await readRawBody(req);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/i);
    if (!boundaryMatch) return { error: 'Expected multipart/form-data' };
    const files = parseMultipart(rawBody, boundaryMatch[1].trim());
    if (files.length === 0) return { error: 'No files found in request' };
    const stored = [];
    for (const { filename, mime, data } of files) {
      stored.push(await cacheStore(data, filename, mime));
    }
    return { ok: true, stored };
  }

  // POST /api/cache/send  — { hash, tvIP } — send cached asset to TV
  if (method === 'POST' && pathname === '/api/cache/send') {
    const { hash, tvIP } = body;
    if (!hash || !tvIP) return { error: 'hash and tvIP required' };
    return cacheSend(hash, tvIP);
  }

  // DELETE /api/cache/:hash
  if (method === 'DELETE' && pathname.startsWith('/api/cache/')) {
    const hash = pathname.split('/').pop();
    return cacheDelete(hash);
  }

  // POST /api/emergency-upload?tvIP=x.x.x.x
  // Body: multipart/form-data with one or more files (in order).
  // Wipes SD card once, creates EMERGENCY CONTENTS folder, uploads all files
  // in the order received (slideshow plays in upload order).
  if (method === 'POST' && pathname === '/api/emergency-upload') {
    const baseURL  = 'http://' + req.headers.host + '/';
    const u        = new URL(req.url, baseURL);
    const tvIP     = u.searchParams.get('tvIP');
    if (!tvIP) return { error: 'tvIP query param required' };
    const rawBody  = await readRawBody(req);
    const contentType = req.headers['content-type'] || '';
    // Parse multipart boundary
    const boundaryMatch = contentType.match(/boundary=(.+)$/i);
    if (!boundaryMatch) return { error: 'Expected multipart/form-data' };
    const files = parseMultipart(rawBody, boundaryMatch[1].trim());
    if (files.length === 0) return { error: 'No files found in request' };
    log('info', `Emergency upload: ${files.length} file(s) → ${tvIP}`);
    return emergencyUploadFiles(tvIP, files);
  }

  // POST /api/self-diagnosis  { sessionId }
  if (method === 'POST' && pathname === '/api/self-diagnosis') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    const r = await s.session.selfDiagnosis(monitorId ?? s.monitorId);
    return r;
  }

  // POST /api/serial  { sessionId }
  if (method === 'POST' && pathname === '/api/serial') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    return s.session.serialRead(monitorId ?? s.monitorId);
  }

  // POST /api/model  { sessionId }
  if (method === 'POST' && pathname === '/api/model') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    return s.session.modelNameRead(monitorId ?? s.monitorId);
  }

  // POST /api/firmware  { sessionId }
  if (method === 'POST' && pathname === '/api/firmware') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    return s.session.firmwareVersionRead(monitorId ?? s.monitorId);
  }

  // POST /api/mac  { sessionId }
  if (method === 'POST' && pathname === '/api/mac') {
    const { sessionId, monitorId } = body;
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session not found' };
    return s.session.lanMacRead(monitorId ?? s.monitorId);
  }

  // GET /api/subnets  — returns detected /24 subnets on this machine
  if (method === 'GET' && pathname === '/api/subnets') {
    const fromEnv = process.env.NEC_SUBNET;
    if (fromEnv) return { subnets: [fromEnv] };
    const subnets = [];
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const parts = addr.address.split('.');
          subnets.push(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
    return { subnets: [...new Set(subnets)] };
  }

  // POST /api/scan  { subnet: '192.168.1', port?: 7142, timeout?: 400 }
  // TCP-probes .1–.254; for responsive hosts attempts a quick power-status read.
  if (method === 'POST' && pathname === '/api/scan') {
    const { subnet, port: scanPort = 7142, timeout: timeoutMs = 400 } = body;
    if (!subnet || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      return { error: 'Invalid subnet (expected x.x.x)' };
    }
    log('info', `Scanning ${subnet}.1–254 on port ${scanPort} …`);
    const results = await scanSubnet(subnet, scanPort, timeoutMs);
    log('info', `Scan complete: ${results.length} host(s) found`);
    return { results };
  }

  // POST /api/device-online  { up, port, mac, ip }
  // Called by a DHCP lease monitor whenever a device appears on the LAN.
  // Classifies the device (known TV / unknown TV / player / suspicious) and
  // broadcasts a typed WebSocket event to all connected browsers.
  if (method === 'POST' && pathname === '/api/device-online') {
    const { mac: rawMac, ip, port: ethPort } = body;
    if (!rawMac || !ip) return { error: 'mac and ip required' };
    const mac = normalizeMac(rawMac);
    const reg = loadRegistry();

    // ── 1. Known media player — silently acknowledge, update IP if changed ──
    if (reg.players?.[mac]) {
      log('info', `[device-online] Known player ${mac} (${ip}) — ignored`);
      if (reg.players[mac].ip !== ip) {
        reg.players[mac].ip = ip;
        saveRegistry(reg);
      }
      wsBroadcast({ type: 'player-online', mac, ip });
      return { ok: true, category: 'player', mac, ip };
    }

    // ── 2. Known TV ──────────────────────────────────────────────────────────
    if (reg.devices[mac]) {
      const device = reg.devices[mac];
      // Keep stored IP current (DHCP can reassign)
      if (device.tvIp !== ip) {
        reg.devices[mac].tvIp = ip;
        saveRegistry(reg);
        log('info', `[device-online] Known TV "${device.name}" (${mac}) — IP updated ${device.tvIp} → ${ip}`);
      } else {
        log('info', `[device-online] Known TV "${device.name}" (${mac}) at ${ip}`);
      }

      // Interrogate power state
      let power = 'unknown';
      try {
        const probe = await probeTvNec(ip, 6000);
        if (probe.ok) power = probe.power;
      } catch (e) {
        log('warn', `[device-online] Power query failed for ${mac}: ${e.message}`);
      }

      wsBroadcast({ type: 'device-online', category: 'tv', mac, name: device.name, ip, power });
      return { ok: true, category: 'tv', mac, name: device.name, ip, power };
    }

    // ── 3. Unknown device — probe to classify ───────────────────────────────
    log('info', `[device-online] Unknown device ${mac} (${ip}) — probing…`);

    // 3a. Try NEC port 7142
    const tvProbe = await probeTvNec(ip, 5000);
    if (tvProbe.ok) {
      const name = tvProbe.model
        ? `TV – ${tvProbe.model} (${ip})`
        : `TV (${ip})`;
      const reg2 = loadRegistry();           // reload to avoid clobbering concurrent writes
      if (!reg2.players)  reg2.players  = {};
      if (!reg2.devices)  reg2.devices  = {};
      reg2.devices[mac] = {
        name,
        tvIp: ip,
        groups: [],
        discoveredAt: new Date().toISOString(),
        ...(tvProbe.model  ? { model:  tvProbe.model  } : {}),
        ...(tvProbe.serial ? { serial: tvProbe.serial } : {}),
      };
      saveRegistry(reg2);
      log('info', `[device-online] New TV discovered: "${name}" MAC=${mac}`);
      wsBroadcast({
        type: 'device-discovered', category: 'tv',
        mac, name, ip,
        power:  tvProbe.power,
        model:  tvProbe.model  ?? null,
        serial: tvProbe.serial ?? null,
      });
      return { ok: true, category: 'tv', discovered: true, mac, name, ip, power: tvProbe.power };
    }

    // 3b. Try player port 80
    const isPlayer = await probePlayerHttp(ip, 4000);
    if (isPlayer) {
      const reg2 = loadRegistry();
      if (!reg2.players) reg2.players = {};
      reg2.players[mac] = { ip, firstSeen: new Date().toISOString() };
      saveRegistry(reg2);
      log('info', `[device-online] New player discovered: MAC=${mac} IP=${ip}`);
      wsBroadcast({ type: 'device-discovered', category: 'player', mac, ip });
      return { ok: true, category: 'player', discovered: true, mac, ip };
    }

    // 3c. Neither — suspicious / unrecognised
    log('warn', `[device-online] Suspicious device: MAC=${mac} IP=${ip} port=${ethPort ?? '?'}`);
    wsBroadcast({ type: 'device-suspicious', mac, ip, port: ethPort ?? null });
    return { ok: true, category: 'unknown', mac, ip };
  }

  // ─── Registry ───────────────────────────────────────────────────────────────
  // GET /api/registry  — full groups + devices map
  if (method === 'GET' && pathname === '/api/registry') {
    return loadRegistry();
  }

  // ─── Groups ─────────────────────────────────────────────────────────────────
  // POST /api/groups  { name }
  if (method === 'POST' && pathname === '/api/groups') {
    const { name } = body;
    if (!name || typeof name !== 'string') return { error: 'name required' };
    const reg = loadRegistry();
    const id = newId();
    reg.groups[id] = { name: name.trim(), assets: [] };
    saveRegistry(reg);
    return { id, ...reg.groups[id] };
  }

  // PATCH /api/groups/:id  { name }
  if (method === 'PATCH' && /^\/api\/groups\/[^/]+$/.test(pathname)) {
    const id = pathname.split('/')[3];
    const { name } = body;
    const reg = loadRegistry();
    if (!reg.groups[id]) return { error: 'group not found' };
    if (name) reg.groups[id].name = name.trim();
    saveRegistry(reg);
    return { id, ...reg.groups[id] };
  }

  // DELETE /api/groups/:id
  if (method === 'DELETE' && /^\/api\/groups\/[^/]+$/.test(pathname)) {
    const id = pathname.split('/')[3];
    const reg = loadRegistry();
    if (!reg.groups[id]) return { error: 'group not found' };
    delete reg.groups[id];
    // Cascade: remove this group from all devices
    for (const dev of Object.values(reg.devices)) {
      dev.groups = (dev.groups || []).filter(g => g !== id);
    }
    saveRegistry(reg);
    return { ok: true };
  }

  // POST /api/groups/:id/assets  { hashes: ['sha256', ...] }  — add assets to group
  if (method === 'POST' && /^\/api\/groups\/[^/]+\/assets$/.test(pathname)) {
    const id = pathname.split('/')[3];
    const { hashes } = body;
    const reg = loadRegistry();
    if (!reg.groups[id]) return { error: 'group not found' };
    const set = new Set(reg.groups[id].assets);
    for (const h of (hashes || [])) set.add(h);
    reg.groups[id].assets = [...set];
    saveRegistry(reg);
    return { id, ...reg.groups[id] };
  }

  // DELETE /api/groups/:id/assets/:hash  — remove a single asset from a group
  if (method === 'DELETE' && /^\/api\/groups\/[^/]+\/assets\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/');
    const id = parts[3], hash = parts[5];
    const reg = loadRegistry();
    if (!reg.groups[id]) return { error: 'group not found' };
    reg.groups[id].assets = reg.groups[id].assets.filter(h => h !== hash);
    saveRegistry(reg);
    return { id, ...reg.groups[id] };
  }

  // ─── Devices ─────────────────────────────────────────────────────────────────
  // GET /api/devices  — list all registered devices
  if (method === 'GET' && pathname === '/api/devices') {
    const reg = loadRegistry();
    return Object.entries(reg.devices).map(([mac, d]) => ({ mac, ...d }));
  }

  // POST /api/devices  { tvMac, name?, tvIp?, playerMac? }  — register / upsert device
  if (method === 'POST' && pathname === '/api/devices') {
    const { tvMac, name, tvIp, playerMac } = body;
    if (!tvMac) return { error: 'tvMac required' };
    const mac = normalizeMac(tvMac);
    const reg = loadRegistry();
    const existing = reg.devices[mac] || { groups: [] };
    reg.devices[mac] = {
      ...existing,
      name: (name ? name.trim() : null) || existing.name || mac,
      ...(tvIp      ? { tvIp }                               : {}),
      ...(playerMac ? { playerMac: normalizeMac(playerMac) } : {}),
    };
    saveRegistry(reg);
    return { mac, ...reg.devices[mac] };
  }

  // PATCH /api/devices/:mac  { name?, tvIp? }
  if (method === 'PATCH' && /^\/api\/devices\/[^/]+$/.test(pathname)) {
    const mac = normalizeMac(pathname.split('/')[3]);
    const reg = loadRegistry();
    if (!reg.devices[mac]) return { error: 'device not found' };
    if (body.name !== undefined) reg.devices[mac].name  = body.name.trim();
    if (body.tvIp !== undefined) reg.devices[mac].tvIp  = body.tvIp;
    saveRegistry(reg);
    return { mac, ...reg.devices[mac] };
  }

  // DELETE /api/devices/:mac
  if (method === 'DELETE' && /^\/api\/devices\/[^/]+$/.test(pathname)) {
    const mac = normalizeMac(pathname.split('/')[3]);
    const reg = loadRegistry();
    delete reg.devices[mac];
    saveRegistry(reg);
    return { ok: true };
  }

  // POST /api/devices/:mac/groups  { groupId }  — assign a group to a device
  if (method === 'POST' && /^\/api\/devices\/[^/]+\/groups$/.test(pathname)) {
    const mac = normalizeMac(pathname.split('/')[3]);
    const { groupId } = body;
    const reg = loadRegistry();
    if (!reg.devices[mac]) return { error: 'device not found' };
    if (groupId !== 'all' && !reg.groups[groupId]) return { error: 'group not found' };
    const set = new Set(reg.devices[mac].groups || []);
    set.add(groupId);
    reg.devices[mac].groups = [...set];
    saveRegistry(reg);
    return { mac, ...reg.devices[mac] };
  }

  // DELETE /api/devices/:mac/groups/:groupId  — remove a group assignment from a device
  if (method === 'DELETE' && /^\/api\/devices\/[^/]+\/groups\/[^/]+$/.test(pathname)) {
    const parts   = pathname.split('/');
    const mac     = normalizeMac(parts[3]);
    const groupId = parts[5];
    const reg = loadRegistry();
    if (!reg.devices[mac]) return { error: 'device not found' };
    reg.devices[mac].groups = (reg.devices[mac].groups || []).filter(g => g !== groupId);
    saveRegistry(reg);
    return { mac, ...reg.devices[mac] };
  }

  // POST /api/devices/:mac/push-all  { tvIp? }
  // Push every assigned group to the device's media player in one shot.
  // Pre-inspects each folder — skips if file set is already up-to-date.
  if (method === 'POST' && /^\/api\/devices\/[^/]+\/push-all$/.test(pathname)) {
    const mac = normalizeMac(pathname.split('/')[3]);
    const { tvIp: overrideIp } = body;
    const reg    = loadRegistry();
    const device = reg.devices[mac];
    if (!device) return { error: 'device not found' };
    const tvIP = overrideIp || device.tvIp;
    if (!tvIP) return { error: 'tvIp required (device has no stored IP)' };

    const devGids = device.groups || [];
    if (!devGids.length) return { error: 'device has no assigned groups' };

    const { items: cacheItems } = await cacheList();

    // Power on TV once
    log('info', `[push-all] Checking power on ${tvIP}:7142`);
    const sess = await openTcpSession(tvIP, { port: 7142 });
    try {
      const pw = await sess.powerStatus(1);
      if (pw.modeStr !== 'on') {
        log('info', `[push-all] Powering on ${tvIP}…`);
        await sess.powerSet(1, 'on');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        log('info', `[push-all] TV already on`);
      }
    } finally {
      await sess.close().catch(() => {});
    }

    // Discover player IP once
    log('info', `[push-all] Fetching player IP from ${tvIP}`);
    const playerIP = await getPlayerIP(tvIP);
    log('info', `[push-all] Player IP: ${playerIP}`);

    // Wait for player once
    await waitForPlayer(playerIP, 15000);
    log('info', `[push-all] Player reachable`);

    const results = [];
    let anyPushed = false;

    for (const groupId of devGids) {
      const grp       = reg.groups[groupId];
      const groupName = grp?.name || groupId;

      // Resolve hashes for this group
      const hashes = grp?.assets || [];
      if (!hashes.length) {
        results.push({ groupId, folder: groupName, status: 'skipped', reason: 'group has no assets' });
        continue;
      }

      // Load file data from cache
      const files = [];
      for (const hash of hashes) {
        const item = cacheItems.find(i => i.sha256 === hash);
        if (!item) continue;
        const ext  = path.extname(item.originalName);
        const data = await fs.promises.readFile(cacheFilePath(hash, ext));
        files.push({ filename: item.displayName, mime: item.mime, data });
      }
      if (!files.length) {
        results.push({ groupId, folder: groupName, status: 'skipped', reason: 'no valid cached files' });
        continue;
      }

      // Pre-inspect folder to check if it's already up-to-date
      log('info', `[push-all] Checking folder "${groupName}"…`);
      const check = await checkPlayerFolder(playerIP, groupName);
      const wantNames = files.map(f => f.filename).sort();
      const haveNames = check.fileNames.slice().sort();
      const upToDate  = check.exists &&
                        wantNames.length === haveNames.length &&
                        wantNames.every((n, i) => n === haveNames[i]);

      if (upToDate) {
        log('info', `[push-all] "${groupName}" already up-to-date — skipping`);
        results.push({ groupId, folder: groupName, status: 'up-to-date' });
        continue;
      }

      // Create/overwrite folder and upload files
      log('info', `[push-all] Pushing ${files.length} file(s) → "${groupName}"`);
      await createFolder(playerIP, groupName);   // navigates into folder

      const pushed = [];
      for (const { filename, mime, data } of files) {
        log('info', `[push-all]   Uploading ${filename} (${data.length} bytes)…`);
        await uploadFileToPlayer(playerIP, data, filename, mime);
        pushed.push(filename);
      }

      // Return to root before processing next folder
      await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

      results.push({ groupId, folder: groupName, status: 'pushed', files: pushed });
      anyPushed = true;
    }

    // Single RSG to commit all uploads (only if we actually pushed something)
    if (anyPushed) {
      const clock = Date.now();
      await playerRequest(playerIP, `/cgi-bin/cgictrl?RSG=${clock}`, 'POST');
      log('info', `[push-all] RSG sent — player will reload content`);
    }

    log('info', `[push-all] Done — ${results.length} group(s) processed`);
    return { ok: true, tvIP, playerIP, results };
  }

  // POST /api/devices/:mac/push  { groupId, tvIp? }
  // Push all assets in a group to a named folder on the device's media player.
  if (method === 'POST' && /^\/api\/devices\/[^/]+\/push$/.test(pathname)) {
    const mac = normalizeMac(pathname.split('/')[3]);
    const { groupId, tvIp: overrideIp } = body;
    const reg    = loadRegistry();
    const device = reg.devices[mac];
    if (!device) return { error: 'device not found' };
    const tvIP = overrideIp || device.tvIp;
    if (!tvIP) return { error: 'tvIp required (device has no stored IP)' };

    // Resolve group → list of sha256 hashes
    const { items: cacheItems } = await cacheList();
    let hashes;
    if (groupId === 'all') {
      hashes = cacheItems.map(i => i.sha256);
    } else {
      const grp = reg.groups[groupId];
      if (!grp) return { error: 'group not found' };
      hashes = grp.assets;
    }
    if (!hashes.length) return { error: 'group has no assets' };

    // Load file data from cache
    const files = [];
    for (const hash of hashes) {
      const item = cacheItems.find(i => i.sha256 === hash);
      if (!item) continue;
      const ext  = path.extname(item.originalName);
      const data = await fs.promises.readFile(cacheFilePath(hash, ext));
      files.push({ filename: item.displayName, mime: item.mime, data });
    }
    if (!files.length) return { error: 'no valid cached files for this group' };

    const groupName = groupId === 'all' ? 'all' : reg.groups[groupId].name;
    log('info', `Pushing ${files.length} file(s) → "${groupName}" on ${device.name || mac} (${tvIP})`);
    const result = await pushGroupToPlayer(tvIP, groupName, files);
    return { ok: true, ...result };
  }

  // POST /api/restart
  // Exits the process cleanly so the `./run --dev` loop can git pull and restart.
  // This is the deploy trigger: push to GitHub, then hit this endpoint from the dev machine.
  if (method === 'POST' && pathname === '/api/restart') {
    log('info', '[restart] Exiting for git-pull restart — goodbye');
    setTimeout(() => process.exit(0), 300); // let response flush first
    return { ok: true, message: 'Server exiting — loop will git pull and restart' };
  }

  // POST /api/emergency-upload?tvIP=x.x.x.x&filename=foo.mp4
  return { error: `Unknown endpoint: ${method} ${pathname}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interrogate — read all settings
// ─────────────────────────────────────────────────────────────────────────────

async function interrogateAll(session, monitorId) {
  const result = {};
  const tryGet = async (label, fn) => {
    try {
      result[label] = await fn();
      log('info', `  ${label}: OK`);
    } catch (e) {
      result[label] = { error: e.message };
      log('warn', `  ${label}: ${e.message}`);
    }
  };

  log('info', `Interrogating monitor ${monitorId} …`);

  // Identity
  await tryGet('serial',   () => session.serialRead(monitorId));
  await tryGet('model',    () => session.modelNameRead(monitorId));
  await tryGet('firmware', () => session.firmwareVersionRead(monitorId));
  await tryGet('mac',      () => session.lanMacRead(monitorId));

  // Health
  await tryGet('selfDiag', () => session.selfDiagnosis(monitorId));

  // Power & timing
  await tryGet('power',  () => session.powerStatus(monitorId));
  await tryGet('timing', () => session.getTimingReport(monitorId));

  // VCP codes
  const VCP_CODES = [
    { name: 'brightness',   opPage: 0x00, opCode: 0x10 },
    { name: 'contrast',     opPage: 0x00, opCode: 0x12 },
    { name: 'sharpness',    opPage: 0x00, opCode: 0x87 },
    { name: 'colorTemp',    opPage: 0x00, opCode: 0x14 },
    { name: 'volume',       opPage: 0x00, opCode: 0x62 },
    { name: 'inputSource',  opPage: 0x00, opCode: 0x60 },
    { name: 'powerMode',    opPage: 0x00, opCode: 0xD6 },
    { name: 'infoOsd',      opPage: 0x02, opCode: 0x3D },
    { name: 'ambientLight', opPage: 0x02, opCode: 0xB4 },
    { name: 'tempSensor',   opPage: 0x02, opCode: 0x79 },
  ];
  result.vcp = {};
  for (const { name, opPage, opCode } of VCP_CODES) {
    await tryGet(`vcp.${name}`, async () => {
      const r = await session.vcpGet(monitorId, opPage, opCode);
      result.vcp[name] = { ...r, opPage, opCode };
      return result.vcp[name];
    });
  }

  // DateTime
  await tryGet('dateTime', () => session.dateTimeRead(monitorId));

  // Asset
  await tryGet('asset', async () => {
    const data = await session.assetReadAll(monitorId);
    return { hex: data.toString('hex'), text: data.toString('ascii').replace(/\x00/g, '') };
  });

  // Schedule slots 0-4
  result.schedule = [];
  for (let i = 0; i < 5; i++) {
    await tryGet(`schedule[${i}]`, async () => {
      const r = await session.scheduleRead(monitorId, i);
      result.schedule[i] = r;
      return r;
    });
  }

  // Holiday slots 0-1
  result.holiday = [];
  for (let i = 0; i < 2; i++) {
    await tryGet(`holiday[${i}]`, async () => {
      const r = await session.holidayRead(monitorId, i);
      result.holiday[i] = r;
      return r;
    });
  }

  // Weekend
  await tryGet('weekend', () => session.weekendRead(monitorId));

  log('info', 'Interrogation complete');
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subnet scanner
// ─────────────────────────────────────────────────────────────────────────────

function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = (open) => { try { sock.destroy(); } catch {} resolve({ host, open }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error',   () => done(false));
    sock.connect(port, host);
  });
}

async function scanSubnet(subnet, port, timeoutMs) {
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const open  = [];

  // TCP probe in batches of 48
  for (let i = 0; i < hosts.length; i += 48) {
    const results = await Promise.all(hosts.slice(i, i + 48).map(h => tcpProbe(h, port, timeoutMs)));
    open.push(...results.filter(r => r.open).map(r => r.host));
  }

  // For each responding host attempt a power-status query (2s timeout)
  const enriched = await Promise.all(open.map(async host => {
    try {
      const sess = await Promise.race([
        openTcpSession(host, { port }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
      ]);
      const pw = await Promise.race([
        sess.powerStatus(1),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
      ]);
      await sess.close().catch(() => {});
      return { host, port, responding: true, power: pw.powerStatus ?? 'unknown' };
    } catch {
      return { host, port, responding: true, power: 'unknown' };
    }
  }));

  return enriched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Device classification probes  (used by /api/device-online)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to open a NEC 7142 session and query power/model/serial.
 * Returns { ok: true, power, model, serial } on success, { ok: false } on any failure.
 * The entire attempt is capped at timeoutMs.
 */
async function probeTvNec(ip, timeoutMs = 5000) {
  let sess;
  try {
    sess = await Promise.race([
      openTcpSession(ip, { port: 7142 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('nec-timeout')), timeoutMs)),
    ]);

    const query = (fn) => Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('nec-timeout')), 2500)),
    ]);

    const result = { ok: true, power: 'unknown', model: null, serial: null };

    try { const pw = await query(() => sess.powerStatus(1));
          result.power = pw.modeStr ?? 'unknown'; } catch { /* best-effort */ }
    try { const m  = await query(() => sess.modelNameRead(1));
          result.model = m.model ?? m.raw ?? null; } catch { /* best-effort */ }
    try { const s  = await query(() => sess.serialRead(1));
          result.serial = s.serial ?? s.raw ?? null; } catch { /* best-effort */ }

    return result;
  } catch {
    return { ok: false };
  } finally {
    if (sess) await sess.close().catch(() => {});
  }
}

/**
 * Try to reach the NEC media player HTTP API on port 80.
 * Fetches /mmb/filelist.json — the firmware always returns a JSON object here
 * (even when the SD card is empty).  Returns true if the host responds with
 * a recognisable player response, false on error or timeout.
 */
function probePlayerHttp(ip, timeoutMs = 4000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const req = http.request(
      {
        host: ip, port: 80,
        path: `/mmb/filelist.json?_=${Date.now()}`,
        method: 'GET',
        headers: {
          'accept': 'application/json, */*',
          'x-requested-with': 'XMLHttpRequest',
          'referer': `http://${ip}/sd_card_viewer.html`,
        },
        insecureHTTPParser: true,
      },
      res => {
        clearTimeout(timer);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const fixed = body.replace(/,(\s*\])/g, '$1');
          try {
            const json = JSON.parse(fixed);
            // filelist.json always has dir_path or fileinfo on a real player
            finish(json.dir_path !== undefined || Array.isArray(json.fileinfo));
          } catch {
            // If the response was non-empty the host is probably a player with
            // a firmware quirk — count it as a positive identification.
            finish(body.trim().length > 0);
          }
        });
        res.on('error', () => { clearTimeout(timer); finish(false); });
      }
    );
    req.on('error', () => { clearTimeout(timer); finish(false); });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Emergency upload subsystem
// Uploads files to the NEC media player SD card (EMERGENCY CONTENTS folder).
// The player HTTP API has broken headers and non-standard JSON, so we use
// node:http directly with insecureHTTPParser:true and manual text parsing.
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a signed 32-bit int (as returned by the TV pjctrl endpoint) to IP string. */
function signedIntToIp(n) {
  if (n < 0) n += 4294967296;
  return `${(n >>> 24) & 0xFF}.${(n >>> 16) & 0xFF}.${(n >>> 8) & 0xFF}.${n & 0xFF}`;
}

/**
 * HTTP request to the player (port 80).
 * Uses insecureHTTPParser to tolerate the TV firmware's malformed headers.
 * Returns response body as a string.
 */
function playerRequest(host, path, method = 'GET', bodyBuf = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'accept': 'text/plain, */*',
      'accept-language': 'en-AU,en;q=0.9',
      'x-requested-with': 'XMLHttpRequest',
      'referer': `http://${host}/sd_card_viewer.html`,
      ...extraHeaders,
    };
    if (bodyBuf) headers['content-length'] = bodyBuf.length;

    const req = http.request(
      { host, port: 80, path, method, headers, insecureHTTPParser: true },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Hit the TV HTTP interface to discover the player IP address.
 * The pjctrl endpoint returns comma-separated signed 32-bit ints;
 * index 5 = TV IP, index 6 = player IP.
 */
async function getPlayerIP(tvIP) {
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: tvIP, port: 80,
      path: '/pjctrl?D%3D%259%25139%250%253%25205',
      method: 'POST',
      headers: {
        'accept': 'application/json, text/javascript, */*',
        'x-requested-with': 'XMLHttpRequest',
        'referer': `http://${tvIP}/`,
      },
      insecureHTTPParser: true,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });

  // Response is comma-separated integers, possibly with trailing comma
  const parts = res.trim().replace(/,+$/, '').split(',').map(n => parseInt(n, 10));
  if (parts.length < 7 || parts.slice(5, 7).some(isNaN)) {
    throw new Error(`Could not parse player IP from pjctrl response: ${res.slice(0, 80)}`);
  }
  return signedIntToIp(parts[6]);
}

/** Poll port 80 on playerIP until it accepts a TCP connection (max timeoutMs). */
function waitForPlayer(playerIP, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = new net.Socket();
      const done = (ok) => { sock.destroy(); ok ? resolve() : retry(); };
      sock.setTimeout(1000);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error',   () => done(false));
      sock.connect(80, playerIP);
    }
    function retry() {
      if (Date.now() >= deadline) return reject(new Error(`Player ${playerIP} not reachable within ${timeoutMs}ms`));
      setTimeout(attempt, 1000);
    }
    attempt();
  });
}

/** List and delete every top-level entry on the player SD card. */
async function wipeDrive(playerIP) {
  // Navigate to root before listing (FL=-01 = go up/to root)
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

  const raw = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET',
    null, { referer: `http://${playerIP}/sd_card_viewer.html` });

  let fileinfo;
  try {
    // Fix trailing comma before ] that the firmware emits
    const fixed = raw.replace(/,(\s*\])/g, '$1');
    ({ fileinfo } = JSON.parse(fixed));
  } catch {
    log('warn', `wipeDrive: could not parse filelist (${raw.slice(0, 80)}), assuming empty`);
    return;
  }
  if (!Array.isArray(fileinfo)) return;

  for (const { name } of fileinfo) {
    await playerRequest(playerIP, `/cgi-bin/cgictrl?FD=${encodeURIComponent(name)}`, 'POST');
    log('info', `  deleted: ${name}`);
  }
}

/** Create a folder on the player SD card using the CGI navigation sequence.
 *  Navigates into the newly created folder so the caller can start uploading immediately.
 *  Returns the folder's index in the root filelist (0-based).
 */
async function createFolder(playerIP, folderName) {
  // 1. Navigate to root
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');
  log('info', `  createFolder: navigated to root`);

  // 2. Delete existing folder of the same name (no-op if absent — firmware ignores it)
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FD=${encodeURIComponent(folderName)}`, 'POST');
  log('info', `  createFolder: attempted delete of "${folderName}"`);

  // 3. Enter file manager mode (required before FC=)
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FM=`, 'POST');
  log('info', `  createFolder: entered file manager mode`);

  // 4. Create the folder
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FC=${encodeURIComponent(folderName)}`, 'POST');
  log('info', `  createFolder: created "${folderName}"`);

  // Give the firmware a moment to flush the new directory entry to the SD card,
  // then navigate to root to ensure we are reading the root filelist and not some
  // undefined post-FC= context.
  await new Promise(r => setTimeout(r, 400));
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');
  log('info', `  createFolder: re-rooted after creation`);

  // 5. Read the updated filelist to locate the actual index of the new folder
  const raw = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET');
  const fixed = raw.replace(/,(\s*\])/g, '$1');
  let fileinfo = [];
  try { ({ fileinfo } = JSON.parse(fixed)); } catch { /* leave fileinfo empty */ }

  const idx = (fileinfo || []).findIndex(f => f.name === folderName && f.type === 0);
  if (idx < 0) throw new Error(`createFolder: "${folderName}" not found in filelist after creation`);

  const idxStr = String(idx).padStart(3, '0');
  log('info', `  createFolder: "${folderName}" is at index ${idx} — navigating in (FL=${idxStr})`);

  // 6. Navigate into the folder (caller can now upload directly)
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=${idxStr}`, 'POST');

  return idx;
}

/**
 * Inspect the contents of a named folder on the player SD card — read-only, no modifications.
 * Returns { exists: boolean, fileNames: string[] }
 *
 * Sequence:
 *   FL=-01        → go to root
 *   filelist.json → read root entries, locate folderName (type === 0)
 *   FL=nnn        → navigate into folder
 *   filelist.json → read folder contents
 *   FL=-01        → return to root
 */
async function checkPlayerFolder(playerIP, folderName) {
  // Navigate to root
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

  // Read root filelist
  const rawRoot = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET');
  const fixedRoot = rawRoot.replace(/,(\s*\])/g, '$1');
  let rootInfo = [];
  try { ({ fileinfo: rootInfo } = JSON.parse(fixedRoot)); } catch { /* leave empty */ }

  // Find the folder by name
  const idx = (rootInfo || []).findIndex(f => f.name === folderName && f.type === 0);
  if (idx < 0) return { exists: false, fileNames: [] };

  // Navigate into folder
  const idxStr = String(idx).padStart(3, '0');
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=${idxStr}`, 'POST');

  // Read folder filelist
  const rawFolder = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET');
  const fixedFolder = rawFolder.replace(/,(\s*\])/g, '$1');
  let folderInfo = [];
  try { ({ fileinfo: folderInfo } = JSON.parse(fixedFolder)); } catch { /* leave empty */ }

  const fileNames = (folderInfo || [])
    .filter(f => f.name !== '..' && f.type !== 0)
    .map(f => f.name);

  // Return to root
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

  return { exists: true, fileNames };
}

/**
 * Upload a file to the player SD card using multipart/form-data.
 * Pure Node.js — no npm dependencies.
 * The RSB endpoint initialises the upload session; Fu accepts the file.
 */
async function uploadFileToPlayer(playerIP, fileBuffer, filename, mime) {
  const clock = Date.now(); // unique per upload, avoids same-second collision
  const rsb_path = `/cgi-bin/cgictrl?RSB=${clock}`;
  const fu_path  = `/cgi-bin/cgictrl?Fu=${clock}`;

  // Initialise upload session
  await playerRequest(playerIP, rsb_path, 'POST');

  // Build multipart body
  const boundary = '----NecUpload' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  );
  const foot = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuffer, foot]);

  const result = await playerRequest(playerIP, fu_path, 'POST', body, {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': body.length,
  });

  log('info', `  upload result: ${result.slice(0, 80)}`);
  return result;
}

/**
 * Parse a multipart/form-data body into an array of { filename, mime, data } objects.
 * Preserves part order (slideshow plays in upload order).
 */
// ─────────────────────────────────────────────────────────────────────────────
// Asset cache subsystem
// Files stored as: {CACHE_DIR}/{sha256}.{ext}
// Metadata stored as: {CACHE_DIR}/{sha256}.json
//
// Display filename format (what the TV sees):
//   basename.slice(0,32).padEnd(33) + sha256.slice(0,24) + ext
//   e.g. "Emergency Slide          a3f9c821b04e16d7f2a8c3d1.mp4"
//        |←       33 chars       →||←    24 hex chars    →|
// ─────────────────────────────────────────────────────────────────────────────

function cacheDisplayName(originalName, sha256) {
  const ext      = path.extname(originalName);           // e.g. ".mp4"
  const base     = path.basename(originalName, ext);     // e.g. "Emergency Slide"
  const trimmed  = base.slice(0, 32).padEnd(33, ' ');    // 33 chars
  const hashPart = sha256.slice(0, 24);                  // 24 hex chars
  return trimmed + hashPart + ext;
}

function cacheSidecarPath(sha256)  { return path.join(CACHE_DIR, sha256 + '.json'); }
function cacheFilePath(sha256, ext) { return path.join(CACHE_DIR, sha256 + ext); }

async function cacheStore(data, originalName, mime) {
  const sha256      = crypto.createHash('sha256').update(data).digest('hex');
  const ext         = path.extname(originalName) || '';
  const filePath    = cacheFilePath(sha256, ext);
  const sidecarPath = cacheSidecarPath(sha256);
  const displayName = cacheDisplayName(originalName, sha256);

  // Write file (idempotent — same hash = same content)
  await fs.promises.writeFile(filePath, data);

  // Write or update sidecar
  let meta;
  try {
    meta = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
  } catch {
    meta = { originalName, displayName, sha256, mime, size: data.length,
             cachedAt: new Date().toISOString(), sentTo: [] };
  }
  await fs.promises.writeFile(sidecarPath, JSON.stringify(meta, null, 2));
  log('info', `Cached ${displayName} (${data.length} bytes) sha256=${sha256.slice(0,16)}…`);
  return { hash: sha256, displayName, originalName, size: data.length, mime };
}

async function cacheList() {
  const entries = await fs.promises.readdir(CACHE_DIR);
  // Only match sha256-named sidecars — excludes registry.json and any other admin files
  const sidecars = entries.filter(f => /^[0-9a-f]{64}\.json$/.test(f));
  const items = [];
  for (const sc of sidecars) {
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(CACHE_DIR, sc), 'utf8'));
      items.push(meta);
    } catch { /* skip corrupt sidecar */ }
  }
  items.sort((a, b) => a.cachedAt < b.cachedAt ? 1 : -1); // newest first
  return { items };
}

async function cacheDelete(sha256) {
  const sidecarPath = cacheSidecarPath(sha256);
  let ext = '';
  try {
    const meta = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
    ext = path.extname(meta.originalName);
  } catch { return { error: 'hash not found in cache' }; }
  await fs.promises.unlink(sidecarPath).catch(() => {});
  await fs.promises.unlink(cacheFilePath(sha256, ext)).catch(() => {});
  log('info', `Cache delete: ${sha256.slice(0, 16)}…`);
  return { ok: true, hash: sha256 };
}

async function cacheSend(sha256, tvIP) {
  const sidecarPath = cacheSidecarPath(sha256);
  let meta;
  try {
    meta = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
  } catch { return { error: 'hash not found in cache' }; }

  const filePath = cacheFilePath(sha256, path.extname(meta.originalName));
  const data = await fs.promises.readFile(filePath);

  // Run full upload flow using display name (so TV shows readable filename)
  const result = await emergencyUploadFiles(tvIP, [{
    filename: meta.displayName,
    mime:     meta.mime,
    data,
  }]);

  // Record in sentTo
  meta.sentTo.push({ tvIP, playerIP: result.playerIP, sentAt: new Date().toISOString() });
  await fs.promises.writeFile(sidecarPath, JSON.stringify(meta, null, 2));

  return { ...result, hash: sha256, displayName: meta.displayName };
}

function parseMultipart(buf, boundary) {
  const files = [];
  const sep   = Buffer.from('--' + boundary);
  const end   = Buffer.from('--' + boundary + '--');
  let pos = 0;

  while (pos < buf.length) {
    // Find next boundary
    const bStart = buf.indexOf(sep, pos);
    if (bStart === -1) break;
    pos = bStart + sep.length;
    // Skip \r\n after boundary
    if (buf[pos] === 0x0D && buf[pos + 1] === 0x0A) pos += 2;
    else break;
    // Check for end boundary
    if (buf.slice(bStart, bStart + end.length).equals(end)) break;

    // Read headers until \r\n\r\n
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headerStr = buf.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;

    // Parse Content-Disposition filename
    const nameMatch = headerStr.match(/filename="([^"]+)"/i);
    if (!nameMatch) continue;
    const filename = nameMatch[1];

    // Parse Content-Type
    const ctMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
    const mime = ctMatch ? ctMatch[1] : 'application/octet-stream';

    // Find next boundary to delimit body
    const nextBound = buf.indexOf(sep, pos);
    if (nextBound === -1) break;
    // Body ends just before \r\n--boundary
    const bodyEnd = nextBound - 2;
    const data = buf.slice(pos, bodyEnd);
    files.push({ filename, mime, data });
    pos = nextBound;
  }
  return files;
}

/**
 * Full emergency upload flow for multiple files:
 * 1. NEC 7142: check power, turn on if needed
 * 2. HTTP: discover player IP via pjctrl
 * 3. Wait for player to become reachable
 * 4. Wipe SD card (once)
 * 5. Create EMERGENCY CONTENTS folder
 * 6. Upload all files in order (slideshow preserves upload order)
 */
async function emergencyUploadFiles(tvIP, files) {
  const FOLDER = 'EMERGENCY CONTENTS';

  // 1. Power on via NEC 7142 if needed
  log('info', `[emergency-upload] Checking power on ${tvIP}:7142`);
  const sess = await openTcpSession(tvIP, { port: 7142 });
  try {
    const pw = await sess.powerStatus(1);
    if (pw.modeStr !== 'on') {
      log('info', `[emergency-upload] Powering on ${tvIP}…`);
      await sess.powerSet(1, 'on');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      log('info', `[emergency-upload] TV already on`);
    }
  } finally {
    await sess.close().catch(() => {});
  }

  // 2. Discover player IP via HTTP pjctrl
  log('info', `[emergency-upload] Fetching player IP from ${tvIP}`);
  const playerIP = await getPlayerIP(tvIP);
  log('info', `[emergency-upload] Player IP: ${playerIP}`);

  // 3. Wait for player to be reachable (up to 15s)
  log('info', `[emergency-upload] Waiting for player at ${playerIP}…`);
  await waitForPlayer(playerIP, 15000);
  log('info', `[emergency-upload] Player reachable`);

  // 4. Wipe SD card once
  log('info', `[emergency-upload] Wiping SD card…`);
  await wipeDrive(playerIP);

  // 5. Create folder
  log('info', `[emergency-upload] Creating folder: ${FOLDER}`);
  await createFolder(playerIP, FOLDER);

  // 6. Upload all files in order
  const uploaded = [];
  for (const { filename, mime, data } of files) {
    log('info', `[emergency-upload] Uploading ${filename} (${data.length} bytes)…`);
    await uploadFileToPlayer(playerIP, data, filename, mime);
    uploaded.push({ filename, bytes: data.length });
  }

  log('info', `[emergency-upload] Done — ${uploaded.length} file(s) uploaded`);
  return { ok: true, tvIP, playerIP, folder: FOLDER, files: uploaded };
}

/**
 * Push a group's files to a named folder on the media player SD card.
 * Unlike emergencyUploadFiles, this preserves all other folders — it only
 * deletes and recreates the one target folder (createFolder handles that).
 *
 * Flow:
 * 1. Power on via NEC 7142 (if needed)
 * 2. Discover player IP via pjctrl
 * 3. Wait for player to be reachable
 * 4. Create/overwrite the named folder (delete → recreate, leaves other folders intact)
 * 5. Upload all files in order
 * 6. RSG finalise so the player picks up the new content
 */
async function pushGroupToPlayer(tvIP, folderName, files) {
  // 1. Power on if needed
  log('info', `[push] Checking power on ${tvIP}:7142`);
  const sess = await openTcpSession(tvIP, { port: 7142 });
  try {
    const pw = await sess.powerStatus(1);
    if (pw.modeStr !== 'on') {
      log('info', `[push] Powering on ${tvIP}…`);
      await sess.powerSet(1, 'on');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      log('info', `[push] TV already on`);
    }
  } finally {
    await sess.close().catch(() => {});
  }

  // 2. Discover player IP
  log('info', `[push] Fetching player IP from ${tvIP}`);
  const playerIP = await getPlayerIP(tvIP);
  log('info', `[push] Player IP: ${playerIP}`);

  // 3. Wait for player
  await waitForPlayer(playerIP, 15000);
  log('info', `[push] Player reachable`);

  // 4. Create (or overwrite) the named folder — navigates into it ready for uploads
  log('info', `[push] Creating folder "${folderName}"`);
  await createFolder(playerIP, folderName);

  // 5. Upload all files in order
  const uploaded = [];
  for (const { filename, mime, data } of files) {
    log('info', `[push] Uploading ${filename} (${data.length} bytes)…`);
    await uploadFileToPlayer(playerIP, data, filename, mime);
    uploaded.push({ filename, bytes: data.length });
  }

  // 6. RSG finalise — restarts player so it picks up the new folder contents
  const clock = Date.now();
  await playerRequest(playerIP, `/cgi-bin/cgictrl?RSG=${clock}`, 'POST');
  log('info', `[push] Done — ${uploaded.length} file(s) uploaded to "${folderName}"`);
  return { tvIP, playerIP, folder: folderName, files: uploaded };
}

// ─── Media player folder playback ─────────────────────────────────────────────

const MEDIA_PLAYER_INPUT  = 0x87;
const PLAYER_ROOT         = '/mnt/usb1';
const INTERVAL_INFINITE   = 99999; // firmware accepts up to 99999s (~27hrs)
const INTERVAL_DEFAULT    = 30;

/**
 * Set the AUTO PLAY folder on the media player.
 * mode: 0=off, 1=slideshow, 2=mediapack
 */
async function setAutoPlay(playerIP, folderPath, mode = 1) {
  // V=S,2A — play mode
  await playerRequest(playerIP, `/cgi-bin/cgictrl?V=S,2A,2,0,${mode},%00,`, 'POST');
  log('info', `  autoplay mode=${mode}`);

  // V=S,2B — folder path.
  // The firmware parses raw URL bytes without decoding percent-sequences first, so:
  //   • use encodeURIComponent on the FULL path (slashes become %2F, spaces become %20, etc.)
  //   • len = encoded string length + 1 (null terminator), NOT the raw decoded length
  // Verified by capturing the NEC player's own web UI via DevTools — it sends e.g.:
  //   V=S,2B,35,1,%2Fmnt%2Fusb1%2FGeneric%20MCEC%202,%00,
  // (Previous CLAUDE.md note saying "never encode slashes" was a misdiagnosis.)
  const encodedPath = encodeURIComponent(folderPath);
  const len         = encodedPath.length + 1;
  await playerRequest(playerIP, `/cgi-bin/cgictrl?V=S,2B,${len},1,${encodedPath},%00,`, 'POST');
  log('info', `  autoplay folder=${folderPath}`);
}

/**
 * Set the slideshow interval (seconds).
 * Firmware accepts 5–99999. Use INTERVAL_INFINITE for single-slide display.
 */
async function setSlideInterval(playerIP, seconds) {
  const val = String(Math.max(5, Math.min(99999, Math.round(seconds))));
  const len = val.length + 1;
  const r   = await playerRequest(playerIP, `/cgi-bin/cgictrl?V=S,22,${len},0,${val},%00,`, 'POST');
  log('info', `  interval=${val}s -> ${r.slice(0, 40)}`);
}

/**
 * Restart the media player (RSG= commits pending changes and restarts playback).
 */
async function restartPlayer(playerIP) {
  const ck = Date.now();
  const r  = await playerRequest(playerIP, `/cgi-bin/cgictrl?RSG=${ck}`, 'POST');
  log('info', `  RSG= -> ${r.slice(0, 40)}`);
}

/**
 * Read the filelist for a given folder on the player.
 * Returns { fileCount, files } where files is the raw fileinfo array.
 * Navigates into the folder by index from root listing.
 */
async function getPlayerFolderContents(playerIP, folder) {
  // Go to root
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

  // Read root filelist to find folder index
  const rootRaw = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET',
    null, { referer: `http://${playerIP}/sd_card_viewer.html` });
  const rootFixed = rootRaw.replace(/,(\s*\])/g, '$1');
  const root = JSON.parse(rootFixed);

  const folderIdx = root.fileinfo.findIndex(f => f.name === folder && f.type === 0);
  if (folderIdx < 0) throw new Error(`Folder "${folder}" not found on player`);

  // Navigate into folder
  const idxStr = String(folderIdx).padStart(3, '0');
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=${idxStr}`, 'POST');

  // Read folder contents
  const raw   = await playerRequest(playerIP, `/mmb/filelist.json?_=${Date.now()}`, 'GET',
    null, { referer: `http://${playerIP}/sd_card_viewer.html` });
  const fixed = raw.replace(/,(\s*\])/g, '$1');
  const list  = JSON.parse(fixed);

  // Navigate back to root
  await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=-01`, 'POST');

  const files = (list.fileinfo || []).filter(f => f.name !== '..' && f.type !== 0);
  return { fileCount: files.length, files };
}

/**
 * Full "play this folder" flow:
 *  1. Discover player IP from TV
 *  2. Check folder contents — abort if empty
 *  3. Decide interval: 99999 for single file, caller-supplied for multiple
 *  4. If already on MP input, bounce away first so the player restarts cleanly
 *  5. Set autoplay folder + mode + interval
 *  6. Restart player (RSG=)
 *  7. Switch TV input to MP
 */
async function playFolder(tvIP, folder, session, monitorId, restoreInput = 0x11, interval = INTERVAL_DEFAULT) {
  const folderPath = `${PLAYER_ROOT}/${folder}`;
  log('info', `[player/play] folder=${folderPath} tv=${tvIP}`);

  const playerIP = await getPlayerIP(tvIP);
  log('info', `[player/play] playerIP=${playerIP}`);

  // Check folder contents
  const { fileCount } = await getPlayerFolderContents(playerIP, folder);
  log('info', `[player/play] fileCount=${fileCount}`);
  if (fileCount === 0) {
    return { ok: false, error: 'folder is empty', folder: folderPath };
  }

  // Decide interval
  const chosenInterval = fileCount === 1 ? INTERVAL_INFINITE : interval;
  log('info', `[player/play] interval=${chosenInterval}s (${fileCount} file(s))`);

  // If no persistent session was supplied, open a temporary one for the TV input operations.
  // This allows badge-clicks (and other sessionless callers) to still switch the TV input.
  let tempSession = null;
  let activeSess  = session;
  const activeMid = monitorId ?? 1;
  if (!activeSess) {
    log('info', `[player/play] no session — opening temporary NEC connection to ${tvIP}`);
    try {
      tempSession = await openTcpSession(tvIP, { port: 7142 });
      activeSess  = tempSession;
    } catch(e) {
      log('warn', `[player/play] temporary session failed (${e.message}) — input switch skipped`);
    }
  }

  try {
    // Read current TV input
    let currentInput = null;
    if (activeSess) {
      try {
        const inp  = await activeSess.vcpGet(activeMid, 0x00, 0x60);
        currentInput = inp.current;
        log('info', `[player/play] current input=0x${currentInput.toString(16)}`);
      } catch(e) {
        log('warn', `[player/play] could not read input: ${e.message}`);
      }
    }

    // If already on MP, bounce away first so the player picks up the new folder
    if (currentInput === MEDIA_PLAYER_INPUT && activeSess) {
      log('info', `[player/play] already on MP — bouncing to 0x${restoreInput.toString(16)} first`);
      await activeSess.vcpSet(activeMid, 0x00, 0x60, restoreInput);
      await new Promise(r => setTimeout(r, 800));
    }

    await setAutoPlay(playerIP, folderPath);
    await setSlideInterval(playerIP, chosenInterval);
    await restartPlayer(playerIP);

    // Switch TV input to MP
    if (activeSess) {
      const r = await activeSess.vcpSet(activeMid, 0x00, 0x60, MEDIA_PLAYER_INPUT);
      log('info', `[player/play] input switch to MP -> ${JSON.stringify(r)}`);
    }
  } finally {
    if (tempSession) {
      await tempSession.close().catch(() => {});
      log('info', `[player/play] temporary session closed`);
    }
  }

  return { ok: true, tvIP, playerIP, folder: folderPath, fileCount, interval: chosenInterval };
}

function hex(n) { return '0x' + n.toString(16).toUpperCase().padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u      = new URL(req.url, `http://localhost`);
  const path   = u.pathname;
  const method = req.method.toUpperCase();

  // WebSocket upgrade check (handled by upgrade event below)
  if (req.headers.upgrade?.toLowerCase() === 'websocket') return;

  // Serve the single-page app
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      const html = fs.readFileSync(new URL('./index.html', import.meta.url));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('index.html not found — place it next to server.js');
    }
    return;
  }

  // JSON API
  if (path.startsWith('/api/')) {
    // cache/store and emergency-upload carry raw multipart — handle before readJson
    if (method === 'POST' && (path === '/api/cache/store' || path === '/api/emergency-upload')) {
      try {
        const result = await handleApi(method, path, {}, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        log('error', `API error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await readJson(req);
    }
    try {
      const result = await handleApi(method, path, body, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const code = err instanceof NecError ? err.code : 'ERROR';
      log('error', `API error [${code}]: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, code }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    wsUpgrade(req, socket);
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`\n  NEC Monitor Control Console  →  http://localhost:${PORT}\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-page application (inlined HTML)
// ─────────────────────────────────────────────────────────────────────────────

