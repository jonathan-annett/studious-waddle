# NEC Media Player HTTP CGI API Specification

**Version:** 1.0
**Protocol:** HTTP/1.1 on port 80
**Base URL:** `http://<playerIP>/cgi-bin/cgictrl`
**Method:** POST (all commands)

---

## Quick Start

The media player is a separate hardware layer from the TV — they share a chassis but are two independent processors. The player handles folder navigation, file uploads, and slideshow playback via HTTP CGI commands.

```bash
# Enter file manager mode (required before reading filelist)
curl -X POST 'http://192.168.100.199/cgi-bin/cgictrl?FM='

# Navigate to root
curl -X POST 'http://192.168.100.199/cgi-bin/cgictrl?FL=-01'

# List files in current directory
curl 'http://192.168.100.199/mmb/filelist.json'

# Navigate into folder at index 0
curl -X POST 'http://192.168.100.199/cgi-bin/cgictrl?FL=000'

# Create a folder
curl -X POST 'http://192.168.100.199/cgi-bin/cgictrl?FC=MyFolder'

# Set autoplay folder
curl -X POST 'http://192.168.100.199/cgi-bin/cgictrl?V=S,2B,35,1,%2Fmnt%2Fusb1%2FMyFolder,%00,'

# Restart player (commit uploads, start autoplay)
curl -X POST "http://192.168.100.199/cgi-bin/cgictrl?RSG=$(date +%s)"
```

---

## HTTP-Level Quirks

### Malformed HTTP Headers

⚠️ **CRITICAL:** The firmware sends **non-standard HTTP headers** that confuse standard parsers.

**Workaround:** Use `insecureHTTPParser: true` in Node.js http.request:

```javascript
const http = require('http');

http.request({
  host: playerIP,
  port: 80,
  path: '/cgi-bin/cgictrl?FM=',
  method: 'POST',
  insecureHTTPParser: true  // <-- required for NEC firmware
}, (res) => { /* handle response */ }).end();
```

### File Manager Mode Prerequisite

⚠️ **CRITICAL:** The endpoint `/mmb/filelist.json` returns **404 Not Found** until `FM=` has been sent at least once after boot or player restart.

**Sequence:**
1. Power on or restart player (RSG=/RSB=)
2. Send `FM=` command (enter file manager mode)
3. Now `/mmb/filelist.json` is accessible
4. On next RSG=/RSB=, FM= prerequisite resets — must re-send

**Failure symptom:** HTTP 404 responses with HTML "Not Found" body (not JSON).

---

## Navigation Commands (FL)

Navigate the SD card filesystem using index-based navigation.

### FL=-01 (Go to Root)

Navigate to the SD card root directory (`/mnt/usb1/`).

```
POST /cgi-bin/cgictrl?FL=-01
Response: 200 OK, body=OK
```

Used before reading the root filelist.

### FL=-02 (Go to Parent)

Navigate up one level (parent directory).

```
POST /cgi-bin/cgictrl?FL=-02
Response: 200 OK, body=OK
```

**Limitation:** No effect if already at root.

### FL=<index> (Navigate Into Item)

Navigate into a folder at a specific index in the current directory listing.

```
POST /cgi-bin/cgictrl?FL=000
POST /cgi-bin/cgictrl?FL=001
POST /cgi-bin/cgictrl?FL=010
```

**Format:** 3-digit zero-padded decimal index (0-based).

**Restrictions:**
- Only works for items with `type === 0` (folders)
- Fails silently if index out of range or item is a file

---

## File Manager Mode (FM)

### FM= (Enter File Manager Mode)

Activate file manager mode on the player.

```
POST /cgi-bin/cgictrl?FM=
Response: 200 OK, body=OK
```

**Why required:**
- Player firmware requires this before `/mmb/filelist.json` is accessible
- State resets on player restart (RSG=/RSB=)
- Safe to call multiple times (idempotent)

**Recommended:** Call before **every** filelist.json access, even if you think it's already active:

```javascript
async function getFileList(playerIP) {
  await playerRequest(playerIP, '/cgi-bin/cgictrl?FM=', 'POST');
  const raw = await playerRequest(playerIP, '/mmb/filelist.json', 'GET');
  return JSON.parse(raw.replace(/,(\s*\])/g, '$1'));
}
```

---

## Folder Management (FC, FD)

### FC=<name> (Create Folder)

Create a new folder in the current directory.

```
POST /cgi-bin/cgictrl?FC=MyFolder
POST /cgi-bin/cgictrl?FC=2024%20Conference
```

**Encoding:** URL-encoded folder name using `encodeURIComponent()`.

**Behavior:**
- Folder created in current working directory
- If folder already exists, command is ignored (no error)
- Does not navigate into the new folder

**Typical usage:**
```javascript
// 1. Go to root
await playerRequest(playerIP, '/cgi-bin/cgictrl?FL=-01', 'POST');

// 2. Create folder
const name = 'EventFolder';
await playerRequest(playerIP, `/cgi-bin/cgictrl?FC=${encodeURIComponent(name)}`, 'POST');

// 3. Navigate into it (find index from filelist, then FL=index)
```

### FD=<name> (Delete File or Folder)

Delete a file or folder (recursive for folders).

```
POST /cgi-bin/cgictrl?FD=OldFolder
POST /cgi-bin/cgictrl?FD=old-image.jpg
```

**Encoding:** URL-encoded name using `encodeURIComponent()`.

**Behavior:**
- Deletes file or folder recursively (entire folder tree deleted)
- Ignores attempt to delete non-existent files (no error)
- Works on current directory only (no path traversal)

---

## File Upload (Fu, RSG)

Upload files to the current directory via multipart/form-data.

### Fu=<timestamp> (Upload File)

Upload file data via multipart/form-data POST.

```
POST /cgi-bin/cgictrl?Fu=1234567890
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary

------WebKitFormBoundary
Content-Disposition: form-data; name="file"; filename="image.png"
Content-Type: image/png

[binary image data here]
------WebKitFormBoundary--
```

**Parameters:**
- `clock` or `Fu`: Unix timestamp (milliseconds) — used to track upload batches

**Multiple files:** Repeat form-data parts in same request:

```javascript
const formData = new FormData();
formData.append('file', file1, 'image1.png');
formData.append('file', file2, 'image2.jpg');

await fetch(`http://${playerIP}/cgi-bin/cgictrl?Fu=${Date.now()}`, {
  method: 'POST',
  body: formData
});
```

### RSG=<timestamp> (Restart & Finalize)

Finalize uploads and restart player (apply autoplay settings).

```
POST /cgi-bin/cgictrl?RSG=1234567890
Response: 200 OK, body=OK
```

**Behavior:**
1. Commit all uploaded files to SD card
2. Restart media player process
3. Clear file manager mode (FM= needed again before next filelist.json)
4. Begin autoplay if configured via V=S,2A

**Timing:** After RSG=, player will briefly return HTML (not JSON) for filelist.json during restart. Query `waitForPlayerReady()` to wait for recovery.

**Typical workflow:**
```javascript
// 1. Enter file manager mode
await playerRequest(playerIP, '/cgi-bin/cgictrl?FM=', 'POST');

// 2. Create folder
await playerRequest(playerIP, '/cgi-bin/cgictrl?FL=-01', 'POST');
await playerRequest(playerIP, `/cgi-bin/cgictrl?FC=MyFolder`, 'POST');

// 3. Navigate into folder (find its index first)
const fileList = JSON.parse(raw.replace(/,(\s*\])/g, '$1'));
const idx = fileList.fileinfo.findIndex(f => f.name === 'MyFolder' && f.type === 0);
await playerRequest(playerIP, `/cgi-bin/cgictrl?FL=${String(idx).padStart(3, '0')}`, 'POST');

// 4. Upload files (Fu=)
// (see Fu= section above)

// 5. Finalize & restart
const clock = Date.now();
await playerRequest(playerIP, `/cgi-bin/cgictrl?RSG=${clock}`, 'POST');
```

### RSB=<timestamp> (Restart Player Only)

Restart player without committing uploads.

```
POST /cgi-bin/cgictrl?RSB=1234567890
Response: 200 OK, body=OK
```

**Difference from RSG:**
- RSG: Commits uploads + restarts + starts autoplay
- RSB: Restarts only (discards uncommitted uploads)

**Use case:** Recovery from hung player state.

---

## Settings (V)

Configure autoplay, slideshow interval, and other settings.

### V=S,2A,<len>,<mode>,<val>,... (Set AutoPlay Mode)

Enable or disable automatic folder playback.

```
POST /cgi-bin/cgictrl?V=S,2A,2,0,0,%00,
  Mode 0: AutoPlay OFF

POST /cgi-bin/cgictrl?V=S,2A,2,0,1,%00,
  Mode 1: AutoPlay ON (slideshow)

POST /cgi-bin/cgictrl?V=S,2A,2,0,2,%00,
  Mode 2: AutoPlay ON (MediaPack mode — rarely used)
```

**Format breakdown:**
- `S` = Set operation
- `2A` = AutoPlay mode opcode
- `2` = value length (always 2 for modes)
- `0` = unknown/reserved
- `0|1|2` = mode
- `%00,` = null terminator + trailing comma

**Behavior:**
- Mode 0: Player idles, no autoplay
- Mode 1: Continuously loop folder (with interval from V=S,22)
- Mode 2: MediaPack mode (specialized, uncommon)

### V=S,2B,<len>,<path_encoded>,... (Set AutoPlay Folder)

Configure which folder to autoplay.

```
POST /cgi-bin/cgictrl?V=S,2B,35,1,%2Fmnt%2Fusb1%2FMyFolder,%00,
```

**Format breakdown:**
- `S` = Set operation
- `2B` = AutoPlay folder opcode
- `35` = **encoded path length + 1** (critical!)
- `1` = unknown/reserved
- `%2Fmnt%2Fusb1%2FMyFolder` = full path, URL-encoded
- `%00,` = null terminator + trailing comma

**Path encoding (CRITICAL):**

1. Take the **full path** (e.g., `/mnt/usb1/MyFolder`)
2. URL-encode **including slashes**: `encodeURIComponent('/mnt/usb1/MyFolder')`
3. Result: `%2Fmnt%2Fusb1%2FMyFolder` (34 characters)
4. Calculate length: encoded length + 1 = 34 + 1 = **35**

```javascript
function encodeAutoPlayPath(folderPath) {
  const encoded = encodeURIComponent(folderPath);
  const len = encoded.length + 1;  // +1 for null terminator
  return `V=S,2B,${len},1,${encoded},%00,`;
}

// Example
const cmd = encodeAutoPlayPath('/mnt/usb1/EventFolder');
// → "V=S,2B,33,1,%2Fmnt%2Fusb1%2FEventFolder,%00,"
```

**Common mistake:** Not encoding slashes → firmware rejects path.

### V=S,22,<len>,<secs>,... (Set Slideshow Interval)

Configure delay between slides in autoplay mode.

```
POST /cgi-bin/cgictrl?V=S,22,5,0,30,%00,
  30 seconds between slides

POST /cgi-bin/cgictrl?V=S,22,6,0,99999,%00,
  99999 seconds (infinite — single image per folder)
```

**Format breakdown:**
- `S` = Set operation
- `22` = Slideshow interval opcode
- `5|6` = value length (depends on value)
- `0` = unknown/reserved
- `30|99999` = seconds
- `%00,` = null terminator

**Valid range:** 5–99999 seconds

**Use cases:**
- Single image folder: use 99999 (firmware max = "infinite")
- Multi-image slideshow: use 5–300 (typical 30 seconds)
- Out-of-range values: firmware clamps to nearest valid value

```javascript
function encodeSlideInterval(seconds) {
  const clamped = Math.max(5, Math.min(99999, seconds));
  const lenStr = clamped.toString();
  const len = lenStr.length;
  return `V=S,22,${len},0,${clamped},%00,`;
}

// Example
const cmd = encodeSlideInterval(30);
// → "V=S,22,2,0,30,%00,"
```

### V=G,<opcode>,<len>,<val>,... (Get Settings — Read-Only)

Query current settings (player does not parse responses — server.js skips these).

```
POST /cgi-bin/cgictrl?V=G,2A,1,0,%00,
  Get AutoPlay mode

POST /cgi-bin/cgictrl?V=G,2B,1,0,%00,
  Get AutoPlay folder

POST /cgi-bin/cgictrl?V=G,22,1,0,%00,
  Get slideshow interval
```

**Note:** Response is 200 OK, but body is not parsed by server.js. Primarily for manual testing via browser.

---

## Filelist API

### GET /mmb/filelist.json

Retrieve directory listing as JSON (file manager mode prerequisite).

```
GET /mmb/filelist.json?_=1234567890
Content-Type: application/json

{
  "dir_path": "/mnt/usb1/MyFolder/",
  "file_cnt": 3,
  "fileinfo": [
    { "name": "image1.png", "size": 204800, "date": "2026/01/01 00:00:00", "type": 1 },
    { "name": "image2.jpg", "size": 153600, "date": "2026/01/01 00:00:00", "type": 1 },
    { "name": "subfolder", "size": 0,       "date": "2026/01/01 00:00:00", "type": 0 },
  ]
}
```

**Response fields:**
- `dir_path` (string): Current directory path (always includes trailing slash)
- `file_cnt` (number): Number of entries in fileinfo array
- `fileinfo` (array): Entries in current directory
  - `name` (string): Filename or folder name
  - `size` (number): File size in bytes (0 for folders)
  - `date` (string): Modification timestamp
  - `type` (number): 0 = folder, 1 = file

### Firmware Bugs in JSON

⚠️ **Trailing comma bug:** JSON ends with invalid syntax:

```javascript
// Raw response
{ "dir_path": "...", "fileinfo": [{ ... }, { ... },] }
//                                                    ^
//                                                    extra comma!
```

**Workaround:**

```javascript
const raw = await fetch('http://.../mmb/filelist.json').then(r => r.text());
const fixed = raw.replace(/,(\s*\])/g, '$1');  // remove trailing comma
const data = JSON.parse(fixed);
```

### Cache Busting

Always include a query parameter to bypass browser/proxy caching:

```
GET /mmb/filelist.json?_=1234567890
                             ^^^^^^^^ current Unix timestamp in ms
```

---

## Emergency Upload Mode

Upload files for high-priority emergency display (firmware quarantine bypass).

### POST /api/emergency-upload?tvIP=x.x.x.x

**Note:** This is a **server-level API**, not a player CGI command. Documented here for completeness.

**Behavior:**
1. Power on the TV
2. Discover player IP via TV (pjctrl endpoint)
3. Wipe SD card (`wipeDrive`)
4. Create `EMERGENCY CONTENTS` folder
5. Upload files in order
6. Restart player

```javascript
// Server endpoint
POST /api/emergency-upload?tvIP=192.168.100.198
Content-Type: multipart/form-data

[multipart files here]

// Response
{
  "ok": true,
  "tvIP": "192.168.100.198",
  "playerIP": "192.168.100.199",
  "folderName": "EMERGENCY CONTENTS",
  "files": [
    { "filename": "alert1.png", "bytes": 204800 },
    { "filename": "alert2.png", "bytes": 153600 }
  ]
}
```

---

## Complete Playback Workflow

The typical sequence to switch a display to a folder:

```javascript
async function playFolder(playerIP, folderPath, interval = 30) {
  // 1. Enter file manager mode (required prerequisite)
  await post(playerIP, '/cgi-bin/cgictrl?FM=');

  // 2. Navigate to root
  await post(playerIP, '/cgi-bin/cgictrl?FL=-01');

  // 3. Read filelist to verify folder exists
  const fileList = await getFileList(playerIP);
  const folder = fileList.fileinfo.find(f => f.name === 'EventFolder' && f.type === 0);
  if (!folder) throw new Error('Folder not found');

  // 4. Configure autoplay settings (before restart)
  const pathCmd = encodeAutoPlayPath(`/mnt/usb1/${folder.name}`);
  await post(playerIP, `/cgi-bin/cgictrl?${pathCmd}`);

  const intervalCmd = encodeSlideInterval(interval);
  await post(playerIP, `/cgi-bin/cgictrl?${intervalCmd}`);

  const modeCmd = 'V=S,2A,2,0,1,%00,';  // mode 1 = slideshow
  await post(playerIP, `/cgi-bin/cgictrl?${modeCmd}`);

  // 5. Restart player (commit all V=S settings, start autoplay)
  const clock = Date.now();
  await post(playerIP, `/cgi-bin/cgictrl?RSG=${clock}`);

  // 6. Wait for player to recover from restart
  await waitForPlayerReady(playerIP, 30000);

  // 7. Now use TV's NEC protocol to switch input to Media Player
  // (handled by server.js vcpSet)
}
```

---

## Quirks & Gotchas

### FM= State Resets on Restart

After RSG= or RSB=:
- File manager mode state is cleared
- `/mmb/filelist.json` returns 404 again
- Must re-send FM= before next filelist access

### Path Encoding Asymmetry

When **setting** autoplay folder (V=S,2B):
- Use `encodeURIComponent()` on **full path** (includes slashes)
- Calculate len = **encoded** length + 1

When **reading** filelist:
- Directory path is provided decoded in JSON response
- Reconstruct full path from navigation history

### No Symlinks or Special Files

- All entries in filelist are real files or folders
- No symlinks, shortcuts, or hidden files
- File order is undefined (filesystem-dependent)

### Index-Based Navigation Only

- FL= requires numeric index (0-based)
- No path argument support (e.g., `FL=/path/to/folder` **invalid**)
- Must read filelist to find folder name, then FL=<index>

### Single Bracket Dimension

- Maximum nesting depth: not documented
- Typical deployments use 1-2 levels (e.g., `/mnt/usb1/EventName/`)
- Very deep paths may fail (untested)

### Upload Concurrency

- Only one upload batch per RSG=
- If Fu= completes without RSG=, files are orphaned in temp state
- Always follow Fu= with RSG=

### Timing Considerations

- File operations are synchronous on firmware
- Creating/deleting folders is instant
- Restarting player (RSG=) takes **2-5 seconds**
- Always use `waitForPlayerReady()` to detect recovery

---

## Error Handling

All CGI commands return HTTP 200 OK (body="OK") regardless of success or failure. No in-protocol error codes.

**Detect failures by:**
1. Try operation → HTTP 200
2. Verify result by querying filelist
3. If unexpected state → retry or log warning

```javascript
async function createAndNavigateFolder(playerIP, name) {
  await post(playerIP, '/cgi-bin/cgictrl?FL=-01');
  await post(playerIP, `/cgi-bin/cgictrl?FC=${encodeURIComponent(name)}`);

  // Verify creation
  const list = await getFileList(playerIP);
  const folder = list.fileinfo.find(f => f.name === name && f.type === 0);
  if (!folder) {
    throw new Error(`Failed to create folder: ${name}`);
  }

  // Navigate into it
  const idx = list.fileinfo.indexOf(folder);
  await post(playerIP, `/cgi-bin/cgictrl?FL=${String(idx).padStart(3, '0')}`);
}
```

---

## Testing with the Simulator

The simulator (`simulator/player-http.js`) reproduces:
- Correct HTTP 200 responses for all commands
- In-memory filesystem (folder/file creation/deletion)
- Trailing-comma JSON bug (authentic to firmware)
- FM= prerequisite for filelist.json access
- FileManagerActive flag (set on FM=, reset on RSG=/RSB=)
- Settings persistence (V=S commands store values)
- Cable disconnection simulation

---

## Further Reading

- **Real player:** NEC media player HTTP CGI interface (undocumented, reverse-engineered)
- **Server integration:** `server.js` player subsystem
- **Simulator:** `simulator/player-http.js` for testing without hardware
- **TV integration:** `NEC-7142-SPEC.md` — NEC protocol for input switching

