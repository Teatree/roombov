import type { ExpeditionConfig, ExpeditionListing } from './types/expedition.ts';
import type { MapData } from './types/map.ts';
import { MAP_MANIFEST } from './maps/map-manifest.ts';
import { BALANCE } from './config/balance.ts';
import { createSeededRandom, seededRandInt, seededShuffle } from './utils/seeded-random.ts';

let nextExpeditionId = 0;

function generateExpeditionId(): string {
  return `exp_${Date.now()}_${nextExpeditionId++}`;
}

/** Generate a single expedition config with correlated risk/reward/stages */
export function generateExpeditionConfig(startTime: number): ExpeditionConfig {
  const seed = Math.floor(Math.random() * 2147483647);
  const rng = createSeededRandom(seed);

  // Risk: weighted bell curve (1:10%, 2:20%, 3:30%, 4:25%, 5:15%)
  const riskRoll = rng();
  const risk = (riskRoll < 0.1 ? 1 : riskRoll < 0.3 ? 2 : riskRoll < 0.6 ? 3 : riskRoll < 0.85 ? 4 : 5) as 1|2|3|4|5;

  // Reward correlates with risk (+/- 1)
  const rewardOffset = seededRandInt(rng, -1, 2);
  const reward = Math.max(1, Math.min(5, risk + rewardOffset)) as 1|2|3|4|5;

  // Stages correlate with average of risk+reward
  const avg = (risk + reward) / 2;
  let stages: number;
  if (avg <= 1.5) stages = 2;
  else if (avg <= 2.5) stages = 2 + seededRandInt(rng, 0, 2);
  else if (avg <= 3.5) stages = 3 + seededRandInt(rng, 0, 2);
  else if (avg <= 4.5) stages = 4 + seededRandInt(rng, 0, 2);
  else stages = 5;
  stages = Math.max(2, Math.min(5, stages));

  // Random map from pool
  const mapIndex = seededRandInt(rng, 0, MAP_MANIFEST.length);
  const map = MAP_MANIFEST[mapIndex];

  const riskTable = BALANCE.risk[risk];
  const rewardTable = BALANCE.reward[reward];

  return {
    id: generateExpeditionId(),
    mapId: map.id,
    mapName: map.name,
    risk,
    reward,
    stages,
    turretCountRange: [...riskTable.turretCountRange] as [number, number],
    goodieCountRange: [...rewardTable.goodieCountRange] as [number, number],
    maxPlayers: BALANCE.lobby.maxPlayersPerExpedition,
    startTime,
    seed,
  };
}

/**
 * Deterministic entity placement from seed + map.
 * All players with the same seed get identical positions.
 */
export function generateExpeditionEntities(
  config: ExpeditionConfig,
  mapData: MapData,
  spawnId: number,
): { turretPositions: { x: number; y: number }[]; goodiePositions: { x: number; y: number }[] } {
  const rng = createSeededRandom(config.seed);

  const occupied = new Set<string>();
  for (const s of mapData.spawns) occupied.add(`${s.x},${s.y}`);
  for (const e of mapData.exits) occupied.add(`${e.x},${e.y}`);
  const spawn = mapData.spawns.find(s => s.id === spawnId)!;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      occupied.add(`${spawn.x + dx},${spawn.y + dy}`);
    }
  }

  // Turret candidates (constrained to turretZones if defined)
  const turretCandidates: { x: number; y: number }[] = [];
  for (let y = 1; y < mapData.height - 1; y++) {
    for (let x = 1; x < mapData.width - 1; x++) {
      if (mapData.grid[y][x] !== 0 || occupied.has(`${x},${y}`)) continue;
      if (mapData.turretZones?.length) {
        if (!mapData.turretZones.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h)) continue;
      }
      turretCandidates.push({ x, y });
    }
  }

  const shuffledTurrets = seededShuffle(rng, turretCandidates);
  const turretCount = seededRandInt(rng, config.turretCountRange[0], config.turretCountRange[1] + 1);
  const turretPositions = shuffledTurrets.slice(0, turretCount);
  for (const p of turretPositions) occupied.add(`${p.x},${p.y}`);

  // Goodie candidates (constrained to goodieZones if defined)
  const goodieCandidates: { x: number; y: number }[] = [];
  for (let y = 1; y < mapData.height - 1; y++) {
    for (let x = 1; x < mapData.width - 1; x++) {
      if (mapData.grid[y][x] !== 0 || occupied.has(`${x},${y}`)) continue;
      if (mapData.goodieZones?.length) {
        if (!mapData.goodieZones.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h)) continue;
      }
      goodieCandidates.push({ x, y });
    }
  }

  const shuffledGoodies = seededShuffle(rng, goodieCandidates);
  const goodieCount = seededRandInt(rng, config.goodieCountRange[0], config.goodieCountRange[1] + 1);
  const goodiePositions = shuffledGoodies.slice(0, goodieCount);

  return { turretPositions, goodiePositions };
}

/** Manages the rolling carousel of expedition listings */
export class ExpeditionScheduler {
  private listings: ExpeditionListing[] = [];
  private nextStartTime: number;

  constructor() {
    const now = Date.now();
    this.nextStartTime = now + BALANCE.lobby.countdownDuration * 1000;
    for (let i = 0; i < BALANCE.lobby.visibleExpeditions; i++) {
      this.listings.push({
        config: generateExpeditionConfig(this.nextStartTime),
        playerCount: 0,
        countdown: BALANCE.lobby.countdownDuration + i * BALANCE.lobby.expeditionInterval,
      });
      this.nextStartTime += BALANCE.lobby.expeditionInterval * 1000;
    }
  }

  /** Tick the scheduler. Returns config if the first expedition just started. */
  tick(): ExpeditionConfig | null {
    const now = Date.now();
    let started: ExpeditionConfig | null = null;

    for (const listing of this.listings) {
      listing.countdown = Math.max(0, (listing.config.startTime - now) / 1000);
    }

    if (this.listings.length > 0 && this.listings[0].countdown <= 0) {
      started = this.listings[0].config;
      this.listings.shift();

      this.listings.push({
        config: generateExpeditionConfig(this.nextStartTime),
        playerCount: 0,
        countdown: (this.nextStartTime - now) / 1000,
      });
      this.nextStartTime += BALANCE.lobby.expeditionInterval * 1000;
    }

    return started;
  }

  getListings(): readonly ExpeditionListing[] {
    return this.listings;
  }

  joinExpedition(expeditionId: string): ExpeditionConfig | null {
    const listing = this.listings.find(l => l.config.id === expeditionId);
    if (!listing) return null;
    listing.playerCount++;
    return listing.config;
  }
}
