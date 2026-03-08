/**
 * sacn.js — Generic sACN (E1.31) DMX receiver and packet handling
 *
 * This module provides:
 * - sACN protocol parsing and validation
 * - UDP multicast socket management
 * - DMX state tracking and debouncing
 * - Device session management
 * - Dependency-injected handlers for device control
 *
 * No server.js or framework dependencies — purely functional utilities +
 * a factory to create handlers with injectable dependencies.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SACN_PORT              = 5568;
export const SACN_FOLDER_CH_START   = 100;   // CH101 = 0-based index 100
export const SACN_FOLDER_COUNT      = 410;   // CH101–CH510
export const SACN_ACTIVE_THRESHOLD  = 128;   // ≥ this = fader "on"
export const SACN_TEMP_PREFIX       = '_show_';
export const SACN_DISPATCH_DEBOUNCE = 200;   // ms — VCP / input commands
export const SACN_FOLDER_DEBOUNCE   = 2000;  // ms — folder switches

/**
 * Input banding for CH3 (input select) and folder-stop fallback.
 * Maps 0–255 DMX values to NEC VCP input codes.
 */
export const SACN_INPUT_BANDS = [
  { max: 0,   code: null   },   // 0 = no change
  { max: 50,  code: 0x11   },   // 1–50   HDMI1
  { max: 100, code: 0x12   },   // 51–100 HDMI2
  { max: 150, code: 0x0F   },   // 101–150 DP1
  { max: 200, code: 0x10   },   // 151–200 DP2
  { max: 255, code: 0x87   },   // 201–255 MediaPlayer
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure Utilities — No Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw UDP packet into { universe, dmx } or null if invalid.
 * Validates sACN header, preamble, vectors, and length.
 *
 * @param {Buffer} buf - Raw UDP packet bytes
 * @returns {{ universe: number, dmx: Buffer }} or null
 */
export function parseSacnPacket(buf) {
  if (buf.length < 126) return null;

  // Preamble size must be 0x0010
  if (buf.readUInt16BE(0) !== 0x0010) return null;

  // ACN packet identifier: "ASC-E1.17\0\0\0" at bytes 4–15 (uppercase)
  const ACN_ID = Buffer.from([0x41,0x53,0x43,0x2D,0x45,0x31,0x2E,0x31,0x37,0x00,0x00,0x00]);
  if (!buf.slice(4, 16).equals(ACN_ID)) return null;

  // Root layer vector must be 0x00000004 (VECTOR_ROOT_E131_DATA)
  if (buf.readUInt32BE(18) !== 0x00000004) return null;

  // Framing layer vector must be 0x00000002 (VECTOR_E131_DATA_PACKET)
  if (buf.readUInt32BE(40) !== 0x00000002) return null;

  const universe  = buf.readUInt16BE(113);
  const propCount = buf.readUInt16BE(123);

  if (buf.length < 126 + propCount - 1) return null;

  // Byte at offset 125 is the start code (must be 0x00 for standard DMX)
  if (buf[125] !== 0x00) return null;

  const dmx = buf.slice(126, 126 + propCount - 1); // up to 512 bytes
  return { universe, dmx };
}

/**
 * Return the multicast address for a given sACN universe number.
 * sACN uses 239.255.U_hi.U_lo where U is the universe (0–63999).
 *
 * @param {number} universe - Universe 0–63999
 * @returns {string} Multicast IPv4 address (e.g., "239.255.0.1")
 */
export function sacnMulticastAddr(universe) {
  return `239.255.${(universe >> 8) & 0xFF}.${universe & 0xFF}`;
}

/**
 * Map a 0–255 DMX channel value to a NEC VCP input code via banding.
 * Returns null for "no change" (value 0).
 *
 * @param {number} value - DMX channel value 0–255
 * @param {Array} bands - Input band definitions (default: SACN_INPUT_BANDS)
 * @returns {number|null} VCP input code or null
 */
export function sacnInputCode(value, bands = SACN_INPUT_BANDS) {
  for (const band of bands) {
    if (value <= band.max) return band.code;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory to create state containers and managers.
 * Separate from socket logic so it can be tested/reset independently.
 */
export class SacnStateManager {
  constructor() {
    this.state    = new Map();      // mac → { dmx, lastPacket, showMode, timers, lastSent, lastFolderBmp }
    this.sessions = new Map();      // mac → { session, monitorId }
    this.socket   = { sock: null, joined: new Set() };
  }

  getOrInitState(mac) {
    if (!this.state.has(mac)) {
      this.state.set(mac, {
        dmx:           new Uint8Array(512),
        lastPacket:    0,
        showMode:      false,
        timers:        {},
        lastSent:      {},
        lastFolderBmp: 0,
      });
    }
    return this.state.get(mac);
  }

  getState(mac) {
    return this.state.get(mac);
  }

  setState(mac, state) {
    this.state.set(mac, state);
  }

  getSession(mac) {
    return this.sessions.get(mac);
  }

  setSession(mac, session) {
    this.sessions.set(mac, session);
  }

  deleteSession(mac) {
    this.sessions.delete(mac);
  }

  reset() {
    this.state.clear();
    this.sessions.clear();
    this.socket = { sock: null, joined: new Set() };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket Management (functional, state passed in)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join a multicast group for a universe (idempotent).
 *
 * @param {number} universe - Universe number
 * @param {Object} socketState - { sock, joined }
 * @param {string} [localIp] - Local IPv4 address to bind to
 * @param {Function} logger - Log function
 */
export function joinUniverse(universe, socketState, localIp = null, logger = () => {}) {
  if (!socketState.sock) {
    logger('warn', `[sACN] socket not ready, cannot join universe ${universe}`);
    return;
  }

  const addr = sacnMulticastAddr(universe);
  if (socketState.joined.has(addr)) return;

  try {
    if (localIp) {
      socketState.sock.addMembership(addr, localIp);
    } else {
      socketState.sock.addMembership(addr);
    }
    socketState.joined.add(addr);
  } catch (e) {
    logger('warn', `[sACN] addMembership ${addr} failed: ${e.message}`);
  }
}

/**
 * Leave a multicast group for a universe.
 *
 * @param {number} universe - Universe number
 * @param {Object} socketState - { sock, joined }
 */
export function leaveUniverse(universe, socketState) {
  if (!socketState.sock) return;
  const addr = sacnMulticastAddr(universe);
  if (!socketState.joined.has(addr)) return;
  try {
    socketState.sock.dropMembership(addr);
    socketState.joined.delete(addr);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bitmap Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the active folder bitmap for a device's folder faders.
 * Reads the folder channel indices from sacnFolders config and checks
 * which ones exceed the ACTIVE_THRESHOLD.
 *
 * @param {Array} folders - Device's sacnFolders config (from registry)
 * @param {Uint8Array} dmx - Current DMX state (512 bytes)
 * @returns {number} Bitmap with one bit per folder
 */
export function computeFolderBitmap(folders, dmx) {
  let bitmap = 0;
  for (let j = 0; j < folders.length; j++) {
    const chIdx = folders[j].channel - 1; // 0-based
    if (chIdx >= 0 && chIdx < 512 && (dmx[chIdx] ?? 0) >= SACN_ACTIVE_THRESHOLD) {
      bitmap |= (1 << j);
    }
  }
  return bitmap;
}

/**
 * Count the number of set bits in a bitmap.
 *
 * @param {number} bitmap - Bitmap value
 * @returns {number} Count of 1 bits
 */
export function countBits(bitmap) {
  return bitmap.toString(2).split('1').length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler Factory — Creates Device Control Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a set of sACN handler functions with injected dependencies.
 * This allows the handlers to be testable while remaining flexible about
 * how they integrate with server.js.
 *
 * Dependencies (all required unless noted):
 * - stateManager: SacnStateManager instance
 * - logger: (level, msg) => void
 * - broadcaster: (obj) => void (WebSocket broadcast)
 * - registryLoader: () => registry object
 * - registrySaver: (registry) => void
 * - getSacnSession: (mac) => Promise<{ session, monitorId }>
 * - playFolder: (tvIP, folderName, ...) => Promise
 * - getPlayerIP: (tvIP) => Promise<string>
 * - playerRequest: (playerIP, url, method) => Promise
 * - SAFE_INPUT: VCP input code for safe fallback (optional, default 0x11)
 *
 * @param {Object} deps - Dependency object
 * @returns {Object} { handleEnable, handleVcp, handleFolders, stopPlayback, receive }
 */
export function createHandlers(deps) {
  const {
    stateManager,
    logger,
    broadcaster,
    registryLoader,
    registrySaver,
    getSacnSession,
    playFolder,
    getPlayerIP,
    playerRequest,
    SAFE_INPUT = 0x11,
  } = deps;

  /**
   * Handle CH1 (enable/show mode). No debounce — scheduler inhibit must be instant.
   */
  function handleEnable(mac, value) {
    const st = stateManager.getState(mac);
    if (!st) return;
    const showMode = value > 0;
    if (st.showMode === showMode) return;
    st.showMode = showMode;
    logger('info', `[sACN] ${mac} show mode ${showMode ? 'ON' : 'OFF'}`);
    broadcaster({ type: 'sacn-status', mac, showMode });
  }

  /**
   * Handle VCP channels (CH2–CH9): power, input, brightness, contrast, backlight,
   * sharpness, volume, colour temp. Only sends NEC commands when values change.
   */
  async function handleVcp(mac, dmx) {
    const st = stateManager.getState(mac);
    if (!st) return;

    let sess;
    try { sess = await getSacnSession(mac); }
    catch (e) { logger('warn', `[sACN] VCP session failed for ${mac}: ${e.message}`); return; }

    const { session: s, monitorId: mid } = sess;

    // CH2 (index 1) — power: 0–127 = standby (0x04), 128–255 = on (0x01)
    const powerVal = dmx[1] !== undefined ? dmx[1] : 0;
    const powerVcp = powerVal < 128 ? 0x04 : 0x01;
    if (st.lastSent.power !== powerVcp) {
      try { await s.vcpSet(mid, 0x00, 0xD6, powerVcp); st.lastSent.power = powerVcp; }
      catch (e) { logger('warn', `[sACN] power set failed: ${e.message}`); }
    }

    // CH3 (index 2) — input select
    if (dmx[2] !== undefined && dmx[2] > 0) {
      const inputCodeVal = sacnInputCode(dmx[2]);
      if (inputCodeVal && st.lastSent.input !== inputCodeVal) {
        try { await s.vcpSet(mid, 0x00, 0x60, inputCodeVal); st.lastSent.input = inputCodeVal; }
        catch (e) { logger('warn', `[sACN] input set failed: ${e.message}`); }
      }
    }

    // CH4–9: brightness, contrast, backlight, sharpness, volume, colour temp
    const vcpMap = [
      { idx: 3, key: 'brightness', page: 0x00, code: 0x10 },
      { idx: 4, key: 'contrast',   page: 0x00, code: 0x12 },
      { idx: 5, key: 'backlight',  page: 0x00, code: 0x13 },
      { idx: 6, key: 'sharpness',  page: 0x00, code: 0x87 },
      { idx: 7, key: 'volume',     page: 0x00, code: 0x62 },
      { idx: 8, key: 'colorTemp',  page: 0x00, code: 0x14 },
    ];

    for (const { idx, key, page, code } of vcpMap) {
      if (dmx[idx] === undefined) continue;
      const scaled = Math.round(dmx[idx] / 255 * 100);
      if (st.lastSent[key] === scaled) continue;
      try { await s.vcpSet(mid, page, code, scaled); st.lastSent[key] = scaled; }
      catch (e) { logger('warn', `[sACN] VCP ${key} set failed: ${e.message}`); }
    }
  }

  /**
   * Handle folder fader channels (CH101–510).
   * 0 active → stop (switch to CH3 input)
   * 1 active → play that folder
   * 2+ active → hold (crossfade in progress)
   */
  async function handleFolders(mac, dmx) {
    const st = stateManager.getState(mac);
    if (st?.playing) { logger('debug', `[sACN] play in progress for ${mac}, skipping`); return; }

    const reg    = registryLoader();
    const device = reg.devices?.[mac];
    if (!device) return;

    const folders = device.sacnFolders ?? [];

    // Build bitmap of active folder faders
    const bitmap = computeFolderBitmap(folders, dmx);
    const bitCount = countBits(bitmap);
    logger('debug', `[sACN] folder bitmap: ${bitmap.toString(2).padStart(folders.length || 1, '0')} (${bitCount} active)`);

    // Handle playback based on bitmap state
    if (bitmap === 0) {
      // All faders off — stop playback
      logger('debug', `[sACN] all folder faders down → stop`);
      await stopPlayback(mac, dmx[2] ?? 0);
      return;
    }

    if ((bitmap & (bitmap - 1)) === 0) {
      // Exactly one bit set — single folder active
      const activeIdx = Math.log2(bitmap);
      const folder = folders[activeIdx];
      if (!folder) return;

      if (device.autoplay === folder.name) {
        logger('debug', `[sACN] folder "${folder.name}" already playing`);
        return;
      }

      if (!st?.showMode) {
        logger('warn', `[sACN] ${mac} folder fader active but CH1 (show mode) is OFF — scheduler may override`);
      }

      logger('info', `[sACN] ${mac} → folder "${folder.name}" (ch ${folder.channel})`);
      if (st) st.playing = true;

      try {
        // Extract actual folder name from folderPath (e.g. "/mnt/usb1/My Folder" → "My Folder")
        let actualFolderName = folder.folderPath;
        if (folder.folderPath.includes('/')) {
          actualFolderName = folder.folderPath.split('/').pop();
        }
        if (!actualFolderName) throw new Error(`Invalid folderPath: ${folder.folderPath}`);

        logger('debug', `[sACN] playFolder: display="${folder.name}" actual="${actualFolderName}" path="${folder.folderPath}"`);
        await playFolder(device.tvIp, actualFolderName, null, 1);

        // Re-load registry after play (may have been modified by scheduler/API during the ~8s play)
        const freshReg = registryLoader();
        freshReg.devices[mac].autoplay = folder.name;
        registrySaver(freshReg);
      } catch (e) {
        logger('warn', `[sACN] playFolder failed for ${mac}: ${e.message}`);
      } finally {
        if (st) st.playing = false;
      }
      return;
    }

    // 2+ bits set — crossfade hold
    const activeNames = [];
    for (let j = 0; j < folders.length; j++) {
      if (bitmap & (1 << j)) activeNames.push(folders[j].name);
    }
    logger('debug', `[sACN] ${bitCount} folders active (hold): ${activeNames.join(' + ')}`);
  }

  /**
   * Stop media player and switch TV to the input specified by CH3 value.
   */
  async function stopPlayback(mac, inputChannelValue) {
    const reg    = registryLoader();
    const device = reg.devices?.[mac];
    if (!device) return;

    // Clear autoplay on player
    try {
      const playerIP = await getPlayerIP(device.tvIp);
      await playerRequest(playerIP, '/cgi-bin/cgictrl?V=S,2A,2,0,0,%00,', 'POST');
    } catch { /* player may not be reachable — continue with TV input switch */ }

    // Switch TV input
    const inputCode = (inputChannelValue > 0) ? sacnInputCode(inputChannelValue) : SAFE_INPUT;
    if (!inputCode) return;

    try {
      const { session: s, monitorId: mid } = await getSacnSession(mac);
      await s.vcpSet(mid, 0x00, 0x60, inputCode);
      const freshReg = registryLoader();
      if (freshReg.devices?.[mac]) {
        freshReg.devices[mac].autoplay = null;
        registrySaver(freshReg);
      }
    } catch (e) { logger('warn', `[sACN] stop input switch failed: ${e.message}`); }
  }

  /**
   * Receive and dispatch a parsed sACN DMX frame for a device.
   * Diffs incoming values against stored state, debounces dispatch.
   */
  function receive(mac, incomingDmx) {
    const st = stateManager.getOrInitState(mac);
    st.lastPacket = Date.now();

    // Compute which channel groups changed
    let vcpChanged    = false;
    let folderChanged = false;
    const oldDmx = st.dmx;
    const newDmx = new Uint8Array(512);
    for (let i = 0; i < Math.min(incomingDmx.length, 512); i++) newDmx[i] = incomingDmx[i];

    // CH1 (index 0) — enable/show mode, no debounce
    if (newDmx[0] !== oldDmx[0]) handleEnable(mac, newDmx[0]);

    // CH2–9 (indices 1–8)
    for (let i = 1; i <= 8; i++) { if (newDmx[i] !== oldDmx[i]) { vcpChanged = true; break; } }

    // CH101–510: Use bitmap to detect state changes (not byte-by-byte)
    let newFolderBmp = 0;
    const reg = registryLoader();
    const folders = reg.devices?.[mac]?.sacnFolders ?? [];
    if (folders.length > 0) {
      newFolderBmp = computeFolderBitmap(folders, newDmx);
      if (newFolderBmp !== st.lastFolderBmp) {
        folderChanged = true;
        st.lastFolderBmp = newFolderBmp;
      }
    }

    // Store snapshot
    st.dmx = newDmx;

    if (vcpChanged) {
      clearTimeout(st.timers.vcp);
      const snap = newDmx.slice(); // capture for closure
      st.timers.vcp = setTimeout(
        () => handleVcp(mac, snap).catch(e => logger('warn', `[sACN] VCP err: ${e.message}`)),
        SACN_DISPATCH_DEBOUNCE
      );
    }

    if (folderChanged) {
      clearTimeout(st.timers.folder);
      const snap = newDmx.slice();
      st.timers.folder = setTimeout(
        () => handleFolders(mac, snap).catch(e => logger('warn', `[sACN] folder err: ${e.message}`)),
        SACN_FOLDER_DEBOUNCE
      );
    }

    // Broadcast live channel values to dashboard (rate-limited: only when something changed)
    if (vcpChanged || folderChanged || newDmx[0] !== oldDmx[0]) {
      broadcaster({ type: 'sacn-update', mac, channels: Array.from(newDmx) });
    }
  }

  return { handleEnable, handleVcp, handleFolders, stopPlayback, receive };
}
