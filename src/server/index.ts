// MUST be the first import. Loads .env before any module reads process.env
// (Analytics.ts in particular captures ANALYTICS_WEBHOOK_URL at eval time).
import './env.ts';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.ts';
import { PlayerStore } from './PlayerStore.ts';
import { IpCountryCache } from './IpCountryCache.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types/messages.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const PORT = parseInt(process.env.PORT || '3000', 10);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3333', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
  },
});

// Bootstrap async before accepting connections
const playerStore = new PlayerStore();
await playerStore.init();
const ipCountryCache = new IpCountryCache();
await ipCountryCache.init();
const gameServer = new GameServer(io, playerStore, ipCountryCache);

app.use(express.static(path.join(__dirname, '../../dist')));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../dist/index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`Bomberman server running on port ${PORT}`);
});

async function shutdown(): Promise<void> {
  console.log('Server shutting down...');
  await gameServer.destroy();
  httpServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
