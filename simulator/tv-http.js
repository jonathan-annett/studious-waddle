/**
 * simulator/tv-http.js
 *
 * HTTP server simulating the TV-side web interface.
 * Only implements the /pjctrl endpoint used by server.js getPlayerIP().
 *
 * Response format: comma-separated signed int32 values where parts[6]
 * is the player IP encoded as a signed int32 (same as real NEC firmware).
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

import http from 'node:http';

/**
 * Encode an IPv4 address string as a signed int32 (Java-style).
 * e.g. 127.0.0.102 → 2130706534
 *      192.168.100.199 → -1062706937 (bit 31 set → negative)
 */
function ipToSignedInt32(ip) {
  const parts = ip.split('.').map(Number);
  const [a, b, c, d] = parts;
  return (((a << 24) | (b << 16) | (c << 8) | d) | 0); // |0 forces int32
}

/**
 * Create and start an HTTP server on tvIP that serves the pjctrl endpoint.
 *
 * @param {object}   device   - shared device state ({ tvIP, playerIP, ... })
 * @param {object}   opts
 * @param {number}   opts.port   - HTTP port (default 80, needs root; use 7580 for dev)
 * @param {Function} opts.onLog  - log callback
 * @returns {http.Server}
 */
export function createTvHttpServer(device, { port = 80, onLog } = {}) {
  const log = (msg) => onLog?.(`[TV-HTTP ${device.name || device.id}] ${msg}`);

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];

    if (path === '/pjctrl') {
      // Serve the player IP discovery response.
      // Real firmware returns ~10 comma-separated ints; parts[6] is the player IP.
      const playerIpInt = ipToSignedInt32(device.playerIP);
      const body = `0,0,0,0,0,0,${playerIpInt},\r\n`;

      log(`GET /pjctrl → playerIP=${device.playerIP} (${playerIpInt})`);

      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // Fallback: minimal NEC-style root page for anything else
    const body = `<html><body><h1>NEC Display Simulator</h1></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
  });

  server.listen(port, device.tvIP, () => {
    log(`TV HTTP server listening on ${device.tvIP}:${port}`);
  });

  server.on('error', (err) => log(`TV HTTP server error on ${device.tvIP}:${port} — ${err.message}`));

  return server;
}
