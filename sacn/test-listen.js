import dgram from 'dgram';
import { parseSacnPacket, sacnMulticastAddr } from './sacn.js';

const PORT = 5568;
const TEST_UNIVERSE = 1; // Listening to our newly relayed universe
const multicastAddress = sacnMulticastAddr(TEST_UNIVERSE);

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('listening', () => {
    const address = socket.address();
    console.log(`\n🎧 [TEST] UDP Socket bound to port ${address.port}`);
    
    try {
        // Try to join the multicast group on the default interface
        socket.addMembership(multicastAddress);
        console.log(`✅ [TEST] Successfully joined Multicast Group: ${multicastAddress} (Universe ${TEST_UNIVERSE})`);
        console.log(`⏳ Waiting for packets...\n`);
    } catch (err) {
        console.error(`❌ [TEST] Failed to join multicast group:`, err.message);
    }
});

let packetCount = 0;

socket.on('message', (msg, rinfo) => {
    // 1. See if our custom parser can make sense of it
    const parsed = parseSacnPacket(msg);
    
    if (parsed) {
        if (parsed.universe === TEST_UNIVERSE) {
            packetCount++;
            // Just log every 10th packet so we don't flood the terminal
            if (packetCount % 10 === 0 || packetCount === 1) {
                console.log(`[SUCCESS] Parsed valid sACN packet from ${rinfo.address}!`);
                console.log(`   -> CH 1: ${parsed.dmx[0]} | CH 2: ${parsed.dmx[1]} | CH 3: ${parsed.dmx[2]}`);
            }
        }
    } else {
        // If it hit port 5568 but parseSacnPacket rejected it, log the raw data
        console.log(`[REJECTED] Received ${msg.length} bytes from ${rinfo.address}, but parseSacnPacket returned null.`);
    }
});

socket.bind(PORT);