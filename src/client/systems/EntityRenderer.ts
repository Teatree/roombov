import Phaser from 'phaser';
import type { RoombaState, TurretState, GoodieState, Projectile } from '@shared/types/entities.ts';
import { BALANCE } from '@shared/config/balance.ts';

const TS = BALANCE.map.tileSize;

export class EntityRenderer {
  private scene: Phaser.Scene;
  private roombaGraphics: Phaser.GameObjects.Graphics;
  private turretGraphics: Phaser.GameObjects.Graphics;
  private goodieGraphics: Phaser.GameObjects.Graphics;
  private projectileGraphics: Phaser.GameObjects.Graphics;
  private labels: Phaser.GameObjects.Text[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.roombaGraphics = scene.add.graphics().setDepth(30);
    this.turretGraphics = scene.add.graphics().setDepth(25);
    this.goodieGraphics = scene.add.graphics().setDepth(15);
    this.projectileGraphics = scene.add.graphics().setDepth(40);
  }

  render(
    roombas: RoombaState[],
    turrets: TurretState[],
    goodies: GoodieState[],
    projectiles: Projectile[],
    isRevealed: (tileX: number, tileY: number) => boolean,
  ): void {
    this.roombaGraphics.clear();
    this.turretGraphics.clear();
    this.goodieGraphics.clear();
    this.projectileGraphics.clear();
    this.labels.forEach(l => l.destroy());
    this.labels = [];

    this.renderGoodies(goodies, isRevealed);
    this.renderTurrets(turrets, isRevealed);
    this.renderRoombas(roombas);
    this.renderProjectiles(projectiles);
  }

  private renderProjectiles(projectiles: Projectile[]): void {
    for (const p of projectiles) {
      if (p.impacted) {
        // Explosion at impact point
        const ex = p.toX;
        const ey = p.toY;
        const t = 1 - (p.explosionTimer / 0.4); // 0→1 over 0.4s
        const alpha = Math.max(0, 1 - t * 1.5);

        // Shockwave ring
        const ringR = TS * (0.2 + t * 0.8);
        this.projectileGraphics.lineStyle(2, p.color, alpha);
        this.projectileGraphics.strokeCircle(ex, ey, ringR);

        // Central flash
        if (t < 0.4) {
          const flashAlpha = (1 - t * 2.5) * 0.8;
          this.projectileGraphics.fillStyle(0xffffff, flashAlpha);
          this.projectileGraphics.fillCircle(ex, ey, TS * (0.3 - t * 0.4));
        }

        // Fire ball
        this.projectileGraphics.fillStyle(p.color, alpha * 0.6);
        this.projectileGraphics.fillCircle(ex, ey, TS * (0.2 - t * 0.1));

        // Sparks
        for (let i = 0; i < 4; i++) {
          const angle = (Math.PI * 2 / 4) * i + t * 3;
          const dist = TS * (0.1 + t * 0.6);
          const sx = ex + Math.cos(angle) * dist;
          const sy = ey + Math.sin(angle) * dist;
          this.projectileGraphics.fillStyle(0xffaa44, alpha * 0.7);
          this.projectileGraphics.fillCircle(sx, sy, 2 - t);
        }
        continue;
      }

      // Flying rocket
      const t = Math.min(p.progress, 1);
      const x = p.fromX + (p.toX - p.fromX) * t;
      const y = p.fromY + (p.toY - p.fromY) * t;

      // Rocket body (elongated along travel direction)
      const angle = Math.atan2(p.toY - p.fromY, p.toX - p.fromX);
      const headX = x + Math.cos(angle) * 4;
      const headY = y + Math.sin(angle) * 4;
      const tailX = x - Math.cos(angle) * 4;
      const tailY = y - Math.sin(angle) * 4;

      // Rocket shape
      this.projectileGraphics.lineStyle(3, p.color, 1);
      this.projectileGraphics.lineBetween(tailX, tailY, headX, headY);
      this.projectileGraphics.fillStyle(0xffffff, 0.9);
      this.projectileGraphics.fillCircle(headX, headY, 2.5);

      // Exhaust trail
      const trailLen = 0.15;
      const trailT = Math.max(0, t - trailLen);
      const trailX = p.fromX + (p.toX - p.fromX) * trailT;
      const trailY = p.fromY + (p.toY - p.fromY) * trailT;
      this.projectileGraphics.lineStyle(1.5, 0xffaa44, 0.5);
      this.projectileGraphics.lineBetween(trailX, trailY, tailX, tailY);

      // Smoke puffs along trail
      for (let i = 0; i < 3; i++) {
        const puffT = Math.max(0, t - trailLen * (i + 1) / 3);
        const px = p.fromX + (p.toX - p.fromX) * puffT;
        const py = p.fromY + (p.toY - p.fromY) * puffT;
        const puffAlpha = 0.15 - i * 0.04;
        this.projectileGraphics.fillStyle(0x888888, puffAlpha);
        this.projectileGraphics.fillCircle(px, py, 3 - i);
      }
    }
  }

  private renderGoodies(goodies: GoodieState[], isRevealed: (tx: number, ty: number) => boolean): void {
    for (const goodie of goodies) {
      if (goodie.collected) continue;
      const tileX = Math.floor(goodie.x / TS);
      const tileY = Math.floor(goodie.y / TS);
      if (!isRevealed(tileX, tileY)) continue;

      // Mark as discovered so it stays visible even after roomba leaves
      (goodie as GoodieState & { _discovered?: boolean })._discovered = true;

      const x = goodie.x;
      const y = goodie.y;
      const r = TS / 4;

      this.goodieGraphics.fillStyle(0xffdd44, 0.9);
      this.goodieGraphics.fillTriangle(x, y - r, x + r * 0.7, y, x, y + r);
      this.goodieGraphics.fillTriangle(x, y - r, x - r * 0.7, y, x, y + r);
      this.goodieGraphics.lineStyle(1.5, 0xffaa00, 1);
      this.goodieGraphics.lineBetween(x, y - r, x + r * 0.7, y);
      this.goodieGraphics.lineBetween(x + r * 0.7, y, x, y + r);
      this.goodieGraphics.lineBetween(x, y + r, x - r * 0.7, y);
      this.goodieGraphics.lineBetween(x - r * 0.7, y, x, y - r);
      this.goodieGraphics.fillStyle(0xffffff, 0.7);
      this.goodieGraphics.fillCircle(x, y, 2);
    }

    // Render discovered but now in fog goodies as dim markers
    for (const goodie of goodies) {
      if (goodie.collected) continue;
      const g = goodie as GoodieState & { _discovered?: boolean };
      if (!g._discovered) continue;
      const tileX = Math.floor(goodie.x / TS);
      const tileY = Math.floor(goodie.y / TS);
      if (isRevealed(tileX, tileY)) continue; // already rendered above

      const x = goodie.x;
      const y = goodie.y;
      const r = TS / 5;
      this.goodieGraphics.fillStyle(0xffdd44, 0.3);
      this.goodieGraphics.fillTriangle(x, y - r, x + r * 0.7, y, x, y + r);
      this.goodieGraphics.fillTriangle(x, y - r, x - r * 0.7, y, x, y + r);
    }
  }

  private renderTurrets(turrets: TurretState[], isRevealed: (tx: number, ty: number) => boolean): void {
    for (const turret of turrets) {
      const tileX = Math.floor(turret.x / TS);
      const tileY = Math.floor(turret.y / TS);
      const revealed = isRevealed(tileX, tileY);

      // Mark as discovered once revealed
      if (revealed) {
        (turret as TurretState & { _discovered?: boolean })._discovered = true;
      }
      const discovered = (turret as TurretState & { _discovered?: boolean })._discovered;

      // Death explosion animation
      if (!turret.alive && turret.deathTimer > 0) {
        turret.deathTimer -= 1 / 60;
        this.renderTurretExplosion(turret);
        continue;
      }

      // Dead turret corpse — always show if discovered
      if (!turret.alive) {
        if (discovered) {
          this.renderTurretCorpse(turret, revealed);
        }
        continue;
      }

      // Alive but not visible
      if (!revealed && !discovered) continue;

      // Alive but in fog (discovered earlier) — dim ghost
      if (!revealed && discovered) {
        this.renderTurretGhost(turret);
        continue;
      }

      // Alive and visible — full render
      const x = turret.x;
      const y = turret.y;
      const s = TS / 2.8;

      this.turretGraphics.fillStyle(0x882222, 0.95);
      this.drawOctagon(this.turretGraphics, x, y, s, true);
      this.turretGraphics.lineStyle(2, 0xcc3333, 1);
      this.drawOctagon(this.turretGraphics, x, y, s, false);

      const innerS = s * 0.5;
      this.turretGraphics.fillStyle(0xcc3333, 0.8);
      this.turretGraphics.fillRect(x - innerS, y - innerS, innerS * 2, innerS * 2);

      const barrelLen = TS * 0.6;
      const bx = x + Math.cos(turret.barrelAngle) * barrelLen;
      const by = y + Math.sin(turret.barrelAngle) * barrelLen;
      this.turretGraphics.lineStyle(4, 0xff4444, 1);
      this.turretGraphics.lineBetween(x, y, bx, by);
      this.turretGraphics.fillStyle(0xff6666, 1);
      this.turretGraphics.fillCircle(bx, by, 3);

      if (turret.attackCooldown > (1 / turret.atkSpd) * 0.7) {
        this.turretGraphics.fillStyle(0xffaa44, 0.8);
        this.turretGraphics.fillCircle(bx, by, 6);
      }

      this.turretGraphics.lineStyle(1, 0xff4444, 0.12);
      this.turretGraphics.strokeCircle(x, y, turret.atkRad * TS);

      this.drawHPBar(this.turretGraphics, x, y - s - 6, turret.hp, turret.maxHp, 0xcc3333);

      const label = this.scene.add.text(x, y, 'T', {
        fontSize: '10px', color: '#ff8888', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(26);
      this.labels.push(label);
    }
  }

  private renderTurretExplosion(turret: TurretState): void {
    const x = turret.x;
    const y = turret.y;
    const t = 1 - (turret.deathTimer / 1.5); // 0→1 over 1.5s

    const ringR = TS * (0.3 + t * 1.2);
    const alpha = Math.max(0, 1 - t * 1.3);

    this.turretGraphics.lineStyle(2, 0xff6644, alpha);
    this.turretGraphics.strokeCircle(x, y, ringR);

    if (t < 0.3) {
      const flashAlpha = 1 - t * 3;
      this.turretGraphics.fillStyle(0xffffff, flashAlpha * 0.7);
      this.turretGraphics.fillCircle(x, y, TS * (0.4 - t));
      this.turretGraphics.fillStyle(0xff6644, flashAlpha * 0.5);
      this.turretGraphics.fillCircle(x, y, TS * (0.3 - t * 0.5));
    }

    // Debris
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 / 5) * i + t * 2;
      const dist = TS * (0.2 + t * 1.5);
      const dx = x + Math.cos(angle) * dist;
      const dy = y + Math.sin(angle) * dist;
      const dAlpha = Math.max(0, 1 - t * 1.5);
      this.turretGraphics.fillStyle(i % 2 === 0 ? 0xff4444 : 0x553333, dAlpha);
      this.turretGraphics.fillCircle(dx, dy, 2);
    }

    // Smoke
    if (t > 0.3) {
      const smokeAlpha = Math.max(0, 0.3 - (t - 0.3) * 0.4);
      this.turretGraphics.fillStyle(0x333333, smokeAlpha);
      this.turretGraphics.fillCircle(x + 3, y - 2, TS * 0.2 + t * TS * 0.2);
    }
  }

  private renderTurretCorpse(turret: TurretState, bright: boolean): void {
    const x = turret.x;
    const y = turret.y;
    const s = TS / 3;
    const alpha = bright ? 0.5 : 0.25;

    // Wrecked base (darker, cracked look)
    this.turretGraphics.fillStyle(0x332222, alpha);
    this.drawOctagon(this.turretGraphics, x, y, s, true);
    this.turretGraphics.lineStyle(1, 0x553333, alpha);
    this.drawOctagon(this.turretGraphics, x, y, s, false);

    // Scorch mark
    this.turretGraphics.fillStyle(0x221111, alpha * 0.6);
    this.turretGraphics.fillCircle(x, y, s * 1.3);

    // Broken barrel stub
    const stubLen = TS * 0.25;
    const bx = x + Math.cos(turret.barrelAngle) * stubLen;
    const by = y + Math.sin(turret.barrelAngle) * stubLen;
    this.turretGraphics.lineStyle(2, 0x553333, alpha);
    this.turretGraphics.lineBetween(x, y, bx, by);

    // "X" mark
    const label = this.scene.add.text(x, y, 'x', {
      fontSize: '9px', color: bright ? '#664444' : '#443333', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(26).setAlpha(alpha);
    this.labels.push(label);
  }

  private renderTurretGhost(turret: TurretState): void {
    const x = turret.x;
    const y = turret.y;
    const s = TS / 3;

    // Dim outline only — last known position
    this.turretGraphics.lineStyle(1, 0xcc3333, 0.25);
    this.drawOctagon(this.turretGraphics, x, y, s, false);

    const label = this.scene.add.text(x, y, 'T', {
      fontSize: '9px', color: '#663333', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(26).setAlpha(0.3);
    this.labels.push(label);
  }

  private renderRoombas(roombas: RoombaState[]): void {
    for (const roomba of roombas) {
      // Death explosion animation
      if (!roomba.alive && roomba.deathTimer > 0) {
        this.renderDeathExplosion(roomba);
        continue;
      }
      if (!roomba.alive) continue;

      const x = roomba.x;
      const y = roomba.y;
      const r = TS / 2.2;
      const stateColor = ROOMBA_STATE_COLORS[roomba.state] ?? 0x44aaff;

      // Outer body ring
      this.roombaGraphics.fillStyle(0x333344, 0.9);
      this.roombaGraphics.fillCircle(x, y, r);
      this.roombaGraphics.lineStyle(3, stateColor, 1);
      this.roombaGraphics.strokeCircle(x, y, r);

      // Inner disc
      this.roombaGraphics.fillStyle(stateColor, 0.6);
      this.roombaGraphics.fillCircle(x, y, r * 0.65);

      // Turret barrel on the roomba (aims at target or movement direction)
      const barrelAngle = roomba.targetId !== null
        ? roomba.barrelAngle
        : (roomba.path.length > 0 && roomba.pathIndex < roomba.path.length)
          ? Math.atan2(
              (roomba.path[roomba.pathIndex].y + 0.5) * TS - y,
              (roomba.path[roomba.pathIndex].x + 0.5) * TS - x)
          : 0;
      const barrelLen = r * 1.1;
      const bx = x + Math.cos(barrelAngle) * barrelLen;
      const by = y + Math.sin(barrelAngle) * barrelLen;
      this.roombaGraphics.lineStyle(3, 0x8899bb, 1);
      this.roombaGraphics.lineBetween(x, y, bx, by);
      this.roombaGraphics.fillStyle(0xaabbcc, 1);
      this.roombaGraphics.fillCircle(bx, by, 2.5);

      // Muzzle flash when roomba just fired
      if ((roomba.state === 'attacking' || roomba.state === 'ambushing') &&
          roomba.attackCooldown > (1 / roomba.atkSpd) * 0.7) {
        this.roombaGraphics.fillStyle(0x88ccff, 0.8);
        this.roombaGraphics.fillCircle(bx, by, 6);
      }

      // Bumper bar (front direction)
      if (roomba.path.length > 0 && roomba.pathIndex < roomba.path.length) {
        const target = roomba.path[roomba.pathIndex];
        const tx = (target.x + 0.5) * TS;
        const ty = (target.y + 0.5) * TS;
        const moveAngle = Math.atan2(ty - y, tx - x);

        this.roombaGraphics.lineStyle(3, 0xffffff, 0.8);
        this.roombaGraphics.beginPath();
        this.roombaGraphics.arc(x, y, r * 0.85, moveAngle - 0.5, moveAngle + 0.5, false);
        this.roombaGraphics.strokePath();
      }

      // Pickup animation — pulsing golden ring + progress arc
      if (roomba.state === 'picking_up') {
        const progress = 1 - (roomba.pickupTimer / 1); // 0→1
        // Golden ring pulse
        this.roombaGraphics.lineStyle(2, 0xffdd44, 0.6 + Math.sin(progress * Math.PI * 4) * 0.3);
        this.roombaGraphics.strokeCircle(x, y, r + 6);
        // Progress arc (fills clockwise)
        this.roombaGraphics.lineStyle(3, 0xffdd44, 0.9);
        this.roombaGraphics.beginPath();
        this.roombaGraphics.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2, false);
        this.roombaGraphics.strokePath();
        // "+1" text floating up
        if (progress > 0.5) {
          const floatY = y - r - 10 - (progress - 0.5) * 20;
          const alpha = Math.min(1, (progress - 0.5) * 4);
          const pickLabel = this.scene.add.text(x, floatY, '+1', {
            fontSize: '14px', color: '#ffdd44', fontFamily: 'monospace', fontStyle: 'bold',
          }).setOrigin(0.5).setDepth(50).setAlpha(alpha);
          this.labels.push(pickLabel);
        }
      }

      // State icon
      const stateIcon = STATE_ICONS[roomba.state] ?? '';
      if (stateIcon) {
        const iconLabel = this.scene.add.text(x, y, stateIcon, {
          fontSize: '12px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(31);
        this.labels.push(iconLabel);
      }

      // HP bar
      this.drawHPBar(this.roombaGraphics, x, y - r - 8, roomba.hp, roomba.maxHp, 0x44ff88);

      // Inventory badge
      if (roomba.inventory.length > 0) {
        const badgeX = x + r * 0.7;
        const badgeY = y - r * 0.7;
        this.roombaGraphics.fillStyle(0xffdd44, 1);
        this.roombaGraphics.fillCircle(badgeX, badgeY, 7);
        const label = this.scene.add.text(badgeX, badgeY, `${roomba.inventory.length}`, {
          fontSize: '9px', color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(31);
        this.labels.push(label);
      }
    }
  }

  private renderDeathExplosion(roomba: RoombaState): void {
    const x = roomba.x;
    const y = roomba.y;
    const t = 1 - (roomba.deathTimer / 3); // 0→1 over 3 seconds

    // Expanding explosion rings
    const ring1R = TS * (0.5 + t * 2);
    const ring2R = TS * (0.3 + t * 1.5);
    const alpha1 = Math.max(0, 1 - t * 1.2);
    const alpha2 = Math.max(0, 0.8 - t);

    // Outer shockwave ring
    this.roombaGraphics.lineStyle(3, 0xff6644, alpha1);
    this.roombaGraphics.strokeCircle(x, y, ring1R);

    // Inner explosion ring
    this.roombaGraphics.lineStyle(2, 0xffaa44, alpha2);
    this.roombaGraphics.strokeCircle(x, y, ring2R);

    // Central flash (fades out)
    if (t < 0.4) {
      const flashAlpha = 1 - t * 2.5;
      this.roombaGraphics.fillStyle(0xffffff, flashAlpha * 0.8);
      this.roombaGraphics.fillCircle(x, y, TS * (0.6 - t * 0.5));
      this.roombaGraphics.fillStyle(0xff8844, flashAlpha * 0.6);
      this.roombaGraphics.fillCircle(x, y, TS * (0.4 - t * 0.3));
    }

    // Debris particles (scattered dots)
    const debrisCount = 8;
    for (let i = 0; i < debrisCount; i++) {
      const angle = (Math.PI * 2 / debrisCount) * i + t * 1.5;
      const dist = TS * (0.3 + t * 2.5);
      const dx = x + Math.cos(angle) * dist;
      const dy = y + Math.sin(angle) * dist;
      const debrisAlpha = Math.max(0, 1 - t * 1.5);
      this.roombaGraphics.fillStyle(i % 2 === 0 ? 0xff6644 : 0x666688, debrisAlpha);
      this.roombaGraphics.fillCircle(dx, dy, 3 - t * 2);
    }

    // Smoke (dark circles expanding slowly)
    if (t > 0.2) {
      const smokeAlpha = Math.max(0, 0.4 - (t - 0.2) * 0.5);
      this.roombaGraphics.fillStyle(0x333333, smokeAlpha);
      this.roombaGraphics.fillCircle(x + 5, y - 3, TS * 0.3 + t * TS * 0.4);
      this.roombaGraphics.fillCircle(x - 4, y + 2, TS * 0.25 + t * TS * 0.3);
    }

    // "DESTROYED" label
    if (t > 0.15) {
      const labelAlpha = Math.min(1, (t - 0.15) * 3);
      const label = this.scene.add.text(x, y - TS, 'DESTROYED', {
        fontSize: '14px',
        color: `rgba(255, 68, 68, ${labelAlpha})`,
        fontFamily: 'monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(50).setAlpha(labelAlpha);
      this.labels.push(label);
    }

    // Decrement timer
    roomba.deathTimer -= 1 / 60; // approximate frame rate
  }

  private drawOctagon(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, fill: boolean): void {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI / 4) * i - Math.PI / 8;
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    if (fill) {
      g.beginPath();
      g.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < 8; i++) g.lineTo(points[i].x, points[i].y);
      g.closePath();
      g.fillPath();
    } else {
      for (let i = 0; i < 8; i++) {
        const next = (i + 1) % 8;
        g.lineBetween(points[i].x, points[i].y, points[next].x, points[next].y);
      }
    }
  }

  private drawHPBar(g: Phaser.GameObjects.Graphics, x: number, y: number, hp: number, maxHp: number, color: number): void {
    const barWidth = TS * 0.9;
    const barHeight = 4;
    const ratio = Math.max(0, hp / maxHp);

    g.fillStyle(0x222222, 0.9);
    g.fillRect(x - barWidth / 2, y, barWidth, barHeight);

    const barColor = ratio <= 0.3 ? 0xff4444 : ratio <= 0.6 ? 0xffaa44 : color;
    g.fillStyle(barColor, 1);
    g.fillRect(x - barWidth / 2, y, barWidth * ratio, barHeight);

    g.lineStyle(1, 0x666666, 0.5);
    g.strokeRect(x - barWidth / 2, y, barWidth, barHeight);
  }

  destroy(): void {
    this.roombaGraphics.destroy();
    this.turretGraphics.destroy();
    this.goodieGraphics.destroy();
    this.projectileGraphics.destroy();
    this.labels.forEach(l => l.destroy());
  }
}

const ROOMBA_STATE_COLORS: Record<string, number> = {
  idle: 0x44aaff,
  moving: 0x44aaff,
  searching: 0xffcc44,
  attacking: 0xff4444,
  avoiding: 0x44ccff,
  rushing: 0xff8844,
  ambushing: 0xcc44ff,
  extracting: 0x44ff88,
  picking_up: 0xffdd44,
};

const STATE_ICONS: Record<string, string> = {
  searching: '\u2315',
  attacking: '\u2694',
  avoiding: '\u21B6',
  rushing: '\u27A4',
  ambushing: '\u2295',
  extracting: '\u2192',
  picking_up: '\u2B07',
};
