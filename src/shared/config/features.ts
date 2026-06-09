/**
 * Feature-visibility flags — soft-shelving switchboard.
 *
 * Each flag hides a live feature without removing its code, data, or
 * persistence. Flip a flag to `false` to bring the feature back; every
 * gate in the codebase reads from here. The full list of gated sites is
 * documented in HIDDEN_STUFF.md at the repo root — keep it in sync when
 * adding or removing a gate.
 *
 * Shared so both client (UI gates) and server (economy gates) agree.
 */
export const HIDDEN_FEATURES = {
  /**
   * Factory crafting system. Hides the [ FACTORY ] entry buttons (Main Menu
   * + Results) and their claim badges. FactoryScene stays registered and
   * functional — it is just unreachable through the UI.
   */
  factory: true,
  /**
   * Treasure economy. Hides the treasure wallet UI everywhere, drops the
   * treasure cost from special bombs (coins only), and zeroes treasure
   * income from chests. Profile stashes keep persisting untouched.
   */
  treasures: true,
};
