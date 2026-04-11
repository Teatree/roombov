import Phaser from 'phaser';

/**
 * Camera controller for the match scene.
 *
 * - Starts centered on the player's Bomberman spawn at zoom 2.5
 * - Smoothly follows the target position with lerp (no jolts)
 * - Middle/right mouse drag takes over panning AND permanently disables
 *   auto-follow for the rest of the match (per design: once the player
 *   moves the camera manually, they're in control)
 * - Scroll wheel zooms in/out (0.5–4.0 range)
 */
export class CameraController {
  private scene: Phaser.Scene;
  private camera: Phaser.Cameras.Scene2D.Camera;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private camStartX = 0;
  private camStartY = 0;
  /** Target world pixel coords the camera lerps toward. */
  private targetX: number;
  private targetY: number;
  /**
   * True until the player drags the camera manually — after that first
   * drag, auto-follow is OFF for the rest of the match.
   */
  private autoFollow = true;
  private lerpSpeed = 0.08;

  constructor(scene: Phaser.Scene, worldWidth: number, worldHeight: number, startX?: number, startY?: number) {
    this.scene = scene;
    this.camera = scene.cameras.main;

    const padX = 250;
    const padY = 100;
    this.camera.setBounds(-padX, -padY, worldWidth + padX * 2, worldHeight + padY * 2);
    this.camera.setZoom(2.5);

    // Start centered on the given world pixel coords (player spawn)
    this.targetX = startX ?? worldWidth / 2;
    this.targetY = startY ?? worldHeight / 2;
    this.camera.centerOn(this.targetX, this.targetY);

    this.setupInput();
    this.preventContextMenu();

    scene.events.on('update', this.updateFollow, this);
    scene.events.once('shutdown', () => {
      scene.events.off('update', this.updateFollow, this);
    });
  }

  /**
   * Update the follow target to the player's current world position.
   * Does NOT re-enable autoFollow — once the player drags, follow stays off.
   */
  setTarget(worldX: number, worldY: number): void {
    this.targetX = worldX;
    this.targetY = worldY;
  }

  private updateFollow = (): void => {
    if (!this.autoFollow || this.isDragging) return;
    const cam = this.camera;
    // Current viewport center in world coordinates
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    const currentCenterX = cam.scrollX + halfW;
    const currentCenterY = cam.scrollY + halfH;
    // Lerp the center toward the target
    const newCenterX = currentCenterX + (this.targetX - currentCenterX) * this.lerpSpeed;
    const newCenterY = currentCenterY + (this.targetY - currentCenterY) * this.lerpSpeed;
    cam.centerOn(newCenterX, newCenterY);
  };

  private preventContextMenu(): void {
    this.scene.game.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  private setupInput(): void {
    const pointer = this.scene.input;

    pointer.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.middleButtonDown() || p.rightButtonDown()) {
        this.isDragging = true;
        // Permanently disable auto-follow — player is now in control
        this.autoFollow = false;
        this.dragStartX = p.x;
        this.dragStartY = p.y;
        this.camStartX = this.camera.scrollX;
        this.camStartY = this.camera.scrollY;
      }
    });

    pointer.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.isDragging) {
        const dx = p.x - this.dragStartX;
        const dy = p.y - this.dragStartY;
        this.camera.scrollX = this.camStartX - dx / this.camera.zoom;
        this.camera.scrollY = this.camStartY - dy / this.camera.zoom;
      }
    });

    pointer.on('pointerup', () => {
      this.isDragging = false;
    });

    this.scene.input.on('wheel', (_pointer: Phaser.Input.Pointer, _gameObjects: unknown[], _dx: number, dy: number) => {
      const zoomFactor = dy > 0 ? 0.9 : 1.1;
      const newZoom = Phaser.Math.Clamp(this.camera.zoom * zoomFactor, 0.5, 4);
      this.camera.setZoom(newZoom);
    });
  }
}
