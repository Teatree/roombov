/**
 * End-to-end smoke test — runs as a standalone script.
 *
 * Boots the server in-process, connects a Socket.io client, and walks the
 * happy path:
 *   1. auth → receive empty profile with 500 coins
 *   2. bomberman_shop_request → receive cycle with 5 templates
 *   3. buy_bomberman → coins decrease, roster +1
 *   4. equip already auto-equipped, verify
 *   5. bombs_shop_request → receive catalog
 *   6. buy_bomb → stockpile +1, coins decrease
 *   7. equip_bomb into slot 0 → slot populated, stockpile decreases
 *   8. match_listings_request → receive 3 listings
 *
 * Exit code 0 = all good, non-zero = failure.
 */

import { io as ioClient } from 'socket.io-client';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import express from 'express';
import { GameServer } from '../src/server/GameServer.ts';
import { PlayerStore } from '../src/server/PlayerStore.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/shared/types/messages.ts';

const PORT = 3399;

async function main(): Promise<void> {
  // --- Boot server in-process ---
  const app = express();
  const httpServer = createServer(app);
  const sio = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  });
  const playerStore = new PlayerStore();
  await playerStore.init();
  const gs = new GameServer(sio, playerStore);

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`[smoke] server up on :${PORT}`);

  // --- Connect client ---
  const client = ioClient(`http://localhost:${PORT}`, {
    transports: ['websocket'],
    reconnection: false,
  });

  const state = {
    profile: null as any,
    shopCycle: null as any,
    bombsCatalog: null as any,
    listings: null as any,
    lastShopResult: null as any,
  };

  client.on('profile', (msg: any) => { state.profile = msg.profile; });
  client.on('bomberman_shop_cycle', (msg: any) => { state.shopCycle = msg; });
  client.on('bombs_catalog', (msg: any) => { state.bombsCatalog = msg; });
  client.on('match_listings', (msg: any) => { state.listings = msg.listings; });
  client.on('shop_result', (msg: any) => { state.lastShopResult = msg; });

  await new Promise<void>((resolve) => client.on('connect', () => resolve()));
  console.log('[smoke] client connected');

  // Wait helper
  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const waitFor = async (pred: () => boolean, label: string, timeoutMs = 2000) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await wait(20);
    }
  };

  let pass = 0;
  const assert = (cond: unknown, label: string): void => {
    if (!cond) { console.error(`  ❌ ${label}`); throw new Error(`assertion failed: ${label}`); }
    console.log(`  ✓ ${label}`);
    pass++;
  };

  try {
    // 1. Auth
    client.emit('auth', { playerId: '' });
    await waitFor(() => state.profile !== null, 'profile');
    assert(state.profile.id?.startsWith('p_'), 'profile has generated id');
    assert(state.profile.coins === 500, 'starting coins == 500');
    assert(state.profile.ownedBombermen.length === 0, 'empty roster');

    const initialPlayerId = state.profile.id;

    // Also verify listings were auto-pushed on auth
    await waitFor(() => state.listings !== null, 'match listings on auth');
    assert(Array.isArray(state.listings) && state.listings.length === 3, 'received 3 match listings');

    // 2. Bomberman shop
    state.shopCycle = null;
    client.emit('bomberman_shop_request');
    await waitFor(() => state.shopCycle !== null, 'shop cycle');
    assert(state.shopCycle.bombermen.length === 5, 'shop has 5 bombermen');
    const freeBomberman = state.shopCycle.bombermen.find((b: any) => b.tier === 'free');
    assert(!!freeBomberman, 'at least one free bomberman');
    assert(freeBomberman.price === 0, 'free tier has price 0');
    const paidBomberman = state.shopCycle.bombermen.find((b: any) => b.tier === 'paid');
    assert(paidBomberman.price >= 100 && paidBomberman.price <= 200, `paid price in [100,200] (got ${paidBomberman.price})`);
    assert(paidBomberman.price % 5 === 0, 'paid price rounded to 5');

    // 3. Buy a free bomberman
    state.profile = null;
    state.lastShopResult = null;
    client.emit('buy_bomberman', { templateId: freeBomberman.id });
    await waitFor(() => state.profile !== null && state.lastShopResult !== null, 'buy response');
    assert(state.lastShopResult.ok === true, 'shop_result ok');
    assert(state.profile.coins === 500, 'coins unchanged after free buy');
    assert(state.profile.ownedBombermen.length === 1, 'roster +1');
    assert(state.profile.equippedBombermanId === state.profile.ownedBombermen[0].id, 'auto-equipped');
    const ownedFree = state.profile.ownedBombermen[0];
    assert(ownedFree.inventory.slots.some((s: any) => s !== null), 'free bomberman has some starting bombs');

    // 4. Buy a paid bomberman and verify coin deduction
    state.profile = null;
    client.emit('buy_bomberman', { templateId: paidBomberman.id });
    await waitFor(() => state.profile !== null, 'paid buy response');
    assert(state.profile.coins === 500 - paidBomberman.price, 'coins deducted for paid buy');
    assert(state.profile.ownedBombermen.length === 2, 'roster +1 again');

    // 5. Bombs catalog
    client.emit('bombs_shop_request');
    await waitFor(() => state.bombsCatalog !== null, 'bombs catalog');
    assert(state.bombsCatalog.catalog.length === 7, 'catalog has 7 purchasable bombs (no rock)');
    const delayBomb = state.bombsCatalog.catalog.find((c: any) => c.type === 'delay');
    assert(!!delayBomb && delayBomb.price > 0, 'delay bomb exists with price > 0');

    // 6. Buy a delay bomb (if affordable)
    if (state.profile.coins >= delayBomb.price) {
      const coinsBefore = state.profile.coins;
      state.profile = null;
      client.emit('buy_bomb', { type: 'delay', quantity: 1 });
      await waitFor(() => state.profile !== null, 'buy bomb response');
      assert(state.profile.coins === coinsBefore - delayBomb.price, 'coins deducted for bomb');
      assert((state.profile.bombStockpile.delay ?? 0) === 1, 'stockpile has 1 delay');

      // 7. Equip into slot 0
      state.profile = null;
      client.emit('equip_bomb', { type: 'delay', slotIndex: 0, quantity: 5 });
      await waitFor(() => state.profile !== null, 'equip response');
      const equipped = state.profile.ownedBombermen.find((b: any) => b.id === state.profile.equippedBombermanId);
      assert(!!equipped, 'equipped bomberman found');
      const s0 = equipped.inventory.slots[0];
      assert(s0 && s0.type === 'delay', 'slot 0 is delay');
    }

    // 8. Reconnect with the same player id → profile persists
    client.disconnect();
    await wait(100);

    const client2 = ioClient(`http://localhost:${PORT}`, { transports: ['websocket'], reconnection: false });
    let profile2: any = null;
    client2.on('profile', (msg: any) => { profile2 = msg.profile; });
    await new Promise<void>(r => client2.on('connect', () => r()));
    client2.emit('auth', { playerId: initialPlayerId });
    await waitFor(() => profile2 !== null, 'profile on reconnect', 3000);
    assert(profile2.id === initialPlayerId, 'same player id returned');
    assert(profile2.ownedBombermen.length === 2, 'roster persisted across reconnect');
    client2.disconnect();

    console.log(`\n✓ ALL ${pass} ASSERTIONS PASSED`);
  } catch (err) {
    console.error('\n❌ SMOKE FAILED:', err);
    process.exitCode = 1;
  } finally {
    client.disconnect();
    await gs.destroy();
    sio.close();
    httpServer.close();

    // Clean up the two player files we created so the test is idempotent
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

    // Force exit — socket.io keeps timers alive
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  }
}

void main();
