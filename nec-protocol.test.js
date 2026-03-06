/**
 * nec-protocol.test.js
 *
 * Self-contained test suite.  Run with:
 *   node --experimental-vm-modules nec-protocol.test.js
 *   (or just:  node nec-protocol.test.js  on Node ≥ v20)
 *
 * Uses only node:assert and the module under test — no test framework needed.
 */

import assert from 'node:assert/strict';
import {
  computeBCC,
  encodePacket,
  parsePacket,
  toAsciiHex,
  fromAsciiHex,
  monitorIdToDestByte,
  Messages,
  Parsers,
  decodeWeekMask,
  encodeWeekMask,
  NecError,
} from './nec-protocol.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mini test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function hexBuf(hexStr) {
  return Buffer.from(hexStr.replace(/\s+/g, ''), 'hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Codec primitives
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nCodec primitives');

test('toAsciiHex: single byte', () => {
  assert.equal(toAsciiHex(0x0A, 2).toString('ascii'), '0A');
  assert.equal(toAsciiHex(0xFF, 2).toString('ascii'), 'FF');
  assert.equal(toAsciiHex(0x00, 2).toString('ascii'), '00');
});

test('toAsciiHex: 16-bit word', () => {
  assert.equal(toAsciiHex(0x003A, 4).toString('ascii'), '003A');
  assert.equal(toAsciiHex(0xFFFF, 4).toString('ascii'), 'FFFF');
});

test('fromAsciiHex: decode', () => {
  assert.equal(fromAsciiHex(Buffer.from('0A', 'ascii')), 0x0A);
  assert.equal(fromAsciiHex(Buffer.from('003A', 'ascii')), 0x003A);
  assert.equal(fromAsciiHex(Buffer.from('FFFF', 'ascii')), 0xFFFF);
});

test('fromAsciiHex: rejects non-hex chars', () => {
  assert.throws(() => fromAsciiHex(Buffer.from('GG', 'ascii')), TypeError);
});

test('monitorIdToDestByte: id 1 → 0x41', () => {
  assert.equal(monitorIdToDestByte(1),   0x41);
  assert.equal(monitorIdToDestByte(100), 0xA4);
  assert.equal(monitorIdToDestByte(0),   0x2A); // broadcast
});

test('monitorIdToDestByte: rejects out-of-range', () => {
  assert.throws(() => monitorIdToDestByte(101), RangeError);
  assert.throws(() => monitorIdToDestByte(-1),  RangeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// BCC
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nBCC checksum');

test('BCC: spec worked example — vector 1 (save current settings)', () => {
  // Full packet without BCC and CR:
  // 01 30 41 30 41 30 34 02 30 43 03
  const frame = hexBuf('01 30 41 30 41 30 34 02 30 43 03');
  assert.equal(computeBCC(frame), 0x76);
});

test('BCC: vector 2 (get timing report)', () => {
  const frame = hexBuf('01 30 41 30 41 30 34 02 30 37 03');
  assert.equal(computeBCC(frame), 0x02);
});

test('BCC: vector 3 (power status read)', () => {
  const frame = hexBuf('01 30 41 30 41 30 36 02 30 31 44 36 03');
  assert.equal(computeBCC(frame), 0x74);
});

test('BCC: vector 6 (VCP get, opPage=00 opCode=10)', () => {
  const frame = hexBuf('01 30 41 30 43 30 36 02 30 30 31 30 03');
  assert.equal(computeBCC(frame), 0x04);
});

// ─────────────────────────────────────────────────────────────────────────────
// encodePacket — all 7 spec test vectors
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nencodePacket — spec test vectors (monitor ID 1)');

const DEST1 = monitorIdToDestByte(1); // 0x41

test('Vector 1: CTL Save Current Settings ("0C")', () => {
  const pkt = encodePacket(DEST1, 'A', Messages.saveCurrentSettings());
  const expected = hexBuf('01 30 41 30 41 30 34 02 30 43 03 76 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 2: CTL Get Timing Report ("07")', () => {
  const pkt = encodePacket(DEST1, 'A', Messages.getTimingReport());
  const expected = hexBuf('01 30 41 30 41 30 34 02 30 37 03 02 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 3: CTL Power Status Read ("01D6")', () => {
  const pkt = encodePacket(DEST1, 'A', Messages.powerStatusRead());
  const expected = hexBuf('01 30 41 30 41 30 36 02 30 31 44 36 03 74 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 4: CTL Power Control OFF (C203D6 + 0004)', () => {
  const pkt = encodePacket(DEST1, 'A', Messages.powerControl(0x0004));
  const expected = hexBuf('01 30 41 30 41 30 43 02 43 32 30 33 44 36 30 30 30 34 03 76 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 5: CTL Asset Read (C00B offset=00 length=20h)', () => {
  const pkt = encodePacket(DEST1, 'A', Messages.assetRead(0x00, 0x20));
  const expected = hexBuf('01 30 41 30 41 30 41 02 43 30 30 42 30 30 32 30 03 73 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 6: VCP Get (opPage=00, opCode=10h)', () => {
  const pkt = encodePacket(DEST1, 'C', Messages.vcpGet(0x00, 0x10));
  const expected = hexBuf('01 30 41 30 43 30 36 02 30 30 31 30 03 04 0D');
  assert.deepEqual(pkt, expected);
});

test('Vector 7: VCP Set (opPage=00, opCode=10h, value=0050h)', () => {
  const pkt = encodePacket(DEST1, 'E', Messages.vcpSet(0x00, 0x10, 0x0050));
  const expected = hexBuf('01 30 41 30 45 30 41 02 30 30 31 30 30 30 35 30 03 70 0D');
  assert.deepEqual(pkt, expected);
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePacket — round-trip all 7 vectors
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nparsePacket — round-trip validation');

test('Vector 1 round-trip', () => {
  const raw = hexBuf('01 30 41 30 41 30 34 02 30 43 03 76 0D');
  const p   = parsePacket(raw);
  assert.equal(p.msgType, 'A');
  assert.equal(p.msgBody.toString('hex'), '02304303');
});

test('Vector 6 round-trip (VCP get)', () => {
  const raw = hexBuf('01 30 41 30 43 30 36 02 30 30 31 30 03 04 0D');
  const p   = parsePacket(raw);
  assert.equal(p.msgType, 'C');
});

test('Vector 7 round-trip (VCP set)', () => {
  const raw = hexBuf('01 30 41 30 45 30 41 02 30 30 31 30 30 30 35 30 03 70 0D');
  const p   = parsePacket(raw);
  assert.equal(p.msgType, 'E');
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePacket — validation rules
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nparsePacket — validation rules');

test('Rejects missing SOH', () => {
  const bad = hexBuf('30 41 30 41 30 34 02 30 43 03 76 0D');
  assert.throws(() => parsePacket(bad), /SOH/);
});

test('Rejects missing CR', () => {
  const bad = hexBuf('01 30 41 30 41 30 34 02 30 43 03 76');
  assert.throws(() => parsePacket(bad), /CR/);
});

test('Rejects bad reserved byte', () => {
  const bad = hexBuf('01 31 41 30 41 30 34 02 30 43 03 77 0D');
  assert.throws(() => parsePacket(bad));
});

test('Rejects bad BCC', () => {
  const bad = hexBuf('01 30 41 30 41 30 34 02 30 43 03 FF 0D');
  assert.throws(() => parsePacket(bad), /BCC/);
});

test('Rejects declared length mismatch', () => {
  // Change length field to 05 (one more than actual 04)
  const bad = hexBuf('01 30 41 30 41 30 35 02 30 43 03 77 0D');
  // Will fail on BCC or length overrun
  assert.throws(() => parsePacket(bad));
});

// ─────────────────────────────────────────────────────────────────────────────
// Reply parsers
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nReply parsers');

test('Parsers.vcpGetReply: success', () => {
  // STX result(00) opPage(00) opCode(10) type(00) max(0064) current(0050) ETX
  const body = Buffer.from('\x02' + '00' + '00' + '10' + '00' + '0064' + '0050' + '\x03', 'ascii');
  const r = Parsers.vcpGetReply(body);
  assert.equal(r.opCode,   0x10);
  assert.equal(r.max,      0x0064);
  assert.equal(r.current,  0x0050);
  assert.equal(r.type,     'set_parameter');
});

test('Parsers.vcpGetReply: result code 01 throws NecError', () => {
  const body = Buffer.from('\x02' + '01' + '00' + '10' + '00' + '0064' + '0050' + '\x03', 'ascii');
  assert.throws(() => Parsers.vcpGetReply(body), NecError);
});

test('Parsers.vcpSetReply: success', () => {
  const body = Buffer.from('\x02' + '00' + '00' + '10' + '00' + '0064' + '0050' + '\x03', 'ascii');
  const r = Parsers.vcpSetReply(body);
  assert.equal(r.requested, 0x0050);
});

test('Parsers.saveSettingsReply: success', () => {
  const body = Buffer.from('\x02' + '00' + '0C' + '\x03', 'ascii');
  const r = Parsers.saveSettingsReply(body);
  assert.ok(r.ok);
});

test('Parsers.powerStatusReply: on (0001)', () => {
  // STX '00' '01' 'D6' '0001' ETX
  const body = Buffer.from('\x02' + '00' + '01' + 'D6' + '0001' + '\x03', 'ascii');
  const r = Parsers.powerStatusReply(body);
  assert.equal(r.modeStr, 'on');
});

test('Parsers.powerStatusReply: standby (0002)', () => {
  const body = Buffer.from('\x02' + '00' + '01' + 'D6' + '0002' + '\x03', 'ascii');
  const r = Parsers.powerStatusReply(body);
  assert.equal(r.modeStr, 'standby');
});

test('Parsers.timingReportReply: valid frame', () => {
  // STX '4E' SS(2) HFreq(4) VFreq(4) ETX
  // 12A9 = 4777 → 47.77 kHz
  const body = Buffer.from('\x02' + '4E' + '00' + '12A9' + '075A' + '\x03', 'ascii');
  const r = Parsers.timingReportReply(body);
  assert.equal(r.hFreqKHz, 0x12A9 / 100); // 47.77
});

test('Parsers.scheduleWriteReply: tolerates C33E', () => {
  const body = Buffer.from('\x02' + 'C33E' + '00' + '\x03', 'ascii');
  const r = Parsers.scheduleWriteReply(body);
  assert.ok(r.ok);
});

test('Parsers.scheduleWriteReply: tolerates C322 alias', () => {
  const body = Buffer.from('\x02' + 'C322' + '00' + '\x03', 'ascii');
  const r = Parsers.scheduleWriteReply(body);
  assert.ok(r.ok);
});

test('Parsers.weekendReply: decodes bitmask', () => {
  // weekMask = 0x41 = bit0 (Mon) + bit6 (Sun)
  const body = Buffer.from('\x02' + 'CB1A' + '01' + '41' + '\x03', 'ascii');
  const r = Parsers.weekendReply(body);
  assert.deepEqual(r.days, ['mon', 'sun']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Weekday mask helpers
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nWeekday mask helpers');

test('decodeWeekMask: 0x7F → all days', () => {
  assert.deepEqual(decodeWeekMask(0x7F), ['mon','tue','wed','thu','fri','sat','sun']);
});

test('decodeWeekMask: 0x00 → no days', () => {
  assert.deepEqual(decodeWeekMask(0x00), []);
});

test('encodeWeekMask: round-trip', () => {
  const mask = 0b0101001; // Mon, Thu, Sat
  const days = decodeWeekMask(mask);
  assert.equal(encodeWeekMask(days), mask);
});

test('encodeWeekMask: rejects unknown day', () => {
  assert.throws(() => encodeWeekMask(['monday']), TypeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// Domain constraint guards
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nDomain constraints');

test('assetRead: rejects length > 32', () => {
  assert.throws(() => Messages.assetRead(0, 33), RangeError);
});

test('assetWrite: rejects data > 32 bytes', () => {
  assert.throws(() => Messages.assetWrite(0, Buffer.alloc(33, 0x41)), RangeError);
});

test('assetWrite: rejects non-ASCII data', () => {
  assert.throws(() => Messages.assetWrite(0, Buffer.from([0x80])), TypeError);
});

test('powerControl: rejects invalid mode', () => {
  assert.throws(() => Messages.powerControl(0x0002), Error);
  assert.throws(() => Messages.powerControl(0x0003), Error);
});

test('weekendWrite: rejects mask > 0x7F', () => {
  assert.throws(() => Messages.weekendWrite(0x80), RangeError);
});

test('dateTimeWrite: rejects out-of-range month', () => {
  assert.throws(() => Messages.dateTimeWrite({ year:24, month:13, day:1, weekday:0, hour:0, minute:0, dst:false }), RangeError);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
