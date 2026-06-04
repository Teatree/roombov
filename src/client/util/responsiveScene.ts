import Phaser from 'phaser';

/**
 * Shared responsive-layout helper for the menu/UI scenes.
 *
 * The menus are authored at a comfortable desktop size and overflow on a short
 * landscape phone (~390px tall). Rather than reflow every element, each scene
 * lays its content out in a fixed *design* box and lets the scene's main camera
 * scale that box down to fit small viewports. Because the camera renders every
 * object (text, widgets, badges), one zoom call fits the whole screen.
 *
 * Crucially this is a **no-op on desktop**: when the viewport is at least the
 * design size the camera is left at its default (zoom 1, no scroll), so desktop
 * layout is byte-for-byte unchanged. Only genuinely small viewports get scaled.
 *
 * Usage per scene:
 *   const { layoutW, layoutH } = designViewport(this, DW, DH);
 *   // ...build UI; use layoutW/layoutH (not this.scale.*) for edge-anchored
 *   //    elements so they sit at the design box edges when short...
 *   fitSceneToViewport(this, DW, DH);              // end of create()
 *   this.scale.on('resize', () => fitSceneToViewport(this, DW, DH), this);
 */

export interface DesignViewport {
  /** True when the viewport is smaller than the design box (content is scaled). */
  short: boolean;
  /** Width to lay out against (live viewport on desktop, design width when short). */
  layoutW: number;
  /** Height to lay out against (live viewport on desktop, design height when short). */
  layoutH: number;
}

/**
 * Returns the dimensions a scene should lay its content out against: the live
 * viewport when it already meets the design size (desktop — unchanged), or the
 * fixed design size when the viewport is smaller (so edge-anchored elements land
 * on the design box edges and scale cleanly via {@link fitSceneToViewport}).
 */
export function designViewport(scene: Phaser.Scene, designW: number, designH: number): DesignViewport {
  const vw = scene.scale.width;
  const vh = scene.scale.height;
  const short = vw < designW || vh < designH;
  return {
    short,
    layoutW: short ? designW : vw,
    layoutH: short ? designH : vh,
  };
}

/**
 * Scale the scene's main camera so a `designW × designH` layout fits the
 * viewport, centered. No-op (default camera) when the viewport already fits, so
 * desktop is untouched. Horizontal centering tracks the live viewport width so
 * width-centered content (`this.scale.width / 2`) stays centered.
 */
export function fitSceneToViewport(scene: Phaser.Scene, designW: number, designH: number): void {
  const cam = scene.cameras.main;
  const vw = scene.scale.width;
  const vh = scene.scale.height;
  if (vw >= designW && vh >= designH) {
    cam.setZoom(1);
    cam.centerOn(vw / 2, vh / 2);
    return;
  }
  const scale = Math.min(vw / designW, vh / designH);
  cam.setZoom(scale);
  cam.centerOn(vw / 2, designH / 2);
}
