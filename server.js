const WebSocket = require("ws");
const http = require("http");

// Configuration
const PORT = process.env.PORT || 8080;
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes (increased from 5)
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const PERSISTENT_ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours for persistent rooms

// Data structures
const rooms = new Map(); // Map<pairingCode, Room>
const connections = new Map(); // Map<ws, ConnectionInfo>

// Room structure
class Room {
	constructor(code, persistent = false) {
		this.code = code;
		this.mac = null;
		this.android = null;
		this.createdAt = Date.now();
		this.timeout = null;
		this.persistent = persistent; // ✅ NEW: Persistent rooms don't timeout quickly
		this.lastActivity = Date.now();
	}

	isFull() {
		return this.mac !== null && this.android !== null;
	}

	isEmpty() {
		return this.mac === null && this.android === null;
	}

	addDevice(ws, deviceType) {
		if (deviceType === "mac") {
			this.mac = ws;
		} else if (deviceType === "android") {
			this.android = ws;
		}
		this.lastActivity = Date.now();
		this.clearTimeout();
	}

	removeDevice(ws) {
		if (this.mac === ws) {
			this.mac = null;
		} else if (this.android === ws) {
			this.android = null;
		}
		this.lastActivity = Date.now();
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
		// ✅ Use longer timeout for persistent rooms
		const timeoutDuration = this.persistent
			? PERSISTENT_ROOM_TIMEOUT
			: ROOM_TIMEOUT;
		this.timeout = setTimeout(() => {
			log(
				`Room ${this.code} timed out after ${timeoutDuration / 1000} seconds`
			);
			callback(this.code);
		}, timeoutDuration);
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
	sendMessage(ws, "error", { message });
}

function cleanupRoom(code) {
	const room = rooms.get(code);
	if (room) {
		room.clearTimeout();

		// Notify connected devices
		if (room.mac) {
			sendMessage(room.mac, "roomClosed", { reason: "Room timeout" });
			const macInfo = connections.get(room.mac);
			if (macInfo) {
				macInfo.roomCode = null;
			}
		}
		if (room.android) {
			sendMessage(room.android, "roomClosed", {
				reason: "Room timeout"
			});
			const androidInfo = connections.get(room.android);
			if (androidInfo) {
				androidInfo.roomCode = null;
			}
		}

		rooms.delete(code);
		log(`Room ${code} cleaned up`);
	}
}

function handleCreateRoom(ws, data = {}) {
	const connInfo = connections.get(ws);
	if (!connInfo) return;

	// ✅ Support persistent rooms
	const persistent = data.persistent === true;

	// Generate unique pairing code
	let code;
	do {
		code = generatePairingCode();
	} while (rooms.has(code));

	// Create new room
	const room = new Room(code, persistent);
	room.addDevice(ws, "mac");
	rooms.set(code, room);

	// Update connection info
	connInfo.roomCode = code;
	connInfo.deviceType = "mac";

	// Start timeout for room with only one device
	room.startTimeout(cleanupRoom);

	sendMessage(ws, "roomCreated", { code, persistent });
	log(
		`Room created with code: ${code} (Persistent: ${persistent}, Total rooms: ${rooms.size})`
	);
}

function handleJoinRoom(ws, data) {
	const connInfo = connections.get(ws);
	if (!connInfo) return;

	const { code } = data;

	if (!code) {
		sendError(ws, "Pairing code is required");
		return;
	}

	const room = rooms.get(code);

	if (!room) {
		sendError(ws, "Invalid pairing code");
		log(`Failed join attempt with invalid code: ${code}`);
		return;
	}

	// ✅ Allow rejoining if device disconnected
	const existingDevice =
		connInfo.deviceType === "mac" ? room.mac : room.android;
	if (room.isFull() && existingDevice !== ws) {
		sendError(ws, "Room is full");
		log(`Failed join attempt - room ${code} is full`);
		return;
	}

	// Add device to room
	const deviceType = data.deviceType || "android";
	room.addDevice(ws, deviceType);
	connInfo.roomCode = code;
	connInfo.deviceType = deviceType;

	// Notify device that joined
	sendMessage(ws, "roomJoined", { code, persistent: room.persistent });

	// ✅ Notify partner if they're connected
	const partner = room.getPartner(ws);
	if (partner) {
		sendMessage(partner, "partnerConnected", { deviceType });
		log(
			`Device ${deviceType} joined room ${code} - both devices now connected`
		);
	} else {
		log(`Device ${deviceType} joined room ${code} - waiting for partner`);
		// Start timeout since only one device
		room.startTimeout(cleanupRoom);
	}
}

function handleRelay(ws, data) {
	const connInfo = connections.get(ws);
	if (!connInfo || !connInfo.roomCode) {
		sendError(ws, "Not in a room");
		return;
	}

	const room = rooms.get(connInfo.roomCode);
	if (!room) {
		sendError(ws, "Room no longer exists");
		return;
	}

	const partner = room.getPartner(ws);
	if (!partner) {
		sendError(ws, "Partner not connected");
		return;
	}

	// Update activity timestamp
	room.lastActivity = Date.now();

	// Forward the message to partner
	sendMessage(partner, "relay", data);
}

function handlePing(ws) {
	const connInfo = connections.get(ws);
	if (connInfo) {
		connInfo.isAlive = true;

		// Update room activity
		if (connInfo.roomCode) {
			const room = rooms.get(connInfo.roomCode);
			if (room) {
				room.lastActivity = Date.now();
			}
		}
	}
	sendMessage(ws, "pong", {});
}

function handleDisconnect(ws) {
	const connInfo = connections.get(ws);
	if (!connInfo) return;

	log(`Device disconnected (Type: ${connInfo.deviceType || "unknown"})`);

	// Clean up room if in one
	if (connInfo.roomCode) {
		const room = rooms.get(connInfo.roomCode);
		if (room) {
			room.removeDevice(ws);

			// ✅ For persistent rooms, keep room alive and notify partner
			if (room.persistent) {
				const partner = room.getPartner(ws);
				if (partner) {
					sendMessage(partner, "partnerDisconnected", {
						deviceType: connInfo.deviceType
					});
				}
				// Start long timeout
				room.startTimeout(cleanupRoom);
				log(
					`Persistent room ${connInfo.roomCode} kept alive - ${connInfo.deviceType} disconnected`
				);
			} else {
				// Non-persistent room:  clean up if empty
				if (room.isEmpty()) {
					cleanupRoom(connInfo.roomCode);
				} else {
					const partner = room.getPartner(ws);
					if (partner) {
						sendMessage(partner, "partnerDisconnected", {
							deviceType: connInfo.deviceType
						});
						room.startTimeout(cleanupRoom);
					}
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
			case "createRoom":
				handleCreateRoom(ws, data || {});
				break;
			case "joinRoom":
				handleJoinRoom(ws, data || {});
				break;
			case "relay":
				handleRelay(ws, data || {});
				break;
			case "ping":
				handlePing(ws);
				break;
			default:
				sendError(ws, `Unknown message type: ${type}`);
				log(`Unknown message type received: ${type}`);
		}
	} catch (err) {
		error(`Failed to parse message: ${err.message}`);
		sendError(ws, "Invalid message format");
	}
}

// Create HTTP server
const server = http.createServer((req, res) => {
	if (req.url === "/health" || req.url === "/") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				uptime: process.uptime(),
				activeConnections: connections.size,
				activeRooms: rooms.size,
				timestamp: new Date().toISOString()
			})
		);
	} else {
		res.writeHead(404);
		res.end();
	}
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
	log(`New connection established (Total: ${connections.size + 1})`);

	// Initialize connection info
	const connInfo = new ConnectionInfo(ws);
	connections.set(ws, connInfo);

	// Handle messages
	ws.on("message", (message) => {
		handleMessage(ws, message.toString());
	});

	// Handle pong responses
	ws.on("pong", () => {
		const connInfo = connections.get(ws);
		if (connInfo) {
			connInfo.isAlive = true;
		}
	});

	// Handle connection close
	ws.on("close", () => {
		handleDisconnect(ws);
	});

	// Handle errors
	ws.on("error", (err) => {
		error(`WebSocket error: ${err.message}`);
	});
});

// Heartbeat mechanism to detect dead connections
const heartbeat = setInterval(() => {
	const deadConnections = [];
	connections.forEach((connInfo, ws) => {
		if (!connInfo.isAlive) {
			deadConnections.push(ws);
		} else {
			connInfo.isAlive = false;
			ws.ping();
		}
	});

	deadConnections.forEach((ws) => {
		log("Terminating dead connection");
		handleDisconnect(ws);
		ws.terminate();
	});
}, HEARTBEAT_INTERVAL);

// Cleanup on server shutdown
wss.on("close", () => {
	clearInterval(heartbeat);
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
process.on("SIGTERM", () => {
	log("SIGTERM signal received: closing HTTP server");
	server.close(() => {
		log("HTTP server closed");
		process.exit(0);
	});
});

process.on("SIGINT", () => {
	log("SIGINT signal received: closing HTTP server");
	server.close(() => {
		log("HTTP server closed");
		process.exit(0);
	});
});
