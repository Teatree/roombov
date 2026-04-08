/**
 * Tiny network activity tracker. Increments a "pending" counter whenever
 * client code sends a request to the server, decrements when we receive the
 * expected response (or after a timeout). Scenes render a small hourglass
 * indicator tied to this so the user can always see when the server is
 * doing work for them.
 *
 * This is intentionally lightweight — it doesn't try to match specific
 * requests to specific responses. It just shows "is anything pending?".
 */

type Listener = (pending: number, lastEventAt: number) => void;

const listeners = new Set<Listener>();
let pending = 0;
let lastEventAt = 0;

const TIMEOUT_MS = 5000;

function notify(): void {
  const t = Date.now();
  lastEventAt = t;
  for (const l of listeners) l(pending, t);
}

export const NetworkActivity = {
  /** Mark a request as in-flight. Returns a handle to settle it. */
  begin(label: string): () => void {
    pending++;
    const startedAt = Date.now();
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      pending = Math.max(0, pending - 1);
      notify();
      if (import.meta.env?.DEV) {
        console.log(`[Net] ${label}: ${Date.now() - startedAt}ms`);
      }
    };
    // Auto-settle after TIMEOUT_MS so a lost response doesn't leave the
    // hourglass stuck on forever.
    setTimeout(settle, TIMEOUT_MS);
    notify();
    return settle;
  },

  /** Subscribe to activity changes. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(pending, lastEventAt);
    return () => listeners.delete(fn);
  },

  getPending(): number { return pending; },
};
