# remoteRequest — NAT-Traversal Tunnel Protocol

A custom Layer 7 multiplexing protocol for exposing local HTTP/WebSocket services
through a public relay via a single WebSocket connection. Think of it as self-hosted
ngrok: the local server initiates an outbound WebSocket to the relay, and the relay
reverse-proxies public HTTP requests through that tunnel.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  PUBLIC CLIENTS (browsers, APIs, WebSocket clients)                  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  HTTPS / WSS
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  RELAY SERVER (server.js)                                            │
│  - Public HTTPS endpoint on the internet (e.g. dev-drop.example.com) │
│  - Accepts tunnel connections from local servers                     │
│  - Routes public requests through the correct tunnel                 │
│  - Edge cache: serves static UI files without hitting the tunnel     │
│  Port: 443 (HTTPS)                                                   │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  WSS tunnel (single persistent connection)
                            │  Binary frames (custom protocol below)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LOCAL SERVER (behind NAT/firewall)                                  │
│  - Express app, vanilla Node server, or any HTTP handler             │
│  - Connects outbound to relay — no port forwarding needed            │
│  - Receives tunneled requests, processes locally, sends responses    │
│  Port: any (not publicly exposed)                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Outbound-only**: The local server initiates the WebSocket to the relay.
   No inbound ports, no NAT hole-punching, no UPnP.

2. **Single connection, multiplexed**: All HTTP request/response pairs and
   WebSocket streams share one WebSocket connection, differentiated by frame IDs.

3. **Express-compatible**: The local tunnel creates mock `req`/`res` objects that
   Express middleware processes without modification. Your Express app doesn't
   know it's behind a tunnel.

4. **Edge caching**: The relay can serve static files (HTML, JS, CSS) directly
   from memory, only tunneling dynamic requests (API, WebSocket). Local servers
   push their UI files to the relay via `POST /api/edge-publish`.

---

## Binary Frame Format

Every message between relay and local server is a binary WebSocket frame:

```
Offset  Size  Field         Description
─────── ───── ───────────── ──────────────────────────────────────────────
0       4     frameId       32-bit unsigned LE — unique ID linking
                            request to response(s)
4       1     typeFlags     Lower 4 bits: message type
                            Upper 4 bits: flags (see below)
5       1     metaSize      Length of JSON metadata blob (0–255 bytes)
6       N     metadata      JSON object (UTF-8), present if metaSize > 0
6+N     M     data          Payload (type-dependent encoding)
```

**Minimum frame size: 6 bytes** (header only, no metadata, no data).

### Message Types (lower 4 bits of typeFlags)

| Value | Name             | Data Encoding                        |
|-------|------------------|--------------------------------------|
| 0x00  | TUN_NULL         | No data payload                      |
| 0x01  | TUN_TEXT         | UTF-8 string                         |
| 0x02  | TUN_JSON_OBJ     | JSON object (UTF-8 encoded)          |
| 0x03  | TUN_JSON_ARRAY   | JSON array (UTF-8 encoded)           |
| 0x04  | TUN_ARRAYBUFFER  | Raw ArrayBuffer                      |
| 0x05  | TUN_BUFFER       | Node.js Buffer / raw binary          |
| 0x06  | TUN_UINT8ARRAY   | Uint8Array                           |
| 0x07  | TUN_BOOLEAN      | Single byte: 0x00 = false, else true |

### Flags (upper 4 bits of typeFlags)

| Mask | Name              | Meaning                                    |
|------|-------------------|--------------------------------------------|
| 0x80 | TUN_CAN_REPLY     | Sender expects a reply on this frameId     |
| 0x40 | TUN_MUST_REPLY    | Reply is mandatory (combined with CAN)     |
| 0x20 | TUN_IS_REPLY      | This frame IS a reply to a prior request   |
| 0x10 | TUN_IS_STREAM     | Part of a multi-frame stream (e.g. WS)     |

Flags can be combined. For example, a new HTTP request uses
`TUN_CAN_REPLY (0x80)`, and the response frames use `TUN_IS_REPLY (0x20)`.
WebSocket data frames use `TUN_IS_STREAM (0x10)` with the same frameId
as the original `wsConnect` message.

### Frame ID Lifecycle

- Each side maintains an incrementing counter starting at 1.
- The **initiator** (relay for HTTP requests, local for outbound) assigns the ID.
- All reply frames carry the same frameId with `TUN_IS_REPLY` set.
- Stream frames (WebSocket proxy) carry the same frameId with `TUN_IS_STREAM`.
- When `TUN_CAN_REPLY` is set, the sender attaches a persistent listener
  on the WebSocket that filters for replies matching that frameId.
- The listener is detached when a terminating command (`send`, `end`) arrives,
  or explicitly via `.destroy()`.

---

## HTTP Request Flow (Public → Local)

### Step 1: Relay captures the HTTP request

When a public client makes an HTTP request, the relay's `requestMiddleware`
encodes it as a `TUN_JSON_OBJ` frame:

```json
{
  "method": "POST",
  "url": "/the-venue-club/api/upload",
  "headers": { "content-type": "application/json", ... },
  "response": { "headers": {}, "statusCode": 200 },
  "requestId": "a1b2c3d4e5f6g7h8"
}
```

Flags: `TUN_CAN_REPLY (0x80)` — the relay expects response frames back.

### Step 2: Request body streaming (POST/PUT/PATCH only)

If the request has a body, it arrives in chunks:

```
Frame: TUN_BUFFER, same frameId, metadata: { event: "data", target: "req" }
Data:  [chunk bytes]
```

End of body:

```
Frame: TUN_NULL, same frameId, flags: CAN_REPLY | MUST_REPLY
Metadata: { event: "end", target: "req" }
```

### Step 3: Local server processes the request

The tunnel creates a PassThrough stream as a mock `req` object and a mock `res`
object, then calls `app(req, res, next)`. Body chunks are `.push()`'d into the
stream; `.push(null)` signals EOF.

### Step 4: Response flows back

Every `res` method call on the local side generates a reply frame:

**Headers/status (TUN_JSON_OBJ, IS_REPLY):**
```json
{ "setHeader": ["Content-Type", "application/json"] }
{ "status": [200] }
{ "writeHead": [200, { "Content-Type": "text/html" }] }
```

**Body chunks (TUN_BUFFER, IS_REPLY):**
```
Metadata: { cmd: "write" }
Data: [binary chunk]
```

**End (TUN_JSON_OBJ, IS_REPLY):**
```json
{ "end": [] }
```

### Step 5: Relay applies response commands

The relay's `responseCmdHandler` receives each reply frame and applies it to
the real `res` object. Only whitelisted commands are executed:

```
status, set, setHeader, writeHead, write, send, end
```

Commands `send` and `end` are terminal — they detach the reply listener.

### next() passthrough

If the local Express app calls `next()` (no matching route), the tunnel sends:

```json
{ "next": [] }
```

The relay then continues to the next middleware in its own stack.

---

## WebSocket Proxy Flow

### Step 1: Client connects to relay

A WebSocket client connects to `wss://relay.example.com/the-venue-club/ws-path`.
The relay's `server.on('upgrade')` handler detects this is for a tunneled path.

### Step 2: Relay sends wsConnect

```
Frame: TUN_JSON_OBJ, new frameId (e.g. 42)
Data: { "wsConnect": { "url": "/the-venue-club/ws-path", "headers": { ... } } }
```

### Step 3: Local server opens local WebSocket

The local tunnel receives the `wsConnect`, strips the rootPath, and opens a
WebSocket to `ws://127.0.0.1:<localWsPort>/<remaining-path>`.

### Step 4: Bidirectional streaming

All subsequent messages use the same frameId with `TUN_IS_STREAM`:

**Client → Local:**
```
Relay encodes client WS message as TUN_TEXT or TUN_BUFFER, IS_STREAM, frameId=42
Local tunnel forwards to local WebSocket
```

**Local → Client:**
```
Local WS message arrives
Local tunnel encodes as TUN_TEXT or TUN_BUFFER, IS_STREAM, frameId=42
Relay forwards to client WebSocket
```

### Step 5: Close

Either side sends:
```json
{ "wsClose": true }
```
as `TUN_JSON_OBJ` with `IS_STREAM` and the same frameId.

---

## Tunnel Connection Setup

### Relay side: `publicServerExpressTunnel(app, tunnelWss, server)`

1. Listens for WebSocket connections at `/connect-<rootPath>` (e.g.
   `/connect-the-venue-club`)
2. Creates a `wsTunnel(ws)` instance per connection
3. Registers the tunnel's `requestMiddleware` for that rootPath
4. Express middleware routes requests matching `/<rootPath>/*` through the tunnel
5. WebSocket upgrades for `/<rootPath>/*` are proxied through the tunnel

### Local side: `localServerExpressTunnel(app, wss_domain, rootPath, localWsPort)`

1. Connects to `wss://<wss_domain>/connect-<rootPath>`
2. Creates a `wsTunnel(ws)` instance
3. Listens for incoming request frames and feeds them to `app(req, res, next)`
4. Listens for `wsConnect` frames and bridges to `ws://127.0.0.1:<localWsPort>`
5. Sends heartbeat pings every 30 seconds
6. Auto-reconnects after 3 seconds on disconnect

---

## Edge Cache

The relay supports per-tenant static file caching to avoid tunneling static assets.

### Publishing

Local servers push UI files on startup:

```http
POST /api/edge-publish
Content-Type: application/json

{
  "tenant": "the-venue-club",
  "files": {
    "index.html": { "type": "text/html", "content": "<!DOCTYPE html>..." },
    "app.js": { "type": "application/javascript", "content": "..." }
  }
}
```

### Serving

Requests to `/:tenant/app.js` check the edge cache first. Cache hits are served
directly from the relay's memory. Cache misses fall through to the tunnel.

Dynamic paths (`/api/*`, `/gateway/*`, `/s/*`, `/login`, `/logout`,
`/sacn-connect`) always bypass the cache and go through the tunnel.

---

## Exported API

### `wsTunnel(ws)` → `{ requestMiddleware, on, off, encodeFrame, messageTypes }`

Low-level tunnel over an existing WebSocket. This is the building block used by
both the relay and local sides.

- `requestMiddleware(req, res, next)` — Express middleware that captures HTTP
  requests and sends them through the tunnel
- `on(event, fn)` / `off(event, fn)` — subscribe to message events by type name
  (e.g. `'TUN_JSON_OBJ'`, `'message'` for all)
- `encodeFrame(type, data, flags, frameId, metadata)` → `{ frameId, send, destroy }`
- `messageTypes` — constants object

### `publicServerExpressTunnel(app, tunnelWss, server)`

Set up the relay side. Call once during server initialisation.

- `app` — Express application
- `tunnelWss` — WebSocketServer for tunnel connections (noServer mode)
- `server` — HTTP(S) server (for upgrade handling)

### `localServerExpressTunnel(app, wss_domain, rootPath, localWsPort)`

Set up the local side. Call once; it connects immediately and auto-reconnects.

- `app` — Express application (receives tunneled requests)
- `wss_domain` — Relay hostname (e.g. `'relay.example.com'`)
- `rootPath` — URL prefix (e.g. `'/the-venue-club'`)
- `localWsPort` — Local port for WebSocket proxy bridge

### `vanillaServeStaticFile(req, res, rootPath, publicDir)`

Static file server for non-Express backends. Serves files from `publicDir`,
handles MIME types, prevents directory traversal.

Returns `true` if the file was served, `false` if not found (caller should
handle the request differently).

---

## Implementing an Alternate Backend

To build a tunnel client in another language/platform (Python, ESP32, etc.),
you need to implement:

### 1. WebSocket Client

Connect to `wss://<relay>/connect-<rootPath>` and keep the connection alive
with pings every 30 seconds. Auto-reconnect on disconnect.

### 2. Frame Parser

Read binary WebSocket messages and decode the 6-byte header:

```python
# Pseudocode
frame_id   = read_uint32_le(data, 0)
type_flags = data[4]
meta_size  = data[5]
msg_type   = type_flags & 0x0F
is_reply   = (type_flags & 0x20) != 0
is_stream  = (type_flags & 0x10) != 0
can_reply  = (type_flags & 0x80) != 0
metadata   = json_parse(data[6 : 6 + meta_size]) if meta_size > 0 else {}
payload    = data[6 + meta_size :]
```

### 3. Frame Encoder

Build binary frames for responses:

```python
# Pseudocode
def encode_frame(msg_type, payload_bytes, flags, frame_id, metadata=None):
    meta_bytes = json_encode(metadata).encode('utf-8') if metadata else b''
    header = bytearray(6)
    write_uint32_le(header, 0, frame_id)
    header[4] = msg_type | flags
    header[5] = len(meta_bytes)
    return header + meta_bytes + payload_bytes
```

### 4. HTTP Request Handler

When you receive a `TUN_JSON_OBJ` frame with a `method` field:

1. Extract `method`, `url`, `headers` from the JSON payload
2. If the request has a body, collect subsequent `TUN_BUFFER` frames with
   matching frameId and `metadata.target == "req"` until you see
   `metadata.event == "end"`
3. Process the request with your HTTP handler
4. Send response frames back:
   - `TUN_JSON_OBJ` with `IS_REPLY` flag for headers/status:
     `{ "setHeader": ["Content-Type", "text/plain"] }`
     `{ "status": [200] }`
   - `TUN_BUFFER` with `IS_REPLY` flag and `metadata.cmd = "write"` for body
   - `TUN_JSON_OBJ` with `IS_REPLY` flag: `{ "end": [] }` to finish

### 5. WebSocket Proxy (Optional)

When you receive a `TUN_JSON_OBJ` frame with a `wsConnect` field:

1. Open a local WebSocket to the target
2. Forward all `TUN_TEXT`/`TUN_BUFFER` stream frames (same frameId) to/from it
3. Send `{ "wsClose": true }` when either side disconnects

### 6. Heartbeat

Send WebSocket pings every 30 seconds to prevent NAT timeout.

---

## Environment Variables

| Variable          | Default                      | Description                    |
|-------------------|------------------------------|--------------------------------|
| RELAY_HOST        | dev-drop.sophtwhere.com      | Relay server hostname          |
| RELAY_ROOT_PATH   | /the-venue-club              | URL prefix for this tenant     |
| PORT              | 443 (relay) / 4004 (local)   | Listen port                    |
| NODE_ENV          | development                  | Set to 'production' for builds |

---

## Security Considerations

- Transport: Always use WSS (TLS) for the tunnel connection
- The relay should validate tunnel connections (currently open; consider
  pre-shared keys or JWT)
- The `x-is-tunneled: true` header is injected on all tunneled requests so
  the local server can distinguish tunnel traffic from direct LAN access
- Backend WebSocket connections (`/sacn-connect`) reject tunneled connections
  to prevent remote access to the control plane
- Edge cache `POST /api/edge-publish` has no authentication — should be
  restricted to known tunnel connections or require a shared secret

---

## File Reference

| File                    | Role                                           |
|-------------------------|-------------------------------------------------|
| `remoteRequest.js`      | Core tunnel engine — frame protocol + Express middleware |
| `server.js`             | Public relay server (HTTPS, edge cache, tunnel routing)  |
| `local-express-server.js` | Reference local client (Express + auth + QR gateway)  |
| `public/index.html`     | Diagnostic test suite (HTTP, upload, WebSocket tests)    |
| `public/index.js`       | Frontend test logic                                      |
| `session.json`          | Runtime session state (should not be in git)             |
| `run`                   | Bootstrap script for local deployment                    |
