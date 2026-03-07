const { openStreamDeck, listStreamDecks } = require('@elgato-stream-deck/node');
const sharp = require('sharp');
const WebSocket = require('ws');

const SERVER_URL = 'ws://192.168.100.1:4000/streamdeck';
const activePaths = new Set();

function getDeviceSpec(sd) {
    const model = (sd.MODEL || '').toLowerCase();
    let spec = { rows: sd.KEY_ROWS || 0, cols: sd.KEY_COLUMNS || 0, size: sd.ICON_SIZE || 0 };
    if (model.includes('mini')) {
        spec.rows = 2; spec.cols = 3; spec.size = 80;
    } else if (model.includes('xl')) {
        spec.rows = 4; spec.cols = 8; spec.size = 96;
    } else {
        spec.rows = 3; spec.cols = 5; spec.size = 72;
    }
    return spec;
}

async function setupDevice(deviceInfo) {
    if (activePaths.has(deviceInfo.path)) return;
    activePaths.add(deviceInfo.path);

    let sd;
    try {
        sd = await openStreamDeck(deviceInfo.path);
        const spec = getDeviceSpec(sd);
        const serial = await sd.getSerialNumber().catch(() => 'unknown');

        console.log(`[HOTPLUG] Connected: ${sd.MODEL} (SN: ${serial}) at ${deviceInfo.path}`);
        await sd.clearPanel();

        const keyCache = new Map();
        let splashActive = false;
        let splashTimer = null;
        let preSplashCache = null;

        const ws = new WebSocket(SERVER_URL);
        const whiteBuffer = await sharp({
            create: { width: spec.size, height: spec.size, channels: 3, background: { r: 255, g: 255, b: 255 } }
        }).raw().toBuffer();

        const cleanup = () => {
            if (activePaths.has(deviceInfo.path)) {
                console.log(`[DISCONNECT] Removing device at ${deviceInfo.path}`);
                activePaths.delete(deviceInfo.path);
                try { sd.close(); } catch (e) {}
                try { ws.close(); } catch (e) {}
            }
        };

        // Clears the splash overlay and restores the previous panel state.
        const clearSplash = async () => {
            if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
            splashActive = false;
            if (preSplashCache) {
                keyCache.clear();
                for (const [idx, cached] of preSplashCache) keyCache.set(idx, cached);
                preSplashCache = null;
                const tasks = [];
                for (const [idx, cached] of keyCache) {
                    tasks.push(sd.fillKeyBuffer(idx, cached.normal));
                }
                if (tasks.length) await Promise.all(tasks);
                else await sd.clearPanel();
            } else {
                keyCache.clear();
                await sd.clearPanel();
            }
        };

        ws.on('open', () => {
            ws.send(JSON.stringify({
                event: 'device_online',
                data: { model: sd.MODEL, serial, rows: spec.rows, cols: spec.cols, iconSize: spec.size }
            }));
        });

        ws.on('message', async (message) => {
            try {
                const { event, data } = JSON.parse(message);

                if (event === 'set_key') {
                    const idx = parseInt(data.index);
                    const normal = await sharp(Buffer.from(data.image, 'base64')).resize(spec.size, spec.size).raw().toBuffer();
                    let pressed = data.pressImage === false ? false : (data.pressImage ? await sharp(Buffer.from(data.pressImage, 'base64')).resize(spec.size, spec.size).raw().toBuffer() : null);
                    const entry = { normal, pressed };
                    if (splashActive) {
                        // Buffer for after splash clears
                        if (preSplashCache) preSplashCache.set(idx, entry);
                    } else {
                        keyCache.set(idx, entry);
                        await sd.fillKeyBuffer(idx, normal);
                    }
                }

                if (event === 'set_zone_fast') {
                    const { image, indices, cols, rows, position, background } = data;
                    const size = spec.size;
                    const masterImage = sharp(Buffer.from(image, 'base64'))
                        .resize(cols * size, rows * size, {
                            fit: 'contain',
                            background: background || { r: 0, g: 0, b: 0 },
                            position: position || 'right top'
                        });

                    const tasks = indices.map(async (deckIndex, i) => {
                        const r = Math.floor(i / cols);
                        const c = i % cols;
                        const buf = await masterImage.clone()
                            .extract({ left: c * size, top: r * size, width: size, height: size })
                            .raw().toBuffer();
                        const idx = parseInt(deckIndex);
                        const entry = { normal: buf, pressed: false };
                        if (splashActive) {
                            if (preSplashCache) preSplashCache.set(idx, entry);
                        } else {
                            keyCache.set(idx, entry);
                            return sd.fillKeyBuffer(idx, buf);
                        }
                    });
                    await Promise.all(tasks);
                }

                if (event === 'set_splash') {
                    const { image, duration, background } = data;
                    if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
                    // Snapshot current state before overwriting
                    preSplashCache = new Map(keyCache);
                    splashActive = true;
                    const size = spec.size;
                    const totalKeys = spec.rows * spec.cols;
                    const masterImage = sharp(Buffer.from(image, 'base64'))
                        .resize(spec.cols * size, spec.rows * size, {
                            fit: 'contain',
                            background: background || { r: 0, g: 0, b: 0 },
                            position: 'center'
                        });
                    const tasks = Array.from({ length: totalKeys }, async (_, i) => {
                        const r = Math.floor(i / spec.cols);
                        const c = i % spec.cols;
                        const buf = await masterImage.clone()
                            .extract({ left: c * size, top: r * size, width: size, height: size })
                            .raw().toBuffer();
                        keyCache.set(i, { normal: buf, pressed: false });
                        return sd.fillKeyBuffer(i, buf);
                    });
                    await Promise.all(tasks);
                    if (duration) splashTimer = setTimeout(clearSplash, duration * 1000);
                }

                if (event === 'clear_splash') {
                    await clearSplash();
                }

                if (event === 'clear_all') {
                    if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
                    splashActive = false;
                    preSplashCache = null;
                    await sd.clearPanel();
                    keyCache.clear();
                }

            } catch (e) { console.error('Render Error:', e.message); }
        });

        sd.on('down', (data) => {
            const index = typeof data === 'number' ? data : data.index;
            if (!splashActive) {
                const cached = keyCache.get(index);
                if (cached && cached.pressed === false) { /* Locked */ }
                else if (cached && cached.pressed) { sd.fillKeyBuffer(index, cached.pressed); }
                else { sd.fillKeyBuffer(index, whiteBuffer); }
            }
            ws.send(JSON.stringify({ event: 'key_event', data: { index, state: 'down', serial } }));
        });

        sd.on('up', (data) => {
            const index = typeof data === 'number' ? data : data.index;
            if (!splashActive) {
                const cached = keyCache.get(index);
                if (cached?.normal) sd.fillKeyBuffer(index, cached.normal);
            }
            ws.send(JSON.stringify({ event: 'key_event', data: { index, state: 'up', serial } }));
        });

        sd.on('error', cleanup);
        ws.on('close', cleanup);
    } catch (e) {
        activePaths.delete(deviceInfo.path);
        console.error(`Init Failed:`, e.message);
    }
}

setInterval(async () => {
    const devices = await listStreamDecks();
    devices.forEach(setupDevice);
}, 2000);
