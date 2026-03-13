import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import os from 'os';
import QRCode from 'qrcode';
import { localServerExpressTunnel } from './remoteRequest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const wss_domain = process.env.RELAY_HOST || 'dev-drop.sophtwhere.com';
const rootPath = process.env.RELAY_ROOT_PATH || '/the-venue-club'; 
const LOCAL_WS_PORT = 8080;

const app = express();

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    if (ifaces['br-lan']) {
        const ipv4 = ifaces['br-lan'].find(a => a.family === 'IPv4');
        if (ipv4) return ipv4.address;
    }
    for (const [ifname, addrs] of Object.entries(ifaces)) {
        if (ifname.startsWith('usb') || ifname.startsWith('wwan') || ifname.startsWith('tun')) continue;
        const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
        if (ipv4 && (ipv4.address.startsWith('192.168.') || ipv4.address.startsWith('10.') || ipv4.address.startsWith('172.'))) {
            return ipv4.address;
        }
    }
    return '127.0.0.1';
}

const magicTokens = new Map(); 

// --- 1. THE SMART GATEWAY API ---

// Generate the QR Code
app.get(rootPath + '/gateway/qr', async (req, res) => {
    const token = crypto.randomBytes(8).toString('hex');
    magicTokens.set(token, { expires: Date.now() + 600000 }); // 10 mins
    
    const lanIp = `${getLocalIp()}:${LOCAL_WS_PORT}`;
    const joinUrl = `https://${wss_domain}${rootPath}/gateway/join?token=${token}&lan=${lanIp}`;
    
    try {
        const qrDataUrl = await QRCode.toDataURL(joinUrl, { color: { dark: '#e91e63', light: '#ffffff' }, margin: 2 });
        res.send(`
            <!DOCTYPE html><html><body style="background:#1c1c24; color:white; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; font-family:sans-serif;">
                <h2>Scan to Connect</h2>
                <img src="${qrDataUrl}" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 250px; height: 250px;" />
                <p style="color:#aaa; font-size:0.8em; margin-top:20px;">Or visit:<br><a href="${joinUrl}" style="color:#89dceb; word-break:break-all;">${joinUrl}</a></p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send("Failed to generate QR code.");
    }
});

// The entry point for QR scans AND successful manual logins
app.get(rootPath + '/gateway/join', (req, res) => {
    const { token, lan } = req.query;
    
    if (!magicTokens.has(token) || magicTokens.get(token).expires < Date.now()) {
        return res.status(401).send("<h1>Link Expired or Invalid</h1>");
    }
    magicTokens.delete(token);

    // Issue the cookie for the current domain (usually the public tunnel)
    res.cookie('venue_auth', 'stagehand123', { maxAge: 86400000, httpOnly: true });

    // Generate a secure Handoff Token just in case they pivot to the LAN
    const handoffToken = crypto.randomBytes(8).toString('hex');
    magicTokens.set(handoffToken, { expires: Date.now() + 60000 }); // 60 seconds

    // Serve the Smart Router Ping Race
    // Serve the Smart Router Ping Race
    res.send(`
        <!DOCTYPE html><html><head><title>Connecting...</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { background: #0f0f13; color: #fff; font-family: sans-serif; display: flex; flex-direction:column; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .spinner { width: 40px; height: 40px; border: 4px solid #444; border-top: 4px solid #e91e63; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            #status { color: #aaa; font-size: 0.9em; }
        </style>
        </head><body>
            <div class="spinner"></div>
            <h2>Authenticating...</h2>
            <div id="status">Verifying security token...</div>
            
            <script>
                (async function() {
                    const lanTarget = "${lan}";
                    const rootPath = "${rootPath}";
                    const statusEl = document.getElementById('status');
                    
                    try {
                        statusEl.innerText = "Searching for local network...";
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 8000);
                        
                        await fetch('http://' + lanTarget + rootPath + '/api/ping', { 
                            mode: 'no-cors', 
                            signal: controller.signal 
                        });
                        
                        clearTimeout(timeoutId);
                        
                        // Pivot to LAN with the Handoff Token!
                        statusEl.innerText = "Local network found! Switching...";
                        statusEl.style.color = "#a6e3a1";
                        setTimeout(() => { window.location.href = 'http://' + lanTarget + rootPath + '/gateway/claim?token=${handoffToken}'; }, 200);
                        
                    } catch (err) {
                        // Stay on the Tunnel
                        statusEl.innerText = "Securing remote tunnel...";
                        statusEl.style.color = "#89dceb";
                        setTimeout(() => { window.location.href = rootPath + '/index.html'; }, 200);
                    }
                })();
            </script>
        </body></html>
    `);
});

// The receiver for the LAN pivot
app.get(rootPath + '/gateway/claim', (req, res) => {
    const token = req.query.token;
    
    // Verify the handoff token from the tunnel
    if (magicTokens.has(token) && magicTokens.get(token).expires > Date.now()) {
        magicTokens.delete(token);
        // Issue the cookie for the LOCAL LAN domain
        res.cookie('venue_auth', 'stagehand123', { maxAge: 86400000, httpOnly: true });
        res.redirect(rootPath + '/index.html');
    } else {
        res.redirect(rootPath + '/login');
    }
});


// --- 2. ZERO-TRUST WEBSOCKET SERVER ---
const localWss = new WebSocketServer({ 
    port: LOCAL_WS_PORT,
    verifyClient: (info, callback) => {
        // EVERYONE must have a cookie, local or remote.
        const cookieStr = info.req.headers.cookie || '';
        if (cookieStr.includes('venue_auth=stagehand123')) return callback(true); 
        
        console.log(`[WSS Security] Blocked unauthenticated connection from ${info.req.socket.remoteAddress}`);
        callback(false, 401, 'Unauthorized');
    }
});

let userCount = 0;
localWss.on('connection', (ws, req) => {
    userCount++;
    const userId = `User${userCount}`;
    broadcast(`[System] ${userId} joined the chat.`, false);
    ws.on('message', (msg, isBinary) => broadcast(`${userId}: ${msg.toString()}`, isBinary));
    function broadcast(text, isBinary) {
        localWss.clients.forEach(client => {
            if (client.readyState === 1) client.send(text, { binary: isBinary });
        });
    }
});


// --- 3. ZERO-TRUST EXPRESS AIRLOCK ---
app.use((req, res, next) => {
    // 1. Allow the Gateway routing endpoints and the Ping test
    if (req.path.startsWith(rootPath + '/gateway/') || 
        req.path === rootPath + '/login' ||
        req.path === rootPath + '/api/ping') {
        return next(); 
    }

    // 2. Everyone else must be authenticated
    if (req.cookies['venue_auth'] === 'stagehand123') return next();

    // 3. Reject
    if (req.path.startsWith(rootPath + '/api/')) {
        return res.status(401).json({ error: "Unauthorized" });
    } else {
        return res.redirect(rootPath + '/login');
    }
});


// --- 4. MANUAL LOGIN ---
app.get(rootPath + '/login', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><title>The Venue Club</title><style>
            body { background: #0f0f13; color: #fff; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .login-box { background: #1c1c24; padding: 40px; border-radius: 8px; text-align: center; border-top: 4px solid #e91e63; }
            input { width: 100%; padding: 10px; margin: 10px 0; background: #2a2a35; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #e91e63; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;}
        </style></head><body><div class="login-box"><h2>The Venue Club</h2>
        <form method="POST" action="${rootPath}/login"><input type="password" name="password" placeholder="Access Code" required><button type="submit">ENTER</button></form>
        </div></body></html>
    `);
});

app.post(rootPath + '/login', (req, res) => {
    if (req.body.password === 'demo') { 
        // Feed manual log-ins right into the Smart Gateway flow!
        const token = crypto.randomBytes(8).toString('hex');
        magicTokens.set(token, { expires: Date.now() + 60000 });
        const lanIp = `${getLocalIp()}:${LOCAL_WS_PORT}`;
        
        res.redirect(`${rootPath}/gateway/join?token=${token}&lan=${lanIp}`);
    } else {
        res.status(401).send('Access Denied');
    }
});


// --- 5. PROTECTED ROUTES ---
app.get(rootPath, (req, res) => res.redirect(rootPath + '/index.html'));
app.use(rootPath, express.static(path.join(__dirname, 'public')));
app.get(rootPath + '/api/ping', (req, res) => res.json({ status: "ok", time: Date.now() }));
app.post(rootPath + '/api/upload', (req, res) => {
    let bodyBytes = 0;
    req.on('data', chunk => { bodyBytes += chunk.length; });
    req.on('end', () => res.json({ filename: "auth-upload.bin", size: bodyBytes }));
});

// --- 6. ATTACH THE TUNNEL ---
localServerExpressTunnel(app, wss_domain, rootPath, LOCAL_WS_PORT);

console.log(`[Gateway] Display QR Code to users at: http://localhost:${LOCAL_WS_PORT}${rootPath}/gateway/qr`);