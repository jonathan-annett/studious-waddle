
import express from 'express';
import { localServerExpressTunnel } from './remoteRequest.js';

const app = express();


const wss_domain = process.env.RELAY_HOST;
const rootPath = process.env.RELAY_ROOT_PATH || '/test-dashboard';
console.log(`https://${wss_domain}${rootPath}`);

app.get(rootPath, (req, res) => res.send("Hello from behind NAT"));

localServerExpressTunnel(app, wss_domain, rootPath);

