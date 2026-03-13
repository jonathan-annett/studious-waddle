import { readFileSync, writeFileSync, existsSync, fstat, read  } from 'fs';
import { join } from 'path';
import express from 'express';
import { createServer } from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash,randomBytes } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs';

import { publicServerExpressTunnel } from './remoteRequest.js';

// ESM Fix for otplib
const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

const bootSeed = createHash('sha1').update(randomBytes(32)).digest('base64url');

const app = express();

const requests = new Map();
const contentHashes = new Map();
const sockets = new Map();

const auth = createHash('sha256').update(process.argv[1]).digest('base64url');
const readCert = async (fn) => {
    const r = await fetch('http://localhost:9999/' + fn, { headers: { 'x-auth': auth } });
    return await r.text();
};

const httpsOptions = {
    cert: await readCert('cert.pem'),
    ca: await readCert('chain.pem'),
    key: await readCert('privkey.pem')
};

const server = createServer(httpsOptions, app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.static(join(import.meta.dirname, 'public')));

// --- ZERO-CONFIG EDGE APP SHELL CACHE ---
const edgeCache = new Map();

// 1. Ingestion endpoint for OpenWRT routers to push their UI
// Increased limit to 50mb to handle embedded SVGs/images comfortably
app.post('/api/edge-publish', express.json({ limit: '50mb' }), (req, res) => {
    const { tenant, files } = req.body;
    if (!tenant || !files) return res.status(400).send("Invalid payload");
    
    edgeCache.set(tenant, files);
    console.log(`[Edge Cache] Received and cached UI for tenant: /${tenant}`);
    res.send({ status: 'ok' });
});

// 2. Edge Serving Middleware
app.use('/:tenant', (req, res, next) => {
    const tenant = req.params.tenant;
    const cache = edgeCache.get(tenant);

    // --- NEW: Explicitly bypass the Edge Cache for dynamic backend routes ---
    const isDynamic = req.path.startsWith('/api/') || 
                      req.path.startsWith('/gateway/') || 
                      req.path.startsWith('/s/') || 
                      req.path === '/login' || 
                      req.path === '/logout' ||
                      req.path === '/sacn-connect';

    if (isDynamic) {
        return next(); // Forward immediately to the OpenWRT tunnel
    }

    if (cache) {
        let filename = req.path;
        
        // If it's the root, or a UI deep link (no file extension), serve index.html
        if (filename === '/' || filename === '' || !filename.includes('.')) {
            filename = '/index.html';
        } else if (filename.includes('/')) {
            // BUG FIX: If deep-linked HTML asks for /test-1/app.js, normalize it to /app.js
            filename = '/' + filename.split('/').pop();
        }

        const fileKey = filename.substring(1);

        if (cache[fileKey]) {
            res.type(cache[fileKey].type);
            return res.send(cache[fileKey].content);
        }
    }
    
    next(); 
});
// ----------------------------------------

// The tunnel catches anything that wasn't served by the Edge Cache
publicServerExpressTunnel(app, wss, server);
 
const PORT = process.env.PORT || 443;

server.listen(PORT, () => console.log(`[relay] Relay ready on port ${PORT}`));