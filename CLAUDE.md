# CLAUDE.md — NEC Monitor Control System

This document brings you up to speed on the project. Read it fully before making any changes.

---

## What This Is

A Node.js server (`server.js`) + single-page web UI (`index.html`) that controls NEC large-format
displays over a local network. It runs on an OpenWrt router sitting on the same LAN as the
displays. Zero npm dependencies — everything uses Node.js built-ins only.

**Repo:** https://github.com/jonathan-annett/studious-waddle  
**Deployed at:** `/server/claude12/` on the OpenWrt router  
**Port:** 4000 (run with `node server.js`)

---

## Hardware Architecture — Critical

Each NEC display is actually **two separate network devices**:

| Device | IP (example) | Protocol | Purpose |
|--------|-------------|----------|---------|
| **TV** | `192.168.100.198` | NEC 7142 (RS-232C over TCP) | Input switching, power, brightness, all monitor controls |
| **Media Player** | `192.168.100.199` | HTTP CGI (`/cgi-bin/cgictrl`) | File management, folder config, slideshow settings |

The TV does not know about the media player's folder contents. The media player cannot switch
inputs. They are almost certainly separate processors sharing a box — NEC reuses TV firmware
across models and bolts the media player on as a separate firmware layer.

The server discovers the media player IP automatically by calling the TV's `pjctrl` endpoint
(`getPlayerIP()` in server.js).

**All input switching must go through the TV (port 7142).  
All file/folder/playback config must go through the Media Player HTTP API.**

---

## NEC 7142 Protocol (TV side)

Custom binary protocol over TCP port 7142. Implemented in `nec-protocol.js`.

Key facts:
- Sessions are stateful — `POST /api/connect { host }` opens a TCP connection, returns a `sessionId`
- Sessions are **in-memory only** — lost on server restart, must reconnect
- Monitor IDs are 1-based (default `1`)
- VCP commands: `vcpGet(monitorId, opPage, opCode)` / `vcpSet(monitorId, opPage, opCode, value)`
- Input source is VCP page `0x00`, opcode `0x60`
- MP (Media Player) input value: `0x87` (decimal 135)
- HDMI1 = `0x11` (17), HDMI2 = `0x12` (18), DP1 = `0x0F` (15), DP2 = `0x10` (16)

**Emergency contents** use the `CA1F` command family (not VCP):
- `emergencyDisplay(monitorId)` — activates EMERGENCY CONTENTS folder, locks all controls
- `emergencyDelete(monitorId)` — formal stop command

---

## Firmware Quarantine

`EXPECTED_FIRMWARE = '00R3.400'` is the only supported firmware version (defined as a constant
in server.js). When any device is discovered on port 7142:

1. `probeTvNec()` reads power, model, serial, **and firmware** in one probe session.
2. If firmware is present and does not match `EXPECTED_FIRMWARE`, the device is stored in
   `reg.quarantined[mac]` (not `reg.devices`) and a `device-quarantined` WebSocket event
   is broadcast.
3. Quarantined TVs are **never** used by the scheduler, player flow, or any other automation.
4. When a quarantined TV reconnects, only its IP is updated and the `device-quarantined` event
   is rebroadcast — no playback is attempted.
5. If firmware cannot be read (older NEC firmware ignores `CA02`), the device is treated as
   normal so existing devices are not accidentally blocked.

### Registry structure

```javascript
quarantined: {
  "<mac>": {
    ip, discoveredAt, firmware,
    model?, serial?
  }
}
```

### UI

The **Quarantined TVs** card appears in `#scanner-wrap` (below the scanner and asset manager
cards) whenever `reg.quarantined` is non-empty. It shows model, MAC, IP, actual firmware
version, and two links per device:
- `http://<tvIp>/updatefirmware.html` — NEC firmware update page
- `http://<tvIp>/` — device web UI root (useful for very old firmware that may lack the update page)

---

## Media Player HTTP API (Player side)

All requests go to `http://<playerIP>/cgi-bin/cgictrl?<command>` via POST.
**Must use `insecureHTTPParser: true`** — the firmware sends malformed HTTP headers.
`playerRequest()` in server.js handles this correctly.

### CGI Commands Reference

**File management:**
```
FL=-01          Navigate to root
FL=-02          Navigate to parent
FL=000          Navigate into item at index 0 (zero-padded 3 digits)
FM=             Enter file manager mode
FC=<name>       Create folder (URL-encoded name)
FD=<name>       Delete file/folder (URL-encoded name)
Fu=<clock>      Upload file — multipart/form-data POST, clock=Date.now()
RSG=<clock>     Finalise/commit upload
RSB=<clock>     Restart media player process
```

**Settings (V= namespace):**
```
V=S,2A,<len>,0,<val>,%00,   Set AutoPlay mode: 0=off, 1=slideshow, 2=mediapack
V=G,2A,1,0,%00,             Get AutoPlay mode
V=S,2B,<len>,1,<path>,%00,  Set AutoPlay folder path
V=G,2B,1,0,%00,             Get AutoPlay folder path
V=S,22,<len>,0,<secs>,%00,  Set slideshow interval (5–99999 seconds)
```

**CRITICAL — V=S,2B path encoding (verified via DevTools against firmware's own web UI):**
- Use `encodeURIComponent(folderPath)` on the **full** path — slashes become `%2F`, spaces `%20`
- `<len>` = **encoded** string length + 1 (null terminator)
- Example: `/mnt/usb1/Generic MCEC 2` → encoded = `%2Fmnt%2Fusb1%2FGeneric%20MCEC%202` (34 chars) → `len=35`
- The firmware parses raw URL bytes without percent-decoding, so `len` must match the encoded byte count.
- (An earlier note here said "never encode slashes — hard-won bug fix". That was a misdiagnosis.
  The actual firmware requirement is full encoding + encoded length.)

**Filelist API:**
```
GET /mmb/filelist.json
```
Returns `{ dir_path, file_cnt, fileinfo: [{name, size, date, type}] }`
`type`: 0 = folder, 1 = file
**Firmware bug:** trailing comma before `]` — fix with `.replace(/,(\s*\])/g, '$1')` before JSON.parse.
**CRITICAL — FM= prerequisite:** The player returns 404 for `/mmb/filelist.json` until
`POST /cgi-bin/cgictrl?FM=` (enter file manager mode) has been sent at least once after boot
or player restart (RSG=/RSB=). Always call `enterFileManager(playerIP)` before any filelist
access. This is idempotent — safe to call multiple times.

**Index navigation:**
Items are 0-based in the filelist array. Use `findIndex()` to locate a folder by name, then
`FL=<index padded to 3 digits>` to navigate into it.

---

## Playback Flow ("play folder X")

The correct sequence to switch the display to a named folder:

1. **Check folder contents** — read filelist, abort if empty
2. **Decide interval** — 99999s (infinite) if 1 file, user-configured (default 30s) if multiple
3. **Read current TV input** — if already on MP (`0x87`), bounce to `SAFE_INPUT` (HDMI1, `0x11`)
   and wait 800ms. This is mandatory — the player won't pick up a new folder without a bounce.
   Using a fixed safe input keeps behaviour predictable regardless of what was on-screen before.
4. **Set AutoPlay folder + mode** — `V=S,2B,...` (path) and `V=S,2A,...` (mode=1, slideshow)
5. **Set interval** — `V=S,22,...`
6. **Restart player** — `RSG=<clock>` commits V=S,2B/2A and starts the slideshow immediately
7. **Switch TV input to MP** — `vcpSet(monitorId, 0x00, 0x60, 0x87)`
8. **Clear autoplay flag** — 3 seconds later (fire-and-forget): `V=S,2A,2,0,0,%00,`

**Why step 8 exists (important):** The NEC firmware autoplays the configured folder whenever
the TV switches to the MP input while V=S,2A is set to mode=1. Humans can switch inputs with
the IR remote or the NEC web UI — if the flag stayed set, any time they switched away from MP
and back, the slideshow would restart from the beginning. By clearing it ~3 seconds after *we*
switch to MP (after the slideshow is already running), we win the race: the player is running
freely via RSG=, and a human switching away/back to MP afterwards won't retrigger autoplay.
This also prevents the player from auto-restarting the folder after an unexpected reboot.
The server can always re-trigger via `playFolder()` which sets V=S,2A=1 again as part of
the play sequence.

This is all implemented in `playFolder()` in server.js.

## Idle / Stop Flow ("no active event, no default group")

When the scheduler determines a device should not be playing anything (no active sub-event
and `device.defaultGroup` is not set), it:

1. **Clears the autoplay flag** — `V=S,2A,2,0,0,%00,` on the media player
2. **Reads current TV input** — if already on MP (`0x87`), switches to `SAFE_INPUT` (HDMI1)

This returns the display to a neutral state. The player stops being the visible source, and
the autoplay flag is cleared so reconnecting to MP manually won't retrigger it.

---

## Emergency Contents System

A separate, higher-priority playback mode that locks all monitor controls (except power).

**Flow:**
1. Save current input via VCP get
2. `POST /api/emergency-upload?tvIP=x.x.x.x` — wipes SD card, creates `EMERGENCY CONTENTS`
   folder, uploads files in order (slideshow plays in upload order)
3. `POST /api/emergency/display` — activates emergency mode
4. `POST /api/emergency/stop` — restores saved input (which exits emergency mode); falls back
   to `emergencyDelete` if saved input was MP or unavailable

The emergency system works even if the display is in normal media player mode.

---

## Event Scheduling System

Time-based automation for switching display content during events.

### Concepts

- **Event**: a named container (e.g. "Conference 2026") with one or more sub-events.
- **Sub-event**: a time window + asset group + set of devices. All named devices show the
  sub-event's group for the duration.
- **Default group** (`device.defaultGroup`): the group a device shows when no event is active.
  Set via the Devices tab badge clicks.
- **Conflict**: a device cannot be in two overlapping sub-events.

### Data Model

Added to `registry.json`:

```javascript
events: {
  "<eventId>": {
    name: "Conference 2026",
    subEvents: [
      {
        id: "abc123",
        name: "Morning Keynote",
        groupId: "gid_xyz",                    // asset group to display
        devices: ["aa:bb:cc:dd:ee:ff", ...],   // MAC addresses
        start: "2026-03-09T22:00:00.000Z",     // UTC ISO 8601 (toISOString())
        end: "2026-03-10T01:00:00.000Z"        // UTC ISO 8601 (toISOString())
      }
    ]
  }
}
```

Times are stored as UTC ISO strings (JavaScript `toISOString()` output, always ending in `Z`).
The UI converts the user's local time → UTC before sending, and converts back UTC → local for
display. The server compares using `new Date(sub.start)` vs `new Date()` — both UTC, correct
regardless of the server's local timezone (typically UTC on OpenWrt).

Each device gains `defaultGroup: "gid_abc"` — the group shown when no event is active.

### Scheduler

`checkSchedule()` runs every 60 seconds and on startup. For each device:
1. Check if a scheduled sub-event is active → play that group
2. Otherwise → play `defaultGroup`
3. If desired state differs from `device.autoplay` → save + apply

Also triggered after event create/update/delete.

On `device-online`, the handler calls `getDesiredAutoplay(mac, reg)` to determine whether to
restore an event group or the default.

### Key Functions (server.js)

- `getActiveSubEvent(mac, reg)` → `{ eventId, event, subEvent }` or `null`
- `findConflicts(devices, start, end, excludeEventId, excludeSubId, reg)` → conflict array
- `validateEvent(event, excludeEventId, reg)` → all conflicts for an event
- `getDesiredAutoplay(mac, reg)` → folder name string or `null`
- `getNextEvent(reg)` → `{ eventId, event, subEvent, device, minsUntil }` or `null` (next upcoming event across all devices)
- `checkSchedule()` → scans all devices, applies correct autoplay state
- `pushEventGroup(tvIP, group, reg)` → push asset group files to a device (builds file list from cache, calls pushGroupToPlayer)

### Auto-Push on Event Save

When an event is created or updated via `POST /api/events` or `PUT /api/events/:id`:
1. Save event to registry (with conflict validation)
2. For each sub-event, for each device:
   - Lookup the asset group by `groupId`
   - Call `pushEventGroup(device.tvIp, group, reg)` (fire-and-forget)
   - Log success or warn on failure
3. Run `checkSchedule()` to apply correct playback state

This ensures assets are pre-positioned on the media player before the event starts.

### Countdown Logging

Every 60 seconds, the server logs:
```
[scheduler] Next event: "EventName" — SubEventName on DeviceName, in X min
```

This helps admins know what's coming up and whether a server restart is safe.

---

## API Routes

All routes accept/return JSON. `sessionId` is required for TV-side operations.

### Connection
```
POST /api/connect          { host, port? }          → { sessionId, monitorId, ... }
DELETE /api/connect/:id                              → disconnect
POST /api/interrogate      { sessionId }             → full display state snapshot
```

### VCP (TV controls)
```
POST /api/vcp/get          { sessionId, opPage, opCode }
POST /api/vcp/set          { sessionId, opPage, opCode, value, persist? }
POST /api/power/status     { sessionId }
POST /api/power/set        { sessionId, state: 'on'|'off' }
```

### Media Player (folder playback)
```
POST /api/player/play      { sessionId, tvIP, folder, restoreInput?, interval? }
POST /api/player/stop      { sessionId, tvIP, restoreInput? }
POST /api/player/folder    { tvIP }                  → current autoplay folder
POST /api/player/filelist  { tvIP, folder }          → file count + names in folder
```

### Emergency
```
POST /api/emergency/display   { sessionId }
POST /api/emergency/stop      { sessionId }
POST /api/emergency-upload?tvIP=x.x.x.x   (multipart/form-data files)
```

### Asset Cache
```
GET  /api/cache
GET  /api/cache/:hash/file                   → stream raw file (for thumbnails)
POST /api/cache/store      (multipart/form-data)
POST /api/cache/send       { hash, tvIP }
DELETE /api/cache/:hash
```

### Events (scheduling)
```
GET    /api/events                            → list all events
POST   /api/events           { name, subEvents }  → create event
GET    /api/events/:id                        → single event
PUT    /api/events/:id       { name?, subEvents? } → update event
DELETE /api/events/:id                        → delete event
GET    /api/events/active                     → currently active sub-events
POST   /api/devices/:mac/default-group  { groupId } → set default display group
```

### Firmware Quarantine
```
GET  /api/quarantined                    → { quarantined: [{ mac, ip, firmware, model, serial, discoveredAt }], expectedFirmware }
```

### Utilities
```
GET  /api/subnets
POST /api/scan             { subnet }
POST /api/self-diagnosis   { sessionId }
POST /api/serial           { sessionId }
POST /api/model            { sessionId }
POST /api/firmware         { sessionId }
POST /api/mac              { sessionId }
POST /api/restart                        → exits process (triggers --dev loop git pull + restart)
```

---

## SD Card Folder Structure

The media player mounts its SD card at `/mnt/usb1/`. Current test folder structure:

```
/mnt/usb1/
  folder1/    ← sample1.png (red slide)
  folder2/    ← sample2.png (blue slide)
  folder3/    ← sample3.png (green slide)
  folder4/    ← sample4.png (orange slide)
  all/        ← all 4 slides
  EMERGENCY CONTENTS/   ← created by emergency upload flow
```

The folder names `folder1`–`folder4` and `all` are hardcoded in `PLAYER_FOLDERS` in index.html.
This will need to be made dynamic in a future iteration.

---

## Known Firmware Quirks

1. **Malformed HTTP headers** — always use `insecureHTTPParser: true` in all http.request calls
   to the media player. `playerRequest()` does this already.

2. **Invalid JSON from filelist** — trailing comma before `]`. Fix:
   ```js
   raw.replace(/,(\s*\])/g, '$1')
   ```

3. **V=S,2B path encoding** — `encodeURIComponent` the full path (slashes included), and set
   `<len>` to the **encoded** length + 1. The firmware counts raw URL bytes. Verified against
   the NEC player's own web UI via DevTools network capture.

4. **Input bounce required** — if TV is already on MP input and you change the autoplay folder,
   the player won't reload. Must switch to `SAFE_INPUT` (800ms) then back to MP.

5. **Slideshow interval range** — firmware accepts 5–99999 seconds. Values outside this range
   are clamped by `setSlideInterval()`. Use 99999 as "infinite" for single-slide folders.

6. **RSG= vs RSB=** — `RSG=<clock>` finalises uploads AND restarts playback. `RSB=<clock>` just
   restarts. Use RSG= for the play flow.

7. **FM= required before filelist.json** — the player returns 404 for `/mmb/filelist.json` until
   `POST /cgi-bin/cgictrl?FM=` has been sent at least once. This state resets on player restart
   (RSG=/RSB=). `enterFileManager(playerIP)` in server.js handles this. All functions that access
   filelist.json call it first. It is idempotent — safe to call multiple times.

---

## File Structure

```
server.js          Main server — all API routes + player/TV subsystems
index.html         Single-page UI — connects, interrogates, controls display
nec-protocol.js    NEC 7142 protocol driver (TCP, binary framing, VCP, emergency)
nec-protocol.test.js  Protocol unit tests
CLAUDE.md          This file
```

---

## Development Notes

- **No npm deps** — do not introduce any. Node built-ins only (`http`, `net`, `fs`, `crypto`,
  `url`, `path`).
- The server is structured as one large `handleApi()` function with if/else route matching.
  Keep this pattern — don't refactor to Express or a router framework.
- The UI uses vanilla JS with no framework. Cards are rendered by dedicated `renderX()` functions
  called from `populateUI()` after interrogation. Keep this pattern.
- `PLAYER_FOLDERS` in index.html is the list shown as folder buttons in the Media Player card.
  This is temporary test scaffolding — a future task is to read folder names dynamically from
  the player via `/api/player/filelist`.
- The server logs to stdout with timestamps. The UI receives logs via WebSocket and displays
  them in the log panel.

---

## Running the Server

### Production / normal start
```bash
cd /server/claude12
./run          # sets NEC_CACHE_DIR and NEC_SUBNET, then runs node server.js 4000
```

### Dev / auto-restart loop
```bash
./run --dev    # loops: git pull → node server.js → on exit, repeat
```
`--dev` mode is the normal way to run in deployment. The loop means any clean exit
(including via `POST /api/restart`) triggers an automatic `git pull` + restart.

### Deploying a new version (from dev machine)
```bash
# Claude handles the first two steps automatically:
git push
curl -s -X POST http://<router-ip>:4000/api/restart
# The server exits cleanly, the loop pulls the new commit, restarts within ~5s.
```

### First-time setup on the router
```bash
git pull && chmod +x run
# Kill any existing node process, then:
./run --dev
```

## Typical Test Session

```bash
# In browser — http://<router-ip>:4000
# 1. Enter TV IP (192.168.100.198), click Connect
# 2. Click Interrogate All to populate all cards
# 3. Use Media Player card to switch folders
# 4. Use Emergency Contents card for emergency mode testing
```

---

## Stream Deck Gateway

A companion subsystem (in `streamdeck-gateway/`) that bridges Elgato Stream Deck hardware to
the NEC monitor control system. Runs on the operator's local machine (e.g. i7 workstation),
**not** on the OpenWrt router.

### Architecture

```
[Physical USB Deck]          [Browser WebHID Deck]
       ↓                              ↓
  index.js (Node)          public/remote.js (browser)
  USB → sharp → WS          WebHID → Canvas → WS
         ↘                        ↙
      ws://<router>:4000/streamdeck   (brain in server.js)
                ↕
          NEC API (same process)
```

Two client types connect to the same brain server over WebSocket:

| Client | File | HID Access | Image Rendering |
|--------|------|-----------|----------------|
| **USB Gateway** | `index.js` | `@elgato-stream-deck/node` | `sharp` (native) |
| **Browser Satellite** | `public/remote.js` | WebHID API | `OffscreenCanvas` |

Both implement identical protocol behaviour. `index.js` runs as a persistent Node process;
`remote.js` is served to any browser and uses the WebHID permission prompt to claim the device.

The brain server is **integrated directly into `server.js`** as a WebSocket endpoint at
`ws://<router-ip>:4000/streamdeck`. The gateway's `SERVER_URL` must point there (not localhost:4001).
`test-server.js` remains as a standalone demo/reference only.

### Running the Gateway (dev machine)

```bash
cd streamdeck-gateway
# Edit index.js: set SERVER_URL to ws://<router-ip>:4000/streamdeck
node index.js          # USB gateway — connects to brain in server.js
```

The brain runs inside `server.js` on the router. No separate brain server needed.
`test-server.js` can still be used for standalone testing on port 4001.

### Authentication / Whitelist

- `whitelist.json` — array of authorised serial number strings (test-server.js only)
- The production brain in `server.js` accepts all Stream Deck connections on `/streamdeck`
  (no serial whitelist — the gateway runs on a trusted LAN)

---

### XL Layout — TV Button Grid

The Stream Deck XL (4×8 = 32 keys) is laid out as:

```
┌─────────────────────────────┬─────────────────────────────┐
│   Left 4 columns (0–3)     │   Right 4 columns (4–7)     │
│                             │                             │
│   PREVIEW ZONE              │   TV BUTTONS                │
│   (set_zone_fast)           │   (set_key per device)      │
│                             │                             │
│   Indices:                  │   Row 0:  4   5   6   7     │
│   0  1  2  3               │   Row 1: 12  13  14  15     │
│   8  9 10 11               │   Row 2: 20  21  22  23     │
│  16 17 18 19               │   Row 3: 28  29  30  31     │
│  24 25 26 27               │                             │
└─────────────────────────────┴─────────────────────────────┘
```

**TV buttons** (right 4 cols, max 16 TVs):
- Assigned in registry order (sorted by MAC), one per registered device
- Label: first 8 chars of `device.name` (uppercase, bitmap font)
- Colours: **green** = powered on, **red** = powered off, **dark grey** = offline

**Preview zone** (left 4 cols):
- Updated on TV button press — shows the first image from the device's active asset group
- Sent via `set_zone_fast` (fit-contain, centred, black letterbox)

**Button interactions:**
- **Short press** (< 5s): sends the first cached image from the TV's active group to the
  preview zone (event group takes priority, then `defaultGroup`)
- **Long press** (≥ 5s): toggles the TV's power state via NEC protocol, updates button colour

**Device offline handling:**
When `POST /api/device-online` receives `{ up: false }`, the TV's button goes dark grey with
dimmed text. It remains in position (not removed) so the layout stays stable.

---

### WebSocket Protocol

All messages are JSON `{ event, data }`. The brain runs the WebSocket server; gateways/
satellites are clients.

#### Device → Brain

```
device_online   Sent immediately after WS open.
                data: { model, serial, rows, cols, iconSize, keys? }
                  model    — e.g. "Stream Deck XL"
                  serial   — hardware serial number (used for auth)
                  rows     — button grid rows
                  cols     — button grid columns
                  iconSize — button pixel size (square)
                  keys     — total button count (optional, cols×rows if absent)

key_event       Sent on every button press and release.
                data: { index, state, serial }
                  index  — 0-based key index (left-to-right, top-to-bottom)
                  state  — "down" | "up"
                  serial — identifies which deck (for multi-deck setups)
```

#### Brain → Device

```
set_key         Fill a single button with an image.
                data: { index, image, pressImage? }
                  index       — 0-based key index
                  image       — base64-encoded PNG
                  pressImage  — base64 PNG for pressed state (optional)
                                false = locked (no visual feedback on press)
                                omit  = default white flash on press

set_zone_fast   Fill a rectangular group of buttons with slices of one image.
                Efficient for multi-key thumbnails or sidebar layouts.
                data: { image, indices, cols, rows, position?, background? }
                  image      — base64 PNG — the source image to slice
                  indices    — ordered array of deck key indices to fill
                               (must be cols×rows in length, row-major order)
                  cols       — grid width of the zone in keys
                  rows       — grid height of the zone in keys
                  position   — sharp/canvas position string (default "right top")
                               "center" | "right top" | "left top" | etc.
                  background — { r, g, b } fill colour for letterbox (default black)
                Example — 4×4 sidebar zone on XL (left 4 cols):
                  indices: [0,1,2,3, 8,9,10,11, 16,17,18,19, 24,25,26,27]
                  cols: 4, rows: 4

set_splash      Cover the ENTIRE panel with one image. Used to announce a state
                change (e.g. "OFFLINE", "LOCKED", countdown) or draw attention.
                The current panel content is saved and restored on clear.
                Key events still fire during a splash so the brain can react
                (e.g. any key press dismisses). No visual press feedback is shown.
                data: { image, duration?, background? }
                  image      — base64 PNG — displayed fit-contain centred
                  duration   — seconds before auto-dismiss (omit = until clear_splash)
                  background — { r, g, b } letterbox fill (default black)

clear_splash    Dismiss the active splash and restore the previous panel state.
                data: {}
                Note: also fires automatically when duration elapses.

clear_all       Clear the entire panel and reset all key state.
                data: {}
```

#### Brain → Device (auth only)

```
auth_failed     Remote device rejected — serial not in whitelist.
                data: { reason }
                The brain closes the connection immediately after sending this.
```

---

### Splash Feature — Design Notes

**State machine per device:**
- `splashActive: bool` — whether a splash is currently shown
- `preSplashCache` — snapshot of `keyCache` taken when splash activates
- `splashTimer` — handle for the auto-dismiss timeout

**On `set_splash`:**
1. Cancel any existing splash timer
2. Snapshot `keyCache` → `preSplashCache`
3. Render the image fit-contain centred across all `rows×cols` keys
4. Cache each sliced key with `pressed: false` (locked — no press feedback)
5. If `duration` given, set timer to call `clearSplash()` after that many seconds

**On `clear_splash` / timer expiry:**
1. Restore `keyCache` from `preSplashCache`
2. Re-render all restored keys to hardware (single `fillPanelCanvas` call in browser;
   parallel `fillKeyBuffer` calls in Node)
3. Clear `preSplashCache`

**During a splash**, `set_key` and `set_zone_fast` updates go to `preSplashCache` rather than
to the hardware. This means the brain can stage the next panel state while a splash is showing
and it will appear correctly when the splash clears.

**`clear_all`** resets splash state completely — no restore.

---

### Integration with server.js (implemented)

The brain is built into `server.js` at the `/streamdeck` WebSocket endpoint. Key components:

**State tracking (in server.js):**
```javascript
const sdClients     = new Map();  // serial → { socket, model, rows, cols, iconSize }
const sdDeviceState = new Map();  // mac → { online, power }
const sdKeyTimers   = new Map();  // `${serial}:${index}` → { timer, mac, downAt, fired }
```

**PNG generation (zero deps):**
`renderTextButton(text, bg, fg, size)` — pure Node.js bitmap font renderer using `zlib.deflateSync`
for PNG compression. The gateway's `sharp` handles resizing to icon size.

**Key functions:**
- `sdWsUpgrade(req, socket)` — WebSocket handshake + bidirectional frame reader
- `sdRefreshAllButtons(socket)` — send all TV buttons on connect
- `sdUpdateButton(mac)` — re-render one button on all connected SDs
- `sdShowPreview(socket, mac)` — send first group image to preview zone
- `sdTogglePower(mac)` — open temp NEC session, toggle power, update button
- `sdHandleKeyEvent(serial, data)` — routes press/release + long-press timer

**Hooks into existing code:**
- `POST /api/device-online` with `up: false` → `sdDeviceState` + `sdUpdateButton`
- `device-online` broadcast (known TV) → `sdDeviceState` + `sdUpdateButton`
- `device-discovered` broadcast (new TV) → `sdDeviceState` + `sdUpdateButton`

### File Structure

```
streamdeck-gateway/
  index.js              USB gateway — polls USB every 2s, thin client to brain
  remote.js             (legacy stub — superseded by public/remote.js)
  test-server.js        Reference brain server — demo only, not for production
  public/
    index.html          Satellite web page — served by brain, opened in Chrome
    remote.js           StreamDeckRemote class — WebHID satellite client
  dist/                 Webpack output — copy of public/ + bundled vendor JS
    index.html
    remote.js
    streamdeck-vendor.js  @elgato-stream-deck/webhid bundled for browser use
  src/
    vendor.js           Webpack entry — re-exports @elgato-stream-deck/webhid
  webpack.config.cjs    Bundles src/vendor.js → dist/streamdeck-vendor.js,
                        copies public/ → dist/
  whitelist.json        Authorised serial numbers (auto-managed)
  package.json          npm deps: @elgato-stream-deck/node, sharp, ws, express
```

**Note:** `dist/remote.js` is a plain copy of `public/remote.js` (webpack does not process it).
When editing `public/remote.js`, also copy to `dist/remote.js` or run `npm run build`.
