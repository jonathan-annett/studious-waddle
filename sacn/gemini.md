
**The Architecture:**

1. **Local Router (OpenWRT):** Runs an Express/Node server (`server.js`). It maintains the DMX state, outputs sACN multicast, handles WebSocket updates, generates shortlinks for sharing, and dynamically generates a cache-busting Service Worker. On boot, it pushes its UI files to the cloud.

2. **Public Gateway (VPS):** Runs a proxy server (`remoteRelay/server.js`). It acts as a Zero-Config Edge Cache, serving the frontend UI directly from memory to mobile devices, while proxying API and WebSocket traffic down a secure tunnel to the local router.

3. **Frontend (PWA):** Built with Vanilla JS (`app.js`) and a custom Web Component (`dmx-console.js`). It features an offline "Simulacrum" mode, explicit PWA installation/removal, and QR/Clipboard shortlink generation with visual TTL progress bars.



**Current Authentication:**

Right now, the system uses a simple, global shared cookie (`venue_auth=stagehand123`) set upon entering a password or consuming a shortlink token.



**Our Immediate Goal: Device Management & Session Revocation**

We need to upgrade the authentication from a shared password to individual Device Sessions so operators can forcefully revoke specific devices. 

1. We need device fingerprinting/UUIDs stored in a server-side `sessions.json` ledger.

2. We need to tie active WebSocket connections to these session UUIDs.

3. We need a new UI panel inside the main "..." menu that lists active devices (e.g., "Apple iPhone", "Windows Desktop").

4. We need a "Revoke" button next to each device that deletes the session and instantly terminates their active WebSocket connection, locking them out of the console.