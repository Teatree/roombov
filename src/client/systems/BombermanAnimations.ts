import Phaser from 'phaser';

/**
 * Shared helpers for loading and registering the animated Bomberman
 * spritesheets. Any scene that displays a Bomberman (shop cards, main menu
 * equipped preview, match scene) calls these.
 *
 * Phaser textures and animations are game-global, so once a scene has
 * loaded the sheets and registered the anim keys, every subsequent scene
 * can just `this.add.sprite(x, y, 'bomber_walk').play('bomber_walk_down')`.
 * Call both helpers as a safety net — they're idempotent.
 */

/** Call from a scene's `preload()` to queue the 4 Bomberman spritesheets. */
export function preloadBombermanSpritesheets(scene: Phaser.Scene): void {
  if (!scene.textures.exists('bomber_idle')) {
    scene.load.spritesheet('bomber_idle', 'sprites/Unarmed_Idle_with_shadow.png', {
      frameWidth: 64, frameHeight: 64,
    });
  }
  if (!scene.textures.exists('bomber_walk')) {
    scene.load.spritesheet('bomber_walk', 'sprites/Unarmed_Walk_with_shadow.png', {
      frameWidth: 64, frameHeight: 64,
    });
  }
  if (!scene.textures.exists('bomber_hurt')) {
    scene.load.spritesheet('bomber_hurt', 'sprites/Unarmed_Hurt_with_shadow.png', {
      frameWidth: 64, frameHeight: 64,
    });
  }
  if (!scene.textures.exists('bomber_death')) {
    scene.load.spritesheet('bomber_death', 'sprites/Unarmed_Death_with_shadow.png', {
      frameWidth: 64, frameHeight: 64,
    });
  }
  if (!scene.textures.exists('bomber_throw')) {
    scene.load.spritesheet('bomber_throw', 'sprites/Unarmed_Walk_Attack_with_shadow.png', {
      frameWidth: 64, frameHeight: 64,
    });
  }
}

/**
 * Register the 16 Bomberman animation keys (4 states × 4 directions).
 * Call from `create()` in any scene that uses the sprites. Idempotent —
 * subsequent calls no-op because the anim cache is game-global.
 */
export function ensureBombermanAnims(scene: Phaser.Scene): void {
  if (scene.anims.exists('bomber_idle_down')) return;

  // Idle: 12 frames per direction, except 'up' which has only 4.
  // Row order in every sheet: 0=down, 1=left, 2=right, 3=up.
  scene.anims.create({ key: 'bomber_idle_down',  frames: scene.anims.generateFrameNumbers('bomber_idle',  { start: 0,  end: 11 }), frameRate: 6,  repeat: -1 });
  scene.anims.create({ key: 'bomber_idle_left',  frames: scene.anims.generateFrameNumbers('bomber_idle',  { start: 12, end: 23 }), frameRate: 6,  repeat: -1 });
  scene.anims.create({ key: 'bomber_idle_right', frames: scene.anims.generateFrameNumbers('bomber_idle',  { start: 24, end: 35 }), frameRate: 6,  repeat: -1 });
  scene.anims.create({ key: 'bomber_idle_up',    frames: scene.anims.generateFrameNumbers('bomber_idle',  { start: 36, end: 39 }), frameRate: 4,  repeat: -1 });

  // Walk: 6 frames per direction.
  scene.anims.create({ key: 'bomber_walk_down',  frames: scene.anims.generateFrameNumbers('bomber_walk',  { start: 0,  end: 5  }), frameRate: 10, repeat: -1 });
  scene.anims.create({ key: 'bomber_walk_left',  frames: scene.anims.generateFrameNumbers('bomber_walk',  { start: 6,  end: 11 }), frameRate: 10, repeat: -1 });
  scene.anims.create({ key: 'bomber_walk_right', frames: scene.anims.generateFrameNumbers('bomber_walk',  { start: 12, end: 17 }), frameRate: 10, repeat: -1 });
  scene.anims.create({ key: 'bomber_walk_up',    frames: scene.anims.generateFrameNumbers('bomber_walk',  { start: 18, end: 23 }), frameRate: 10, repeat: -1 });

  // Hurt: 5 frames per direction.
  scene.anims.create({ key: 'bomber_hurt_down',  frames: scene.anims.generateFrameNumbers('bomber_hurt',  { start: 0,  end: 4  }), frameRate: 12, repeat: 0  });
  scene.anims.create({ key: 'bomber_hurt_left',  frames: scene.anims.generateFrameNumbers('bomber_hurt',  { start: 5,  end: 9  }), frameRate: 12, repeat: 0  });
  scene.anims.create({ key: 'bomber_hurt_right', frames: scene.anims.generateFrameNumbers('bomber_hurt',  { start: 10, end: 14 }), frameRate: 12, repeat: 0  });
  scene.anims.create({ key: 'bomber_hurt_up',    frames: scene.anims.generateFrameNumbers('bomber_hurt',  { start: 15, end: 19 }), frameRate: 12, repeat: 0  });

  // Death: 7 frames per direction.
  scene.anims.create({ key: 'bomber_death_down',  frames: scene.anims.generateFrameNumbers('bomber_death', { start: 0,  end: 6  }), frameRate: 8, repeat: 0 });
  scene.anims.create({ key: 'bomber_death_left',  frames: scene.anims.generateFrameNumbers('bomber_death', { start: 7,  end: 13 }), frameRate: 8, repeat: 0 });
  scene.anims.create({ key: 'bomber_death_right', frames: scene.anims.generateFrameNumbers('bomber_death', { start: 14, end: 20 }), frameRate: 8, repeat: 0 });
  scene.anims.create({ key: 'bomber_death_up',    frames: scene.anims.generateFrameNumbers('bomber_death', { start: 21, end: 27 }), frameRate: 8, repeat: 0 });

  // Throw (repurposed walk_attack sheet): 6 frames per direction. The registered
  // frameRate is only a default — BombermanSpriteSystem overrides with an explicit
  // `duration` per play so the 6 frames align with the bomb's arc flight time.
  scene.anims.create({ key: 'bomber_throw_down',  frames: scene.anims.generateFrameNumbers('bomber_throw', { start: 0,  end: 5  }), frameRate: 12, repeat: 0 });
  scene.anims.create({ key: 'bomber_throw_left',  frames: scene.anims.generateFrameNumbers('bomber_throw', { start: 6,  end: 11 }), frameRate: 12, repeat: 0 });
  scene.anims.create({ key: 'bomber_throw_right', frames: scene.anims.generateFrameNumbers('bomber_throw', { start: 12, end: 17 }), frameRate: 12, repeat: 0 });
  scene.anims.create({ key: 'bomber_throw_up',    frames: scene.anims.generateFrameNumbers('bomber_throw', { start: 18, end: 23 }), frameRate: 12, repeat: 0 });
}

/**
 * Convenience: create a walking-down Bomberman sprite at a fixed on-screen
 * position, tinted with the given color. Used by shop cards and menu
 * previews. The origin is 0.5/0.5 so the sprite is visually centered at
 * the given coords (unlike in-match sprites which use 0.5/0.625 so the
 * feet anchor to the tile).
 */
export function createShopBombermanSprite(
  scene: Phaser.Scene,
  x: number,
  y: number,
  tint: number,
  scale = 1,
): Phaser.GameObjects.Sprite {
  const sprite = scene.add.sprite(x, y, 'bomber_walk');
  sprite.setOrigin(0.5, 0.5);
  sprite.setScale(scale * 3);
  sprite.setTint(tint);
  sprite.play('bomber_walk_down');
  sprite.anims.timeScale = 0.5;
  return sprite;
}
