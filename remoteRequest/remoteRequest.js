import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { PassThrough } from 'stream'; 

/*
    Generic UInt8Array packet format:
    [0,1,2,3]       = 32 bit frameId (Little Endian)
    [4]             = message type and flags
    [5]             = metaSize (8 bit size of JSON metadata)
    [6 + metaSize]  = data payload
*/

// --- CONFIGURATION ---
const LOG_LEVEL = 3; // 0: None, 1: Info, 2: Verbose, 3: Trace/Traffic

const logger = {
    info: (msg) => LOG_LEVEL >= 1 && console.log(`[${new Date().toISOString()}] [INFO] ${msg}`),
    verbose: (msg, data) => {
        if (LOG_LEVEL >= 2) {
            console.log(`[${new Date().toISOString()}] [DEBUG] ${msg}`);
            if (data && LOG_LEVEL < 3) console.dir(data, { depth: null });
        }
    },
    trace: (msg) => LOG_LEVEL >= 3 && console.log(`[${new Date().toISOString()}] [TRACE] ${msg}`)
};

const TUN_FRAME_ID_AT = 0;
const TUN_TYPE_FLAGS_AT = 4;
const TUN_META_SIZE_AT = 5;
const TUN_HEADER_SIZE_MIN = 6;

const TUN_NULL = 0b0000_0000;
const TUN_TEXT = 0b0000_0001;
const TUN_JSON_OBJ = 0b0000_0010;
const TUN_JSON_ARRAY = 0b0000_0011;
const TUN_ARRAYBUFFER = 0b0000_0100;
const TUN_BUFFER = 0b0000_0101;
const TUN_UINT8ARRAY = 0b0000_0110;
const TUN_BOOLEAN = 0b0000_0111;

// --- BITMASK FLAGS ---
const TUN_CAN_REPLY_MASK  = 0b1000_0000;
const TUN_MUST_REPLY_MASK = 0b0100_0000;
const TUN_IS_REPLY_MASK   = 0b0010_0000;
const TUN_IS_STREAM_MASK  = 0b0001_0000;
const TUN_UNMASK          = 0b0000_1111;

export const messageTypes = { TUN_NULL, TUN_TEXT, TUN_JSON_OBJ, TUN_JSON_ARRAY, TUN_ARRAYBUFFER, TUN_BUFFER, TUN_UINT8ARRAY, TUN_BOOLEAN };
const messageTypeNames = Object.keys(messageTypes);
const messageTypeToString = new Map(messageTypeNames.map(k => [messageTypes[k], k]));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function wsTunnel(ws) {
    const whitelistedResponseCommands = ['status', 'set', 'setHeader', 'writeHead', 'write', 'send', 'end'];
    const responseCmdsThatTerminate = ["send", "end"];
    const events = { message: [] };
    messageTypeNames.forEach(MSG => { events[MSG] = []; });

    let nextFrameId = 1;

    ws.on('message', onWebsocketMessage);

    return { requestMiddleware, on: addListener, off: removeListener, encodeFrame, messageTypes };

    async function requestMiddleware(req, res, next) {
        const contentLength = parseInt(req.headers['content-length']) || 0;
        const hasBody = /POST|PUT|PATCH/i.test(req.method) && (contentLength > 0);
        const requestId = crypto.randomBytes(8).toString('hex');

        logger.info(`[Public] Request: ${req.method} ${req.url} (${requestId})`);

        const requestMessage = encodeX(
            {
                method: req.method,
                url: req.url,
                headers: req.headers,
                response: {
                    headers: typeof res.getHeaders === 'function' ? res.getHeaders() : {},
                    statusCode: res.statusCode,
                },
                requestId
            },
            TUN_CAN_REPLY_MASK, null, { requestId }
        );

        if (hasBody) {
            logger.verbose(`[Public] ${requestId} starting body stream.`);
            requestMessage.send();
            req.on('data', (data) => {
                encodeFrame(TUN_BUFFER, new Uint8Array(data), 0, requestMessage.frameId, { event: 'data', target: 'req' }).send();
            });
        } else {
            requestMessage.send(responseCmdHandler);
        }

        req.on('end', () => {
            if (hasBody) {
                logger.verbose(`[Public] ${requestId} body ended. Sending final frame.`);
                const finalFlags = TUN_CAN_REPLY_MASK | TUN_MUST_REPLY_MASK;
                encodeFrame(TUN_NULL, null, finalFlags, requestMessage.frameId, { event: 'end', target: 'req' }).send(responseCmdHandler);
            }
        });

        function responseCmdHandler(msg) {
            logger.verbose(`[Public] Response for Frame ${msg.frameId} (Type: ${messageTypeToString.get(msg.msgType)})`);

            if (msg.msgType === TUN_JSON_OBJ) {
                const cmds = msg.data;
                if (cmds.next) {
                    logger.info(`[Public] Local server triggered next() for Frame ${msg.frameId}`);
                    requestMessage.destroy();
                    return next();
                }

                Object.keys(cmds)
                    .filter(cmd => whitelistedResponseCommands.includes(cmd))
                    .forEach(cmd => {
                        const args = cmds[cmd];
                        const fn = res[cmd];
                        if (Array.isArray(args) && typeof fn === 'function') {
                            logger.trace(`[Public] Executing res.${cmd}(${JSON.stringify(args)})`);
                            fn.apply(res, args);
                            if (responseCmdsThatTerminate.includes(cmd)) requestMessage.destroy();
                        }
                    });
            } else if ([TUN_BUFFER, TUN_ARRAYBUFFER, TUN_UINT8ARRAY].includes(msg.msgType) && msg.metaData?.cmd) {
                const cmd = msg.metaData.cmd;
                const fn = res[cmd];
                if (whitelistedResponseCommands.includes(cmd) && typeof fn === 'function') {
                    logger.trace(`[Public] Executing res.${cmd}([Binary ${msg.data.length} bytes])`);
                    fn.call(res, msg.data || new Uint8Array());
                    if (responseCmdsThatTerminate.includes(cmd)) requestMessage.destroy();
                }
            }
        }
    }

    function parseMessageToFrame(frameIn_U8, findReplyId) {
        if (frameIn_U8.byteLength < TUN_HEADER_SIZE_MIN) return null;

        const dv = new DataView(frameIn_U8.buffer, frameIn_U8.byteOffset, frameIn_U8.byteLength);
        const fId = dv.getUint32(TUN_FRAME_ID_AT, true);
        const typeFlags = frameIn_U8[TUN_TYPE_FLAGS_AT];
        
        const isReply = (typeFlags & TUN_IS_REPLY_MASK) === TUN_IS_REPLY_MASK;
        const isStream = (typeFlags & TUN_IS_STREAM_MASK) === TUN_IS_STREAM_MASK;

        if (Number.isInteger(findReplyId) && (!isReply || fId !== findReplyId)) return null;

        const msgType = typeFlags & TUN_UNMASK;
        const metaSize = frameIn_U8[TUN_META_SIZE_AT];
        const metaData = metaSize === 0 ? {} : JSON.parse(decoder.decode(frameIn_U8.slice(TUN_HEADER_SIZE_MIN, TUN_HEADER_SIZE_MIN + metaSize)));
        let data = frameIn_U8.slice(TUN_HEADER_SIZE_MIN + metaSize);

        switch (msgType) {
            case TUN_JSON_OBJ:
            case TUN_JSON_ARRAY: data = JSON.parse(decoder.decode(data)); break;
            case TUN_ARRAYBUFFER: data = data.buffer; break;
            case TUN_BUFFER: data = Buffer.from(data); break;
            case TUN_BOOLEAN: data = data[0] !== 0; break;
            case TUN_TEXT: data = decoder.decode(data); break;
        }

        logger.verbose(`Parsed Frame: ID=${fId}, Reply=${isReply}, Stream=${isStream}, Type=${messageTypeToString.get(msgType)}`);
        if (LOG_LEVEL >= 3) logger.trace(`Frame ${fId} Meta: ${JSON.stringify(metaData)}`);
        
        return { 
            frameId: fId, 
            isReply, 
            isStream, 
            msgType, 
            metaData, 
            data, 
            canReply: (typeFlags & TUN_CAN_REPLY_MASK) === TUN_CAN_REPLY_MASK 
        };
    }

    function encodeFrame(type, u8, flags, useId, metaData) {
        let frameType = (typeof type === 'string' ? messageTypes[type] : type);
        if (Number.isInteger(flags)) frameType |= flags;

        const metaU8 = metaData ? encoder.encode(JSON.stringify(metaData)) : null;
        const metaSize = metaU8 ? metaU8.byteLength : 0;
        const dataLen = u8 ? u8.byteLength : 0;

        const frame = new Uint8Array(TUN_HEADER_SIZE_MIN + metaSize + dataLen);
        const dv = new DataView(frame.buffer);
        const fId = Number.isInteger(useId) ? useId : nextFrameId++;

        dv.setUint32(TUN_FRAME_ID_AT, fId, true);
        frame[TUN_TYPE_FLAGS_AT] = frameType;
        frame[TUN_META_SIZE_AT] = metaSize;
        if (metaU8) frame.set(metaU8, TUN_HEADER_SIZE_MIN);
        if (u8) frame.set(u8, TUN_HEADER_SIZE_MIN + metaSize);

        const msg = {
            frameId: fId,
            destroy: () => { },
            send: (persistentCallback) => {
                const handler = (d) => {
                    const reply = parseMessageToFrame(new Uint8Array(d), fId);
                    if (reply && persistentCallback) persistentCallback(reply);
                };
                if (persistentCallback && (frameType & TUN_CAN_REPLY_MASK)) {
                    ws.on('message', handler);
                    msg.destroy = () => {
                        ws.off('message', handler);
                        logger.verbose(`[Tunnel] Listener detached for Frame ${fId}`);
                    };
                }
                logger.trace(`Sending Frame: ID=${fId}, Type=${messageTypeToString.get(frameType & TUN_UNMASK)}, Bytes=${frame.byteLength}`);
                ws.send(frame, { binary: true });
                return fId;
            }
        };
        return msg;
    }

    function onWebsocketMessage(msgIn) {
        const frameIn_U8 = new Uint8Array(Buffer.isBuffer(msgIn) ? msgIn : Buffer.from(msgIn));
        const payload = parseMessageToFrame(frameIn_U8);
        if (!payload || payload.isReply) return;
        events.message.forEach(fn => fn(payload));
        const typeHandlers = events[messageTypeToString.get(payload.msgType)];
        if (typeHandlers) typeHandlers.forEach(fn => fn(payload));
    }

    function addListener(e, fn) { if (events[e] && !events[e].includes(fn)) events[e].push(fn); }
    function removeListener(e, fn) { if (events[e]) events[e] = events[e].filter(f => f !== fn); }

    function encodeX(x, flags = 0, useId, metaData) {
        if (typeof x === 'string') return encodeFrame('TUN_TEXT', encoder.encode(x), flags, useId, metaData);
        if (Buffer.isBuffer(x) || x instanceof Uint8Array) return encodeFrame('TUN_BUFFER', new Uint8Array(x), flags, useId, metaData);
        if (Array.isArray(x)) return encodeFrame('TUN_JSON_ARRAY', encoder.encode(JSON.stringify(x)), flags, useId, metaData);
        if (x instanceof ArrayBuffer) return encodeFrame('TUN_ARRAYBUFFER', new Uint8Array(x), flags, useId, metaData);
        if (typeof x === 'boolean') return encodeFrame('TUN_BOOLEAN', new Uint8Array([x ? 1 : 0]), flags, useId, metaData);
        if (typeof x === 'object') return encodeFrame('TUN_JSON_OBJ', encoder.encode(JSON.stringify(x)), flags, useId, metaData);
        throw new Error(`Cannot encode ${typeof x}`);
    }
}

export function publicServerExpressTunnel(app, tunnelWss, server) {
    const ws_middlewares = new Map();
    const activeTunnels = new Map();

    tunnelWss.on('connection', (ws, req) => {
        const match = req.url.match(/^\/connect-(.+)$/);
        if (!match) return ws.close();
        
        const rootPath = '/' + match[1].replace(/\/$/, '');
        logger.info(`[Gateway] Tunnel connected: ${rootPath}`);
        
        const tunnel = wsTunnel(ws);
        activeTunnels.set(rootPath, tunnel);
        
        if (!ws_middlewares.has(rootPath)) ws_middlewares.set(rootPath, new Set());
        ws_middlewares.get(rootPath).add(tunnel.requestMiddleware);
        
        ws.on('close', () => {
            logger.info(`[Gateway] Tunnel disconnected: ${rootPath}`);
            ws_middlewares.get(rootPath)?.delete(tunnel.requestMiddleware);
            activeTunnels.delete(rootPath);
        });
    });

    app.use((req, res, next) => {
        const root = '/' + req.url.replace(/^\//, '').split('/')[0].split('?')[0];
        const mwares = Array.from(ws_middlewares.get(root) || []);
        if (!mwares.length) return next();

        let i = 0;
        const runNext = () => (i < mwares.length) ? mwares[i++](req, res, runNext) : next();
        runNext();
    });

    const clientWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        if (req.url.match(/^\/connect-(.+)$/)) {
            tunnelWss.handleUpgrade(req, socket, head, (ws) => {
                tunnelWss.emit('connection', ws, req);
            });
            return;
        }

        const rootPath = '/' + req.url.replace(/^\//, '').split('/')[0].split('?')[0];
        const tunnel = activeTunnels.get(rootPath);

        if (!tunnel) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        clientWss.handleUpgrade(req, socket, head, (clientWs) => {
            logger.info(`[Gateway] Proxied WS connected for ${req.url}`);
            
            const wsConnectMsg = tunnel.encodeFrame(
                messageTypes.TUN_JSON_OBJ, 
                encoder.encode(JSON.stringify({ wsConnect: { url: req.url, headers: req.headers } }))
            );
            
            const frameId = wsConnectMsg.frameId;
            wsConnectMsg.send();

            clientWs.on('message', (data, isBinary) => {
                const type = isBinary ? messageTypes.TUN_BUFFER : messageTypes.TUN_TEXT;
                const payload = isBinary ? new Uint8Array(data) : encoder.encode(data.toString());
                tunnel.encodeFrame(type, payload, TUN_IS_STREAM_MASK, frameId, null).send();
            });

            clientWs.on('close', () => {
                tunnel.encodeFrame(messageTypes.TUN_JSON_OBJ, encoder.encode(JSON.stringify({ wsClose: true })), TUN_IS_STREAM_MASK, frameId, null).send();
            });

            tunnel.on('message', (payload) => {
                if (payload.frameId !== frameId || !payload.isStream) return;
                
                if (payload.msgType === messageTypes.TUN_TEXT) {
                    clientWs.send(payload.data); 
                } else if (payload.msgType === messageTypes.TUN_BUFFER || payload.msgType === messageTypes.TUN_UINT8ARRAY || payload.msgType === messageTypes.TUN_ARRAYBUFFER) {
                    clientWs.send(payload.data, { binary: true });
                } else if (payload.msgType === messageTypes.TUN_JSON_OBJ && payload.data.wsClose) {
                    clientWs.close();
                }
            });
        });
    });
}

export function localServerExpressTunnel(app, wss_domain, rootPath, localWsPort) {
    const ws_url = `wss://${wss_domain}/connect-${rootPath.replace(/^\//, '')}`;

    const connect = () => {
        logger.info(`[Local Express Tunnel] Connecting to ${ws_url}`);
        const ws = new WebSocket(ws_url);
        
        const activeStreams = new Map();
        const activeWebSockets = new Map();
        let heartbeat;

        ws.on('open', () => {
            logger.info(`[Local Express Tunnel] Open.`);
            const tunnel = wsTunnel(ws);

            heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping(); 
            }, 30000);

            tunnel.on('message', (payload) => {
                const { frameId, msgType, data, metaData } = payload;

                if (msgType === TUN_JSON_OBJ && data.method) {
                    const resEvents = { finish: [], close: [], error: [], drain: [], pipe: [], unpipe: [] };

                    const sendJson = (cmd, args) => tunnel.encodeFrame(TUN_JSON_OBJ, encoder.encode(JSON.stringify({ [cmd]: args })), TUN_IS_REPLY_MASK, frameId).send();
                    const sendBinary = (cmd, type, rawData) => {
                        const buf = Buffer.isBuffer(rawData) ? new Uint8Array(rawData) : encoder.encode(String(rawData));
                        tunnel.encodeFrame(type, buf, TUN_IS_REPLY_MASK, frameId, { cmd }).send();
                    };

                    if (!data.headers) data.headers = {};
                    data.headers['x-is-tunneled'] = 'true';

                    // --- NEW: Socket is now a Native Stream ---
                    const mockSocket = new PassThrough();
                    mockSocket.remoteAddress = '127.0.0.1';

                   const req = new PassThrough();
                    req.url = data.url;
                    req.originalUrl = data.url;
                    req.method = data.method;
                    req.headers = data.headers;
                    req.socket = mockSocket;
                    req.connection = mockSocket;
                    req.complete = false;

                    req.on('end', () => { req.complete = true; });

                    // --- REVERT to simply storing the req object ---
                    activeStreams.set(frameId, req);


                    const rawRes = {
                        app, locals: {}, _headers: data.response?.headers || {},
                        
                        // --- NEW: Dynamic Status Code Syncing ---
                        // Intercept res.statusCode = 304 and push it to the public gateway
                        _statusCode: data.response?.statusCode || 200,
                        get statusCode() { return this._statusCode; },
                        set statusCode(val) { 
                            this._statusCode = val; 
                            sendJson('status', [val]); 
                        },

                        headersSent: false, writable: true, writableEnded: false, writableFinished: false, writableNeedDrain: false, _destroyed: false,
                        finished: false, complete: false,
                        req: req, socket: mockSocket, connection: mockSocket,

                        getHeader: (name) => rawRes._headers[name?.toLowerCase()],
                        get: (name) => rawRes.getHeader(name),
                        setHeader: (k, v) => { 
                            if (rawRes.headersSent) return rawRes; 
                            rawRes._headers[k.toLowerCase()] = v; sendJson('setHeader', [k, v]); return rawRes; 
                        },
                        getHeaders: () => ({ ...rawRes._headers }),
                        hasHeader: (k) => !!rawRes._headers[k.toLowerCase()],
                        removeHeader: (k) => { 
                            if (rawRes.headersSent) return rawRes;
                            delete rawRes._headers[k.toLowerCase()]; sendJson('removeHeader', [k]); return rawRes; 
                        },
                        set: (field, val) => { 
                            if (rawRes.headersSent) return rawRes;
                            if (typeof field === 'string') return rawRes.setHeader(field, val); 
                            for (const key in field) rawRes._headers[key.toLowerCase()] = field[key]; 
                            sendJson('set', [field]); return rawRes; 
                        },
                        writeHead: (statusCode, statusMessage, headers) => {
                            if (rawRes.headersSent) return rawRes;
                            if (typeof statusMessage === 'object') { headers = statusMessage; statusMessage = undefined; }
                            
                            rawRes.statusCode = statusCode; // <--- Automatically triggers the new setter
                            
                            if (headers) { for (const k in headers) rawRes.setHeader(k, headers[k]); }
                            rawRes.headersSent = true;
                            return rawRes;
                        },
                        flushHeaders: () => { rawRes.headersSent = true; },
                        
                        status: (c) => { rawRes.statusCode = c; return rawRes; }, // <--- Automatically triggers the new setter
                        
                        type: (ext) => rawRes.set('Content-Type', ext),

                        write: (chunk, encoding, callback) => {
                            if (rawRes.writableEnded) return false;
                            rawRes.headersSent = true; 
                            sendBinary('write', TUN_BUFFER, chunk);
                            if (typeof encoding === 'function') encoding(); if (typeof callback === 'function') callback();
                            process.nextTick(() => rawRes.emit('drain'));
                            return true; 
                        },
                        send: (body) => {
                            if (rawRes.writableEnded) return rawRes;
                            rawRes.headersSent = true; if (body) sendBinary('write', TUN_BUFFER, body); return rawRes.end();
                        },
                        end: (body, encoding, callback) => {
                            if (rawRes.writableEnded) return rawRes;
                            if (typeof body === 'function') { callback = body; body = null; } 
                            else if (typeof encoding === 'function') { callback = encoding; encoding = null; }
                            rawRes.headersSent = true; rawRes.writableEnded = true; rawRes.writableFinished = true;
                            rawRes.finished = true;
                            if (body) sendBinary('write', TUN_BUFFER, body);
                            sendJson('end', []); 
                            
                            rawRes.emit('finish'); rawRes.emit('close');
                            if (typeof callback === 'function') callback(); return rawRes;
                        },

                        on: (event, fn) => { if (!resEvents[event]) resEvents[event] = []; resEvents[event].push(fn); return rawRes; },
                        once: (event, fn) => { const wrapper = (...args) => { rawRes.removeListener(event, wrapper); fn(...args); }; wrapper.listener = fn; return rawRes.on(event, wrapper); },
                        prependListener: (event, fn) => { if (!resEvents[event]) resEvents[event] = []; resEvents[event].unshift(fn); return rawRes; },
                        emit: (event, ...args) => { if (resEvents[event]) { [...resEvents[event]].forEach(fn => fn(...args)); } return true; },
                        removeListener: (event, fn) => { if (resEvents[event]) { resEvents[event] = resEvents[event].filter(f => f !== fn && f.listener !== fn); } return rawRes; },
                        destroy: () => { 
                            rawRes._destroyed = true; 
                            rawRes.writable = false; 
                            rawRes.finished = true;
                            return rawRes; 
                        }
                    };

                    req.res = rawRes;

                    let res = rawRes;
                    if (LOG_LEVEL >= 3) {
                        res = new Proxy(rawRes, {
                            get(target, prop, receiver) {
                                const val = Reflect.get(target, prop, receiver);
                                if (typeof val === 'function') {
                                    return (...args) => {
                                        const safeArgs = args.map(a => {
                                            if (Buffer.isBuffer(a) || a instanceof Uint8Array) return `[Binary ${a.byteLength || a.length}b]`;
                                            if (typeof a === 'function') return '[Function]';
                                            if (typeof a === 'object' && a !== null) return `[Object ${a.constructor?.name || 'Unknown'}]`;
                                            return String(a);
                                        });
                                        logger.trace(`[ResProxy][Frame ${frameId}] CALL: res.${String(prop)}(${safeArgs.join(', ')})`);
                                        try { return val.apply(target, args); } 
                                        catch (err) { logger.trace(`[ResProxy][Frame ${frameId}] ERROR in res.${String(prop)}: ${err.stack}`); throw err; }
                                    };
                                }
                                logger.trace(`[ResProxy][Frame ${frameId}] GET: res.${String(prop)} (Type: ${typeof val})`);
                                return val;
                            },
                            set(target, prop, value, receiver) {
                                const safeVal = (typeof value === 'object' && value !== null) ? `[Object ${value.constructor?.name || 'Unknown'}]` : (typeof value === 'function' ? '[Function]' : String(value));
                                logger.trace(`[ResProxy][Frame ${frameId}] SET: res.${String(prop)} = ${safeVal}`);
                                return Reflect.set(target, prop, value, receiver);
                            }
                        });
                    }

                    app(req, res, (err) => { 
                        if (err) logger.info(`[Express Route Error] ${err.message || err.stack}`);
                        sendJson('next', []); 
                        activeStreams.delete(frameId); 
                    });
                } 
                
                // --- PUSH DATA INSTEAD OF WRITING ---
                else if (metaData?.target === 'req' && activeStreams.has(frameId)) {
                    const reqStream = activeStreams.get(frameId);
                    
                    if (metaData.event === 'data') {
                        // .push() is the native way to feed a Readable stream!
                        reqStream.push(data);
                    } else if (metaData.event === 'end') {
                        // .push(null) signals End-Of-File for a Readable stream
                        reqStream.push(null);
                        activeStreams.delete(frameId);
                    }
                }

                else if (msgType === TUN_JSON_OBJ && data.wsConnect) {
                    const targetUrl = data.wsConnect.url.replace(new RegExp(`^${rootPath}`), '') || '/';
                    const localTarget = `ws://127.0.0.1:${localWsPort}${targetUrl}`;
                    
                    logger.info(`[Local Express WS] Spawning bridge to ${localTarget} for Frame ${frameId}`);
                    
                    const wsOptions = {
                        headers: {
                            ...(data.wsConnect.headers || {}),
                            'x-is-tunneled': 'true' 
                        }
                    };
                    
                    const localWs = new WebSocket(localTarget, wsOptions);
                    
                    localWs.pendingFrames = []; 
                    activeWebSockets.set(frameId, localWs);

                    localWs.on('open', () => {
                        while (localWs.pendingFrames.length > 0) {
                            const frameData = localWs.pendingFrames.shift();
                            localWs.send(frameData); 
                        }
                    });

                    localWs.on('message', (wsData, isBinary) => {
                        const type = isBinary ? TUN_BUFFER : TUN_TEXT;
                        const buf = isBinary ? new Uint8Array(wsData) : encoder.encode(wsData.toString());
                        tunnel.encodeFrame(type, buf, TUN_IS_STREAM_MASK, frameId, null).send();
                    });

                    localWs.on('close', () => {
                        tunnel.encodeFrame(TUN_JSON_OBJ, encoder.encode(JSON.stringify({ wsClose: true })), TUN_IS_STREAM_MASK, frameId, null).send();
                        activeWebSockets.delete(frameId);
                    });

                    localWs.on('error', (err) => {
                        logger.verbose(`[Local Express WS] Bridge Error: ${err.message}`);
                        tunnel.encodeFrame(TUN_JSON_OBJ, encoder.encode(JSON.stringify({ wsClose: true })), TUN_IS_STREAM_MASK, frameId, null).send();
                        activeWebSockets.delete(frameId);
                    });
                }

                else if (payload.isStream && activeWebSockets.has(frameId)) {
                    const localWs = activeWebSockets.get(frameId);
                    
                    if (msgType === TUN_JSON_OBJ && data.wsClose) {
                        localWs.close();
                        activeWebSockets.delete(frameId);
                    } else if (msgType === TUN_TEXT || msgType === TUN_BUFFER || msgType === TUN_UINT8ARRAY || msgType === TUN_ARRAYBUFFER) {
                        if (localWs.readyState === WebSocket.CONNECTING) {
                            localWs.pendingFrames.push(data);
                        } else if (localWs.readyState === WebSocket.OPEN) {
                            localWs.send(data);
                        }
                    }
                }
            });
        });

        ws.on('close', () => {
            clearInterval(heartbeat);
            setTimeout(connect, 3000);
        });
        ws.on('error', (err) => logger.info(`[Local Express Tunnel] WebSocket Error: ${err.message}`));
    };

    connect();
}

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

export async function vanillaServeStaticFile(req, res, rootPath, publicDir = './public') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return false;
    }

    try {
        const parsedUrl = req.url.split('?')[0];
        
        if (rootPath !== "" && !parsedUrl.startsWith(rootPath)) {
            return false;
        }

        const relativeUrl = parsedUrl.substring(rootPath.length) || '/';
        const basePath = path.resolve(process.cwd(), publicDir);
        const filePath = path.join(basePath, relativeUrl);

        if (!filePath.startsWith(basePath)) {
            return false;
        }

        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            return false;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        const fileData = await fs.readFile(filePath);
        
        res.status(200)
           .setHeader('Content-Type', contentType)
           .setHeader('Content-Length', fileData.length);
           
        if (req.method === 'GET') {
            res.write(fileData);
        }
        
        res.end();
        return true;

    } catch (err) {
        return false; 
    }
}