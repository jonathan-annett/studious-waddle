import path from 'path';
import { WebSocketServer } from 'ws';
import { localServerVanillaTunnel, vanillaServeStaticFile, localServerExpressTunnel } from './remoteRequest.js';

const wss_domain = process.env.RELAY_HOST || 'dev-drop.sophtwhere.com';
const rootPath = process.env.RELAY_ROOT_PATH || '/test-dashboard';
const RELAY_BACKEND = process.env.RELAY_BACKEND || 'local-vanilla-server';

// --- LOCAL INTERNAL WEBSOCKET SERVER ---
const LOCAL_WS_PORT = 8080;
const localWss = new WebSocketServer({ port: LOCAL_WS_PORT });

// Quick and dirty user counter
let userCount = 0;

localWss.on('connection', (ws, req) => {
    userCount++;
    const userId = `User${userCount}`;
    console.log(`[Local WSS] ${userId} joined the chat.`);
    
    // Broadcast system message
    broadcast(`[System] ${userId} joined the chat.`, false);

    ws.on('message', (msg, isBinary) => {
        // Broadcast user message to everyone
        broadcast(`${userId}: ${msg.toString()}`, isBinary);
    });

    ws.on('close', () => {
        console.log(`[Local WSS] ${userId} left.`);
        broadcast(`[System] ${userId} left the chat.`, false);
    });

    function broadcast(text, isBinary) {
        localWss.clients.forEach(client => {
            if (client.readyState === 1 /* WebSocket.OPEN */) {
                client.send(text, { binary: isBinary });
            }
        });
    }
});
// ----------------------------------------

 
localServerVanillaTunnel(wss_domain, rootPath, LOCAL_WS_PORT, async (req, res) => {
    console.log(`[Vanilla App] ${req.method} ${req.url}`);

    if (req.url === rootPath || req.url === rootPath + '/') {
        return res.status(302).setHeader('Location', rootPath + '/index.html').end();
    }

    const isStaticServed = await vanillaServeStaticFile(req, res, rootPath, './public');
    if (isStaticServed) return;

    if (req.url.startsWith(rootPath + '/api/ping')) {
        return res.status(200)
                  .setHeader('Content-Type', 'application/json')
                  .end(JSON.stringify({ status: "ok", time: Date.now() }));
    }

    if (req.method === 'POST' && req.url.startsWith(rootPath + '/api/upload')) {
        let bodyBytes = 0;
        req.on('data', chunk => { bodyBytes += chunk.length; });
        req.on('end', () => {
            res.status(200)
               .setHeader('Content-Type', 'application/json')
               .end(JSON.stringify({ filename: "raw-vanilla-upload.bin", size: bodyBytes }));
        });
        return;
    }

    res.status(404).setHeader('Content-Type', 'text/plain').end('404 Not Found');
});

console.log(`[${RELAY_BACKEND}] Local Test App ready. Visit https://${wss_domain}${rootPath}`);