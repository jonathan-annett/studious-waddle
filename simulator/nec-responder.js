/**
 * simulator/nec-responder.js
 *
 * Standalone NEC 7142 protocol TCP server for simulating NEC large-format displays.
 * Handles CTL (A→B), VCP-get (C→D), VCP-set (E→F) commands.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

import net from 'node:net';

// ─────────────────────────────────────────────────────────────────────────────
// Protocol constants
// ─────────────────────────────────────────────────────────────────────────────

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;
const CR  = 0x0D;

// ─────────────────────────────────────────────────────────────────────────────
// Codec helpers (self-contained — no import from nec-protocol.js)
// ─────────────────────────────────────────────────────────────────────────────

function toHex(value, digits) {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function fromHex(str) {
  return parseInt(str, 16);
}

/** XOR bytes from index 1 through end of buf. */
function computeBCC(buf) {
  let bcc = 0;
  for (let i = 1; i < buf.length; i++) bcc ^= buf[i];
  return bcc;
}

/**
 * Build a full NEC reply packet.
 * dest = controller (0x30), src = monitor address (0x40 + monitorId)
 */
function encodePacket(dest, msgType, msgBody, src) {
  const msgLen = msgBody.length;
  const lenStr = toHex(msgLen, 2);
  const header = Buffer.from([
    SOH, 0x30, dest, src,
    msgType.charCodeAt(0),
    lenStr.charCodeAt(0), lenStr.charCodeAt(1),
  ]);
  const forBCC = Buffer.concat([header, msgBody]);
  const bcc    = computeBCC(forBCC);
  return Buffer.concat([header, msgBody, Buffer.from([bcc, CR])]);
}

/**
 * Build a msgBody (STX … ETX) from string/Buffer parts.
 * String parts are treated as ASCII.
 */
function wrapMsg(...parts) {
  return Buffer.concat([
    Buffer.from([STX]),
    ...parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'ascii')),
    Buffer.from([ETX]),
  ]);
}

/**
 * Encode a string as NEC double-hex format.
 * Each char → 2 uppercase hex digits of its char code, plus a '00' null terminator.
 */
function encodeNecString(str) {
  let hex = '';
  for (const c of str) hex += toHex(c.charCodeAt(0), 2);
  hex += '00';
  return hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers  (return a msgBody Buffer)
// ─────────────────────────────────────────────────────────────────────────────

const POWER_CODES = { on: 0x0001, standby: 0x0002, suspend: 0x0003, off: 0x0004 };
const POWER_NAMES = Object.fromEntries(Object.entries(POWER_CODES).map(([k,v]) => [v, k]));

/** Handle CTL command ('A') → return reply msgBody for 'B' */
function handleCTL(inner, device, log) {

  // ── Power status read: '01D6' ──
  if (inner === '01D6') {
    const code = POWER_CODES[device.power] ?? POWER_CODES.on;
    return wrapMsg('00', '01D6', toHex(code, 4));
  }

  // ── Power control: 'C203D6' + mode(4) ──
  if (inner.startsWith('C203D6')) {
    const code = fromHex(inner.slice(6, 10));
    device.power = POWER_NAMES[code] ?? 'on';
    log(`power → ${device.power}`);
    return wrapMsg('00', inner.slice(0, 6), toHex(code, 4));
  }

  // ── Save current settings: '0C' ──
  if (inner === '0C') return wrapMsg('000C');

  // ── Timing report: '07' ──
  if (inner === '07') {
    // SS=01 (sync present), HFreq=12A9 (47.77kHz), VFreq=1770 (60.00Hz)
    return wrapMsg('4E', '01', '12A9', '1770');
  }

  // ── Model name read: 'C217' ──
  if (inner === 'C217') {
    return wrapMsg('C317', encodeNecString(device.model || 'P435-PC2'));
  }

  // ── Serial number read: 'C216' ──
  if (inner === 'C216') {
    return wrapMsg('C316', encodeNecString(device.serial || 'SIM00001'));
  }

  // ── Firmware version read: 'CA02' + type byte ──
  if (inner.startsWith('CA02')) {
    const fw = device.firmware || '00R3.400';
    // Parser fallback path: msgBody.slice(7, -1).toString('ascii')
    // Layout: STX[0] 'CB02'[1-4] '00'[5-6] rawFirmware[7...] ETX[-1]
    return Buffer.concat([
      Buffer.from([STX]),
      Buffer.from('CB02', 'ascii'),
      Buffer.from('00', 'ascii'),
      Buffer.from(fw, 'ascii'),
      Buffer.from([ETX]),
    ]);
  }

  // ── LAN MAC address read: 'C22A' + subtype ──
  if (inner.startsWith('C22A')) {
    const mac = (device.mac || 'AA:BB:CC:00:00:01')
      .split(':').map(x => x.toUpperCase()).join('');
    // Layout: C32A + rc(2) + subtype(2) + ipv(2) + mac(12)
    return wrapMsg('C32A', '00', '02', '04', mac);
  }

  // ── Self-diagnosis: 'B1' ──
  if (inner === 'B1') return wrapMsg('A1', '00'); // Normal

  // ── Emergency display: 'CA1F01' ──
  if (inner === 'CA1F01') {
    device.emergency = true;
    log('emergency display activated');
    return wrapMsg('CB1F', '01', '00');
  }

  // ── Emergency delete: 'CA1F00' ──
  if (inner === 'CA1F00') {
    device.emergency = false;
    log('emergency display deactivated');
    return wrapMsg('CB1F', '00', '00');
  }

  // ── Asset read: 'C00B' + offset(2) + len(2) ──
  if (inner.startsWith('C00B')) {
    const offset = fromHex(inner.slice(4, 6));
    const len    = fromHex(inner.slice(6, 8));
    const data   = Buffer.alloc(len, 0x20); // spaces
    return wrapMsg('00', 'C10B', toHex(offset, 2), data);
  }

  // ── Asset write: 'C00E' ──
  if (inner.startsWith('C00E')) return wrapMsg('00');

  // ── Date/time read: 'C211' ──
  if (inner === 'C211') {
    const n = new Date();
    return wrapMsg('00', 'C311',
      toHex(n.getFullYear() % 100, 2),
      toHex(n.getMonth() + 1, 2),
      toHex(n.getDate(), 2),
      toHex(n.getDay(), 2),
      toHex(n.getHours(), 2),
      toHex(n.getMinutes(), 2),
      '00',
    );
  }

  // ── Date/time write: 'C212' ──
  if (inner.startsWith('C212')) return wrapMsg('00');

  // ── Schedule read: 'C23D' + programNo ──
  if (inner.startsWith('C23D')) {
    const pn = inner.slice(4, 6);
    // Return "deleted" entry: hour=FF, minute=FF
    return wrapMsg('C33D', pn, '00', 'FF', 'FF', '00', '00', '00', '00');
  }

  // ── Schedule write: 'C23E' ──
  if (inner.startsWith('C23E')) return wrapMsg('C33E', '00');

  // ── Holiday commands: 'CA19' ──
  if (inner.startsWith('CA19')) return wrapMsg('CB19', '00', '00');

  // ── Weekend commands: 'CA1A' ──
  if (inner.startsWith('CA1A')) return wrapMsg('CB1A', '00', '00');

  // ── Unknown ──
  log(`[CTL] unknown command inner='${inner}'`);
  return wrapMsg('00');
}

/** Handle VCP get ('C') → return reply msgBody for 'D' */
function handleVCPGet(inner, device, log) {
  // inner = opPage(2) + opCode(2) — 4 ASCII hex chars
  const opPage = fromHex(inner.slice(0, 2));
  const opCode = fromHex(inner.slice(2, 4));

  let current, max;

  if (opPage === 0x00 && opCode === 0x60) {
    // Input source
    current = device.input ?? 0x11;
    max     = 0x00C8;
  } else {
    const key    = `${opPage}:${opCode}`;
    const stored = device.vcpValues?.[key];
    current = stored?.current ?? 50;
    max     = stored?.max     ?? 100;
  }

  log(`VCP get ${toHex(opPage,2)}/${toHex(opCode,2)} → ${toHex(current,4)}`);

  // Reply layout: result(2) opPage(2) opCode(2) type(2) max(4) current(4)
  return wrapMsg(
    '00',
    toHex(opPage, 2),
    toHex(opCode, 2),
    '00',              // type: set_parameter
    toHex(max, 4),
    toHex(current, 4),
  );
}

/** Handle VCP set ('E') → return reply msgBody for 'F' */
function handleVCPSet(inner, device, log) {
  // inner = opPage(2) + opCode(2) + value(4) — 8 ASCII hex chars
  const opPage = fromHex(inner.slice(0, 2));
  const opCode = fromHex(inner.slice(2, 4));
  const value  = fromHex(inner.slice(4, 8));

  if (opPage === 0x00 && opCode === 0x60) {
    device.input = value;
    log(`input → 0x${toHex(value, 2)}`);
  } else {
    const key = `${opPage}:${opCode}`;
    if (!device.vcpValues) device.vcpValues = {};
    device.vcpValues[key] = {
      current: value,
      max: device.vcpValues[key]?.max ?? 100,
    };
    log(`VCP set ${toHex(opPage,2)}/${toHex(opCode,2)} = ${toHex(value,4)}`);
  }

  const key = `${opPage}:${opCode}`;
  const max = (opPage === 0x00 && opCode === 0x60) ? 0x00C8 : (device.vcpValues?.[key]?.max ?? 100);

  return wrapMsg(
    '00',
    toHex(opPage, 2),
    toHex(opCode, 2),
    '00',
    toHex(max, 4),
    toHex(value, 4),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame accumulator / parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to extract one complete NEC frame from buf.
 * Returns { msgType, dest, src, inner, frameLen } on success.
 * Returns null if not enough data yet.
 * Returns { error, consumeBytes } on a framing error.
 */
function extractFrame(buf) {
  if (buf.length < 9) return null;
  if (buf[0] !== SOH)  return { error: 'no SOH', consumeBytes: 1 };

  // Bytes 5-6 are the declared message length (2 ASCII hex chars)
  const lenHi = buf[5], lenLo = buf[6];
  if (!isAsciiHexChar(lenHi) || !isAsciiHexChar(lenLo)) {
    return { error: 'bad length field', consumeBytes: 1 };
  }
  const declaredLen = parseInt(String.fromCharCode(lenHi, lenLo), 16);
  const fullLen     = 7 + declaredLen + 2; // header(7) + body + BCC(1) + CR(1)

  if (buf.length < fullLen) return null; // wait for more data

  const frame = buf.slice(0, fullLen);

  // Validate BCC
  const forBCC = frame.slice(0, fullLen - 2);
  let bcc = 0;
  for (let i = 1; i < forBCC.length; i++) bcc ^= forBCC[i];
  if (bcc !== frame[fullLen - 2]) {
    return { error: `BCC mismatch (got 0x${frame[fullLen-2].toString(16)}, expected 0x${bcc.toString(16)})`, consumeBytes: fullLen };
  }

  const msgType = String.fromCharCode(frame[4]);
  const dest    = frame[2];
  const src     = frame[3];
  const msgBody = frame.slice(7, fullLen - 2);
  const inner   = msgBody.slice(1, -1).toString('ascii'); // between STX and ETX

  return { msgType, dest, src, inner, msgBody, frameLen: fullLen };
}

function isAsciiHexChar(b) {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: createNecServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and start a NEC 7142 TCP server for one virtual device.
 *
 * @param {object} device  - shared device state object (mutated on VCP/power changes)
 * @param {object} opts
 * @param {number}  opts.port    - TCP port to bind (default 7142)
 * @param {Function} opts.onLog  - log callback (msg: string) => void
 * @returns {net.Server}
 */
export function createNecServer(device, { port = 7142, onLog } = {}) {
  const log = (msg) => onLog?.(`[NEC ${device.name || device.id}] ${msg}`);

  const server = net.createServer((socket) => {
    log(`client connected from ${socket.remoteAddress}:${socket.remotePort}`);
    let rxBuf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);

      while (rxBuf.length >= 9) {
        // Re-sync on SOH
        if (rxBuf[0] !== SOH) {
          const next = rxBuf.indexOf(SOH, 1);
          rxBuf = next !== -1 ? rxBuf.slice(next) : Buffer.alloc(0);
          continue;
        }

        const parsed = extractFrame(rxBuf);
        if (!parsed) break; // wait for more bytes

        if (parsed.error) {
          log(`frame error: ${parsed.error}`);
          rxBuf = rxBuf.slice(parsed.consumeBytes || 1);
          continue;
        }

        rxBuf = rxBuf.slice(parsed.frameLen);

        const { msgType, dest, src, inner } = parsed;

        // Monitor ID from dest byte (0x41 = monitor 1, 0x2A = broadcast)
        const monitorId = dest === 0x2A ? 0 : dest - 0x40;
        if (monitorId !== 0 && monitorId !== 1) {
          log(`packet for monitor ${monitorId}, ignoring`);
          continue;
        }

        // Reply: src=monitorAddr, dest=controller(0x30)
        const replyDest = src;  // back to controller
        const replySrc  = dest; // this monitor's address

        let replyType, replyBody;

        try {
          if (msgType === 'A') {
            replyType = 'B';
            replyBody = handleCTL(inner, device, log);
          } else if (msgType === 'C') {
            replyType = 'D';
            replyBody = handleVCPGet(inner, device, log);
          } else if (msgType === 'E') {
            replyType = 'F';
            replyBody = handleVCPSet(inner, device, log);
          } else {
            log(`unknown message type '${msgType}'`);
            continue;
          }
        } catch (err) {
          log(`handler error: ${err.message}`);
          continue;
        }

        // Small realistic delay before reply (2–10 ms)
        const delay = device.replyDelayMs ?? 5;
        setTimeout(() => {
          if (!socket.destroyed) {
            socket.write(encodePacket(replyDest, replyType, replyBody, replySrc));
          }
        }, delay);
      }
    });

    socket.on('close', () => log('client disconnected'));
    socket.on('error', (err) => log(`socket error: ${err.message}`));
  });

  server.listen(port, device.tvIP, () => {
    log(`NEC TCP server listening on ${device.tvIP}:${port}`);
  });

  server.on('error', (err) => log(`NEC server error on ${device.tvIP}:${port} — ${err.message}`));

  return server;
}
