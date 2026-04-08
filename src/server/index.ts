import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3000', 10);

// Socket.io with CORS for local dev
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3333', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
  },
});

// Start game server
const gameServer = new GameServer(io);

// Serve built client
app.use(express.static(path.join(__dirname, '../../dist')));

app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../dist/index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`Roombov server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  gameServer.destroy();
  httpServer.close();
});
