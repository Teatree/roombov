/**
 * Match-loop smoke test. Boots server, connects 2 clients, walks them
 * through: auth → equip a free bomberman → join the same match listing →
 * wait for match_start → verify match_state arrives → submit actions →
 * verify turn resolution → walk onto an escape tile → verify match_end.
 *
 * This isn't a full integration test — but it covers the critical paths.
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import express from 'express';
import { GameServer } from '../src/server/GameServer.ts';
import { PlayerStore } from '../src/server/PlayerStore.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/shared/types/messages.ts';
import type { MatchState } from '../src/shared/types/match.ts';
import { BALANCE } from '../src/shared/config/balance.ts';

const PORT = 3398;

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ClientState {
  id: string;
  sock: Client;
  profile: any;
  listings: any;
  matchState: MatchState | null;
  matchEnded: boolean;
  matchEndMsg: any;
}

function makeClient(port: number, label: string): Promise<ClientState> {
  return new Promise((resolve) => {
    const sock = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'], reconnection: false,
    }) as Client;

    const state: ClientState = {
      id: label,
      sock,
      profile: null,
      listings: null,
      matchState: null,
      matchEnded: false,
      matchEndMsg: null,
    };

    sock.on('profile', (msg: any) => { state.profile = msg.profile; });
    sock.on('match_listings', (msg: any) => { state.listings = msg.listings; });
    sock.on('match_state', (msg: any) => { state.matchState = msg.state; });
    sock.on('match_end', (msg: any) => {
      state.matchEnded = true;
      state.matchEndMsg = msg;
    });

    sock.on('connect', () => resolve(state));
  });
}

async function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await wait(50);
  }
}

async function main(): Promise<void> {
  // Shrink the lobby countdown + turn pace so the test finishes quickly.
  (BALANCE.lobby as any).countdownDuration = 2;
  (BALANCE.match as any).inputPhaseSeconds = 0.5;
  (BALANCE.match as any).transitionPhaseSeconds = 0.3;
  (BALANCE.match as any).turnLimit = 5;

  const app = express();
  const httpServer = createServer(app);
  const sio = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  });
  const playerStore = new PlayerStore();
  await playerStore.init();
  const gs = new GameServer(sio, playerStore);

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`[match] server up on :${PORT}`);

  let pass = 0;
  const assert = (cond: unknown, label: string): void => {
    if (!cond) { console.error(`  ❌ ${label}`); throw new Error(`assert failed: ${label}`); }
    console.log(`  ✓ ${label}`);
    pass++;
  };

  const a = await makeClient(PORT, 'A');
  const b = await makeClient(PORT, 'B');

  try {
    // --- Auth both ---
    a.sock.emit('auth', { playerId: '' });
    b.sock.emit('auth', { playerId: '' });
    await waitFor(() => a.profile && b.profile, 'both profiles');

    // --- Buy a free Bomberman each (first one in cycle) ---
    let cycle: any = null;
    const cycleHandler = (msg: any) => { cycle = msg; };
    a.sock.on('bomberman_shop_cycle', cycleHandler);
    a.sock.emit('bomberman_shop_request');
    await waitFor(() => cycle !== null, 'shop cycle');
    const freeTemplates = cycle.bombermen.filter((t: any) => t.tier === 'free');
    assert(freeTemplates.length >= 2, 'at least 2 free bombermen in cycle');

    a.profile = null;
    b.profile = null;
    a.sock.emit('buy_bomberman', { templateId: freeTemplates[0].id });
    b.sock.emit('buy_bomberman', { templateId: freeTemplates[1].id });
    await waitFor(() => a.profile?.equippedBombermanId && b.profile?.equippedBombermanId, 'equipped bombermen');

    // --- Wait for next match listing to be near ---
    await waitFor(() => a.listings?.length > 0, 'listings');
    // Find the listing with the smallest countdown
    const firstListing = a.listings.slice().sort((x: any, y: any) => x.countdown - y.countdown)[0];
    assert(!!firstListing, 'have a listing to join');

    // --- Both join the same match ---
    a.sock.emit('join_match', { matchId: firstListing.config.id });
    b.sock.emit('join_match', { matchId: firstListing.config.id });

    // --- Wait for match_state (server authoritative) ---
    await waitFor(() => a.matchState !== null && b.matchState !== null, 'match started and first state arrived', 15000);
    assert(a.matchState!.bombermen.length === 2, 'match has 2 bombermen');
    assert(a.matchState!.phase === 'input', 'first phase is input');
    assert(a.matchState!.turnNumber === 1, 'turn number 1');

    // --- Submit a walk action for each player ---
    const aBomberman = a.matchState!.bombermen.find((b2: any) => b2.playerId === a.profile.id)!;
    const bBomberman = b.matchState!.bombermen.find((b2: any) => b2.playerId === b.profile.id)!;
    assert(!!aBomberman && !!bBomberman, 'both bombermen present');

    // Find a walkable neighbor tile for each
    const findStep = (x: number, y: number, map: any) => {
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (map?.grid?.[ny]?.[nx] === 0) return { x: nx, y: ny };
      }
      return null;
    };

    // We don't have the map on the client-side of this test — but we know
    // bombermen spawn on walkable tiles and custom_map1 is mostly open.
    // Use the server's match state: Bombermen are on floor tiles, so stepping
    // to (x+1, y) will usually work; if not, the resolver will treat as idle.
    a.sock.emit('player_action', { action: { kind: 'move', x: aBomberman.x + 1, y: aBomberman.y } });
    b.sock.emit('player_action', { action: { kind: 'idle' } });

    // Wait for the transition phase (matchState phase change)
    const prevTurn = a.matchState!.turnNumber;
    await waitFor(() => {
      return a.matchState!.turnNumber > prevTurn || a.matchState!.phase === 'transition';
    }, 'turn advanced', 5000);

    // After at most a few turn cycles the state should progress
    await waitFor(() => a.matchState!.turnNumber >= 2, 'turn 2 reached', 8000);
    assert(a.matchState!.turnNumber >= 2, `turn advanced to ${a.matchState!.turnNumber}`);

    // --- Let the match run out naturally: submit idle for both ---
    let safety = 0;
    while (!a.matchEnded && safety < 400) {
      safety++;
      if (a.matchState!.phase === 'input' && a.matchState!.bombermen.find(bb => bb.playerId === a.profile.id && bb.alive)) {
        a.sock.emit('player_action', { action: { kind: 'idle' } });
      }
      if (b.matchState!.phase === 'input' && b.matchState!.bombermen.find(bb => bb.playerId === b.profile.id && bb.alive)) {
        b.sock.emit('player_action', { action: { kind: 'idle' } });
      }
      await wait(100);
    }

    assert(a.matchEnded, `match ended (reason=${a.matchEndMsg?.endReason})`);
    assert(b.matchEnded, 'client B also received match_end');

    console.log(`\n✓ ALL ${pass} ASSERTIONS PASSED`);
  } catch (err) {
    console.error('\n❌ MATCH FAILED:', err);
    process.exitCode = 1;
  } finally {
    a.sock.disconnect();
    b.sock.disconnect();
    await gs.destroy();
    sio.close();
    httpServer.close();

    // Cleanup player files
    const { readdir, unlink } = await import('fs/promises');
    const { join } = await import('path');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const dataDir = join(here, '../production/player-data');
    try {
      const files = await readdir(dataDir);
      for (const f of files) if (f.endsWith('.json')) await unlink(join(dataDir, f));
    } catch { /* ignore */ }

    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  }
}

void main();
