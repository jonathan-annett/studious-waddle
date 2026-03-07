class StreamDeckRemote {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.ws = null;
        this.sd = null;
        this.serial = null;
    }

    async init() {
        // 1. Request Device via WebHID
        const devices = await window.elgatoStreamDeckWebhid.openStreamDeck();
        if (!devices || devices.length === 0) throw new Error("No device selected");
        this.sd = devices[0];

        // 2. Setup WebSocket
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.onopen = async () => {
            this.serial = await this.sd.getSerialNumber();
            const model = this.sd.MODEL || 'Remote Device';
            
            // Send exactly what index.js sends
            this.ws.send(JSON.stringify({
                event: 'device_online',
                data: { 
                    model: model, 
                    serial: this.serial, 
                    rows: this.sd.KEY_ROWS, 
                    cols: this.sd.KEY_COLUMNS, 
                    iconSize: this.sd.ICON_SIZE 
                }
            }));
        };

        this.ws.onmessage = async (msg) => {
            const { event, data } = JSON.parse(msg.data);
            
            if (event === 'set_key') {
                // Convert base64 to Blob for Browser HID
                const blob = await (await fetch(`data:image/png;base64,${data.image}`)).blob();
                const buffer = await blob.arrayBuffer();
                await this.sd.fillImage(data.index, buffer);
            }

            if (event === 'clear_all') {
                await this.sd.clearAllKeys();
            }

            // Note: set_zone_fast logic would be implemented here 
            // by slicing the image using a <canvas> element locally.
        };

        // 3. Handle physical button presses
        this.sd.on('down', (index) => {
            this.ws.send(JSON.stringify({
                event: 'key_event',
                data: { index, state: 'down', serial: this.serial }
            }));
        });

        this.sd.on('up', (index) => {
            this.ws.send(JSON.stringify({
                event: 'key_event',
                data: { index, state: 'up', serial: this.serial }
            }));
        });
    }
}
