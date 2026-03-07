class StreamDeckRemote {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.ws = null;
        this.sd = null;
        this.serial = null;
        
        // Internal state for the Canvas approach
        this.canvas = null;
        this.ctx = null;
        this.cols = 0;
        this.iconSize = 0;
        
        // Emulate the Node.js keyCache for hover/press states
        this.keyCache = new Map();
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
            
            // Setup the backing Canvas
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
                    
                    // Decode Normal Image
                    const resNormal = await fetch(`data:image/png;base64,${data.image}`);
                    const normalBitmap = await createImageBitmap(await resNormal.blob());
                    
                    // Decode Pressed Image (or lock if false)
                    let pressedBitmap = null;
                    if (data.pressImage === false) {
                        pressedBitmap = false; // Locked
                    } else if (data.pressImage) {
                        const resPressed = await fetch(`data:image/png;base64,${data.pressImage}`);
                        pressedBitmap = await createImageBitmap(await resPressed.blob());
                    }

                    // Cache and render
                    this.keyCache.set(idx, { normal: normalBitmap, pressed: pressedBitmap });
                    await this._updateMasterKey(idx, normalBitmap);
                }

                if (event === 'set_zone_fast') {
                    const { image, indices, cols: zCols, rows: zRows, position, background } = data;
                    
                    const resMaster = await fetch(`data:image/png;base64,${image}`);
                    const masterImg = await createImageBitmap(await resMaster.blob());
                    
                    const zoneW = zCols * this.iconSize;
                    const zoneH = zRows * this.iconSize;
                    
                    // Create a temporary canvas to act as the "sharp" container
                    const zoneCanvas = new OffscreenCanvas(zoneW, zoneH);
                    const zoneCtx = zoneCanvas.getContext('2d', { willReadFrequently: true });
                    
                    // Emulate sharp background fill
                    if (background) {
                        zoneCtx.fillStyle = `rgb(${background.r}, ${background.g}, ${background.b})`;
                    } else {
                        zoneCtx.fillStyle = 'black';
                    }
                    zoneCtx.fillRect(0, 0, zoneW, zoneH);
                    
                    // Emulate sharp "fit: contain" and position
                    const scale = Math.min(zoneW / masterImg.width, zoneH / masterImg.height);
                    const drawW = masterImg.width * scale;
                    const drawH = masterImg.height * scale;
                    
                    // Emulate 'right top' default from Node.js code, otherwise center
                    let drawX = (zoneW - drawW) / 2;
                    let drawY = (zoneH - drawH) / 2;
                    if (position === 'right top') {
                        drawX = zoneW - drawW;
                        drawY = 0;
                    }
                    
                    zoneCtx.drawImage(masterImg, drawX, drawY, drawW, drawH);

                    // Slice the master canvas into individual keys and cache them
                    for (let i = 0; i < indices.length; i++) {
                        const idx = parseInt(indices[i]);
                        const r = Math.floor(i / zCols);
                        const c = i % zCols;
                        
                        const sliceX = c * this.iconSize;
                        const sliceY = r * this.iconSize;
                        
                        // Extract specific button pixels
                        const sliceData = zoneCtx.getImageData(sliceX, sliceY, this.iconSize, this.iconSize);
                        const sliceBitmap = await createImageBitmap(sliceData);
                        
                        // Cache it (Locked visual feedback by default for zones)
                        this.keyCache.set(idx, { normal: sliceBitmap, pressed: false });
                        
                        // Draw to master canvas
                        const mX = (idx % this.cols) * this.iconSize;
                        const mY = Math.floor(idx / this.cols) * this.iconSize;
                        this.ctx.drawImage(sliceBitmap, mX, mY);
                    }
                    
                    // Send to device
                    await this.sd.fillPanelCanvas(this.canvas);
                }

                if (event === 'clear_all') {
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

        // 3. Handle physical button presses & Visual Feedback
        this.sd.on('down', async (control) => {
            const index = control.index;
            const cached = this.keyCache.get(index);
            
            if (cached && cached.pressed === false) {
                // Locked visually, do nothing
            } else if (cached && cached.pressed) {
                await this._updateMasterKey(index, cached.pressed);
            } else {
                await this._updateMasterKey(index, 'white');
            }
            
            this.ws.send(JSON.stringify({
                event: 'key_event',
                data: { index, state: 'down', serial: this.serial }
            }));
        });

        this.sd.on('up', async (control) => {
            const index = control.index;
            const cached = this.keyCache.get(index);
            
            if (cached && cached.normal) {
                await this._updateMasterKey(index, cached.normal);
            } else {
                await this._updateMasterKey(index, 'black');
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
    
    // Updates a specific grid slot on the master canvas and pushes to hardware
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