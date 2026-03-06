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

**Index navigation:**
Items are 0-based in the filelist array. Use `findIndex()` to locate a folder by name, then
`FL=<index padded to 3 digits>` to navigate into it.

---

## Playback Flow ("play folder X")

The correct sequence to switch the display to a named folder:

1. **Check folder contents** — read filelist, abort if empty
2. **Decide interval** — 99999s (infinite) if 1 file, user-configured (default 30s) if multiple
3. **Read current TV input** — if already on MP (`0x87`), bounce to restore input first (800ms delay)
   This is mandatory — the player won't pick up a new folder without an input bounce
4. **Set AutoPlay folder** — `V=S,2B,...`
5. **Set interval** — `V=S,22,...`
6. **Restart player** — `RSG=<clock>`
7. **Switch TV input to MP** — `vcpSet(monitorId, 0x00, 0x60, 0x87)`
8. **Clear autoplay startup config** — 3 seconds later (fire-and-forget): `V=S,2A,2,0,0,%00,`

Step 8 is intentional: `RSG=` has already committed the folder path and started playback.
Clearing `V=S,2A` afterwards only affects the player's *next* reboot — the running slideshow is
unaffected. This prevents the firmware from auto-restarting the last folder if staff manually
change content via the NEC web UI, while still allowing the server to re-trigger via `playFolder()`.

This is all implemented in `playFolder()` in server.js.

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
   the player won't reload. Must switch away (800ms) then back to MP.

5. **Slideshow interval range** — firmware accepts 5–99999 seconds. Values outside this range
   are clamped by `setSlideInterval()`. Use 99999 as "infinite" for single-slide folders.

6. **RSG= vs RSB=** — `RSG=<clock>` finalises uploads AND restarts playback. `RSB=<clock>` just
   restarts. Use RSG= for the play flow.

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
