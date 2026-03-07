# NEC 7142 Protocol Specification

**Version:** 1.6 G4 (NEC External Control Protocol)
**Transport:** TCP/IP on port 7142 (also RS-232C serial at 9600 baud)
**Encoding:** ASCII-hex with BCC checksum

---

## Quick Start

```javascript
import { openTcpSession } from './nec-protocol.js';

// Connect to a monitor at IP address
const session = await openTcpSession('192.168.1.100');

// Read a value
const brightness = await session.vcpGet(1, 0x00, 0x10);
console.log(brightness.current);  // 0-100

// Set a value
await session.vcpSet(1, 0x00, 0x10, 75);

// Check power state
const power = await session.powerStatus(1);
console.log(power.modeStr);  // 'on' | 'standby' | 'suspend' | 'off'

// Clean up
await session.close();
```

---

## Transport Layer

### TCP Connection

- **Port:** 7142 (default)
- **Address:** Monitor's IP on the LAN
- **Stateful:** Session persists across multiple commands until closed
- **Timeout:** 5000ms default (configurable per session)
- **Keep-alive:** Optional periodic heartbeat to prevent idle disconnection (LAN firewalls)

### Packet Framing

All packets follow this binary structure:

```
[SOH] [RES] [DEST] [SRC] [TYPE] [LEN_HI] [LEN_LO] [MSG] [BCC] [CR]
 0x01  0x30  byte   0x30  char    hex     hex    bytes  byte 0x0D
```

| Field | Size | Value | Purpose |
|-------|------|-------|---------|
| **SOH** | 1 byte | `0x01` | Start of header |
| **RES** | 1 byte | `0x30` | Reserved (always '0') |
| **DEST** | 1 byte | `0x41-0x64` | Destination address: monitor ID (1-100 → 'A'-'d') |
| **SRC** | 1 byte | `0x30` | Source address: controller ('0') |
| **TYPE** | 1 byte | `A`/`B`/`C`/`D`/`E`/`F` | Packet type (see below) |
| **LEN_HI, LEN_LO** | 2 bytes | ASCII hex | Message length (STX...ETX inclusive) |
| **MSG** | N bytes | `[STX]...[ETX]` | Message body (see below) |
| **BCC** | 1 byte | XOR of RES..ETX | Checksum (byte-wise XOR) |
| **CR** | 1 byte | `0x0D` | Carriage return (end marker) |

### Monitor ID Addressing

- **Valid range:** 1-100 (1-based indexing)
- **Broadcast address:** 0 (address `*` / `0x2A`)
- **ASCII conversion:** `monitorId → (0x40 + monitorId)`
  - ID 1 → `0x41` ('A')
  - ID 2 → `0x42` ('B')
  - ...
  - ID 100 → `0xA4`

### Message Encoding

All numeric values inside messages are **uppercase ASCII hexadecimal**:

```
Value 255 → "FF"
Value 15  → "0F"
Value 1   → "01"
```

Text fields use **printable ASCII** (0x20-0x7E).

---

## Packet Types

### Command Types (Controller → Monitor)

| Type | Direction | Purpose |
|------|-----------|---------|
| **A** | Controller → Monitor | CTL (Control) — status queries, settings, power, time, schedules |
| **C** | Controller → Monitor | VCP GET — read parameter value |
| **E** | Controller → Monitor | VCP SET — write parameter value |

### Reply Types (Monitor → Controller)

| Type | Direction | Purpose |
|------|-----------|---------|
| **B** | Monitor → Controller | Reply to type A (CTL) |
| **D** | Monitor → Controller | Reply to type C (VCP GET) |
| **F** | Monitor → Controller | Reply to type E (VCP SET) |

---

## VCP (Video Control Panel) Commands

VCP codes control display parameters like brightness, contrast, input, etc.

### VCP Get

**Purpose:** Read current value, maximum, and type of a parameter.

**Request format:**
```
Type C message: [STX] [opPage:2h] [opCode:2h] [ETX]

Example: brightness (page 0x00, code 0x10)
→ 02 00 10 03  (STX + "0010" + ETX)
```

**Reply format:**
```
Type D message: [STX] [result:2h] [opPage:2h] [opCode:2h] [type:2h] [max:4h] [current:4h] [ETX]

Example reply:
→ 02 00 00 10 00 0064 0050 03  (result=0, page=00, code=10, type=00 [set parameter], max=100, current=80)
```

**Result codes:**
- `00` = Success
- `01` = Unsupported opcode

**Type field:**
- `00` = Set parameter (standard value)
- `01` = Momentary (write-only, pulse action)

**JavaScript API:**
```javascript
const result = await session.vcpGet(monitorId, opPage, opCode);
// Returns: { result, opPage, opCode, type, max, current }

// Example: get brightness
const bright = await session.vcpGet(1, 0x00, 0x10);
console.log(`Current: ${bright.current}, Max: ${bright.max}`);
```

---

### VCP Set

**Purpose:** Change a parameter to a new value (write-only).

**Request format:**
```
Type E message: [STX] [opPage:2h] [opCode:2h] [value:4h] [ETX]

Example: set brightness to 75%
→ 02 00 10 004B 03  (STX + "001000004B" + ETX)
```

**Reply format:**
```
Type F message: [STX] [result:2h] [opPage:2h] [opCode:2h] [type:2h] [max:4h] [requested:4h] [ETX]

Example reply:
→ 02 00 00 10 00 0064 004B 03  (confirmed brightness set to 75)
```

**JavaScript API:**
```javascript
const result = await session.vcpSet(monitorId, opPage, opCode, value);
// Returns: { result, opPage, opCode, type, max, requested }

// Example: set brightness to 75
await session.vcpSet(1, 0x00, 0x10, 75);
```

---

### VCP Set with Persistence

**Purpose:** Set a value, verify it was applied, and save to non-volatile storage.

**JavaScript API:**
```javascript
const result = await session.vcpSetPersisted(monitorId, opPage, opCode, value, opts);
// opts: { verify: true, persist: true }

// Workflow:
// 1. vcpGet → compare current with requested (optional)
// 2. vcpSet → write new value
// 3. vcpGet → verify value changed (optional)
// 4. saveCurrentSettings → persist to EEPROM (optional)

// Example
await session.vcpSetPersisted(1, 0x00, 0x10, 75, { verify: true, persist: true });
```

---

## Common VCP Codes

| Opcode | Page | Name | Range | Purpose |
|--------|------|------|-------|---------|
| `0x10` | `0x00` | Brightness | 0-100 | Set display brightness |
| `0x12` | `0x00` | Contrast | 0-100 | Set display contrast |
| `0x60` | `0x00` | Input Source | varies | Switch HDMI/DP/etc |
| `0xDF` | `0x00` | Power Button | momentary | Virtual power button press |
| `0xF0` | `0x00` | Settings Menu | momentary | Open on-screen menu |

**Input source values:**
- `0x0F` = DP1 (DisplayPort 1)
- `0x10` = DP2 (DisplayPort 2)
- `0x11` = HDMI1
- `0x12` = HDMI2
- `0x87` = Media Player (internal IP source)

---

## CTL (Control) Commands

CTL commands handle status, settings, power, and scheduling operations.

### Power Status

**Purpose:** Read current power state.

**Request:**
```javascript
const power = await session.powerStatus(monitorId);
// Returns: { mode: 0x0001|0x0002|0x0003|0x0004, modeStr: 'on'|'standby'|'suspend'|'off' }
```

**Mode values:**
- `0x0001` = On
- `0x0002` = Standby
- `0x0003` = Suspend (low-power mode)
- `0x0004` = Off

**Cooldown:** 15 seconds after setting power state.

---

### Power Control

**Purpose:** Change power state.

**Request:**
```javascript
await session.powerSet(monitorId, 'on');   // power on
await session.powerSet(monitorId, 'off');  // power off

// Returns: { ok: true }
```

**Cooldown:** 15 seconds required after this command before any other commands.

---

### Save Settings

**Purpose:** Persist current VCP values to non-volatile storage (EEPROM).

**Request:**
```javascript
await session.saveCurrentSettings(monitorId);
// Returns: { ok: true }
```

---

### Self-Diagnosis

**Purpose:** Read hardware health status (power supplies, fans, temperature, LED backlight).

**Request:**
```javascript
const diag = await session.selfDiagnosis(monitorId);
// Returns: {
//   psOnOK, ps5vOK, ps24vOK, ps12vOK, psStandby5vOK,
//   fanOK, thermalOK, ledBacklightOK,
//   raw_hex_string
// }
```

---

### Timing Report

**Purpose:** Read horizontal and vertical frequency of the current input signal.

**Request:**
```javascript
const timing = await session.getTimingReport(monitorId);
// Returns: {
//   statusBits,
//   syncPresent: boolean,
//   hFreqKHz: number,     // e.g., 47.77
//   vFreqHz: number       // e.g., 60.00
// }
```

---

### Date/Time

**Purpose:** Read and write monitor's internal clock (used by scheduling).

**Read:**
```javascript
const dt = await session.dateTimeRead(monitorId);
// Returns: { year, month, day, weekday, hour, minute, dst: boolean }
```

**Write:**
```javascript
await session.dateTimeWrite(monitorId, {
  year: 26,        // 0-99 (2000-2099)
  month: 3,        // 1-12
  day: 8,          // 1-31
  weekday: 6,      // 0=Mon, 1=Tue, ... 6=Sun
  hour: 15,        // 0-23
  minute: 30,      // 0-59
  dst: false       // daylight saving time
});
```

---

### Schedule (Program)

**Purpose:** Set up time-based switching (input, picture mode, power, etc).

**Read one entry:**
```javascript
const entry = await session.scheduleRead(monitorId, programNo);
// programNo: 0-99
// Returns: {
//   programNo, event, hour, minute, input,
//   weekMask, typeMask, pictureMode
// }
```

**Write one entry:**
```javascript
await session.scheduleWrite(monitorId, {
  programNo: 0,
  event: 0x00,           // event code
  hour: 9,               // 0-23, or 0xFF to delete
  minute: 0,             // 0-59, or 0xFF to delete
  input: 0x11,           // input source (HDMI1)
  weekMask: 0x1F,        // Mon-Fri (bit0=Mon, bit6=Sun)
  typeMask: 0x01,        // type 1: switch input
  pictureMode: 0x00      // picture mode 0-3
});
```

**Special case:** Set `hour=0xFF` or `minute=0xFF` to delete an entry.

---

### Holiday & Weekend Definitions

**Purpose:** Configure special schedules for holidays and weekend days.

**Read holiday:**
```javascript
const holiday = await session.holidayRead(monitorId, programNo);
// Returns: { mode, programNo, type?, endDay?, weekNo? }
```

**Write holiday:**
```javascript
await session.holidayWrite(monitorId, {
  programNo: 0,
  type: 0x00,      // holiday type
  endDay: 0x11,    // end day (month/day packed)
  weekNo: 0x00     // week number (for moveable holidays)
});
```

**Read/write weekend mask:**
```javascript
// Read
const weekend = await session.weekendRead(monitorId);
// Returns: { weekMask }

// Write (7-bit: bit0=Mon, bit6=Sun)
await session.weekendWrite(monitorId, 0x60);  // Sat+Sun
```

---

### Asset Storage

**Purpose:** Store arbitrary data (up to 64 bytes) in non-volatile storage on the monitor.

**Read (32 bytes max):**
```javascript
const asset = await session.assetRead(monitorId, offset, length);
// offset: 0x00 or 0x20 (64-byte area divided in half)
// length: 1-32
// Returns: { offset, data: Buffer }

// Read entire 64-byte area
const full = await session.assetReadAll(monitorId);  // returns Buffer
```

**Write (32 bytes max):**
```javascript
const data = Buffer.from('MyAssetData', 'ascii');
await session.assetWrite(monitorId, 0x00, data);
// offset: 0x00 or 0x20
// data: must be printable ASCII, ≤ 32 bytes
```

---

### Emergency Contents

**Purpose:** Display high-priority content (e.g., emergency alerts) that locks all controls except power off.

**Activate:**
```javascript
await session.emergencyDisplay(monitorId);
// All on-screen controls are locked. Only power button works.
```

**Deactivate:**
```javascript
await session.emergencyDelete(monitorId);
// Returns to normal operation, restores previous input.
```

---

### Identity Queries

**Purpose:** Read monitor information for diagnostics and logging.

**Serial number:**
```javascript
const serial = await session.serialRead(monitorId);
// Returns: { serial: '00R3ABC123XYZ' }
```

**Model name:**
```javascript
const model = await session.modelNameRead(monitorId);
// Returns: { model: 'MultiSync UN4809QA' }
```

**Firmware version:**
```javascript
const fw = await session.firmwareVersionRead(monitorId);
// Returns: {
//   version: '00R3.400',  // display firmware
//   mv: 0, bv1: 0, bv2: 0, bv3: 0,  // component versions
//   br1: 0, br2: 0                   // revision numbers
// }
```

**LAN MAC address:**
```javascript
const lan = await session.lanMacRead(monitorId);
// Returns: { mac: 'aa:bb:cc:dd:ee:ff', ipv: ... }
```

---

## Session Lifecycle

### Creating a Session

```javascript
import { openTcpSession } from './nec-protocol.js';

const session = await openTcpSession('192.168.1.100', {
  port: 7142,                    // default
  defaultMonitorId: 1,           // fallback monitor ID
  timeoutMs: 5000,               // command timeout
  keepAlive: false,              // periodic heartbeat
  keepAliveIntervalMs: 600_000   // 10 minutes
});
```

### Command Ordering

- **Serial execution:** Commands are queued; only one executes at a time
- **Cooldowns:** Some commands require waiting before the next command:
  - Power state change: 15 seconds
  - Input switch: 10 seconds
  - Auto-setup: 10 seconds
  - Factory reset: 10 seconds
- **Timeouts:** Each command has a 5-second default timeout (configurable)

### Closing a Session

```javascript
await session.close();
// TCP connection closed, timers cleared
```

---

## Error Handling

### NecError Exception

```javascript
// All errors are thrown as NecError or subtypes
try {
  await session.vcpGet(1, 0xFF, 0xFF);
} catch (err) {
  if (err.name === 'NecError') {
    console.log(err.code);     // error type
    console.log(err.message);  // human-readable message
  }
}
```

**Common error codes:**
- `PARSE_ERROR` — Packet format invalid
- `VCP_UNSUPPORTED` — VCP opcode not supported by monitor
- `VCP_SET_FAILED` — VCP set operation rejected
- `TIMEOUT` — No reply within timeout window
- `CONNECTION_LOST` — TCP disconnected unexpectedly
- `UNEXPECTED_REPLY` — Reply type mismatch

---

## Quirks & Firmware Behavior

### Broadcast Limitation

- Broadcast address (`monitorId=0`) is **read-only**
- Write operations (VCP set, power control, etc.) **require a specific monitor ID**
- Useful for: discovery, `powerStatus` queries to find all devices on subnet

### Reply Wait Enforcement

The protocol guarantees the monitor will reply within **~5 seconds**, but:
- Physical monitor may take 1-2 seconds to process
- Always implement timeout handling (standard library does this)
- Don't retry immediately on timeout; wait and try again after a delay

### Model-Specific Behavior

- Older models may not support firmware version read (CA02) — gracefully ignored
- Input switching may take 1-2 seconds before the new input stabilizes
- VCP brightness values may be 0-100 or 0-255 depending on model (always query `max` first)

### Cooldown Timing

- **Power control:** 15 seconds required before next command
- **Input switch:** 10 seconds required before next command
- Session automatically enforces these; overly fast commands are delayed

### Input Bounce Requirement

If the TV is already on a given input and you set that same input again, the monitor may **not respond to the change**. Solution:

```javascript
const current = await session.vcpGet(monitorId, 0x00, 0x60);
if (current.current === DESIRED_INPUT) {
  // Already on desired input — bounce to safe input first
  await session.vcpSet(monitorId, 0x00, 0x60, SAFE_INPUT);
  await sleep(800);  // wait for input to settle
}
await session.vcpSet(monitorId, 0x00, 0x60, DESIRED_INPUT);
```

### Power State Transition

- Power takes **2-3 seconds** to fully transition (even though command completes)
- Safe to proceed immediately after `powerSet()` returns
- But if reading state immediately, may still be in transition state
- Cool-down timer is enforced regardless

---

## Testing & Simulation

The simulator (`simulator/nec-responder.js`) reproduces:
- Correct packet framing and BCC validation
- Realistic power transition timing
- VCP read/write with bounds checking
- All CTL commands (identity, settings, time, scheduling)
- Input and power cooldowns
- Cable disconnection simulation

---

## Further Reading

- **Official spec:** NEC External Control Protocol Rev.1.6 G4
- **Reference implementation:** `nec-protocol.js` (this repo)
- **Server integration:** `server.js` API routes for monitor control

