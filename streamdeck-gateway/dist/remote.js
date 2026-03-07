class StreamDeckRemote {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.ws = null;
        this.sd = null;
        this.serial = null;

        // Grid geometry
        this.rows = 0;
        this.cols = 0;
        this.iconSize = 0;

        // Master canvas — backing store for the full panel
        this.canvas = null;
        this.ctx = null;

        // Per-key state cache (normal and optional pressed bitmaps)
        this.keyCache = new Map();

        // Splash state
        this.splashActive = false;
        this.splashTimer = null;
        this.preSplashCache = null;
    }

    async init() {
        // 1. Request Device via WebHID
        const devices = await window.StreamDeck.requestStreamDecks();
        if (!devices || devices.length === 0) {
            throw new Error("No device selected or found.");
        }

        this.sd = devices[0];
        await this.sd.clearPanel();

        // 2. Setup WebSocket
        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = async () => {
            this.serial = await this.sd.getSerialNumber();
            const model = this.sd.MODEL || 'Remote Device';

            // --- Robust Geometry Detection ---
            let rows = this.sd.KEY_ROWS;
            let cols = this.sd.KEY_COLUMNS;
            let keys = this.sd.NUM_KEYS;
            let iconSize = this.sd.ICON_SIZE;

            const props = this.sd.device?.deviceProperties;
            if ((!rows || !iconSize) && props && Array.isArray(props.CONTROLS)) {
                let maxRow = 0, maxCol = 0, btnCount = 0;
                for (const c of props.CONTROLS) {
                    if (c.type === 'button') {
                        btnCount++;
                        if (c.row > maxRow) maxRow = c.row;
                        if (c.column > maxCol) maxCol = c.column;
                        if (!iconSize && c.pixelSize && c.pixelSize.width) {
                            iconSize = c.pixelSize.width;
                        }
                    }
                }
                rows = rows || (maxRow + 1);
                cols = cols || (maxCol + 1);
                keys = keys || btnCount;
            }

            // Fallbacks
            rows = rows || 3;
            cols = cols || 5;
            keys = keys || 15;
            iconSize = iconSize || 72;

            this.rows = rows;
            this.cols = cols;
            this.iconSize = iconSize;
            this.canvas = new OffscreenCanvas(cols * iconSize, rows * iconSize);
            this.ctx = this.canvas.getContext('2d');
            this.ctx.fillStyle = 'black';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            this.ws.send(JSON.stringify({
                event: 'device_online',
                data: { model, serial: this.serial, rows, cols, keys, iconSize }
            }));
        };

        this.ws.onmessage = async (msg) => {
            const { event, data } = JSON.parse(msg.data);

            try {
                if (event === 'set_key') {
                    const idx = parseInt(data.index);

                    const normalBitmap = await createImageBitmap(
                        await (await fetch(`data:image/png;base64,${data.image}`)).blob()
                    );
                    let pressedBitmap = null;
                    if (data.pressImage === false) {
                        pressedBitmap = false; // Locked
                    } else if (data.pressImage) {
                        pressedBitmap = await createImageBitmap(
                            await (await fetch(`data:image/png;base64,${data.pressImage}`)).blob()
                        );
                    }

                    const entry = { normal: normalBitmap, pressed: pressedBitmap };
                    if (this.splashActive) {
                        // Buffer for after splash clears
                        if (this.preSplashCache) this.preSplashCache.set(idx, entry);
                    } else {
                        this.keyCache.set(idx, entry);
                        await this._updateMasterKey(idx, normalBitmap);
                    }
                }

                if (event === 'set_zone_fast') {
                    const { image, indices, cols: zCols, rows: zRows, position, background } = data;

                    const masterImg = await createImageBitmap(
                        await (await fetch(`data:image/png;base64,${image}`)).blob()
                    );
                    const zoneW = zCols * this.iconSize;
                    const zoneH = zRows * this.iconSize;

                    const zoneCanvas = new OffscreenCanvas(zoneW, zoneH);
                    const zoneCtx = zoneCanvas.getContext('2d', { willReadFrequently: true });

                    zoneCtx.fillStyle = background
                        ? `rgb(${background.r}, ${background.g}, ${background.b})`
                        : 'black';
                    zoneCtx.fillRect(0, 0, zoneW, zoneH);

                    const scale = Math.min(zoneW / masterImg.width, zoneH / masterImg.height);
                    const drawW = masterImg.width * scale;
                    const drawH = masterImg.height * scale;
                    let drawX = (zoneW - drawW) / 2;
                    let drawY = (zoneH - drawH) / 2;
                    if (position === 'right top') { drawX = zoneW - drawW; drawY = 0; }

                    zoneCtx.drawImage(masterImg, drawX, drawY, drawW, drawH);

                    for (let i = 0; i < indices.length; i++) {
                        const idx = parseInt(indices[i]);
                        const r = Math.floor(i / zCols);
                        const c = i % zCols;
                        const sliceData = zoneCtx.getImageData(c * this.iconSize, r * this.iconSize, this.iconSize, this.iconSize);
                        const sliceBitmap = await createImageBitmap(sliceData);
                        const entry = { normal: sliceBitmap, pressed: false };
                        if (this.splashActive) {
                            if (this.preSplashCache) this.preSplashCache.set(idx, entry);
                        } else {
                            this.keyCache.set(idx, entry);
                            const mX = (idx % this.cols) * this.iconSize;
                            const mY = Math.floor(idx / this.cols) * this.iconSize;
                            this.ctx.drawImage(sliceBitmap, mX, mY);
                        }
                    }
                    if (!this.splashActive) await this.sd.fillPanelCanvas(this.canvas);
                }

                if (event === 'set_splash') {
                    const { image, duration, background } = data;
                    if (this.splashTimer) { clearTimeout(this.splashTimer); this.splashTimer = null; }
                    this.preSplashCache = new Map(this.keyCache);
                    this.splashActive = true;

                    const masterImg = await createImageBitmap(
                        await (await fetch(`data:image/png;base64,${image}`)).blob()
                    );
                    const totalW = this.cols * this.iconSize;
                    const totalH = this.rows * this.iconSize;

                    // Fit the image onto the full panel canvas (centered, contain)
                    const bg = background || { r: 0, g: 0, b: 0 };
                    this.ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
                    this.ctx.fillRect(0, 0, totalW, totalH);

                    const scale = Math.min(totalW / masterImg.width, totalH / masterImg.height);
                    const drawW = masterImg.width * scale;
                    const drawH = masterImg.height * scale;
                    this.ctx.drawImage(masterImg, (totalW - drawW) / 2, (totalH - drawH) / 2, drawW, drawH);

                    // Slice each key and cache as locked (no press feedback during splash)
                    for (let i = 0; i < this.rows * this.cols; i++) {
                        const r = Math.floor(i / this.cols);
                        const c = i % this.cols;
                        const sliceData = this.ctx.getImageData(c * this.iconSize, r * this.iconSize, this.iconSize, this.iconSize);
                        const sliceBitmap = await createImageBitmap(sliceData);
                        this.keyCache.set(i, { normal: sliceBitmap, pressed: false });
                    }

                    await this.sd.fillPanelCanvas(this.canvas);

                    if (duration) this.splashTimer = setTimeout(() => this._clearSplash(), duration * 1000);
                }

                if (event === 'clear_splash') {
                    await this._clearSplash();
                }

                if (event === 'clear_all') {
                    if (this.splashTimer) { clearTimeout(this.splashTimer); this.splashTimer = null; }
                    this.splashActive = false;
                    this.preSplashCache = null;
                    this.keyCache.clear();
                    if (this.ctx) {
                        this.ctx.fillStyle = 'black';
                        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                    }
                    await this.sd.clearPanel();
                }

            } catch (err) {
                console.error("Render Error:", err.message);
            }
        };

        // 3. Handle physical button presses & visual feedback
        this.sd.on('down', async (control) => {
            const index = control.index;
            if (!this.splashActive) {
                const cached = this.keyCache.get(index);
                if (cached && cached.pressed === false) {
                    // Locked — no visual feedback
                } else if (cached && cached.pressed) {
                    await this._updateMasterKey(index, cached.pressed);
                } else {
                    await this._updateMasterKey(index, 'white');
                }
            }
            this.ws.send(JSON.stringify({
                event: 'key_event',
                data: { index, state: 'down', serial: this.serial }
            }));
        });

        this.sd.on('up', async (control) => {
            const index = control.index;
            if (!this.splashActive) {
                const cached = this.keyCache.get(index);
                if (cached && cached.normal) {
                    await this._updateMasterKey(index, cached.normal);
                } else {
                    await this._updateMasterKey(index, 'black');
                }
            }
            this.ws.send(JSON.stringify({
                event: 'key_event',
                data: { index, state: 'up', serial: this.serial }
            }));
        });

        this.sd.on('error', (err) => {
            console.error('Stream Deck Hardware Error:', err);
        });
    }

    // --- Helpers ---

    // Dismiss splash and restore the panel to its pre-splash state.
    async _clearSplash() {
        if (this.splashTimer) { clearTimeout(this.splashTimer); this.splashTimer = null; }
        this.splashActive = false;
        if (this.preSplashCache) {
            this.keyCache.clear();
            for (const [idx, cached] of this.preSplashCache) this.keyCache.set(idx, cached);
            this.preSplashCache = null;
        } else {
            this.keyCache.clear();
        }
        await this._rebuildCanvasFromCache();
    }

    // Redraws the master canvas from keyCache and pushes to hardware in one call.
    async _rebuildCanvasFromCache() {
        if (!this.ctx) return;
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        for (const [idx, cached] of this.keyCache) {
            if (cached.normal) {
                const x = (idx % this.cols) * this.iconSize;
                const y = Math.floor(idx / this.cols) * this.iconSize;
                this.ctx.drawImage(cached.normal, x, y, this.iconSize, this.iconSize);
            }
        }
        await this.sd.fillPanelCanvas(this.canvas);
    }

    // Updates a specific grid slot on the master canvas and pushes to hardware.
    async _updateMasterKey(index, source) {
        const x = (index % this.cols) * this.iconSize;
        const y = Math.floor(index / this.cols) * this.iconSize;

        if (typeof source === 'string') {
            this.ctx.fillStyle = source;
            this.ctx.fillRect(x, y, this.iconSize, this.iconSize);
        } else if (source) {
            this.ctx.drawImage(source, x, y, this.iconSize, this.iconSize);
        }

        await this.sd.fillPanelCanvas(this.canvas);
    }
}
