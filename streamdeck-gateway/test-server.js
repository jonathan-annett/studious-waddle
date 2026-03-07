const WebSocket = require('ws');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

const PORT = 4001;
const WHITELIST_PATH = './whitelist.json';

// --- 1. Express & HTTP Setup ---
const app = express();
const server = http.createServer(app);

// Serve the remote satellite page from the ./public folder
app.use(express.static(path.join(__dirname, 'dist')));


// --- 2. Whitelist Management ---
let whitelist = [];
if (fs.existsSync(WHITELIST_PATH)) {
    try {
        whitelist = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
    } catch (e) {
        console.error("Error reading whitelist.json, starting fresh.");
        whitelist = [];
    }
}

function saveWhitelist() {
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(whitelist, null, 2));
}

// --- 3. Functional Helpers ---

/**
 * Sends a 16:9 Portrait image (sidebar.png) to a 4x4 zone
 */
async function sendZoneImage(ws, imagePath, position = 'right top', bgColor = { r: 0, g: 0, b: 0 }) {
    if (!fs.existsSync(imagePath)) return console.error("File not found:", imagePath);
    
    const imageBuffer = await fs.promises.readFile(imagePath);
    const targetIndices = [
        0, 1, 2, 3,
        8, 9, 10, 11,
        16, 17, 18, 19,
        24, 25, 26, 27
    ];

    ws.send(JSON.stringify({
        event: 'set_zone_fast',
        data: { 
            image: imageBuffer.toString('base64'),
            indices: targetIndices,
            cols: 4, 
            rows: 4,
            position: position,
            background: bgColor
        }
    }));
}

/**
 * Updates a single key with an image
 */
async function setKey(ws, index, color, size = 96) {
    const img = await sharp({
        create: { width: size, height: size, channels: 3, background: color }
    }).png().toBuffer();

    ws.send(JSON.stringify({
        event: 'set_key',
        data: { 
            index: index, 
            image: img.toString('base64')
        }
    }));
}

// --- 4. WebSocket Server Initialization ---
const wss = new WebSocket.Server({ server }); // Attach WSS to the HTTP server
console.log(`🚀 Brain Server running on http://localhost:${PORT}`);
console.log(`🔒 Active Whitelist: ${whitelist.length} devices.`);

wss.on('connection', (ws, req) => {
    const remoteIp = req.socket.remoteAddress;
    // Check if localhost (i7 Gateway)
    const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1';
    
    console.log(`🔌 New Connection Attempt from ${remoteIp} (${isLocal ? 'LOCAL' : 'REMOTE'})`);

    ws.on('message', async (message) => {
        try {
            const { event, data } = JSON.parse(message);

            if (event === 'device_online') {
                const serial = data.serial;

                console.log("connected:",data);

                // --- AUTHENTICATION ---
                if (isLocal) {
                    if (!whitelist.includes(serial)) {
                        whitelist.push(serial);
                        saveWhitelist();
                        console.log(`[AUTH] Local device auto-registered: ${serial}`);
                    }
                } else {
                    if (!whitelist.includes(serial)) {
                        console.warn(`[AUTH] REMOTE REJECTED: ${serial} (Unauthorized)`);
                        ws.send(JSON.stringify({ 
                            event: 'auth_failed', 
                            data: { reason: 'Serial not whitelisted. Connect locally first.' } 
                        }));
                        return ws.close();
                    }
                    console.log(`[AUTH] Remote device authorized: ${serial}`);
                }

                // --- INITIALIZE DEVICE ---
                console.log(`📱 ${data.model} (${serial}) is now ONLINE.`);

                // Updated filename per your request
                if (data.model.includes('xl')) {
                    await sendZoneImage(ws, './sidebar.png', 'right top', { r: 25, g: 25, b: 25 });
                }

                await setKey(ws, 4, { r: 0, g: 150, b: 0 }, data.iconSize || 96);
            }

            if (event === 'key_event') {
                console.log(`⌨️ Key ${data.index} ${data.state} on ${data.serial}`);
            }

        } catch (err) {
            console.error('WebSocket Error:', err.message);
        }
    });
});

// Start the integrated server
server.listen(PORT);