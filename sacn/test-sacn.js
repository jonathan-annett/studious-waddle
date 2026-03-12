import WebSocket from 'ws';
import fs from 'fs';
import sharp from 'sharp';

// Basic CLI Argument Parser
const args = process.argv.slice(2);
let targetUniverse = 1;
let deviceName = 'test-device';
let relayUniverse = undefined;
let host = 'localhost';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--universe' && args[i + 1]) targetUniverse = parseInt(args[++i]);
    if (args[i] === '--name' && args[i + 1]) deviceName = args[++i];
    if (args[i] === '--relay' && args[i + 1]) relayUniverse = parseInt(args[++i]);
    if (args[i] === '--host' && args[i + 1]) host = args[++i];
}

const WS_URL = `ws://${host}:4004/sacn-connect`;

console.log(`[INIT] Connecting to DMX Hub at ${WS_URL}`);
console.log(`[INIT] Target Universe: ${targetUniverse}`);
if (relayUniverse) console.log(`[INIT] Transmitting Merged Relay to Universe: ${relayUniverse}`);

// Set up the default names, layouts, and the required glyphs
const totalChannels = 512;
const defaultNames = new Array(totalChannels).fill('');
const glyphs = new Array(totalChannels).fill('');

// Define our TV inputs
defaultNames[0] = 'HDMI 1';
defaultNames[1] = 'HDMI 2';
defaultNames[2] = 'Signage 1';
defaultNames[3] = 'Signage 2';

// Provide HTML/CSS glyphs to satisfy the server's Radio Group validation
const baseStyle = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;text-align:center;font-size:0.75em;font-weight:bold;color:#11111b;box-sizing:border-box;padding:2px;";

glyphs[0] = `<div style="${baseStyle} background:#89b482;">HDMI<br>1</div>`;
glyphs[1] = `<div style="${baseStyle} background:#fab387;">HDMI<br>2</div>`;
glyphs[2] = await generateThumbnail('./sample1.jpg');
glyphs[3] = await generateThumbnail('./sample2.jpg');

console.log({glyphs});

// Build the registration payload
const registrationData = {
    universe: targetUniverse,
    name: deviceName,
    relayUniverse: relayUniverse,
    radioGroups: [[0, 1, 2, 3]], // Grouping channels 0 through 3
    defaultNames: defaultNames,
    glyphs: glyphs,
    serverLayout: {
        name: "Media Rack A",
        slug: "media-a",
        channels: [0, 1, 2, 3]
    }
};

function connect() {
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log(`[NETWORK] Connected! Generating thumbnails and preparing registration...`);
        console.log(`[NETWORK] Sending registration packet...`);
        ws.send(JSON.stringify(registrationData));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Handle cross-universe updates mapped by the operator
            if (msg.type === 'update') {
                // Uncomment to debug incoming standard DMX updates
                // console.log(`[CONSOLE] CH: ${msg.channel} | Val: ${msg.value}`);
            }
            
            // Handle Radio Group macro commands triggered by the server
            if (msg.type === 'tv-command') {
                if (msg.action === 'stop') {
                    console.log(`📺 [TV CMD] Group ${msg.group}: HARD STOP (All inputs 0)`);
                } else if (msg.action === 'start') {
                    const chName = defaultNames[msg.channel] || `CH ${msg.channel + 1}`;
                    console.log(`📺 [TV CMD] Group ${msg.group}: SWITCH INPUT TO -> ${chName} (CH ${msg.channel})`);
                }
            }
            
            // Handle validation errors from the Hub
            if (msg.type === 'error') {
                console.error(`❌ [SERVER ERROR]: ${msg.message}`);
            }
        } catch (e) {
            console.error('[NETWORK] Failed to parse message:', data);
        }
    });

    ws.on('close', () => {
        console.log('[NETWORK] Connection to Hub lost. Reconnecting in 2 seconds...');
        setTimeout(connect, 2000);
    });

    ws.on('error', (err) => {
        console.error(`[NETWORK] WebSocket Error: ${err.message}`);
    });
}

// Start connection loop
connect();


async function generateThumbnail(filePath, fallbackText = 'MEDIA', width = 90, height = 160) {
    if (!fs.existsSync(filePath)) {
        console.warn(`[WARN] Image file not found: ${filePath} (Using fallback glyph)`);
        // Return a red fallback HTML button so the server doesn't reject our connection
        const fallbackStyle = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;text-align:center;font-size:0.75em;font-weight:bold;color:#11111b;box-sizing:border-box;padding:2px;background:#f38ba8;";
        return `<div style="${fallbackStyle}">NO IMG<br>${fallbackText}</div>`;
    }
    
    try {
        const buffer = await sharp(filePath)
            .resize(width, height, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
        
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (error) {
        console.error(`[ERROR] Failed to process image ${filePath}:`, error);
        const errorStyle = "display:flex;align-items:center;justify-content:center;width:100%;height:100%;text-align:center;font-size:0.75em;font-weight:bold;color:#11111b;box-sizing:border-box;padding:2px;background:#f38ba8;";
        return `<div style="${errorStyle}">ERR<br>${fallbackText}</div>`;
    }
}