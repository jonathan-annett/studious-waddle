/**
 * nec-protocol.js
 *
 * NEC External Control Protocol implementation (Rev.1.6 G4)
 * Pure Node.js ESM module — zero third-party dependencies.
 *
 * Supports:
 *  - TCP transport (port 7142) via node:net
 *  - Serial transport (RS-232C 9600 8N1) via /dev/tty* raw mode + node:fs
 *  - Full packet framing, BCC checksum, ASCII-hex codec
 *  - VCP get / set / set-and-persist
 *  - CTL: save settings, timing report, power status, power control
 *  - CTL: asset read/write (64-byte area, 32-byte chunks)
 *  - CTL: date-time read/write
 *  - CTL: schedule read/write
 *  - CTL: holiday read/write
 *  - CTL: weekend read/write
 *  - Reply-wait enforcement, per-command cooldowns, LAN reconnect
 */

import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SOH = 0x01;
export const STX = 0x02;
export const ETX = 0x03;
export const CR  = 0x0D;

export const DEFAULT_TCP_PORT   = 7142;
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Cooldown periods (ms) required *after* reply is received. */
export const COOLDOWNS = {
  power:   15_000,
  input:   10_000,
  autoSetup: 10_000,
  factory: 10_000,
};

/** Monitor ID → destination address byte (ASCII). ID 1 → 0x41 ('A'), ID 100 → 0xA4. */
export function monitorIdToDestByte(id) {
  if (id === 0)   return 0x2A; // broadcast '*'
  if (id < 1 || id > 100) throw new RangeError(`Monitor ID must be 1–100 (or 0 for broadcast), got ${id}`);
  return 0x40 + id;            // 1 → 0x41 = 'A', 2 → 0x42 = 'B' …
}

// ─────────────────────────────────────────────────────────────────────────────
// Codec primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Encode integer as upper-case ASCII hex, padded to `digits` characters. Returns Buffer. */
export function toAsciiHex(value, digits) {
  const s = value.toString(16).toUpperCase().padStart(digits, '0');
  if (s.length !== digits) throw new RangeError(`Value ${value} overflows ${digits} hex digits`);
  return Buffer.from(s, 'ascii');
}

/** Decode an ASCII-hex Buffer/slice to an integer. Throws on invalid chars. */
export function fromAsciiHex(buf, offset = 0, length = buf.length - offset) {
  const slice = buf.slice(offset, offset + length);
  for (const b of slice) {
    if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66))) {
      throw new TypeError(`Non-hex byte 0x${b.toString(16)} in ASCII-hex field`);
    }
  }
  return parseInt(slice.toString('ascii'), 16);
}

/**
 * Compute BCC: XOR of all bytes from Reserved (index 1) through ETX inclusive.
 * `packetNoSuffix` is the buffer from SOH through ETX (does NOT include BCC or CR).
 */
export function computeBCC(packetNoSuffix) {
  let bcc = 0;
  for (let i = 1; i < packetNoSuffix.length; i++) bcc ^= packetNoSuffix[i];
  return bcc;
}

/**
 * Encode a full NEC packet.
 * @param {number}  dest       - destination address byte (use monitorIdToDestByte)
 * @param {string}  msgType    - single ASCII char: 'A'..'F'
 * @param {Buffer}  msgBody    - bytes from STX through ETX inclusive
 * @param {number}  [src=0x30] - source address byte (default '0' for controller)
 */
export function encodePacket(dest, msgType, msgBody, src = 0x30) {
  if (msgBody[0] !== STX || msgBody[msgBody.length - 1] !== ETX) {
    throw new Error('msgBody must start with STX (0x02) and end with ETX (0x03)');
  }
  const msgLen   = msgBody.length;            // STX…ETX inclusive
  const lenBytes = toAsciiHex(msgLen, 2);     // 2 ASCII hex digits
  const typeCode = msgType.charCodeAt(0);

  // Header: SOH '0' dest src type lenHi lenLo
  const header = Buffer.from([SOH, 0x30, dest, src, typeCode, lenBytes[0], lenBytes[1]]);

  // BCC: XOR from Reserved (header[1]) through ETX
  const forBCC = Buffer.concat([header, msgBody]);
  const bcc    = computeBCC(forBCC);

  return Buffer.concat([header, msgBody, Buffer.from([bcc, CR])]);
}

/**
 * Parse and validate a raw NEC packet.
 * @param {Buffer} raw - the complete packet including SOH and CR
 * @returns {{ header, msgType, msgBody, bcc }} - validated packet fields
 * @throws {Error} on any framing / checksum violation
 */
export function parsePacket(raw) {
  if (raw.length < 11) throw new Error(`Packet too short (${raw.length} bytes)`);
  if (raw[0]  !== SOH)  throw new Error(`Missing SOH, got 0x${raw[0].toString(16)}`);
  if (raw[raw.length - 1] !== CR) throw new Error('Missing CR at end of packet');

  const reserved = raw[1];
  if (reserved !== 0x30) throw new Error(`Reserved byte must be '0' (0x30), got 0x${reserved.toString(16)}`);

  const dest    = raw[2];
  const src     = raw[3];
  const msgType = String.fromCharCode(raw[4]);
  const declaredLen = fromAsciiHex(raw, 5, 2);  // 2 ASCII hex chars

  // Message block starts at index 7
  const msgStart = 7;
  const msgEnd   = msgStart + declaredLen;       // exclusive

  if (msgEnd + 2 > raw.length) {
    throw new Error(`Declared message length (${declaredLen}) exceeds packet size`);
  }

  const msgBody = raw.slice(msgStart, msgEnd);

  if (msgBody[0] !== STX) throw new Error('Message body must start with STX');
  if (msgBody[msgBody.length - 1] !== ETX) throw new Error('Message body must end with ETX');

  // BCC at msgEnd, CR at msgEnd+1
  const receivedBCC = raw[msgEnd];
  const forBCC      = raw.slice(0, msgEnd);
  const expectedBCC = computeBCC(forBCC);
  if (receivedBCC !== expectedBCC) {
    throw new Error(`BCC mismatch: expected 0x${expectedBCC.toString(16)}, got 0x${receivedBCC.toString(16)}`);
  }

  return { header: { reserved, dest, src, msgType, msgLen: declaredLen }, msgType, msgBody, bcc: receivedBCC };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders  (return msgBody = STX…ETX Buffer)
// ─────────────────────────────────────────────────────────────────────────────

function wrapMessage(...parts) {
  return Buffer.concat([Buffer.from([STX]), ...parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)), Buffer.from([ETX])]);
}

export const Messages = {
  // ── VCP ─────────────────────────────────────────────────────────────────
  vcpGet(opPage, opCode) {
    return wrapMessage(toAsciiHex(opPage, 2), toAsciiHex(opCode, 2));
  },
  vcpSet(opPage, opCode, value) {
    return wrapMessage(toAsciiHex(opPage, 2), toAsciiHex(opCode, 2), toAsciiHex(value, 4));
  },

  // ── CTL ─────────────────────────────────────────────────────────────────
  saveCurrentSettings() {
    return wrapMessage(Buffer.from('0C', 'ascii'));
  },
  getTimingReport() {
    return wrapMessage(Buffer.from('07', 'ascii'));
  },
  powerStatusRead() {
    return wrapMessage(Buffer.from('01D6', 'ascii'));
  },
  powerControl(mode) {
    // mode: 0x0001 = on, 0x0004 = off
    if (mode !== 0x0001 && mode !== 0x0004) throw new Error('powerControl: only 0x0001 (on) or 0x0004 (off) are valid');
    return wrapMessage(Buffer.from('C203D6', 'ascii'), toAsciiHex(mode, 4));
  },
  assetRead(offset, length) {
    if (length > 0x20) throw new RangeError('Asset read length must be ≤ 32 (0x20)');
    return wrapMessage(Buffer.from('C00B', 'ascii'), toAsciiHex(offset, 2), toAsciiHex(length, 2));
  },
  assetWrite(offset, asciiData) {
    if (asciiData.length > 0x20) throw new RangeError('Asset write data must be ≤ 32 bytes');
    for (const b of asciiData) {
      if (b < 0x20 || b > 0x7E) throw new TypeError('Asset data must be printable ASCII');
    }
    return wrapMessage(Buffer.from('C00E', 'ascii'), toAsciiHex(offset, 2), asciiData);
  },
  dateTimeRead() {
    return wrapMessage(Buffer.from('C211', 'ascii'));
  },
  dateTimeWrite(dt) {
    // dt: { year, month, day, weekday, hour, minute, dst }
    // All fields encoded as 2 ASCII hex digits
    const validate = (v, min, max, name) => {
      if (v < min || v > max) throw new RangeError(`${name} must be ${min}–${max}, got ${v}`);
    };
    validate(dt.year,    0,   99, 'year');
    validate(dt.month,   1,   12, 'month');
    validate(dt.day,     1,   31, 'day');
    validate(dt.weekday, 0,    6, 'weekday');
    validate(dt.hour,    0,   23, 'hour');
    validate(dt.minute,  0,   59, 'minute');
    const ds = dt.dst ? 0x01 : 0x00;
    return wrapMessage(
      Buffer.from('C212', 'ascii'),
      toAsciiHex(dt.year,    2),
      toAsciiHex(dt.month,   2),
      toAsciiHex(dt.day,     2),
      toAsciiHex(dt.weekday, 2),
      toAsciiHex(dt.hour,    2),
      toAsciiHex(dt.minute,  2),
      toAsciiHex(ds,         2),
    );
  },
  scheduleRead(programNo) {
    return wrapMessage(Buffer.from('C23D', 'ascii'), toAsciiHex(programNo, 2));
  },
  scheduleWrite(entry) {
    // entry: { programNo, event, hour, minute, input, weekMask, typeMask, pictureMode }
    // hour/minute = 0xFF means "delete" sentinel
    return wrapMessage(
      Buffer.from('C23E', 'ascii'),
      toAsciiHex(entry.programNo,   2),
      toAsciiHex(entry.event,       2),
      toAsciiHex(entry.hour,        2),
      toAsciiHex(entry.minute,      2),
      toAsciiHex(entry.input,       2),
      toAsciiHex(entry.weekMask,    2),
      toAsciiHex(entry.typeMask,    2),
      toAsciiHex(entry.pictureMode, 2),
    );
  },
  holidayRead(programNo) {
    return wrapMessage(Buffer.from('CA19', 'ascii'), toAsciiHex(programNo, 2), Buffer.from('00', 'ascii'));
  },
  holidayWrite(entry) {
    // entry: { programNo, type, endDay, weekNo, status }
    return wrapMessage(
      Buffer.from('CA19', 'ascii'),
      Buffer.from('01', 'ascii'),
      toAsciiHex(entry.programNo, 2),
      toAsciiHex(entry.type,      2),
      toAsciiHex(entry.endDay,    2),
      toAsciiHex(entry.weekNo,    2),
    );
  },
  weekendRead() {
    return wrapMessage(Buffer.from('CA1A', 'ascii'), Buffer.from('00', 'ascii'));
  },
  weekendWrite(weekMask) {
    // weekMask: 7-bit value, bit0=Mon…bit6=Sun
    if (weekMask < 0 || weekMask > 0x7F) throw new RangeError('weekMask must be 0–0x7F');
    return wrapMessage(Buffer.from('CA1A', 'ascii'), Buffer.from('01', 'ascii'), toAsciiHex(weekMask, 2));
  },

  /** Activate Emergency Contents playback (CA1F + '01'). */
  emergencyDisplay() {
    return wrapMessage(Buffer.from('CA1F', 'ascii'), Buffer.from('01', 'ascii'));
  },

  /** Stop Emergency Contents playback (CA1F + '00'). */
  emergencyDelete() {
    return wrapMessage(Buffer.from('CA1F', 'ascii'), Buffer.from('00', 'ascii'));
  },

  /** Self-diagnosis status read (command 'B1'). */
  selfDiagnosis() {
    return wrapMessage(Buffer.from('B1', 'ascii'));
  },

  /** Serial number read (command C216). */
  serialRead() {
    return wrapMessage(Buffer.from('C216', 'ascii'));
  },

  /** Model name read (command C217). */
  modelNameRead() {
    return wrapMessage(Buffer.from('C217', 'ascii'));
  },

  /**
   * Firmware version read (command CA02 + type byte 00).
   * TY=00h → main firmware.
   */
  firmwareVersionRead() {
    return wrapMessage(Buffer.from('CA02', 'ascii'), Buffer.from('00', 'ascii'));
  },

  /** LAN MAC address read (command C22A + subtype 02). */
  lanMacRead() {
    return wrapMessage(Buffer.from('C22A', 'ascii'), Buffer.from('02', 'ascii'));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Reply parsers
// ─────────────────────────────────────────────────────────────────────────────

export const Parsers = {
  vcpGetReply(msgBody) {
    // Layout: STX(1) result(2) opPage(2) opCode(2) type(2) max(4) current(4) ETX(1) = 18 bytes
    if (msgBody.length < 18) throw new NecError('PARSE_ERROR', `VCP get reply too short (${msgBody.length})`);
    const d = msgBody;
    const result  = fromAsciiHex(d, 1, 2);
    if (result !== 0) throw new NecError('VCP_UNSUPPORTED', `VCP get result code: ${result}`);
    return {
      result,
      opPage:   fromAsciiHex(d, 3, 2),
      opCode:   fromAsciiHex(d, 5, 2),
      type:     fromAsciiHex(d, 7, 2) === 0 ? 'set_parameter' : 'momentary',
      max:      fromAsciiHex(d, 9, 4),
      current:  fromAsciiHex(d, 13, 4),
    };
  },
  vcpSetReply(msgBody) {
    // Layout: STX(1) result(2) opPage(2) opCode(2) type(2) max(4) requested(4) ETX(1) = 18 bytes
    if (msgBody.length < 18) throw new NecError('PARSE_ERROR', `VCP set reply too short (${msgBody.length})`);
    const d = msgBody;
    const result = fromAsciiHex(d, 1, 2);
    if (result !== 0) throw new NecError('VCP_SET_FAILED', `VCP set result code: ${result}`);
    return {
      result,
      opPage:     fromAsciiHex(d, 3, 2),
      opCode:     fromAsciiHex(d, 5, 2),
      type:       fromAsciiHex(d, 7, 2) === 0 ? 'set_parameter' : 'momentary',
      max:        fromAsciiHex(d, 9, 4),
      requested:  fromAsciiHex(d, 13, 4),
    };
  },
  saveSettingsReply(msgBody) {
    // STX '0''0''0''C' ETX
    const inner = msgBody.slice(1, -1).toString('ascii');
    if (!inner.startsWith('00')) throw new NecError('SAVE_FAILED', `Unexpected save reply: ${inner}`);
    return { ok: true };
  },
  timingReportReply(msgBody) {
    // Layout: STX(1) '4E'(2) SS(2) HFreq(4) VFreq(4) ETX(1) = 14 bytes minimum
    // SS = 2 ASCII hex digits (1 byte value)
    // HFreq = 4 ASCII hex digits, unit = 0.01 kHz  (e.g. 12A9h = 4777 → 47.77 kHz)
    // VFreq = 4 ASCII hex digits, unit = 0.01 Hz
    if (msgBody.length < 14) throw new Error(`Timing report reply too short (${msgBody.length})`);
    const d = msgBody;
    const cmd = d.slice(1, 3).toString('ascii');
    if (cmd !== '4E') throw new NecError('UNEXPECTED_REPLY', `Expected timing reply '4E', got '${cmd}'`);
    const ss    = fromAsciiHex(d, 3, 2);   // offset 3, 2 chars
    const hFreq = fromAsciiHex(d, 5, 4);   // offset 5, 4 chars
    const vFreq = fromAsciiHex(d, 9, 4);   // offset 9, 4 chars
    return {
      statusBits:  ss,
      syncPresent: !!(ss & 0x01),
      hFreqKHz:    hFreq / 100,
      vFreqHz:     vFreq / 100,
    };
  },
  powerStatusReply(msgBody) {
    // STX result(2)? opPage+opCode '01''D''6' ... mode(4) ... ETX
    // Find MODE field: last 4 ascii hex digits before ETX
    const inner = msgBody.slice(1, -1).toString('ascii');
    // The mode is at a fixed position — parse from spec layout
    // CTL B reply for 01D6: STX '00' '01' 'D''6' MODE(4) ETX
    if (inner.length < 10) throw new Error('Power status reply too short');
    const modeStr = inner.slice(6, 10);
    const mode = parseInt(modeStr, 16);
    const MODES = { 0x0001: 'on', 0x0002: 'standby', 0x0003: 'suspend', 0x0004: 'off' };
    return { mode, modeStr: MODES[mode] ?? `unknown(${modeStr})` };
  },
  powerControlReply(msgBody) {
    const inner = msgBody.slice(1, -1).toString('ascii');
    return { ok: true, raw: inner };
  },
  assetReadReply(msgBody) {
    // STX '00' 'C''1''0''B' offset(2) data... ETX
    if (msgBody.length < 8) throw new Error('Asset read reply too short');
    const d = msgBody;
    const result = fromAsciiHex(d, 1, 2);
    if (result !== 0) throw new NecError('ASSET_READ_FAILED', `Asset read result: ${result}`);
    const cmd = d.slice(3, 7).toString('ascii');
    if (cmd !== 'C10B') throw new NecError('UNEXPECTED_REPLY', `Expected C10B, got ${cmd}`);
    const offset = fromAsciiHex(d, 7, 2);
    const data   = d.slice(9, -1);  // raw ASCII data bytes before ETX
    return { offset, data };
  },
  assetWriteReply(msgBody) {
    const result = fromAsciiHex(msgBody, 1, 2);
    if (result !== 0) throw new NecError('ASSET_WRITE_FAILED', `Asset write result: ${result}`);
    return { ok: true };
  },
  dateTimeReadReply(msgBody) {
    // STX '00' 'C''3''1''1' year(2) month(2) day(2) weekday(2) hour(2) minute(2) ds(2) ETX
    if (msgBody.length < 21) throw new Error('DateTime read reply too short');
    const d = msgBody;
    return {
      year:    fromAsciiHex(d, 7,  2),
      month:   fromAsciiHex(d, 9,  2),
      day:     fromAsciiHex(d, 11, 2),
      weekday: fromAsciiHex(d, 13, 2),
      hour:    fromAsciiHex(d, 15, 2),
      minute:  fromAsciiHex(d, 17, 2),
      dst:     fromAsciiHex(d, 19, 2) === 0x01,
    };
  },
  dateTimeWriteReply(msgBody) {
    const result = fromAsciiHex(msgBody, 1, 2);
    if (result !== 0) throw new NecError('DATETIME_WRITE_FAILED', `DateTime write status: ${result}`);
    return { ok: true };
  },
  scheduleReadReply(msgBody) {
    if (msgBody.length < 21) throw new Error('Schedule read reply too short');
    const d = msgBody;
    const cmd = d.slice(1, 5).toString('ascii');
    if (cmd !== 'C33D') throw new NecError('UNEXPECTED_REPLY', `Expected C33D, got ${cmd}`);
    return {
      programNo:   fromAsciiHex(d, 5,  2),
      event:       fromAsciiHex(d, 7,  2),
      hour:        fromAsciiHex(d, 9,  2),
      minute:      fromAsciiHex(d, 11, 2),
      input:       fromAsciiHex(d, 13, 2),
      weekMask:    fromAsciiHex(d, 15, 2),
      typeMask:    fromAsciiHex(d, 17, 2),
      pictureMode: fromAsciiHex(d, 19, 2),
    };
  },
  scheduleWriteReply(msgBody) {
    // Tolerant: accept C33E or C322 (spec inconsistency)
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'C33E' && cmd !== 'C322') {
      throw new NecError('UNEXPECTED_REPLY', `Unexpected schedule write reply cmd: ${cmd}`);
    }
    const result = fromAsciiHex(msgBody, 5, 2);
    return { ok: result === 0, result, cmd };
  },
  holidayReply(msgBody) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'CB19') throw new NecError('UNEXPECTED_REPLY', `Expected CB19, got ${cmd}`);
    const mode      = fromAsciiHex(msgBody, 5, 2);
    const programNo = fromAsciiHex(msgBody, 7, 2);
    if (msgBody.length < 15) return { mode, programNo };
    return {
      mode, programNo,
      type:   fromAsciiHex(msgBody, 9,  2),
      endDay: fromAsciiHex(msgBody, 11, 2),
      weekNo: fromAsciiHex(msgBody, 13, 2),
    };
  },
  weekendReply(msgBody) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'CB1A') throw new NecError('UNEXPECTED_REPLY', `Expected CB1A, got ${cmd}`);
    const mode     = fromAsciiHex(msgBody, 5, 2);
    const weekMask = fromAsciiHex(msgBody, 7, 2);
    // Decode bitmask: bit0=Mon … bit6=Sun
    const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
    const days = DAYS.filter((_, i) => weekMask & (1 << i));
    return { mode, weekMask, days };
  },

  /**
   * Reply to emergencyDisplay or emergencyDelete.
   * Reply body: STX CB1F mode(2) status(2) ETX
   *   mode 01 = display, 00 = delete
   *   status 00 = no error, 01 = error
   */
  emergencyReply(msgBody) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'CB1F') throw new NecError('UNEXPECTED_REPLY', `Expected CB1F, got ${cmd}`);
    const mode   = fromAsciiHex(msgBody, 5, 2); // 0x01=display, 0x00=delete
    const status = fromAsciiHex(msgBody, 7, 2); // 0x00=ok, 0x01=error
    return { mode, ok: status === 0, status };
  },

  /**
   * Self-diagnosis reply.
   * Reply body: STX 'A1' [ST(0) ST(1) ...] ETX
   * Each ST is 2 ascii-hex chars representing one status byte.
   * 0x00 = Normal. Other codes indicate specific faults.
   */
  selfDiagnosisReply(msgBody) {
    const cmd = msgBody.slice(1, 3).toString('ascii');
    if (cmd !== 'A1') throw new NecError('UNEXPECTED_REPLY', `Expected A1, got ${cmd}`);
    const STATUS_CODES = {
      0x00: 'Normal',
      0x70: 'Standby-power +3.3V abnormality',
      0x71: 'Standby-power +5V abnormality',
      0x72: 'Panel-power +12V abnormality',
      0x78: 'Inverter/Option slot2 +24V abnormality',
      0x80: 'Cooling fan-1 abnormality',
      0x81: 'Cooling fan-2 abnormality',
      0x82: 'Cooling fan-3 abnormality',
      0x91: 'LED backlight abnormality',
      0xA0: 'Temperature abnormality — shutdown',
      0xA1: 'Temperature abnormality — half brightness',
      0xA2: 'Temperature sensor reached user threshold',
      0xB0: 'No signal',
      0xD0: 'Proof of Play buffer reduction',
      0xE0: 'System error',
    };
    const codes = [];
    for (let i = 3; i < msgBody.length - 1; i += 2) {
      const code = fromAsciiHex(msgBody, i, 2);
      codes.push({ code, description: STATUS_CODES[code] ?? `Unknown (0x${code.toString(16).toUpperCase()})` });
    }
    const normal = codes.length === 0 || (codes.length === 1 && codes[0].code === 0x00);
    return { normal, codes };
  },

  /**
   * Decode a double-encoded string from the monitor (used for serial / model name).
   * The NEC protocol sends the string bytes themselves ascii-hex encoded inside
   * the already ascii-hex framed message.  Each pair of ascii-hex chars in
   * the payload decodes to one ASCII character of the string.
   */
  _decodeString(msgBody, cmdTag) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== cmdTag) throw new NecError('UNEXPECTED_REPLY', `Expected ${cmdTag}, got ${cmd}`);
    const payload = msgBody.slice(5, msgBody.length - 1);
    const chars = [];
    for (let i = 0; i + 1 < payload.length; i += 2) {
      chars.push(String.fromCharCode(fromAsciiHex(payload, i, 2)));
    }
    return chars.join('').replace(/\x00/g, '').trim();
  },

  serialReply(msgBody)    { return { serial:    this._decodeString(msgBody, 'C316') }; },
  modelNameReply(msgBody) { return { modelName: this._decodeString(msgBody, 'C317') }; },

  /**
   * Firmware version reply.
   * Body: STX CB02 ST TY MV PP BV1 BV2 BV3 BR1 BR2 ETX
   * Each field is one byte ascii-hex encoded (2 chars each).
   * MV = major, BV1/2/3 = minor digits, BR1/2 = branch letters.
   * Version string formatted as: "MV.BV1BV2BV3BR1BR2" e.g. "1.023AB"
   */
  firmwareVersionReply(msgBody) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'CB02') throw new NecError('UNEXPECTED_REPLY', `Expected CB02, got ${cmd}`);
    const status = fromAsciiHex(msgBody, 5, 2);
    if (status !== 0) return { ok: false, status };
    try {
      const mv  = fromAsciiHex(msgBody, 9,  2);
      const bv1 = fromAsciiHex(msgBody, 13, 2);
      const bv2 = fromAsciiHex(msgBody, 15, 2);
      const bv3 = fromAsciiHex(msgBody, 17, 2);
      const br1 = fromAsciiHex(msgBody, 19, 2);
      const br2 = fromAsciiHex(msgBody, 21, 2);
      const brStr = [br1, br2]
        .filter(b => b >= 0x41 && b <= 0x5A)
        .map(b => String.fromCharCode(b)).join('');
      const version = `${mv}.${bv1}${bv2}${bv3}${brStr}`;
      return { ok: true, version, mv, bv1, bv2, bv3, br1: String.fromCharCode(br1), br2: String.fromCharCode(br2) };
    } catch {
      // Firmware uses a non-standard version encoding (non-hex chars in version fields).
      // Fall back to returning the raw ASCII payload after the status bytes.
      const version = msgBody.slice(7, -1).toString('ascii').replace(/\x00/g, '').trim();
      return { ok: true, version, raw: true };
    }
  },

  /**
   * LAN MAC address reply.
   * Body: STX C32A RC '02' IPV MAC(0)...MAC(5) ETX
   * MAC bytes are each 2-char ascii-hex encoded.
   */
  lanMacReply(msgBody) {
    const cmd = msgBody.slice(1, 5).toString('ascii');
    if (cmd !== 'C32A') throw new NecError('UNEXPECTED_REPLY', `Expected C32A, got ${cmd}`);
    const rc = fromAsciiHex(msgBody, 5, 2);
    if (rc === 0xFF) return { ok: false };
    const ipv = fromAsciiHex(msgBody, 9, 2); // 0x04=IPv4, 0x06=IPv6
    const macBytes = [];
    for (let i = 11; i < msgBody.length - 1; i += 2) {
      macBytes.push(fromAsciiHex(msgBody, i, 2));
    }
    const mac = macBytes.map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(':');
    return { ok: true, mac, ipv: ipv === 0x04 ? 'IPv4' : 'IPv6', rawBytes: macBytes };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Custom error class
// ─────────────────────────────────────────────────────────────────────────────

export class NecError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NecError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport base class
// ─────────────────────────────────────────────────────────────────────────────

class Transport extends EventEmitter {
  constructor() {
    super();
    this._rxBuf  = Buffer.alloc(0);
    this._waiters = [];    // pending { resolve, reject, timer }
  }

  /** Called by subclass when bytes arrive. */
  _onData(chunk) {
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);
    // Use length-based framing: read the declared message length from the
    // packet header (bytes 5–6, ASCII-hex) to know the exact packet size.
    // CR-scanning alone is unreliable because the BCC checksum byte can
    // legitimately equal 0x0D, causing premature frame detection.
    while (true) {
      // Need at least 7 bytes to parse the header and declared length
      if (this._rxBuf.length < 7) break;

      if (this._rxBuf[0] !== SOH) {
        // Out of sync — discard bytes until we find SOH
        const next = this._rxBuf.indexOf(SOH, 1);
        this._rxBuf = next !== -1 ? this._rxBuf.slice(next) : Buffer.alloc(0);
        continue;
      }

      // Bytes 5–6 are the declared message body length (2 ASCII-hex chars)
      let declaredLen;
      try {
        declaredLen = fromAsciiHex(this._rxBuf, 5, 2);
      } catch {
        // Malformed length field — discard SOH and attempt resync
        this._rxBuf = this._rxBuf.slice(1);
        continue;
      }

      // Full packet = 7 (header) + declaredLen (body) + 1 (BCC) + 1 (CR)
      const fullLen = 7 + declaredLen + 2;
      if (this._rxBuf.length < fullLen) break; // wait for more data

      const frame = this._rxBuf.slice(0, fullLen);
      this._rxBuf = this._rxBuf.slice(fullLen);

      const waiter = this._waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        try {
          waiter.resolve(parsePacket(frame));
        } catch (err) {
          waiter.reject(err);
        }
      } else {
        this.emit('unsolicited', frame);
      }
    }
  }

  /** Called by subclass on connection error / close. */
  _onError(err) {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.reject(err); }
    this.emit('error', err);
  }

  /** Write bytes — implemented by subclass. */
  async write(buf) { throw new Error('Not implemented'); }

  /**
   * Send a packet and wait for one reply frame.
   * @param {Buffer} packet
   * @param {number} timeoutMs
   * @returns {Promise<object>} parsed reply packet
   */
  sendAndReceive(packet, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(new NecError('TIMEOUT', `No reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this._waiters.push({ resolve, reject, timer });
      this.write(packet).catch(err => {
        clearTimeout(timer);
        const idx = this._waiters.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this._waiters.splice(idx, 1);
        reject(err);
      });
    });
  }

  async close() { /* overridden */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// TCP Transport
// ─────────────────────────────────────────────────────────────────────────────

export class TcpTransport extends Transport {
  /** @param {net.Socket} socket */
  constructor(socket) {
    super();
    this._socket = socket;
    socket.on('data',  chunk => this._onData(chunk));
    socket.on('error', err   => this._onError(err));
    socket.on('close', ()    => this._onError(new NecError('DISCONNECTED', 'TCP connection closed')));
  }

  async write(buf) {
    await new Promise((resolve, reject) => {
      this._socket.write(buf, err => err ? reject(err) : resolve());
    });
  }

  async close() {
    this._socket.destroy();
  }
}

/**
 * Connect to a NEC monitor over TCP.
 * @param {string} host
 * @param {number} [port=7142]
 * @param {number} [connectTimeoutMs=5000]
 * @returns {Promise<TcpTransport>}
 */
export async function connectTcp(host, port = DEFAULT_TCP_PORT, connectTimeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer  = setTimeout(() => {
      socket.destroy();
      reject(new NecError('CONNECT_TIMEOUT', `TCP connect to ${host}:${port} timed out`));
    }, connectTimeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(new TcpTransport(socket)); });
    socket.once('error',   err => { clearTimeout(timer); reject(err); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Serial Transport  (RS-232C via raw fd — no serialport library)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a serial port in raw mode using core Node.js fs.
 * Baud rate / 8N1 configuration is performed via `stty` (invoked via child_process).
 *
 * Note: full termios configuration from pure JS requires native bindings.
 * This implementation uses `stty` which is universally available on GNU/Linux.
 *
 * @param {string} device  - e.g. '/dev/ttyS0' or '/dev/ttyUSB0'
 * @param {number} [baud=9600]
 * @returns {Promise<SerialTransport>}
 */
export async function connectSerial(device, baud = 9600) {
  // Configure port via stty before opening
  await _sttyConfig(device, baud);
  const fd = fs.openSync(device, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  return new SerialTransport(fd, device);
}

async function _sttyConfig(device, baud) {
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    execFile('stty', ['-F', device, String(baud), 'cs8', '-cstopb', '-parenb', 'raw', '-echo'], (err) => {
      if (err) reject(new Error(`stty failed: ${err.message}`));
      else resolve();
    });
  });
}

export class SerialTransport extends Transport {
  constructor(fd, device) {
    super();
    this._fd     = fd;
    this._device = device;
    this._closed = false;
    this._startReading();
  }

  _startReading() {
    const CHUNK = 256;
    const buf   = Buffer.alloc(CHUNK);
    const poll  = () => {
      if (this._closed) return;
      fs.read(this._fd, buf, 0, CHUNK, null, (err, n) => {
        if (this._closed) return;
        if (err) {
          if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
            // No data yet — back off briefly
            setTimeout(poll, 5);
          } else {
            this._onError(err);
          }
          return;
        }
        if (n > 0) this._onData(buf.slice(0, n));
        setImmediate(poll);
      });
    };
    poll();
  }

  async write(buf) {
    await new Promise((resolve, reject) => {
      fs.write(this._fd, buf, 0, buf.length, null, (err, written) => {
        if (err) return reject(err);
        if (written !== buf.length) return reject(new Error('Partial serial write'));
        resolve();
      });
    });
  }

  async close() {
    this._closed = true;
    fs.closeSync(this._fd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session — pacing scheduler, cooldown, reconnect
// ─────────────────────────────────────────────────────────────────────────────

export class Session {
  /**
   * @param {Transport}  transport
   * @param {object}     [opts]
   * @param {number}     [opts.defaultMonitorId=1]
   * @param {number}     [opts.timeoutMs=5000]
   * @param {boolean}    [opts.keepAlive=false]      - send a periodic safe query to prevent LAN idle-disconnect
   * @param {number}     [opts.keepAliveIntervalMs=600_000]  - default 10 min (< 15 min limit)
   */
  constructor(transport, opts = {}) {
    this._transport  = transport;
    this._monitorId  = opts.defaultMonitorId ?? 1;
    this._timeoutMs  = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._queue      = [];
    this._busy       = false;
    this._cooldownUntil = 0;

    transport.on('error', err => { /* logged; callers will get rejection on next enqueue */ });

    if (opts.keepAlive) {
      const interval = opts.keepAliveIntervalMs ?? 600_000;
      this._keepAliveTimer = setInterval(() => {
        this.powerStatus(this._monitorId).catch(() => {/* silent */});
      }, interval);
      this._keepAliveTimer.unref();
    }
  }

  /** Destroy the session and underlying transport. */
  async close() {
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    await this._transport.close();
  }

  /**
   * Core: enqueue a send/receive operation.
   * Enforces serial execution (one outstanding command at a time) and cooldowns.
   */
  _enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._busy) this._drain();
    });
  }

  async _drain() {
    if (this._busy || this._queue.length === 0) return;
    this._busy = true;
    const { fn, resolve, reject } = this._queue.shift();
    try {
      // Honour any active cooldown
      const now = Date.now();
      if (this._cooldownUntil > now) {
        await _sleep(this._cooldownUntil - now);
      }
      const result = await fn(this._transport);
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this._busy = false;
      this._drain();
    }
  }

  _setCooldown(ms) {
    this._cooldownUntil = Date.now() + ms;
  }

  // ── helper: send a CTL command (type A) and expect type B reply ──────────
  async _ctl(monitorId, msgBody, { cooldown, timeoutMs } = {}) {
    const dest   = monitorIdToDestByte(monitorId);
    const packet = encodePacket(dest, 'A', msgBody);
    return this._enqueue(async transport => {
      const reply = await transport.sendAndReceive(packet, timeoutMs ?? this._timeoutMs);
      if (reply.msgType !== 'B') throw new NecError('UNEXPECTED_REPLY', `Expected type B, got ${reply.msgType}`);
      if (cooldown) this._setCooldown(cooldown);
      return reply;
    });
  }

  // ── helper: send a VCP get (type C) and expect type D reply ─────────────
  async _vcpGet(monitorId, opPage, opCode) {
    const dest   = monitorIdToDestByte(monitorId);
    const packet = encodePacket(dest, 'C', Messages.vcpGet(opPage, opCode));
    return this._enqueue(async transport => {
      const reply = await transport.sendAndReceive(packet, this._timeoutMs);
      if (reply.msgType !== 'D') throw new NecError('UNEXPECTED_REPLY', `Expected type D, got ${reply.msgType}`);
      return Parsers.vcpGetReply(reply.msgBody);
    });
  }

  // ── helper: send a VCP set (type E) and expect type F reply ─────────────
  async _vcpSet(monitorId, opPage, opCode, value) {
    const dest   = monitorIdToDestByte(monitorId);
    const packet = encodePacket(dest, 'E', Messages.vcpSet(opPage, opCode, value));
    return this._enqueue(async transport => {
      const reply = await transport.sendAndReceive(packet, this._timeoutMs);
      if (reply.msgType !== 'F') throw new NecError('UNEXPECTED_REPLY', `Expected type F, got ${reply.msgType}`);
      return Parsers.vcpSetReply(reply.msgBody);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public high-level API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read a VCP parameter.
   * @param {number} monitorId
   * @param {number} opPage
   * @param {number} opCode
   * @returns {Promise<{type, max, current}>}
   */
  async vcpGet(monitorId, opPage, opCode) {
    return this._vcpGet(monitorId, opPage, opCode);
  }

  /**
   * Write a VCP parameter.
   * @param {number} monitorId
   * @param {number} opPage
   * @param {number} opCode
   * @param {number} value
   * @returns {Promise<{type, max, requested}>}
   */
  async vcpSet(monitorId, opPage, opCode, value) {
    return this._vcpSet(monitorId, opPage, opCode, value);
  }

  /**
   * Get → Set → Verify → Save workflow (spec recommended).
   * @param {number}  monitorId
   * @param {number}  opPage
   * @param {number}  opCode
   * @param {number}  value
   * @param {object}  [opts]
   * @param {boolean} [opts.verify=true]  - re-read and confirm value was applied
   * @param {boolean} [opts.persist=true] - issue Save Current Settings after set
   */
  async vcpSetPersisted(monitorId, opPage, opCode, value, { verify = true, persist = true } = {}) {
    const before = await this._vcpGet(monitorId, opPage, opCode);
    if (before.type === 'momentary') throw new NecError('VCP_MOMENTARY', 'Cannot persistently set a momentary VCP code');
    if (value > before.max) throw new RangeError(`Value ${value} exceeds VCP max ${before.max}`);

    const setResult = await this._vcpSet(monitorId, opPage, opCode, value);

    if (verify) {
      const after = await this._vcpGet(monitorId, opPage, opCode);
      if (after.current !== value) {
        throw new NecError('VCP_VERIFY_FAILED', `VCP verify: expected ${value}, got ${after.current}`);
      }
    }

    if (persist) {
      await this.saveCurrentSettings(monitorId);
    }

    return setResult;
  }

  /** Persist current settings to non-volatile storage. */
  async saveCurrentSettings(monitorId) {
    const reply = await this._ctl(monitorId, Messages.saveCurrentSettings());
    return Parsers.saveSettingsReply(reply.msgBody);
  }

  /** Get timing report (H/V frequency, sync status). */
  async getTimingReport(monitorId) {
    const reply = await this._ctl(monitorId, Messages.getTimingReport());
    return Parsers.timingReportReply(reply.msgBody);
  }

  /** Read current power state. Returns { mode, modeStr } */
  async powerStatus(monitorId) {
    const reply = await this._ctl(monitorId, Messages.powerStatusRead());
    return Parsers.powerStatusReply(reply.msgBody);
  }

  /**
   * Set power state.
   * @param {number} monitorId
   * @param {'on'|'off'} state
   */
  async powerSet(monitorId, state) {
    const mode = state === 'on' ? 0x0001 : state === 'off' ? 0x0004 : null;
    if (mode === null) throw new TypeError(`powerSet: state must be 'on' or 'off', got '${state}'`);
    const reply = await this._ctl(monitorId, Messages.powerControl(mode), { cooldown: COOLDOWNS.power });
    return Parsers.powerControlReply(reply.msgBody);
  }

  /**
   * Read up to 32 bytes of asset storage.
   * @param {number} monitorId
   * @param {number} offset  - byte offset (0x00 or 0x20 for full 64-byte area)
   * @param {number} length  - number of bytes to read (≤ 32)
   */
  async assetRead(monitorId, offset, length) {
    const reply = await this._ctl(monitorId, Messages.assetRead(offset, length));
    return Parsers.assetReadReply(reply.msgBody);
  }

  /** Read the full 64-byte asset area in two 32-byte chunks. */
  async assetReadAll(monitorId) {
    const p1 = await this.assetRead(monitorId, 0x00, 0x20);
    const p2 = await this.assetRead(monitorId, 0x20, 0x20);
    return Buffer.concat([p1.data, p2.data]);
  }

  /**
   * Write up to 32 bytes to asset storage.
   * @param {number} monitorId
   * @param {number} offset
   * @param {Buffer} data   - must be printable ASCII, ≤ 32 bytes
   */
  async assetWrite(monitorId, offset, data) {
    const reply = await this._ctl(monitorId, Messages.assetWrite(offset, data));
    return Parsers.assetWriteReply(reply.msgBody);
  }

  /** Read date and time from monitor. */
  async dateTimeRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.dateTimeRead());
    return Parsers.dateTimeReadReply(reply.msgBody);
  }

  /**
   * Write date and time to monitor.
   * @param {number} monitorId
   * @param {{ year, month, day, weekday, hour, minute, dst }} dt
   */
  async dateTimeWrite(monitorId, dt) {
    const reply = await this._ctl(monitorId, Messages.dateTimeWrite(dt));
    return Parsers.dateTimeWriteReply(reply.msgBody);
  }

  /**
   * Read one schedule entry.
   * @param {number} monitorId
   * @param {number} programNo
   */
  async scheduleRead(monitorId, programNo) {
    const reply = await this._ctl(monitorId, Messages.scheduleRead(programNo));
    return Parsers.scheduleReadReply(reply.msgBody);
  }

  /**
   * Write a schedule entry.
   * Set entry.hour or entry.minute to 0xFF to delete the entry.
   */
  async scheduleWrite(monitorId, entry) {
    const reply = await this._ctl(monitorId, Messages.scheduleWrite(entry));
    return Parsers.scheduleWriteReply(reply.msgBody);
  }

  /** Read a holiday definition. */
  async holidayRead(monitorId, programNo) {
    const reply = await this._ctl(monitorId, Messages.holidayRead(programNo));
    return Parsers.holidayReply(reply.msgBody);
  }

  /** Write a holiday definition. */
  async holidayWrite(monitorId, entry) {
    const reply = await this._ctl(monitorId, Messages.holidayWrite(entry));
    return Parsers.holidayReply(reply.msgBody);
  }

  /** Read weekend bitmask. */
  async weekendRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.weekendRead());
    return Parsers.weekendReply(reply.msgBody);
  }

  /**
   * Write weekend bitmask.
   * @param {number} monitorId
   * @param {number} weekMask - 7-bit mask, bit0=Mon … bit6=Sun
   */
  async weekendWrite(monitorId, weekMask) {
    const reply = await this._ctl(monitorId, Messages.weekendWrite(weekMask));
    return Parsers.weekendReply(reply.msgBody);
  }

  /**
   * Activate Emergency Contents playback.
   * Plays files from EMERGENCY CONTENTS folder on SD card via Media Player.
   * During playback the monitor blocks all controls except power off.
   */
  async emergencyDisplay(monitorId) {
    const reply = await this._ctl(monitorId, Messages.emergencyDisplay());
    return Parsers.emergencyReply(reply.msgBody);
  }

  /**
   * Stop Emergency Contents playback and return to normal operation.
   */
  async emergencyDelete(monitorId) {
    const reply = await this._ctl(monitorId, Messages.emergencyDelete());
    return Parsers.emergencyReply(reply.msgBody);
  }

  /** Read self-diagnosis status (power rails, fans, temperature, LED backlight). */
  async selfDiagnosis(monitorId) {
    const reply = await this._ctl(monitorId, Messages.selfDiagnosis());
    return Parsers.selfDiagnosisReply(reply.msgBody);
  }

  /** Read the monitor's serial number string. */
  async serialRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.serialRead());
    return Parsers.serialReply(reply.msgBody);
  }

  /** Read the monitor's model name string. */
  async modelNameRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.modelNameRead());
    return Parsers.modelNameReply(reply.msgBody);
  }

  /** Read firmware version. Returns { version, mv, bv1, bv2, bv3, br1, br2 }. */
  async firmwareVersionRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.firmwareVersionRead());
    return Parsers.firmwareVersionReply(reply.msgBody);
  }

  /** Read the LAN MAC address. Returns { mac, ipv }. */
  async lanMacRead(monitorId) {
    const reply = await this._ctl(monitorId, Messages.lanMacRead());
    return Parsers.lanMacReply(reply.msgBody);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a TCP session to a NEC monitor.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {number} [opts.port=7142]
 * @param {number} [opts.defaultMonitorId=1]
 * @param {boolean}[opts.keepAlive=false]
 * @returns {Promise<Session>}
 *
 * @example
 * const session = await openTcpSession('192.168.1.100');
 * const brightness = await session.vcpGet(1, 0x00, 0x10);
 * console.log(brightness.current);
 * await session.close();
 */
export async function openTcpSession(host, opts = {}) {
  const transport = await connectTcp(host, opts.port ?? DEFAULT_TCP_PORT);
  return new Session(transport, opts);
}

/**
 * Open a Serial session to a NEC monitor.
 *
 * @param {string} device  - e.g. '/dev/ttyS0'
 * @param {object} [opts]
 * @param {number} [opts.baud=9600]
 * @param {number} [opts.defaultMonitorId=1]
 * @returns {Promise<Session>}
 */
export async function openSerialSession(device, opts = {}) {
  const transport = await connectSerial(device, opts.baud ?? 9600);
  return new Session(transport, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decode a weekday bitmask to an array of day names.
 * bit0=Mon … bit6=Sun
 */
export function decodeWeekMask(mask) {
  const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
  return DAYS.filter((_, i) => mask & (1 << i));
}

/**
 * Encode an array of day names to a weekday bitmask.
 */
export function encodeWeekMask(days) {
  const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
  return days.reduce((acc, d) => {
    const i = DAYS.indexOf(d.toLowerCase());
    if (i === -1) throw new TypeError(`Unknown day name: ${d}`);
    return acc | (1 << i);
  }, 0);
}
