// server.js
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import dgram from 'dgram';
import os from 'os';
import { fileURLToPath } from 'url';

import { localServerExpressTunnel } from '../../relay-poc/remoteRequest.js'; // <-- NEW: Import tunnel

import { parseSacnPacket, sacnMulticastAddr, buildSacnPacket } from './sacn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === 'production';
const staticDir = isProd ? path.join(__dirname, 'dist') : path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const PORT = 4004;

const STATE_FILE = path.join(__dirname, 'dmx-state.json');
const PRESETS_FILE = path.join(__dirname, 'dmx-presets.json');
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');

let whitelist = [];
if (fs.existsSync(WHITELIST_FILE)) {
    whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
} else {
    console.warn("No whitelist.json found. Creating default allowing localhost.");
    whitelist = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
}

const totalChannels = 512;
const activeUniverses = new Map(); 
const joinedMulticastGroups = new Set(); 

let environmentPresets = {};
if (fs.existsSync(PRESETS_FILE)) {
    try {
        environmentPresets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    } catch (err) {
        console.error('Error reading presets file:', err);
    }
}

function savePresetsToDisk() {
    fs.writeFile(PRESETS_FILE, JSON.stringify(environmentPresets), (err) => {
        if (err) console.error('Failed to save presets to disk:', err);
    });
}

function broadcastPresetList(deviceName, state) {
    const list = Object.keys(environmentPresets[deviceName] || {});
    const msg = JSON.stringify({ type: 'preset-list', presets: list });
    state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function createEmptyState() {
    return {
        values: new Array(totalChannels).fill(0),
        enabled: new Array(totalChannels).fill(true),
        protected: new Array(totalChannels).fill(false),
        names: new Array(totalChannels).fill(''),
        defaultNames: new Array(totalChannels).fill(''), 
        glyphs: new Array(totalChannels).fill(''), 
        customLayout: [],
        customLayoutName: 'CUSTOM LAYOUT',
        serverLayout: null,
        radioGroups: [], 
        radioColors: new Array(totalChannels).fill(''), 
        lastRadioState: {}, 
        history: new Array(totalChannels).fill(null).map(() => []),
        uiClients: new Set(),
        universeId: null,
        relayUniverse: null, 
        relaySequence: 0,
        backendClient: null
    };
}

if (fs.existsSync(STATE_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        
        if (savedData.values && Array.isArray(savedData.values)) {
            const defaultState = createEmptyState();
            defaultState.values = savedData.values;
            defaultState.enabled = savedData.enabled || defaultState.enabled;
            defaultState.protected = savedData.protected || savedData.hidden || defaultState.protected;
            defaultState.names = savedData.names || defaultState.names;
            defaultState.defaultNames = savedData.defaultNames || defaultState.defaultNames;
            defaultState.glyphs = savedData.glyphs || defaultState.glyphs;
            defaultState.customLayout = savedData.customLayout || [];
            defaultState.customLayoutName = savedData.customLayoutName || 'CUSTOM LAYOUT';
            defaultState.serverLayout = savedData.serverLayout || null;
            defaultState.radioGroups = savedData.radioGroups || [];
            defaultState.radioColors = savedData.radioColors || new Array(totalChannels).fill('');
            defaultState.relayUniverse = savedData.relayUniverse || null;
            defaultState.universeId = 9999; 
            activeUniverses.set('default', defaultState);
        } else {
            for (const [name, data] of Object.entries(savedData)) {
                const state = createEmptyState();
                state.values = data.values || state.values;
                state.enabled = data.enabled || state.enabled;
                state.protected = data.protected || state.protected;
                state.names = data.names || state.names;
                state.defaultNames = data.defaultNames || state.defaultNames;
                state.glyphs = data.glyphs || state.glyphs;
                state.customLayout = data.customLayout || [];
                state.customLayoutName = data.customLayoutName || 'CUSTOM LAYOUT';
                state.serverLayout = data.serverLayout || null;
                state.radioGroups = data.radioGroups || [];
                state.radioColors = data.radioColors || new Array(totalChannels).fill('');
                state.relayUniverse = data.relayUniverse || null;
                if (name === 'default') state.universeId = 9999; 
                activeUniverses.set(name, state);
            }
        }
    } catch (err) {
        console.error('Error reading state file:', err);
    }
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
            values: state.values,
            enabled: state.enabled,
            protected: state.protected,
            names: state.names,
            defaultNames: state.defaultNames,
            glyphs: state.glyphs,
            customLayout: state.customLayout,
            customLayoutName: state.customLayoutName,
            serverLayout: state.serverLayout,
            radioGroups: state.radioGroups,
            radioColors: state.radioColors,
            relayUniverse: state.relayUniverse
        };
    }
    fs.writeFile(STATE_FILE, JSON.stringify(stateData), (err) => {
        if (err) console.error('Failed to save state to disk:', err);
    });
}

function getOrInitUniverse(name) {
    if (!activeUniverses.has(name)) {
        activeUniverses.set(name, createEmptyState());
    }
    return activeUniverses.get(name);
}

function evaluateRadioGroups(state) {
    if (!state.radioGroups || state.radioGroups.length === 0) return;

    let colorsChanged = false;
    let commandsToSend = [];

    state.radioGroups.forEach((group, gIdx) => {
        const activeChannels = group.filter(ch => state.values[ch] >= 128);
        
        group.forEach(ch => {
            let newColor = '';
            if (activeChannels.includes(ch)) {
                newColor = activeChannels.length === 1 ? 'green' : 'yellow';
            }
            if (state.radioColors[ch] !== newColor) {
                state.radioColors[ch] = newColor;
                colorsChanged = true;
            }
        });

        let resolvedState = activeChannels.length === 0 ? 'stop' : (activeChannels.length === 1 ? `start-${activeChannels[0]}` : 'transition');
        
        if (resolvedState !== 'transition' && resolvedState !== state.lastRadioState[gIdx]) {
            state.lastRadioState[gIdx] = resolvedState;
            if (resolvedState === 'stop') {
                commandsToSend.push({ type: 'tv-command', action: 'stop', group: gIdx });
            } else {
                commandsToSend.push({ type: 'tv-command', action: 'start', channel: activeChannels[0], group: gIdx });
            }
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
        meta[name] = {
            universeId: envState.universeId,
            names: envState.names,
            defaultNames: envState.defaultNames,
            radioGroups: envState.radioGroups,
            serverLayoutName: envState.serverLayout ? envState.serverLayout.name : null
        };
    }
    return meta;
}

function broadcastGlobalMeta() {
    const metaUpdate = JSON.stringify({ type: 'global-meta', meta: buildGlobalMeta() });
    for (const envState of activeUniverses.values()) {
        envState.uiClients.forEach(c => { if (c.readyState === 1) c.send(metaUpdate); });
    }
}

if (isProd) {
    console.log("🚀 Server booting in PRODUCTION mode. Serving optimized assets from /dist");
} else {
    console.log("🛠️ Server booting in DEV mode. Serving raw assets from /public");
}

app.use(express.static(staticDir));

// --- NEW: Ping endpoint for local-first connection test ---
app.get('/api/ping', (req, res) => {
    res.json({ status: "ok", time: Date.now() });
});


app.get('/connect', (req, res) => {
    let html = `<h1>Available Consoles</h1><ul>`;
    for (const [name, state] of activeUniverses.entries()) {
        const uniLabel = state.universeId ? `(Universe ${state.universeId})` : '(Offline Prep)';
        const displayLabel = name === 'default' ? 'Default Test Env (Universe 9999)' : name;
        const link = name === 'default' ? '/' : `/${name}`;
        html += `<li><a href="${link}" style="font-size: 1.2em; line-height: 2;">${displayLabel} ${uniLabel}</a></li>`;
    }
    html += `</ul>`;
    res.send(html);
});

app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
});

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
                    if (targetState && targetState.radioGroups[gIdx] && targetState.radioGroups[gIdx].includes(channel)) {
                        return true;
                    }
                }
            } else if (typeof item === 'number') {
                if (isNative && item === channel) return true;
            }
            return false;
        });

        if (isNative || isBorrowed) {
            envState.uiClients.forEach((client) => {
                if (client.readyState === 1) client.send(wsMessage);
            });
        }
    }
}

uiWss.on('connection', (ws, request) => {
    const deviceName = ws.deviceName;
    console.log(`UI Client connected to environment: ${deviceName}`);
    
    const state = getOrInitUniverse(deviceName);
    state.uiClients.add(ws);

    const isOnline = deviceName === 'default' ? true : !!state.backendClient;

    ws.send(JSON.stringify({
        type: 'init',
        values: state.values,
        enabled: state.enabled,
        protected: state.protected,
        names: state.names,
        defaultNames: state.defaultNames,
        glyphs: state.glyphs,
        customLayout: state.customLayout,
        customLayoutName: state.customLayoutName,
        serverLayout: state.serverLayout,
        radioColors: state.radioColors, 
        history: state.history,
        isOnline: isOnline,
        globalMeta: buildGlobalMeta() 
    }));

    const presetsList = Object.keys(environmentPresets[deviceName] || {});
    ws.send(JSON.stringify({ type: 'preset-list', presets: presetsList }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'get-global-meta') {
                ws.send(JSON.stringify({ type: 'global-meta', meta: buildGlobalMeta() }));
                return;
            }

            if (data.type === 'update-layout') {
                state.customLayout = data.layout;
                persistState();
                const msg = JSON.stringify({ type: 'layout-sync', layout: state.customLayout });
                state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
                return;
            }

            if (data.type === 'update-layout-name') {
                state.customLayoutName = data.name;
                persistState();
                const msg = JSON.stringify({ type: 'layout-name-sync', name: state.customLayoutName });
                state.uiClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
                return;
            }

            if (data.type === 'save-preset') {
                if (!environmentPresets[deviceName]) environmentPresets[deviceName] = {};
                environmentPresets[deviceName][data.name] = {
                    values: [...state.values],
                    enabled: [...state.enabled],
                    protected: [...state.protected],
                    names: [...state.names],
                    glyphs: [...state.glyphs],
                    customLayout: [...state.customLayout],
                    customLayoutName: state.customLayoutName
                };
                savePresetsToDisk();
                broadcastPresetList(deviceName, state);
                return;
            }

            if (data.type === 'load-preset') {
                const p = environmentPresets[deviceName]?.[data.name];
                if (p) {
                    state.values = [...p.values];
                    state.enabled = [...p.enabled];
                    state.protected = [...p.protected];
                    state.names = [...p.names];
                    if (p.glyphs) state.glyphs = [...p.glyphs];
                    if (p.customLayout) state.customLayout = [...p.customLayout];
                    if (p.customLayoutName) state.customLayoutName = p.customLayoutName;
                    
                    persistState();
                    evaluateRadioGroups(state); 
                    triggerRelay(state); 
                    
                    const initMsg = JSON.stringify({
                        type: 'init',
                        values: state.values,
                        enabled: state.enabled,
                        protected: state.protected,
                        names: state.names,
                        defaultNames: state.defaultNames,
                        glyphs: state.glyphs,
                        customLayout: state.customLayout,
                        customLayoutName: state.customLayoutName,
                        serverLayout: state.serverLayout,
                        radioColors: state.radioColors,
                        history: state.history,
                        isOnline: deviceName === 'default' ? true : !!state.backendClient,
                        globalMeta: buildGlobalMeta()
                    });
                    state.uiClients.forEach(c => { if (c.readyState === 1) c.send(initMsg); });
                }
                return;
            }

            if (data.type === 'delete-preset') {
                if (environmentPresets[deviceName] && environmentPresets[deviceName][data.name]) {
                    delete environmentPresets[deviceName][data.name];
                    savePresetsToDisk();
                    broadcastPresetList(deviceName, state);
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

                    if (isProtected !== undefined && targetState.protected[channel] !== isProtected) {
                        targetState.protected[channel] = isProtected;
                        stateChanged = true;
                    }

                    if (name !== undefined && targetState.names[channel] !== name) {
                        targetState.names[channel] = name;
                        stateChanged = true;
                    }

                    if (!(targetState.protected[channel] && source === 'human')) {
                        if (value !== undefined && targetState.values[channel] !== value) {
                            targetState.values[channel] = value;
                            stateChanged = true;
                        }
                        if (enabled !== undefined && targetState.enabled[channel] !== enabled) {
                            targetState.enabled[channel] = enabled;
                            stateChanged = true;
                        }
                    }
                    
                    const broadcastMessage = JSON.stringify({
                        type: 'update',
                        device: targetDeviceName, 
                        channel, value, enabled, protected: isProtected, name,
                        source: source || 'human' 
                    });

                    broadcastToSubscribers(targetDeviceName, channel, broadcastMessage);

                    if (source === 'human' && targetState.backendClient && targetState.backendClient.readyState === 1) {
                        targetState.backendClient.send(broadcastMessage);
                    }

                    if (stateChanged && source === 'human') {
                        evaluateRadioGroups(targetState); 
                        triggerRelay(targetState); 
                        persistState();
                    }
                }
            }
        } catch (error) {
            console.error('Failed to parse UI WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        state.uiClients.delete(ws);
        console.log(`UI Client disconnected from: ${deviceName}`);
    });
});

backendWss.on('connection', (ws, request) => {
    console.log(`Backend device authenticated from ${request.socket.remoteAddress}`);
    let boundState = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.universe !== undefined && data.name) {
                boundState = getOrInitUniverse(data.name);
                
                // --- NEW: Strict Validation for Radio Groups & Glyphs ---
                if (data.radioGroups && Array.isArray(data.radioGroups)) {
                    let validGlyphs = true;
                    const providedGlyphs = data.glyphs || [];
                    
                    for (const group of data.radioGroups) {
                        for (const ch of group) {
                            if (!providedGlyphs[ch] || typeof providedGlyphs[ch] !== 'string' || providedGlyphs[ch].trim() === '') {
                                validGlyphs = false;
                                break;
                            }
                        }
                        if (!validGlyphs) break;
                    }

                    if (!validGlyphs) {
                        console.error(`[SECURITY] Rejected backend '${data.name}': Missing glyphs for radio group channels.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'All channels inside radioGroups MUST have glyphs provided.' }));
                        ws.close();
                        return; // Hard stop
                    }
                }
                // --------------------------------------------------------

                boundState.universeId = data.universe;
                boundState.backendClient = ws;
                console.log(`Backend registered as '${data.name}' for Universe ${data.universe}`);

                let updatedDefaults = false;

                if (data.relayUniverse !== undefined) {
                    boundState.relayUniverse = parseInt(data.relayUniverse);
                    updatedDefaults = true;
                    triggerRelay(boundState); 
                }
                
                if (data.radioGroups && Array.isArray(data.radioGroups)) {
                    boundState.radioGroups = data.radioGroups;
                    updatedDefaults = true;
                }

                if (data.serverLayout && typeof data.serverLayout === 'object') {
                    boundState.serverLayout = {
                        name: data.serverLayout.name || 'API Layout',
                        slug: data.serverLayout.slug || 'api',
                        channels: Array.isArray(data.serverLayout.channels) ? data.serverLayout.channels : []
                    };
                    updatedDefaults = true;
                }

                if (data.defaultNames && Array.isArray(data.defaultNames)) {
                    for (let i = 0; i < totalChannels; i++) {
                        if (data.defaultNames[i]) {
                            boundState.defaultNames[i] = data.defaultNames[i];
                            if (!boundState.names[i]) boundState.names[i] = data.defaultNames[i];
                            updatedDefaults = true;
                        }
                    }
                }

                if (data.glyphs && Array.isArray(data.glyphs)) {
                    for (let i = 0; i < totalChannels; i++) {
                        if (data.glyphs[i]) {
                            boundState.glyphs[i] = data.glyphs[i];
                            updatedDefaults = true;
                        }
                    }
                }

                if (updatedDefaults) {
                    persistState();
                    broadcastGlobalMeta();
                }
                
                evaluateRadioGroups(boundState);

                const initMsg = JSON.stringify({
                    type: 'init',
                    values: boundState.values,
                    enabled: boundState.enabled,
                    protected: boundState.protected,
                    names: boundState.names,
                    defaultNames: boundState.defaultNames,
                    glyphs: boundState.glyphs,
                    customLayout: boundState.customLayout,
                    customLayoutName: boundState.customLayoutName,
                    serverLayout: boundState.serverLayout,
                    radioColors: boundState.radioColors,
                    history: boundState.history,
                    isOnline: true,
                    globalMeta: buildGlobalMeta()
                });
                boundState.uiClients.forEach(c => { if (c.readyState === 1) c.send(initMsg); });

                if (!joinedMulticastGroups.has(data.universe)) {
                    const multicastAddress = sacnMulticastAddr(data.universe);
                    try {
                        const localIp = getLocalIp();
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

    if (pathname === '/sacn-connect') {
        const ip = request.socket.remoteAddress;
        if (!whitelist.includes(ip)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        backendWss.handleUpgrade(request, socket, head, (ws) => {
            backendWss.emit('connection', ws, request);
        });
    } else if (pathname.startsWith('/ui/')) {
        uiWss.handleUpgrade(request, socket, head, (ws) => {
            ws.deviceName = pathname.replace('/ui/', '');
            uiWss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    if (ifaces['br-lan']) {
        const ipv4 = ifaces['br-lan'].find(a => a.family === 'IPv4');
        if (ipv4) return ipv4.address;
    }
    for (const [ifname, addrs] of Object.entries(ifaces)) {
        if (ifname.startsWith('usb') || ifname.startsWith('wwan') || ifname.startsWith('tun')) continue;
        const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
        if (ipv4 && (ipv4.address.startsWith('192.168.') || ipv4.address.startsWith('10.'))) return ipv4.address;
    }
    return null;
}

const SACN_PORT = 5568;
const sacnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sacnSocket.on('listening', () => {
    const address = sacnSocket.address();
    console.log(`sACN UDP Server listening on ${address.address}:${address.port}`);
    
    try { sacnSocket.setMulticastLoopback(true); } catch (e) {}

    const testUniverse = 9999;
    const multicastAddress = sacnMulticastAddr(testUniverse);
    const localIp = getLocalIp();

    if (localIp) {
        try {
            sacnSocket.setMulticastTTL(64); 
            sacnSocket.setMulticastInterface(localIp);
        } catch (e) {}
    }

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

                const wsMessage = JSON.stringify({
                    type: 'update',
                    device: deviceName, 
                    channel: channel,
                    value: state.values[channel], 
                    enabled: state.enabled[channel],
                    protected: state.protected[channel],
                    name: state.names[channel],
                    history: state.history[channel],
                    source: 'console'
                });

                broadcastToSubscribers(deviceName, channel, wsMessage);

                if (state.backendClient && state.backendClient.readyState === 1) {
                    state.backendClient.send(wsMessage);
                }
            }
        }
        
        if (valuesChanged) {
            evaluateRadioGroups(state);
            triggerRelay(state); 
        }
    }
});

sacnSocket.bind(SACN_PORT);

const RELAY_KEEPALIVE_MS = 800;

function triggerRelay(state) {
    if (!state.relayUniverse) return;

    if (state.relayTimer) clearTimeout(state.relayTimer);
    if (state.relaySequence === undefined) state.relaySequence = 0;

    const packet = buildSacnPacket(state.relayUniverse, state.relaySequence, `Sidecar Relay (${state.universeId})`, state.values);
    const targetIp = sacnMulticastAddr(state.relayUniverse);

    sacnSocket.send(packet, SACN_PORT, targetIp, (err) => {});

    state.relaySequence = (state.relaySequence + 1) % 256;
    state.relayTimer = setTimeout(() => triggerRelay(state), RELAY_KEEPALIVE_MS);
}

for (const state of activeUniverses.values()) {
    if (state.relayUniverse) triggerRelay(state);
}

server.listen(PORT, () => {
    console.log(`Web UI routing online at http://localhost:${PORT}`);
});