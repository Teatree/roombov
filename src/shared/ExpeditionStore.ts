import type { ExpeditionData } from './types/expedition.ts';
import type { BehaviorNode } from './types/nodes.ts';

/** Keyed expedition store — supports multiple concurrent expeditions (multiplayer-ready) */
const expeditions = new Map<string, ExpeditionData>();
let activeId: string | null = null;
let nodes: BehaviorNode[] = [];

export const ExpeditionStore = {
  /** Get the local player's active expedition */
  get(): ExpeditionData | null {
    if (!activeId) return null;
    return expeditions.get(activeId) ?? null;
  },

  getById(id: string): ExpeditionData | null {
    return expeditions.get(id) ?? null;
  },

  set(data: ExpeditionData): void {
    expeditions.set(data.configId, data);
  },

  setActive(id: string): void {
    activeId = id;
  },

  getActiveId(): string | null {
    return activeId;
  },

  /** Clear the active expedition only */
  clear(): void {
    if (activeId) {
      expeditions.delete(activeId);
    }
    activeId = null;
    nodes = [];
  },

  /** Clear everything (return to lobby) */
  clearAll(): void {
    expeditions.clear();
    activeId = null;
    nodes = [];
  },

  setNodes(n: BehaviorNode[]): void {
    nodes = n;
  },

  getNodes(): BehaviorNode[] {
    return nodes;
  },
};
