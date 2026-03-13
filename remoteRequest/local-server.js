import express from 'express';
import multer from 'multer';
import path from 'path'

import { localServerExpressTunnel } from './remoteRequest.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const wss_domain = process.env.RELAY_HOST;
const rootPath = process.env.RELAY_ROOT_PATH || '/test-dashboard';


// 1. Static Files (Crucial test for binary res.write)
app.use(rootPath, express.static(path.join(import.meta.dirname, 'public')));

// 2. Simple JSON Endpoint
app.get(`${rootPath}/api/ping`, (req, res) => {
    res.json({ message: "Pong from behind NAT!", time: new Date().toISOString() });
});

// 3. Multipart Upload Endpoint
app.post(`${rootPath}/api/upload`, upload.single('testFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    
    console.log(`[TestApp] Received file: ${req.file.originalname} (${req.file.size} bytes)`);
    res.json({
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
    });
});

// Start the tunnel
localServerExpressTunnel(app, wss_domain, rootPath);

console.log(`Local Test App ready. Visit  https://${wss_domain}${rootPath}`);
