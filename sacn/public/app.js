// public/app.js
const consoleComponent = document.querySelector('dmx-console');
const logElement = document.getElementById('network-log');
const logContainer = document.getElementById('log-container');
const toggleLogBtn = document.getElementById('toggle-log-btn');
const closeLogBtn = document.getElementById('close-log-btn');

let ws;
let reconnectDelay = 1000;

let logHistory = [];
const MAX_LOG_LINES = 100;

function addLog(message, type = 'info') {
    const timeStr = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit', fractionalSecondDigits: 3 });
    
    let colorClass = 'log-info';
    if (type === 'sync') colorClass = 'log-sync';
    if (type === 'warn') colorClass = 'log-warn';
    if (type === 'error') colorClass = 'log-error';

    const logLine = `<span class="log-time">[${timeStr}]</span><span class="${colorClass}">${message}</span>`;
    
    logHistory.push(logLine);
    if (logHistory.length > MAX_LOG_LINES) {
        logHistory.shift(); 
    }
    
    if (logElement) {
        logElement.innerHTML = logHistory.join('\n');
        logElement.scrollTop = logElement.scrollHeight;
    }
}

toggleLogBtn.addEventListener('click', () => {
    logContainer.style.display = 'flex';
    toggleLogBtn.style.display = 'none';
    logElement.scrollTop = logElement.scrollHeight;
});

closeLogBtn.addEventListener('click', () => {
    logContainer.style.display = 'none';
    toggleLogBtn.style.display = 'block';
});

let pathParts = window.location.pathname.split('/').filter(Boolean);
let rootPath = "";
if (pathParts[0] === 'the-venue-club') {
    rootPath = '/' + pathParts.shift();
}

const deviceName = pathParts.length > 0 ? pathParts[0] : 'default';

document.addEventListener('dmx-install-pwa', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register(`${rootPath}/sw.js`, { scope: `${rootPath}/` })
            .then(reg => {
                addLog('Offline Engine Installed', 'sync');
                alert("Offline Mode Enabled!\n\nYou can now use your browser's menu to 'Add to Home Screen' or 'Install App' for a full fullscreen experience.");
                consoleComponent.dispatchEvent(new CustomEvent('dmx-pwa-installed'));
            })
            .catch(err => {
                addLog('PWA Install Failed', 'error');
                console.error('PWA Registration failed:', err);
                alert("Failed to install offline engine. Please ensure you are on a secure connection.");
            });
    } else {
        alert("Your browser does not support offline applications.");
    }
});

document.addEventListener('dmx-remove-pwa', () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for (let registration of registrations) {
                registration.unregister();
            }
            addLog('Offline Engine Removed', 'warn');
            alert("Offline Mode Removed.\n\nThe app will no longer load if the server goes down.");
            consoleComponent.dispatchEvent(new CustomEvent('dmx-pwa-removed'));
        }).catch(err => {
            console.error('PWA Removal failed:', err);
        });
    }
});

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    const socketUrl = `${protocol}//${host}${rootPath}/ui/${deviceName}`;

    ws = new WebSocket(socketUrl);
    ws.onopen = () => { 
        addLog(`Connected to Hub Environment: '${deviceName}'`, 'info'); 
        reconnectDelay = 1000; 
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'init') {
            addLog(`Received Full Initial State Sync`, 'info');
            if (data.isTunneled) consoleComponent.dispatchEvent(new CustomEvent('dmx-tunneled'));
            if (data.globalMeta) consoleComponent.dispatchEvent(new CustomEvent('dmx-global-meta', { detail: data.globalMeta }));
            if (data.customLayout) consoleComponent.dispatchEvent(new CustomEvent('dmx-layout-sync', { detail: data.customLayout }));
            if (data.customLayoutName) consoleComponent.dispatchEvent(new CustomEvent('dmx-layout-name-sync', { detail: data.customLayoutName }));
            if (data.serverLayout) consoleComponent.dispatchEvent(new CustomEvent('dmx-server-layout-sync', { detail: data.serverLayout }));
            if (data.radioColors) consoleComponent.dispatchEvent(new CustomEvent('dmx-radio-colors', { detail: data.radioColors }));

            consoleComponent.dispatchEvent(new CustomEvent('dmx-status', { detail: { online: data.isOnline } }));

            for (let i = 0; i < 512; i++) {
                consoleComponent.dispatchEvent(new CustomEvent('dmx-set', {
                    detail: { 
                        device: deviceName, channel: i, value: data.values[i], enabled: data.enabled[i],
                        protected: data.protected[i], name: data.names[i],
                        defaultName: data.defaultNames ? data.defaultNames[i] : '', 
                        glyph: data.glyphs ? data.glyphs[i] : '', history: data.history[i]
                    }
                }));
            }
        } else if (data.type === 'update') {
            data.device = data.device || deviceName;
            addLog(`[Network Sync] DEV: ${data.device} CH: ${data.channel}, Val: ${data.value}, Source: ${data.source}`, 'sync');
            consoleComponent.dispatchEvent(new CustomEvent('dmx-set', { detail: data }));
        } else if (data.type === 'preset-list') {
            consoleComponent.dispatchEvent(new CustomEvent('dmx-presets-list', { detail: data.presets }));
        } else if (data.type === 'global-meta') {
            consoleComponent.dispatchEvent(new CustomEvent('dmx-global-meta', { detail: data.meta }));
        } else if (data.type === 'layout-sync') {
            consoleComponent.dispatchEvent(new CustomEvent('dmx-layout-sync', { detail: data.layout }));
        } else if (data.type === 'layout-name-sync') {
            consoleComponent.dispatchEvent(new CustomEvent('dmx-layout-name-sync', { detail: data.name }));
        } else if (data.type === 'radio-colors') {
            consoleComponent.dispatchEvent(new CustomEvent('dmx-radio-colors', { detail: data.colors }));
        } else if (data.type === 'status') {
            addLog(`Backend hardware device ${data.online ? 'Connected' : 'Disconnected'}`, data.online ? 'info' : 'warn');
            consoleComponent.dispatchEvent(new CustomEvent('dmx-status', { detail: { online: data.online } }));
        } else if (data.type === 'link-used') {
            // --- NEW: Route the event to the modal UI ---
            consoleComponent.dispatchEvent(new CustomEvent('dmx-link-used', { detail: data.token }));
        }
    };

    ws.onclose = () => {
        addLog(`Disconnected from Hub. Reconnecting in ${reconnectDelay / 1000}s...`, 'warn');
        consoleComponent.dispatchEvent(new CustomEvent('dmx-status', { detail: { online: false } }));
        setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000); 
    };

    ws.onerror = (err) => { ws.close(); };
}

connectWebSocket();

// --- NEW: Command the server to revoke an active shortlink ---
document.addEventListener('dmx-revoke-link', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'revoke-link', token: e.detail }));
    }
});

document.addEventListener('dmx-change', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (e.detail.source === 'human') {
            ws.send(JSON.stringify({ type: 'update', device: e.detail.device, channel: e.detail.channel, value: e.detail.value, enabled: e.detail.enabled, protected: e.detail.protected, name: e.detail.name, source: 'human' }));
        }
    }
});

document.addEventListener('dmx-request-meta', () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get-global-meta' }));
});

document.addEventListener('dmx-action-preset', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: e.detail.action, name: e.detail.name }));
});

document.addEventListener('dmx-layout-change', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'update-layout', layout: e.detail }));
});

document.addEventListener('dmx-layout-name-change', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'update-layout-name', name: e.detail }));
});