// server.js
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import dgram from 'dgram';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

import { localServerExpressTunnel } from '../../relay-poc/remoteRequest.js'; 
import { parseSacnPacket, sacnMulticastAddr, buildSacnPacket } from './sacn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === 'production';
const staticDir = isProd ? path.join(__dirname, 'dist') : path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const PORT = 4004;

const wss_domain = process.env.RELAY_HOST || 'dev-drop.sophtwhere.com';
const rootPath = process.env.RELAY_ROOT_PATH || '/the-venue-club'; 
const SECURITY_TIER = 2; 

const STATE_FILE = path.join(__dirname, 'dmx-state.json');
const PRESETS_FILE = path.join(__dirname, 'dmx-presets.json');
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

let whitelist = [];
if (fs.existsSync(WHITELIST_FILE)) {
    whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
} else {
    whitelist = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
}

const totalChannels = 512;
const activeUniverses = new Map(); 
const joinedMulticastGroups = new Set(); 
const magicTokens = new Map();

let environmentPresets = {};
if (fs.existsSync(PRESETS_FILE)) {
    try { environmentPresets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } 
    catch (err) {}
}

function savePresetsToDisk() {
    fs.writeFile(PRESETS_FILE, JSON.stringify(environmentPresets), () => {});
}

function broadcastPresetList(deviceName, state) {
    const list = Object.keys(environmentPresets[deviceName] || {});
    const msg = JSON.stringify({ type: 'preset-list', presets: list });
    state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function createEmptyState() {
    return {
        values: new Array(totalChannels).fill(0), enabled: new Array(totalChannels).fill(true),
        protected: new Array(totalChannels).fill(false), names: new Array(totalChannels).fill(''),
        defaultNames: new Array(totalChannels).fill(''), glyphs: new Array(totalChannels).fill(''), 
        customLayout: [], customLayoutName: 'CUSTOM LAYOUT', serverLayout: null,
        radioGroups: [], radioColors: new Array(totalChannels).fill(''), lastRadioState: {}, 
        history: new Array(totalChannels).fill(null).map(() => []), uiClients: new Set(),
        universeId: null, relayUniverse: null, relaySequence: 0, backendClient: null
    };
}

if (fs.existsSync(STATE_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (savedData.values && Array.isArray(savedData.values)) {
            const defaultState = createEmptyState();
            Object.assign(defaultState, savedData);
            defaultState.universeId = 9999; 
            activeUniverses.set('default', defaultState);
        } else {
            for (const [name, data] of Object.entries(savedData)) {
                const state = createEmptyState();
                Object.assign(state, data);
                if (name === 'default') state.universeId = 9999; 
                activeUniverses.set(name, state);
            }
        }
    } catch (err) {}
}

if (!activeUniverses.has('default')) {
    const defState = createEmptyState();
    defState.universeId = 9999; 
    activeUniverses.set('default', defState);
}

function persistState() {
    const stateData = {};
    for (const [name, state] of activeUniverses.entries()) {
        stateData[name] = {
            values: state.values, enabled: state.enabled, protected: state.protected,
            names: state.names, defaultNames: state.defaultNames, glyphs: state.glyphs,
            customLayout: state.customLayout, customLayoutName: state.customLayoutName,
            serverLayout: state.serverLayout, radioGroups: state.radioGroups,
            radioColors: state.radioColors, relayUniverse: state.relayUniverse
        };
    }
    fs.writeFile(STATE_FILE, JSON.stringify(stateData), () => {});
}

function getOrInitUniverse(name) {
    if (!activeUniverses.has(name)) activeUniverses.set(name, createEmptyState());
    return activeUniverses.get(name);
}

function evaluateRadioGroups(state) {
    if (!state.radioGroups || state.radioGroups.length === 0) return;
    let colorsChanged = false;
    let commandsToSend = [];

    state.radioGroups.forEach((group, gIdx) => {
        const activeChannels = group.filter(ch => state.values[ch] >= 128);
        group.forEach(ch => {
            let newColor = activeChannels.includes(ch) ? (activeChannels.length === 1 ? 'green' : 'yellow') : '';
            if (state.radioColors[ch] !== newColor) {
                state.radioColors[ch] = newColor;
                colorsChanged = true;
            }
        });

        let resolvedState = activeChannels.length === 0 ? 'stop' : (activeChannels.length === 1 ? `start-${activeChannels[0]}` : 'transition');
        if (resolvedState !== 'transition' && resolvedState !== state.lastRadioState[gIdx]) {
            state.lastRadioState[gIdx] = resolvedState;
            commandsToSend.push(resolvedState === 'stop' ? { type: 'tv-command', action: 'stop', group: gIdx } : { type: 'tv-command', action: 'start', channel: activeChannels[0], group: gIdx });
        }
    });

    if (colorsChanged) {
        const colorMsg = JSON.stringify({ type: 'radio-colors', colors: state.radioColors });
        state.uiClients.forEach(c => { if (c.readyState === 1) c.send(colorMsg); });
        persistState();
    }
    if (commandsToSend.length > 0 && state.backendClient && state.backendClient.readyState === 1) {
        commandsToSend.forEach(cmd => state.backendClient.send(JSON.stringify(cmd)));
    }
}

function buildGlobalMeta() {
    const meta = {};
    for (const [name, envState] of activeUniverses.entries()) {
        meta[name] = { universeId: envState.universeId, names: envState.names, defaultNames: envState.defaultNames, radioGroups: envState.radioGroups, serverLayoutName: envState.serverLayout ? envState.serverLayout.name : null };
    }
    return meta;
}

function broadcastGlobalMeta() {
    const metaUpdate = JSON.stringify({ type: 'global-meta', meta: buildGlobalMeta() });
    for (const envState of activeUniverses.values()) {
        envState.uiClients.forEach(c => { if (c.readyState === 1) c.send(metaUpdate); });
    }
}

function getHostLanIp() {
    const ifaces = os.networkInterfaces();
    for (const [ifname, addrs] of Object.entries(ifaces)) {
        if (ifname.startsWith('usb') || ifname.startsWith('wwan') || ifname.startsWith('tun')) continue;
        const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
        if (ipv4 && (ipv4.address.startsWith('192.168.') || ipv4.address.startsWith('10.'))) return ipv4.address;
    }
    return '127.0.0.1';
}

// --- SECURE SHORTLINKS & GATEWAY ---
app.get(rootPath + '/api/gateway/link', (req, res) => {
    const token = crypto.randomBytes(4).toString('hex'); // 8-char shortlink ID
    const type = req.query.type || 'qr';
    const ttl = type === 'clipboard' ? 300000 : 45000; // 5 mins vs 45 secs
    const expires = Date.now() + ttl;
    const target = req.query.target || '';
    const device = req.query.device || 'default';
    
    const lanIp = `${getHostLanIp()}:${PORT}`;
    const joinUrl = `https://${wss_domain}${rootPath}/gateway/join?token=${token}&lan=${lanIp}&target=${encodeURIComponent(target)}`;
    
    magicTokens.set(token, { expires, joinUrl, device, type });
    const shortUrl = `https://${wss_domain}${rootPath}/s/${token}`;
    
    res.json({ url: shortUrl, expires, token, ttl });
});

// Shortlink Interceptor
app.get(rootPath + '/s/:token', (req, res) => {
    const token = req.params.token;
    const linkData = magicTokens.get(token);

    if (!linkData || linkData.expires < Date.now()) {
        if (linkData) magicTokens.delete(token);
        return res.status(404).send("This secure link has expired, been revoked, or is invalid.");
    }

    // Notify the UI that generated it
    const targetState = activeUniverses.get(linkData.device);
    if (targetState) {
        const msg = JSON.stringify({ type: 'link-used', token });
        targetState.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    }

    // Redirect to the actual payload mechanism which handles LAN handoff
    res.redirect(linkData.joinUrl);
});

app.get(rootPath + '/gateway/join', (req, res) => {
    const { token, lan, target } = req.query;
    const targetPath = target ? '/' + target : '/connect';
    
    if (!magicTokens.has(token) || magicTokens.get(token).expires < Date.now()) return res.status(401).send("Expired Link");
    magicTokens.delete(token); // Consume the token
    
    res.cookie('venue_auth', 'stagehand123', { maxAge: 86400000, httpOnly: true });
    const handoffToken = crypto.randomBytes(8).toString('hex');
    magicTokens.set(handoffToken, { expires: Date.now() + 60000 });
    
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="background:#11111b;color:#cdd6f4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div id="status">Routing...</div>
        <script>
            (async function() {
                try {
                    const ctrl = new AbortController();
                    setTimeout(() => ctrl.abort(), 400);
                    await fetch('http://${lan}${rootPath}/api/ping', { mode: 'no-cors', signal: ctrl.signal });
                    window.location.href = 'http://${lan}${rootPath}/gateway/claim?token=${handoffToken}&target=${encodeURIComponent(target || '')}';
                } catch (e) { window.location.href = '${rootPath}${targetPath}'; }
            })();
        </script></body></html>`);
});

app.get(rootPath + '/gateway/claim', (req, res) => {
    const { token, target } = req.query;
    const targetPath = target ? '/' + target : '/connect';
    if (magicTokens.has(token) && magicTokens.get(token).expires > Date.now()) {
        magicTokens.delete(token);
        res.cookie('venue_auth', 'stagehand123', { maxAge: 86400000, httpOnly: true });
        res.redirect(rootPath + targetPath);
    } else res.redirect(rootPath + '/login');
});

// --- AIRLOCK MIDDLEWARE ---
app.use((req, res, next) => {
    if (SECURITY_TIER === 1) return next();
    
    const isPublicPath = req.path.startsWith(rootPath + '/gateway/') || 
                         req.path.startsWith(rootPath + '/s/') || 
                         req.path === rootPath + '/login' || 
                         req.path === rootPath + '/api/ping' ||
                         req.path === rootPath + '/manifest.json' ||
                         req.path === rootPath + '/sw.js';
                         
    if (isPublicPath) return next();
    if (req.cookies['venue_auth'] === 'stagehand123') return next();
    if (req.headers.accept?.includes('application/json')) return res.status(401).json({ error: "Auth Required" });
    res.redirect(rootPath + '/login');
});

app.get(rootPath + '/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><body style="background:#11111b; color:#cdd6f4; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh;">
        <form method="POST" style="background:#1e1e2e; padding:40px; border-radius:8px; border:1px solid #45475a; text-align:center;">
            <h2>The Venue Club</h2>
            <input type="password" name="password" placeholder="Access Code" style="background:#313244; color:white; border:none; padding:10px; border-radius:4px;"><br><br>
            <button type="submit" style="background:#a6e3a1; border:none; padding:10px 20px; border-radius:4px; cursor:pointer;">ENTER</button>
        </form></body></html>`);
});

app.post(rootPath + '/login', (req, res) => {
    if (req.body.password === 'demo') {
        res.cookie('venue_auth', 'stagehand123', { maxAge: 86400000, httpOnly: true });
        res.redirect(rootPath + '/connect');
    } else res.status(401).send("Unauthorized");
});

app.get(rootPath + '/logout', (req, res) => {
    res.clearCookie('venue_auth');
    res.redirect(rootPath + '/login');
});

app.get(rootPath + '/api/ping', (req, res) => res.json({ status: "ok", time: Date.now() }));

app.get(rootPath + '/connect', (req, res) => {
    let html = `<!DOCTYPE html><html><body style="background:#11111b; color:#cdd6f4; font-family:monospace; padding:40px;"><h1>Available Consoles</h1><ul>`;
    for (const [name, state] of activeUniverses.entries()) {
        const uniLabel = state.universeId ? `(Universe ${state.universeId})` : '(Offline Prep)';
        const displayLabel = name === 'default' ? 'Default Test Env (Universe 9999)' : name;
        const link = `${rootPath}/${name}`;
        html += `<li><a href="${link}" style="color:#89dceb; font-size: 1.2em; line-height: 2;">${displayLabel} ${uniLabel}</a></li>`;
    }
    html += `</ul><br><a href="${rootPath}/logout" style="color:#f38ba8;">Logout</a></body></html>`;
    res.send(html);
});

app.use((req, res, next) => {
    if (req.path.match(/\.(js|css|json|png|svg|ico)$/)) {
        const filename = req.path.split('/').pop();
        const correctPath = rootPath + '/' + filename;
        if (req.path !== correctPath) return res.redirect(correctPath);
    }
    next();
});

app.use(rootPath, express.static(staticDir));
app.get(rootPath + '/:deviceName', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
app.get(rootPath + '/:deviceName/:layout', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

const uiWss = new WebSocketServer({ noServer: true });
const backendWss = new WebSocketServer({ noServer: true });

function broadcastToSubscribers(targetDeviceName, channel, wsMessage) {
    const targetState = activeUniverses.get(targetDeviceName);
    for (const [envName, envState] of activeUniverses.entries()) {
        const isNative = envName === targetDeviceName;
        const isBorrowed = envState.customLayout.some(item => {
            if (typeof item === 'string') {
                if (item === `${targetDeviceName}:${channel}`) return true;
                if (item.startsWith(`${targetDeviceName}:group:`)) {
                    const gIdx = parseInt(item.split(':')[2]);
                    if (targetState && targetState.radioGroups[gIdx] && targetState.radioGroups[gIdx].includes(channel)) return true;
                }
            } else if (typeof item === 'number') {
                if (isNative && item === channel) return true;
            }
            return false;
        });
        if (isNative || isBorrowed) {
            envState.uiClients.forEach(client => { if (client.readyState === 1) client.send(wsMessage); });
        }
    }
}

uiWss.on('connection', (ws, request) => {
    const deviceName = ws.deviceName;
    const state = getOrInitUniverse(deviceName);
    state.uiClients.add(ws);

    const isOnline = deviceName === 'default' ? true : !!state.backendClient;
    const isTunneled = request.headers['x-is-tunneled'] === 'true';

    ws.send(JSON.stringify({
        type: 'init', values: state.values, enabled: state.enabled, protected: state.protected,
        names: state.names, defaultNames: state.defaultNames, glyphs: state.glyphs,
        customLayout: state.customLayout, customLayoutName: state.customLayoutName, serverLayout: state.serverLayout,
        radioColors: state.radioColors, history: state.history, isOnline, isTunneled, globalMeta: buildGlobalMeta() 
    }));

    ws.send(JSON.stringify({ type: 'preset-list', presets: Object.keys(environmentPresets[deviceName] || {}) }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Link Revocation Event
            if (data.type === 'revoke-link') {
                if (magicTokens.has(data.token)) magicTokens.delete(data.token);
                return;
            }

            if (data.type === 'get-global-meta') return ws.send(JSON.stringify({ type: 'global-meta', meta: buildGlobalMeta() }));
            
            if (data.type === 'update-layout') {
                state.customLayout = data.layout; persistState();
                const msg = JSON.stringify({ type: 'layout-sync', layout: state.customLayout });
                return state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
            }

            if (data.type === 'update-layout-name') {
                state.customLayoutName = data.name; persistState();
                const msg = JSON.stringify({ type: 'layout-name-sync', name: state.customLayoutName });
                return state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
            }

            if (data.type === 'save-preset') {
                if (!environmentPresets[deviceName]) environmentPresets[deviceName] = {};
                environmentPresets[deviceName][data.name] = {
                    values: [...state.values], enabled: [...state.enabled], protected: [...state.protected],
                    names: [...state.names], glyphs: [...state.glyphs],
                    customLayout: [...state.customLayout], customLayoutName: state.customLayoutName
                };
                savePresetsToDisk();
                return broadcastPresetList(deviceName, state);
            }

            if (data.type === 'load-preset') {
                const p = environmentPresets[deviceName]?.[data.name];
                if (p) {
                    state.values = [...p.values]; state.enabled = [...p.enabled]; state.protected = [...p.protected];
                    state.names = [...p.names];
                    if (p.glyphs) state.glyphs = [...p.glyphs];
                    if (p.customLayout) state.customLayout = [...p.customLayout];
                    if (p.customLayoutName) state.customLayoutName = p.customLayoutName;
                    
                    persistState(); evaluateRadioGroups(state); triggerRelay(state); 
                    
                    const initMsg = JSON.stringify({
                        type: 'init', values: state.values, enabled: state.enabled, protected: state.protected,
                        names: state.names, defaultNames: state.defaultNames, glyphs: state.glyphs,
                        customLayout: state.customLayout, customLayoutName: state.customLayoutName, serverLayout: state.serverLayout,
                        radioColors: state.radioColors, history: state.history,
                        isOnline: deviceName === 'default' ? true : !!state.backendClient, isTunneled, globalMeta: buildGlobalMeta()
                    });
                    state.uiClients.forEach(c => { if (c.readyState === 1) c.send(initMsg); });
                }
                return;
            }

            if (data.type === 'delete-preset') {
                if (environmentPresets[deviceName]?.[data.name]) {
                    delete environmentPresets[deviceName][data.name];
                    savePresetsToDisk(); broadcastPresetList(deviceName, state);
                }
                return;
            }

            if (data.type === 'update') {
                const targetDeviceName = data.device || deviceName;
                const targetState = activeUniverses.get(targetDeviceName);
                if (!targetState) return;

                const { channel, value, enabled, protected: isProtected, name, source } = data;
                
                if (channel >= 0 && channel < totalChannels) {
                    let stateChanged = false;

                    if (isProtected !== undefined && targetState.protected[channel] !== isProtected) { targetState.protected[channel] = isProtected; stateChanged = true; }
                    if (name !== undefined && targetState.names[channel] !== name) { targetState.names[channel] = name; stateChanged = true; }

                    if (!(targetState.protected[channel] && source === 'human')) {
                        if (value !== undefined && targetState.values[channel] !== value) { targetState.values[channel] = value; stateChanged = true; }
                        if (enabled !== undefined && targetState.enabled[channel] !== enabled) { targetState.enabled[channel] = enabled; stateChanged = true; }
                    }
                    
                    const broadcastMessage = JSON.stringify({ type: 'update', device: targetDeviceName, channel, value, enabled, protected: isProtected, name, source: source || 'human' });
                    broadcastToSubscribers(targetDeviceName, channel, broadcastMessage);

                    if (source === 'human' && targetState.backendClient && targetState.backendClient.readyState === 1) targetState.backendClient.send(broadcastMessage);
                    if (stateChanged && source === 'human') { evaluateRadioGroups(targetState); triggerRelay(targetState); persistState(); }
                }
            }
        } catch (error) {}
    });

    ws.on('close', () => { state.uiClients.delete(ws); });
});

backendWss.on('connection', (ws, request) => {
    let boundState = null;
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.universe !== undefined && data.name) {
                boundState = getOrInitUniverse(data.name);
                if (data.radioGroups && Array.isArray(data.radioGroups)) {
                    let validGlyphs = true;
                    const providedGlyphs = data.glyphs || [];
                    for (const group of data.radioGroups) {
                        for (const ch of group) {
                            if (!providedGlyphs[ch] || typeof providedGlyphs[ch] !== 'string' || providedGlyphs[ch].trim() === '') { validGlyphs = false; break; }
                        }
                        if (!validGlyphs) break;
                    }
                    if (!validGlyphs) return (ws.send(JSON.stringify({ type: 'error', message: 'Missing glyphs for radio group channels.' })), ws.close()); 
                }

                boundState.universeId = data.universe;
                boundState.backendClient = ws;
                let updatedDefaults = false;

                if (data.relayUniverse !== undefined) { boundState.relayUniverse = parseInt(data.relayUniverse); updatedDefaults = true; triggerRelay(boundState); }
                if (data.radioGroups && Array.isArray(data.radioGroups)) { boundState.radioGroups = data.radioGroups; updatedDefaults = true; }
                if (data.serverLayout && typeof data.serverLayout === 'object') {
                    boundState.serverLayout = { name: data.serverLayout.name || 'API Layout', slug: data.serverLayout.slug || 'api', channels: Array.isArray(data.serverLayout.channels) ? data.serverLayout.channels : [] };
                    updatedDefaults = true;
                }
                if (data.defaultNames && Array.isArray(data.defaultNames)) {
                    for (let i = 0; i < totalChannels; i++) {
                        if (data.defaultNames[i]) { boundState.defaultNames[i] = data.defaultNames[i]; if (!boundState.names[i]) boundState.names[i] = data.defaultNames[i]; updatedDefaults = true; }
                    }
                }
                if (data.glyphs && Array.isArray(data.glyphs)) {
                    for (let i = 0; i < totalChannels; i++) {
                        if (data.glyphs[i]) { boundState.glyphs[i] = data.glyphs[i]; updatedDefaults = true; }
                    }
                }

                if (updatedDefaults) { persistState(); broadcastGlobalMeta(); }
                evaluateRadioGroups(boundState);

                const initMsg = JSON.stringify({
                    type: 'init', values: boundState.values, enabled: boundState.enabled, protected: boundState.protected,
                    names: boundState.names, defaultNames: boundState.defaultNames, glyphs: boundState.glyphs,
                    customLayout: boundState.customLayout, customLayoutName: boundState.customLayoutName, serverLayout: boundState.serverLayout,
                    radioColors: boundState.radioColors, history: boundState.history, isOnline: true, isTunneled: false, globalMeta: buildGlobalMeta()
                });
                boundState.uiClients.forEach(c => { if (c.readyState === 1) c.send(initMsg); });

                if (!joinedMulticastGroups.has(data.universe)) {
                    const multicastAddress = sacnMulticastAddr(data.universe);
                    try {
                        const localIp = getHostLanIp();
                        if (localIp) sacnSocket.addMembership(multicastAddress, localIp);
                        else sacnSocket.addMembership(multicastAddress);
                        joinedMulticastGroups.add(data.universe);
                    } catch (err) {}
                }
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        if (boundState) {
            boundState.backendClient = null;
            const statusMsg = JSON.stringify({ type: 'status', online: false });
            boundState.uiClients.forEach(c => { if (c.readyState === 1) c.send(statusMsg); });
        }
    });
});

server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    let checkPath = pathname;
    if (checkPath.startsWith(rootPath)) checkPath = checkPath.substring(rootPath.length);

    if (checkPath === '/sacn-connect') {
        if (request.headers['x-is-tunneled'] === 'true') return (socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'), socket.destroy());
        const ip = request.socket.remoteAddress;
        if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') return (socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'), socket.destroy());
        backendWss.handleUpgrade(request, socket, head, (ws) => backendWss.emit('connection', ws, request));
    } else if (checkPath.startsWith('/ui/')) {
        if (SECURITY_TIER > 1 && !request.headers.cookie?.includes('venue_auth=stagehand123')) return (socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'), socket.destroy());
        uiWss.handleUpgrade(request, socket, head, (ws) => {
            ws.deviceName = checkPath.replace('/ui/', '');
            uiWss.emit('connection', ws, request);
        });
    } else socket.destroy();
});

const SACN_PORT = 5568;
const sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sacnSocket.on('listening', () => {
    try { sacnSocket.setMulticastLoopback(true); } catch (e) {}
    const testUniverse = 9999;
    const multicastAddress = sacnMulticastAddr(testUniverse);
    const localIp = getHostLanIp();
    if (localIp) { try { sacnSocket.setMulticastTTL(64); sacnSocket.setMulticastInterface(localIp); } catch (e) {} }
    try {
        if (localIp) sacnSocket.addMembership(multicastAddress, localIp);
        else sacnSocket.addMembership(multicastAddress);
        joinedMulticastGroups.add(testUniverse);
    } catch (err) {}
});

sacnSocket.on('message', (msg, rinfo) => {
    const parsed = parseSacnPacket(msg);
    if (!parsed) return;

    const timestamp = Date.now();
    const targetEntries = Array.from(activeUniverses.entries()).filter(([n, s]) => s.universeId === parsed.universe);
    
    for (const [deviceName, state] of targetEntries) {
        let valuesChanged = false; 
        const radioChannels = new Set();
        state.radioGroups.forEach(g => g.forEach(ch => radioChannels.add(ch)));

        for (let channel = 0; channel < parsed.dmx.length; channel++) {
            const newValue = parsed.dmx[channel];
            const lastConsoleRequest = state.history[channel].length > 0 ? state.history[channel][0].value : -1;

            if (newValue !== lastConsoleRequest) {
                state.history[channel].unshift({ value: newValue, time: timestamp });
                if (state.history[channel].length > 4) state.history[channel].pop();

                const isRadioProtected = state.protected[channel] && radioChannels.has(channel);

                if (state.enabled[channel] && !isRadioProtected) {
                    if (state.values[channel] !== newValue) {
                        state.values[channel] = newValue;
                        valuesChanged = true; 
                    }
                }

                const wsMessage = JSON.stringify({ type: 'update', device: deviceName, channel, value: state.values[channel], enabled: state.enabled[channel], protected: state.protected[channel], name: state.names[channel], history: state.history[channel], source: 'console' });
                broadcastToSubscribers(deviceName, channel, wsMessage);
                if (state.backendClient && state.backendClient.readyState === 1) state.backendClient.send(wsMessage);
            }
        }
        if (valuesChanged) { evaluateRadioGroups(state); triggerRelay(state); }
    }
});

sacnSocket.bind(SACN_PORT);

const RELAY_KEEPALIVE_MS = 800;
function triggerRelay(state) {
    if (!state.relayUniverse) return;
    if (state.relayTimer) clearTimeout(state.relayTimer);
    if (state.relaySequence === undefined) state.relaySequence = 0;

    const packet = buildSacnPacket(state.relayUniverse, state.relaySequence, `Sidecar Relay (${state.universeId})`, state.values);
    sacnSocket.send(packet, SACN_PORT, sacnMulticastAddr(state.relayUniverse), () => {});

    state.relaySequence = (state.relaySequence + 1) % 256;
    state.relayTimer = setTimeout(() => triggerRelay(state), RELAY_KEEPALIVE_MS);
}

for (const state of activeUniverses.values()) { if (state.relayUniverse) triggerRelay(state); }

// --- ZERO-CONFIG EDGE PUBLISHER & SW GENERATOR ---
function getAppVersionHash() {
    try {
        const h = crypto.createHash('md5');
        const appJsPath = path.join(staticDir, 'app.js');
        const consoleJsPath = path.join(staticDir, 'dmx-console.js');
        if (fs.existsSync(appJsPath)) h.update(fs.readFileSync(appJsPath));
        if (fs.existsSync(consoleJsPath)) h.update(fs.readFileSync(consoleJsPath));
        return h.digest('hex').substring(0, 8);
    } catch(e) { return Date.now().toString(); }
}

async function publishToEdgeGateway() {
    try {
        const tenant = rootPath.substring(1); 
        const files = {};
        const addFile = (name, type, content) => { files[name] = { type, content }; };

        // 1. Read physical UI files
        addFile('index.html', 'text/html', fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'));
        addFile('app.js', 'application/javascript', fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8'));
        addFile('dmx-console.js', 'application/javascript', fs.readFileSync(path.join(staticDir, 'dmx-console.js'), 'utf8'));
        addFile('manifest.json', 'application/json', fs.readFileSync(path.join(staticDir, 'manifest.json'), 'utf8'));

        // --- BUG FIX: Add the QR Code library to the Edge Payload ---
        try {
            addFile('qrcode.min.js', 'application/javascript', fs.readFileSync(path.join(staticDir, 'qrcode.min.js'), 'utf8'));
        } catch(e) { console.warn("qrcode.min.js not found in static dir, skipping edge publish for this file."); }

        // 2. Generate the dynamic SW content
        const appVersion = getAppVersionHash();
        const swContent = `
const CACHE_NAME = 'dmx-console-v${appVersion}';

self.addEventListener('install', (event) => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(clients.claim()); });

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    
    // Do not cache API, Gateway, or Shortlink requests
    if (url.pathname.includes('/api/') || url.pathname.includes('/gateway/') || url.pathname.includes('/s/')) return;

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).then((response) => {
                if (response.status === 404) return caches.match(self.registration.scope + 'index.html');
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(self.registration.scope + 'index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const networkFetch = fetch(event.request).then((response) => {
                if (response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {});
            return cachedResponse || networkFetch;
        })
    );
});`;
        
        // 3. Add the generated worker to the payload and serve it locally
        addFile('sw.js', 'application/javascript', swContent);
        
        app.get(rootPath + '/sw.js', (req, res) => {
            res.type('application/javascript');
            res.send(swContent);
        });

        // 4. Push to the VPS
        const payload = { tenant, files };
        const response = await fetch(`https://${wss_domain}/api/edge-publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`[Edge Publish] UI pushed to VPS (${wss_domain}) successfully.`);
        } else {
            console.warn(`[Edge Publish] Failed. VPS responded with: ${response.status}`);
        }
    } catch (e) {
        console.warn(`[Edge Publish] Cannot reach VPS (${wss_domain}). Operating locally only.`);
    }
}

server.listen(PORT, () => {
    if (isProd) {
        console.log("Server booting in PRODUCTION mode.");
    } else {
        console.log("Server booting in DEV mode.");
    }
    console.log(`Web UI routing online at http://localhost:${PORT}${rootPath}`);
    
    localServerExpressTunnel(app, wss_domain, rootPath, PORT);
    
    // Trigger the edge push immediately on startup
    publishToEdgeGateway();
});