import type Phaser from 'phaser';
import { isMobileDevice } from './isMobile.ts';

/**
 * Mobile viewport management — two concerns, both no-ops on desktop:
 *
 *  1. **Dynamic-URL-bar sizing.** Mobile browsers grow/shrink their address
 *     bar as the user scrolls, which changes the *visible* height without
 *     firing a normal `window.resize`. `window.innerHeight` reports the layout
 *     viewport (which can be taller than what's actually on-screen), so a
 *     bottom-anchored HUD ends up clipped under the URL bar. We instead size
 *     the Phaser canvas to `window.visualViewport` — the genuinely visible
 *     rectangle — and re-apply it whenever the visual viewport changes.
 *
 *  2. **Portrait gate.** The game is landscape-only. In portrait we cover the
 *     whole page with a "rotate your device" overlay (with a twisting-phone
 *     animation) so nothing of the game renders sideways.
 *
 * Call {@link installMobileViewport} once, right after the Phaser game is
 * created.
 */
export function installMobileViewport(game: Phaser.Game): void {
  const mobile = isMobileDevice();
  if (!mobile) {
    // Desktop: leave Phaser's own RESIZE handling untouched. (The portrait
    // gate and visualViewport sizing only matter for phones.)
    return;
  }

  const gate = createOrientationGate();

  // rAF-coalesced so a burst of resize/scroll events does one resize per frame.
  let pending = false;
  const apply = (): void => {
    pending = false;
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);

    const portrait = h > w;
    gate.setVisible(portrait);

    if (portrait) return; // don't bother resizing the canvas behind the cover
    if (w <= 0 || h <= 0) return;

    // Phaser's Scale.RESIZE fits the canvas to its parent (#game) element, and
    // re-asserts that on its own resize events. So we pin the parent to the
    // *visible* viewport (URL-bar aware) rather than fight it, then sync the
    // canvas immediately. `100vh`/`100dvh` in CSS is the no-JS baseline.
    const parent = document.getElementById('game');
    if (parent) {
      parent.style.width = `${w}px`;
      parent.style.height = `${h}px`;
    }
    game.scale.resize(w, h);
  };
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(apply);
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);

  // Initial pass (also catches the case where the player loads in portrait).
  schedule();
}

interface OrientationGate {
  setVisible(visible: boolean): void;
}

/**
 * Builds (once) a full-screen DOM overlay shown while the phone is held in
 * portrait. Lives in the DOM rather than a Phaser scene so it covers the game
 * uniformly regardless of which scene is active and works even before the
 * first scene renders. Styling is injected inline so there's no CSS file to
 * keep in sync.
 */
function createOrientationGate(): OrientationGate {
  const STYLE_ID = 'roombov-orientation-style';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #roombov-orientation {
        position: fixed; inset: 0; z-index: 99999;
        display: none; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 24px; padding: 24px; box-sizing: border-box;
        background: #14141f; color: #e6e6f0;
        font-family: monospace; text-align: center;
        user-select: none; -webkit-user-select: none;
      }
      #roombov-orientation.show { display: flex; }
      #roombov-orientation .phone {
        width: 56px; height: 96px;
        border: 4px solid #4aa3ff; border-radius: 12px;
        transform-origin: center;
        animation: roombov-rotate 1.8s ease-in-out infinite;
      }
      #roombov-orientation .phone::after {
        content: ''; position: absolute;
        left: 50%; bottom: 8px; width: 18px; height: 3px;
        background: #4aa3ff; border-radius: 2px; transform: translateX(-50%);
      }
      #roombov-orientation .title { font-size: 20px; font-weight: bold; color: #ffffff; }
      #roombov-orientation .sub { font-size: 14px; color: #9a9ab0; max-width: 320px; line-height: 1.4; }
      @keyframes roombov-rotate {
        0%, 15%   { transform: rotate(0deg); }
        55%, 100% { transform: rotate(-90deg); }
      }
    `;
    document.head.appendChild(style);
  }

  let el = document.getElementById('roombov-orientation');
  if (!el) {
    el = document.createElement('div');
    el.id = 'roombov-orientation';
    const phone = document.createElement('div');
    phone.className = 'phone';
    phone.style.position = 'relative';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Please rotate your device';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'Roombov is played in landscape. Turn your phone sideways to keep playing.';
    el.append(phone, title, sub);
    document.body.appendChild(el);
  }

  const node = el;
  return {
    setVisible(visible: boolean): void {
      node.classList.toggle('show', visible);
    },
  };
}
