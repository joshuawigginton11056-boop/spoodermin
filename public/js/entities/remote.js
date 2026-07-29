// Other players (human and bot). Snapshots arrive at 20Hz, so we render ~100ms
// in the past and interpolate between the two surrounding states.

import * as THREE from 'three';
import { Hero } from './hero.js';
import { SKINS } from '/shared/constants.js';
import { nameTagTexture } from '../util/textures.js';

// How far in the past remote players are drawn. The server rewinds by this
// much (plus half the round trip) when judging our shots, so what we shot at is
// what we hit.
export const INTERP_DELAY = 0.1;
const _v = new THREE.Vector3();

class RemotePlayer {
  constructor(scene, info) {
    this.id = info.i;
    this.name = info.n;
    this.skin = info.c;
    this.isBot = !!info.b;
    this.hero = new Hero(info.c);
    scene.add(this.hero.root);

    const skin = SKINS[info.c % SKINS.length];
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nameTagTexture(info.n, skin.primary),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }));
    this.tag.scale.set(4.4, 1.1, 1);
    this.tag.center.set(0.5, 0);
    this.tag.renderOrder = 20;
    scene.add(this.tag);

    // Slim health bar under the name. The fill is baked into a shared canvas
    // texture (one per 5% bucket) so it always reads correctly no matter which
    // way the camera is facing.
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({
      map: healthBarTexture(100), transparent: true, depthTest: false, depthWrite: false, fog: false,
    }));
    this.bar.center.set(0.5, 0);
    this.bar.renderOrder = 21;
    this.barBucket = 20;
    scene.add(this.bar);

    this.buffer = [];
    this.pos = new THREE.Vector3(info.p[0], info.p[1], info.p[2]);
    this.prevPos = this.pos.clone();
    this.yaw = info.y;
    this.state = info.s;
    this.hp = info.hp;
    this.alive = !!info.a;
    this.anchor = null;
    this.speed = 0;
    this.lastShotSide = 1;
  }

  push(info, time) {
    this.buffer.push({
      time,
      p: new THREE.Vector3(info.p[0], info.p[1], info.p[2]),
      y: info.y,
      h: info.h,
      s: info.s,
      hp: info.hp,
      a: !!info.a,
      w: info.w ? new THREE.Vector3(info.w[0], info.w[1], info.w[2]) : null,
    });
    if (this.buffer.length > 24) this.buffer.shift();
    this.hp = info.hp;
    this.alive = !!info.a;
    this.kills = info.k;
  }

  update(dt, now, camera) {
    const target = now - INTERP_DELAY;
    let a = null;
    let b = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].time <= target) { a = this.buffer[i]; b = this.buffer[i + 1] || null; break; }
    }
    if (!a) a = this.buffer[0];
    if (!a) return;

    this.prevPos.copy(this.pos);
    if (b) {
      const t = THREE.MathUtils.clamp((target - a.time) / Math.max(1e-4, b.time - a.time), 0, 1);
      this.pos.lerpVectors(a.p, b.p, t);
      let d = ((b.y - a.y + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      this.yaw = a.y + d * t;
      this.pitch = THREE.MathUtils.lerp(a.h, b.h, t);
    } else {
      this.pos.copy(a.p);
      this.yaw = a.y;
      this.pitch = a.h;
    }
    this.state = a.s;
    this.anchor = a.w;

    const moved = _v.copy(this.pos).sub(this.prevPos);
    this.speed = dt > 0 ? Math.hypot(moved.x, moved.z) / dt : 0;
    const vy = dt > 0 ? moved.y / dt : 0;

    const visible = this.alive;
    this.hero.root.visible = visible;
    this.tag.visible = visible;
    this.bar.visible = visible;
    if (!visible) return;

    this.hero.root.position.copy(this.pos);
    this.hero.root.rotation.y = this.yaw;

    let anchorLocal = null;
    if (this.anchor) anchorLocal = this.hero.root.worldToLocal(_v.copy(this.anchor)).clone();

    this.hero.update(dt, {
      state: this.state,
      speed: this.speed,
      vy,
      pitch: this.pitch || 0,
      anchorLocal,
      swingSide: 1,
    });

    // Tags shrink with distance but never vanish entirely.
    const dist = camera.position.distanceTo(this.pos);
    const scale = THREE.MathUtils.clamp(dist / 26, 0.75, 3.4);
    const top = this.pos.y + 4.4;
    this.tag.position.set(this.pos.x, top + 0.55 * scale, this.pos.z);
    this.tag.scale.set(4.4 * scale, 1.1 * scale, 1);

    const barW = 3.4 * scale;
    this.bar.position.set(this.pos.x, top, this.pos.z);
    this.bar.scale.set(barW, 0.42 * scale, 1);
    const bucket = Math.round(THREE.MathUtils.clamp(this.hp, 0, 100) / 5);
    if (bucket !== this.barBucket) {
      this.barBucket = bucket;
      this.bar.material.map = healthBarTexture(bucket * 5);
      this.bar.material.needsUpdate = true;
    }
    this.tag.material.opacity = dist > 260 ? 0.35 : 1;
  }

  dispose(scene) {
    scene.remove(this.hero.root, this.tag, this.bar);
    this.hero.dispose();
    this.tag.material.dispose();
    this.bar.material.dispose();
  }
}

// One texture per 5% of health, shared by every remote player.
const barCache = new Map();
function healthBarTexture(hp) {
  const key = Math.round(hp / 5) * 5;
  if (barCache.has(key)) return barCache.get(key);
  const W = 128;
  const H = 16;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(12,15,26,0.85)';
  g.fillRect(0, 0, W, H);
  const frac = THREE.MathUtils.clamp(key / 100, 0, 1);
  g.fillStyle = frac > 0.55 ? '#6be07f' : frac > 0.25 ? '#ffd166' : '#ff5f5f';
  g.fillRect(2, 2, (W - 4) * frac, H - 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  barCache.set(key, tex);
  return tex;
}

export class RemoteManager {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
  }

  applySnapshot(list, myId, now) {
    const seen = new Set();
    for (const info of list) {
      if (info.i === myId) continue;
      seen.add(info.i);
      let rp = this.players.get(info.i);
      if (!rp) {
        rp = new RemotePlayer(this.scene, info);
        this.players.set(info.i, rp);
      }
      rp.push(info, now);
    }
    for (const [id, rp] of this.players) {
      if (!seen.has(id)) { rp.dispose(this.scene); this.players.delete(id); }
    }
  }

  remove(id) {
    const rp = this.players.get(id);
    if (rp) { rp.dispose(this.scene); this.players.delete(id); }
  }

  get(id) { return this.players.get(id); }

  /** Everyone still standing, as the client is currently drawing them. */
  living() {
    const out = [];
    for (const rp of this.players.values()) if (rp.alive) out.push(rp);
    return out;
  }

  update(dt, now, camera, effects) {
    for (const rp of this.players.values()) {
      rp.update(dt, now, camera);
      // Draw their web line while they swing.
      if (rp.alive && rp.anchor && rp.state === 3) {
        effects.remoteLine(rp.id, rp.hero.handWorld(1, _v.clone()), rp.anchor);
      } else {
        effects.remoteLine(rp.id, null, null);
      }
    }
  }

  clear() {
    for (const rp of this.players.values()) rp.dispose(this.scene);
    this.players.clear();
  }
}
