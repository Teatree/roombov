import Phaser from 'phaser';

export class CameraController {
  private scene: Phaser.Scene;
  private camera: Phaser.Cameras.Scene2D.Camera;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private camStartX = 0;
  private camStartY = 0;

  constructor(scene: Phaser.Scene, worldWidth: number, worldHeight: number) {
    this.scene = scene;
    this.camera = scene.cameras.main;

    // Padding lets the user pan the map past HUD overlays
    const padX = 250;
    const padY = 100;
    this.camera.setBounds(-padX, -padY, worldWidth + padX * 2, worldHeight + padY * 2);
    this.camera.centerOn(worldWidth / 2, worldHeight / 2);

    this.setupInput();
    this.preventContextMenu();
  }

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
      const newZoom = Phaser.Math.Clamp(this.camera.zoom * zoomFactor, 0.3, 3);
      this.camera.setZoom(newZoom);
    });
  }
}
