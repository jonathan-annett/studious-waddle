async function testJSON() {
    const res = await fetch('./api/ping');
    const data = await res.json();
    document.getElementById('json-res').innerHTML = `<span class="success">Response: ${JSON.stringify(data)} (Time: ${new Date(data.time).toUTCString()})</span>`;
}

document.getElementById('uploadForm').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const resDiv = document.getElementById('upload-res');
    resDiv.innerText = "Uploading...";

    try {
        const response = await fetch('./api/upload', { method: 'POST', body: formData });
        const result = await response.json();
        resDiv.innerHTML = `<span class="success">Uploaded: ${result.filename} (${result.size} bytes)</span>`;
    } catch (err) {
        resDiv.innerHTML = `<span class="error">Upload failed. Check tunnel logs.</span>`;
    }
};



// --- WEBSOCKET CHAT LOGIC ---
let ws;
const logDiv = document.getElementById('ws-log');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('wsSendBtn');
const connectBtn = document.getElementById('wsConnectBtn');
const statusSpan = document.getElementById('wsStatus');

function logWS(msg, color = 'black') {
    const time = new Date().toLocaleTimeString();
    logDiv.innerHTML += `<div style="color: ${color}; margin-bottom: 4px;">[${time}] ${msg}</div>`;
    logDiv.scrollTop = logDiv.scrollHeight;
}

function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
    const wsUrl = protocol + '//' + window.location.host + basePath + '/ws-endpoint';

    statusSpan.innerText = "Connecting...";
    statusSpan.style.color = "orange";

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        statusSpan.innerText = "Connected";
        statusSpan.style.color = "green";
        connectBtn.innerText = "Disconnect";
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
    };

    ws.onmessage = (e) => {
        const isSystem = e.data.startsWith('[System]');
        logWS(e.data, isSystem ? 'gray' : 'blue');
    };

    ws.onclose = () => {
        statusSpan.innerText = "Disconnected";
        statusSpan.style.color = "red";
        connectBtn.innerText = "Connect to Chat";
        chatInput.disabled = true;
        sendBtn.disabled = true;
    };
}

function sendWS() {
    if (ws && ws.readyState === WebSocket.OPEN && chatInput.value.trim() !== "") {
        ws.send(chatInput.value);
        chatInput.value = ''; // Clear input
    }
}