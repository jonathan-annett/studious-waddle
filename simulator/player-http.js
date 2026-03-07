/**
 * simulator/player-http.js
 *
 * HTTP server simulating the NEC media player CGI interface.
 * Implements:
 *   GET  /mmb/filelist.json          — directory listing (with firmware trailing-comma bug)
 *   POST /cgi-bin/cgictrl?<command>  — all CGI control commands
 *
 * In-memory filesystem mirrors real player structure rooted at /mnt/usb1/.
 * Zero npm dependencies — Node.js built-ins only.
 */

import http from 'node:http';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory filesystem
// ─────────────────────────────────────────────────────────────────────────────

const ROOT_PATH = '/mnt/usb1';

function makeFile(name, size = 1024) {
  return { name, size, date: '2026/01/01 00:00:00', type: 1 };
}

function makeFolder(name) {
  return { name, size: 0, date: '2026/01/01 00:00:00', type: 0, children: new Map() };
}

function makeDefaultFilesystem() {
  const root = makeFolder('');
  const folders = ['folder1', 'folder2', 'folder3', 'folder4', 'all'];
  for (const f of folders) {
    const dir = makeFolder(f);
    dir.children.set('sim-content.txt', makeFile('sim-content.txt', 2048));
    root.children.set(f, dir);
  }
  return root;
}

/**
 * Compute the path string for a node given a parent path.
 * The root node has name '' so ROOT_PATH alone is returned.
 */
function nodePath(parentPath, nodeName) {
  if (!nodeName) return parentPath;
  return `${parentPath}/${nodeName}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// filelist.json builder  (reproduces firmware trailing-comma bug)
// ─────────────────────────────────────────────────────────────────────────────

function buildFilelistJson(dir, dirPath) {
  const entries = Array.from(dir.children.values()).map(e => ({
    name: e.name,
    size: e.type === 0 ? 0 : e.size,
    date: e.date,
    type: e.type,
  }));

  const itemsJson = entries.map(e => JSON.stringify(e)).join(',');
  // Intentional firmware bug: trailing comma before ]
  return `{"dir_path":"${dirPath}/","file_cnt":${entries.length},"fileinfo":[${itemsJson},]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multipart body parser (for Fu= file upload)
// ─────────────────────────────────────────────────────────────────────────────

function extractBoundary(contentType) {
  const m = (contentType || '').match(/boundary=([^\s;]+)/i);
  return m ? m[1].replace(/^"/, '').replace(/"$/, '') : null;
}

function parseMultipart(bodyBuf, boundary) {
  const files = [];
  const delim     = Buffer.from(`\r\n--${boundary}`);
  const startDelim = Buffer.from(`--${boundary}`);

  let pos = bodyBuf.indexOf(startDelim);
  if (pos < 0) return files;
  pos += startDelim.length;
  if (pos + 2 <= bodyBuf.length && bodyBuf[pos] === 0x0D && bodyBuf[pos+1] === 0x0A) pos += 2;

  while (pos < bodyBuf.length) {
    const nextBound = bodyBuf.indexOf(delim, pos);
    if (nextBound < 0) break;

    const partBuf   = bodyBuf.slice(pos, nextBound);
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) { pos = nextBound + delim.length + 2; continue; }

    const headerStr = partBuf.slice(0, headerEnd).toString('ascii');
    const bodyBuf2  = partBuf.slice(headerEnd + 4);

    const fnMatch = headerStr.match(/filename="([^"]+)"/i);
    if (fnMatch) {
      files.push({ name: fnMatch[1], size: bodyBuf2.length });
    }

    pos = nextBound + delim.length;
    if (pos + 2 <= bodyBuf.length && bodyBuf[pos] === 0x2D && bodyBuf[pos+1] === 0x2D) break;
    if (pos + 2 <= bodyBuf.length) pos += 2;
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: read full request body as Buffer
// ─────────────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CGI command dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/** Navigate the player filesystem state, mutating player.cwd and player.cwdPath */
function handleFL(value, player, log) {
  if (value === '-01') {
    // Go to root
    player.cwd     = player.fs;
    player.cwdPath = ROOT_PATH;
    log(`FL=-01 → root`);
    return;
  }

  if (value === '-02') {
    // Go to parent
    if (player.cwdParents.length > 0) {
      const p = player.cwdParents.pop();
      player.cwd     = p.node;
      player.cwdPath = p.path;
      log(`FL=-02 → ${player.cwdPath}`);
    }
    return;
  }

  // Navigate into item at zero-based index
  const idx = parseInt(value, 10);
  if (isNaN(idx) || idx < 0) return;

  const entries = Array.from(player.cwd.children.values());
  if (idx >= entries.length) return;

  const target = entries[idx];
  if (target.type !== 0) return; // can only navigate into folders

  player.cwdParents.push({ node: player.cwd, path: player.cwdPath });
  player.cwd     = target;
  player.cwdPath = `${player.cwdPath}/${target.name}`;
  log(`FL=${value} → ${player.cwdPath}`);
}

/** Parse a V= command from the raw query string value (after 'V=') */
function handleVCommand(rawVal, player, log) {
  // rawVal examples:
  //   'S,2A,2,0,1,%00,'         set AutoPlay mode=1
  //   'G,2A,1,0,%00,'           get AutoPlay mode
  //   'S,2B,35,1,%2Fmnt%2F...,%00,'  set AutoPlay folder
  //   'S,22,5,0,30,%00,'        set slideshow interval
  const parts = rawVal.split(',');
  const op    = parts[0]; // 'S' or 'G'
  const code  = parts[1]; // '2A', '2B', '22', etc.

  if (op === 'S') {
    const val = parts[4]; // 4th comma-separated item is the value
    if (code === '2A') {
      player.settings.autoPlayMode = parseInt(val, 10) || 0;
      log(`V=S,2A → autoPlayMode=${player.settings.autoPlayMode}`);
    } else if (code === '2B') {
      try {
        player.settings.autoPlayFolder = decodeURIComponent(val);
      } catch {
        player.settings.autoPlayFolder = val;
      }
      log(`V=S,2B → autoPlayFolder=${player.settings.autoPlayFolder}`);
    } else if (code === '22') {
      player.settings.slideInterval = parseInt(val, 10) || 30;
      log(`V=S,22 → slideInterval=${player.settings.slideInterval}`);
    }
  }
  // V=G responses: just return 200 OK — server.js doesn't parse them for core flow
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: createPlayerHttpServer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and start the player HTTP server for one virtual device.
 *
 * @param {object}   device   - shared device state (device.player holds player sub-state)
 * @param {object}   opts
 * @param {number}   opts.port         - HTTP port (default 80)
 * @param {Function} opts.onLog        - log callback
 * @returns {http.Server}
 */
export function createPlayerHttpServer(device, { port = 80, onLog } = {}) {
  const log = (msg) => onLog?.(`[Player-HTTP ${device.name || device.id}] ${msg}`);

  // Per-device player state
  if (!device.player) {
    device.player = {
      fs: makeDefaultFilesystem(),
      cwd: null,
      cwdPath: ROOT_PATH,
      cwdParents: [],
      settings: {
        autoPlayMode:   0,
        autoPlayFolder: `${ROOT_PATH}/folder1`,
        slideInterval:  30,
      },
      // Fault injection: if Date.now() < restartingUntil, serve HTML instead of JSON
      restartingUntil: 0,
      serveHtmlFor:    0, // configurable ms to return HTML after RSG= (fault injection)
    };
    device.player.cwd = device.player.fs;
  }

  const server = http.createServer(async (req, res) => {
    const urlPath  = req.url.split('?')[0];
    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';

    // ── GET /mmb/filelist.json ───────────────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/mmb/filelist.json') {
      // Fault injection: briefly return HTML after RSG= to test waitForPlayerReady
      if (Date.now() < device.player.restartingUntil) {
        const html = `<HTML><HEAD><TITLE>Please wait...</TITLE></HEAD><BODY>Restarting...</BODY></HTML>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      const json = buildFilelistJson(device.player.cwd, device.player.cwdPath);
      log(`GET /mmb/filelist.json → ${device.player.cwdPath} (${device.player.cwd.children.size} items)`);
      res.writeHead(200, {
        'Content-Type':  'text/plain',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
      return;
    }

    // ── POST /cgi-bin/cgictrl?<command> ──────────────────────────────────────
    if (urlPath === '/cgi-bin/cgictrl') {
      const body = await readBody(req);

      // Parse command from query string: split on first '='
      const eqIdx = rawQuery.indexOf('=');
      const cmd   = eqIdx >= 0 ? rawQuery.slice(0, eqIdx) : rawQuery;
      const val   = eqIdx >= 0 ? rawQuery.slice(eqIdx + 1) : '';

      // ── FL navigation ──
      if (cmd === 'FL') {
        handleFL(val, device.player, log);
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── FM= (file manager mode) ──
      if (cmd === 'FM') {
        log(`FM= (file manager mode entered)`);
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── FC= create folder ──
      if (cmd === 'FC') {
        let name;
        try { name = decodeURIComponent(val); } catch { name = val; }
        if (name && !device.player.cwd.children.has(name)) {
          device.player.cwd.children.set(name, makeFolder(name));
          log(`FC= created folder '${name}' in ${device.player.cwdPath}`);
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── FD= delete file/folder ──
      if (cmd === 'FD') {
        let name;
        try { name = decodeURIComponent(val); } catch { name = val; }
        if (name && device.player.cwd.children.has(name)) {
          device.player.cwd.children.delete(name);
          log(`FD= deleted '${name}' from ${device.player.cwdPath}`);
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── Fu= file upload (multipart/form-data) ──
      if (cmd === 'Fu') {
        const boundary = extractBoundary(req.headers['content-type']);
        if (boundary && body.length > 0) {
          const files = parseMultipart(body, boundary);
          for (const f of files) {
            device.player.cwd.children.set(f.name, makeFile(f.name, f.size));
            log(`Fu= uploaded '${f.name}' (${f.size} bytes) to ${device.player.cwdPath}`);
          }
        } else {
          log(`Fu= received (no files parsed, boundary=${boundary})`);
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── RSG= finalise/commit upload + restart player ──
      if (cmd === 'RSG') {
        log(`RSG=${val} — player restart`);
        if (device.player.serveHtmlFor > 0) {
          device.player.restartingUntil = Date.now() + device.player.serveHtmlFor;
          log(`fault injection: will serve HTML for ${device.player.serveHtmlFor}ms`);
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── RSB= restart player only ──
      if (cmd === 'RSB') {
        log(`RSB=${val} — player restart (RSB)`);
        if (device.player.serveHtmlFor > 0) {
          device.player.restartingUntil = Date.now() + device.player.serveHtmlFor;
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── V= settings (get/set) ──
      if (cmd === 'V') {
        handleVCommand(val, device.player, log);
        res.writeHead(200);
        res.end('OK');
        return;
      }

      // ── Unknown command ──
      log(`unknown cgictrl command: ${cmd}=${val}`);
      res.writeHead(200);
      res.end('OK');
      return;
    }

    // ── Fallback ──
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, device.playerIP, () => {
    log(`Player HTTP server listening on ${device.playerIP}:${port}`);
  });

  server.on('error', (err) => log(`Player HTTP server error on ${device.playerIP}:${port} — ${err.message}`));

  return server;
}
