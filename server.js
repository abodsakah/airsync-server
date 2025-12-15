const WebSocket = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 8080;
const ROOM_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Data structures
const rooms = new Map(); // Map<pairingCode, Room>
const connections = new Map(); // Map<ws, ConnectionInfo>

// Room structure
class Room {
  constructor(code) {
    this.code = code;
    this.mac = null;
    this.android = null;
    this.createdAt = Date.now();
    this.timeout = null;
  }

  isFull() {
    return this.mac !== null && this.android !== null;
  }

  isEmpty() {
    return this.mac === null && this.android === null;
  }

  addDevice(ws, deviceType) {
    if (deviceType === 'mac') {
      this.mac = ws;
    } else if (deviceType === 'android') {
      this.android = ws;
    }
    this.clearTimeout();
  }

  removeDevice(ws) {
    if (this.mac === ws) {
      this.mac = null;
    } else if (this.android === ws) {
      this.android = null;
    }
  }

  getPartner(ws) {
    if (this.mac === ws) {
      return this.android;
    } else if (this.android === ws) {
      return this.mac;
    }
    return null;
  }

  startTimeout(callback) {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      log(`Room ${this.code} timed out after ${ROOM_TIMEOUT / 1000} seconds`);
      callback(this.code);
    }, ROOM_TIMEOUT);
  }

  clearTimeout() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

// Connection info structure
class ConnectionInfo {
  constructor(ws) {
    this.ws = ws;
    this.roomCode = null;
    this.deviceType = null;
    this.isAlive = true;
  }
}

// Utility functions
function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function error(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

function sendMessage(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type, data }));
    } catch (err) {
      error(`Failed to send message: ${err.message}`);
    }
  }
}

function sendError(ws, message) {
  sendMessage(ws, 'error', { message });
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room) {
    room.clearTimeout();
    
    // Notify connected devices
    if (room.mac) {
      sendMessage(room.mac, 'roomClosed', { reason: 'Partner disconnected' });
      const macInfo = connections.get(room.mac);
      if (macInfo) {
        macInfo.roomCode = null;
      }
    }
    if (room.android) {
      sendMessage(room.android, 'roomClosed', { reason: 'Partner disconnected' });
      const androidInfo = connections.get(room.android);
      if (androidInfo) {
        androidInfo.roomCode = null;
      }
    }
    
    rooms.delete(code);
    log(`Room ${code} cleaned up`);
  }
}

function handleCreateRoom(ws) {
  const connInfo = connections.get(ws);
  if (!connInfo) return;

  // Generate unique pairing code
  let code;
  do {
    code = generatePairingCode();
  } while (rooms.has(code));

  // Create new room
  const room = new Room(code);
  room.addDevice(ws, 'mac');
  rooms.set(code, room);

  // Update connection info
  connInfo.roomCode = code;
  connInfo.deviceType = 'mac';

  // Start timeout for room with only one device
  room.startTimeout(cleanupRoom);

  sendMessage(ws, 'roomCreated', { code });
  log(`Room created with code: ${code} (Total rooms: ${rooms.size})`);
}

function handleJoinRoom(ws, data) {
  const connInfo = connections.get(ws);
  if (!connInfo) return;

  const { code } = data;
  
  if (!code) {
    sendError(ws, 'Pairing code is required');
    return;
  }

  const room = rooms.get(code);
  
  if (!room) {
    sendError(ws, 'Invalid pairing code');
    log(`Failed join attempt with invalid code: ${code}`);
    return;
  }

  if (room.isFull()) {
    sendError(ws, 'Room is full');
    log(`Failed join attempt - room ${code} is full`);
    return;
  }

  // Add device to room
  room.addDevice(ws, 'android');
  connInfo.roomCode = code;
  connInfo.deviceType = 'android';

  // Notify both devices
  sendMessage(ws, 'roomJoined', { code });
  if (room.mac) {
    sendMessage(room.mac, 'partnerConnected', {});
  }

  log(`Device joined room ${code} (Room is now full)`);
}

function handleRelay(ws, data) {
  const connInfo = connections.get(ws);
  if (!connInfo || !connInfo.roomCode) {
    sendError(ws, 'Not in a room');
    return;
  }

  const room = rooms.get(connInfo.roomCode);
  if (!room) {
    sendError(ws, 'Room no longer exists');
    return;
  }

  const partner = room.getPartner(ws);
  if (!partner) {
    sendError(ws, 'Partner not connected');
    return;
  }

  // Forward the message to partner
  sendMessage(partner, 'relay', data);
}

function handlePing(ws) {
  const connInfo = connections.get(ws);
  if (connInfo) {
    connInfo.isAlive = true;
  }
  sendMessage(ws, 'pong', {});
}

function handleDisconnect(ws) {
  const connInfo = connections.get(ws);
  if (!connInfo) return;

  log(`Device disconnected (Type: ${connInfo.deviceType || 'unknown'})`);

  // Clean up room if in one
  if (connInfo.roomCode) {
    const room = rooms.get(connInfo.roomCode);
    if (room) {
      room.removeDevice(ws);
      
      // If room is now empty, clean it up
      if (room.isEmpty()) {
        cleanupRoom(connInfo.roomCode);
      } else {
        // If partner still exists, notify them and start timeout
        const partner = room.getPartner(ws);
        if (partner) {
          sendMessage(partner, 'partnerDisconnected', {});
          room.startTimeout(cleanupRoom);
        }
      }
    }
  }

  // Remove connection
  connections.delete(ws);
  log(`Total active connections: ${connections.size}`);
}

function handleMessage(ws, message) {
  try {
    const { type, data } = JSON.parse(message);
    
    switch (type) {
      case 'createRoom':
        handleCreateRoom(ws);
        break;
      case 'joinRoom':
        handleJoinRoom(ws, data || {});
        break;
      case 'relay':
        handleRelay(ws, data || {});
        break;
      case 'ping':
        handlePing(ws);
        break;
      default:
        sendError(ws, `Unknown message type: ${type}`);
        log(`Unknown message type received: ${type}`);
    }
  } catch (err) {
    error(`Failed to parse message: ${err.message}`);
    sendError(ws, 'Invalid message format');
  }
}

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      activeConnections: connections.size,
      activeRooms: rooms.size,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  log(`New connection established (Total: ${connections.size + 1})`);
  
  // Initialize connection info
  const connInfo = new ConnectionInfo(ws);
  connections.set(ws, connInfo);

  // Handle messages
  ws.on('message', (message) => {
    handleMessage(ws, message.toString());
  });

  // Handle pong responses
  ws.on('pong', () => {
    const connInfo = connections.get(ws);
    if (connInfo) {
      connInfo.isAlive = true;
    }
  });

  // Handle connection close
  ws.on('close', () => {
    handleDisconnect(ws);
  });

  // Handle errors
  ws.on('error', (err) => {
    error(`WebSocket error: ${err.message}`);
  });
});

// Heartbeat mechanism to detect dead connections
const heartbeat = setInterval(() => {
  // Collect dead connections first to avoid modifying map during iteration
  const deadConnections = [];
  connections.forEach((connInfo, ws) => {
    if (!connInfo.isAlive) {
      deadConnections.push(ws);
    } else {
      connInfo.isAlive = false;
      ws.ping();
    }
  });
  
  // Terminate dead connections
  deadConnections.forEach((ws) => {
    log('Terminating dead connection');
    handleDisconnect(ws);
    ws.terminate();
  });
}, HEARTBEAT_INTERVAL);

// Cleanup on server shutdown
wss.on('close', () => {
  clearInterval(heartbeat);
  // Use Array.from to avoid modification during iteration
  Array.from(rooms.keys()).forEach((code) => {
    cleanupRoom(code);
  });
});

// Start server
server.listen(PORT, () => {
  log(`AirSync WebSocket Relay Server running on port ${PORT}`);
  log(`WebSocket URL: ws://localhost:${PORT}`);
  log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    log('HTTP server closed');
    process.exit(0);
  });
});
