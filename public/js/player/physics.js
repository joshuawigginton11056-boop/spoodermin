// Broad-phase grid + swept AABB resolution against the city.
// The player is treated as an axis-aligned box; at this art scale it feels
// identical to a capsule and is far cheaper and more stable.

import * as THREE from 'three';
import { PLAYER } from '/shared/constants.js';
import { rayAabb } from '/shared/citygen.js';

const CELL = 40;

export class WorldCollision {
  constructor(colliders) {
    this.boxes = colliders;
    this.grid = new Map();
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      const x0 = Math.floor((b.x - b.hw) / CELL);
      const x1 = Math.floor((b.x + b.hw) / CELL);
      const z0 = Math.floor((b.z - b.hd) / CELL);
      const z1 = Math.floor((b.z + b.hd) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = x * 73856093 ^ z * 19349663;
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(b);
        }
      }
    }
    this._near = [];
  }

  near(x, z, pad = 2) {
    const out = this._near;
    out.length = 0;
    const x0 = Math.floor((x - pad) / CELL);
    const x1 = Math.floor((x + pad) / CELL);
    const z0 = Math.floor((z - pad) / CELL);
    const z1 = Math.floor((z + pad) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const arr = this.grid.get(gx * 73856093 ^ gz * 19349663);
        if (!arr) continue;
        for (const b of arr) if (!out.includes(b)) out.push(b);
      }
    }
    return out;
  }

  /**
   * Moves a player box by `vel * dt`, resolving one axis at a time.
   * Mutates `pos` (feet position) and `vel`.
   * @returns {{grounded:boolean, wall:THREE.Vector3|null, hitCeiling:boolean, landedSpeed:number}}
   */
  move(pos, vel, dt) {
    const R = PLAYER.RADIUS;
    const H = PLAYER.HEIGHT;
    let grounded = false;
    let hitCeiling = false;
    let landedSpeed = 0;
    let wall = null;

    const overlaps = (px, py, pz, b) =>
      Math.abs(px - b.x) < R + b.hw &&
      Math.abs(py + H / 2 - b.y) < H / 2 + b.hh &&
      Math.abs(pz - b.z) < R + b.hd;

    // ---- X
    pos.x += vel.x * dt;
    let list = this.near(pos.x, pos.z, R + 4);
    for (const b of list) {
      if (!overlaps(pos.x, pos.y, pos.z, b)) continue;
      const pen = R + b.hw - Math.abs(pos.x - b.x);
      const dir = Math.sign(pos.x - b.x) || 1;
      pos.x += dir * pen;
      if (Math.abs(vel.x) > 0.5) wall = new THREE.Vector3(dir, 0, 0);
      vel.x = 0;
    }

    // ---- Z
    pos.z += vel.z * dt;
    list = this.near(pos.x, pos.z, R + 4);
    for (const b of list) {
      if (!overlaps(pos.x, pos.y, pos.z, b)) continue;
      const pen = R + b.hd - Math.abs(pos.z - b.z);
      const dir = Math.sign(pos.z - b.z) || 1;
      pos.z += dir * pen;
      if (Math.abs(vel.z) > 0.5) wall = new THREE.Vector3(0, 0, dir);
      vel.z = 0;
    }

    // ---- Y
    pos.y += vel.y * dt;
    list = this.near(pos.x, pos.z, R + 4);
    for (const b of list) {
      if (!overlaps(pos.x, pos.y, pos.z, b)) continue;
      const centre = pos.y + H / 2;
      if (centre > b.y) {
        pos.y = b.y + b.hh;
        if (vel.y < 0) { grounded = true; landedSpeed = -vel.y; }
        vel.y = 0;
      } else {
        pos.y = b.y - b.hh - H;
        if (vel.y > 0) hitCeiling = true;
        vel.y = Math.min(0, vel.y);
      }
    }

    if (pos.y <= 0) {
      if (vel.y < 0) { grounded = true; landedSpeed = -vel.y; }
      pos.y = 0;
      vel.y = 0;
    }

    return { grounded, wall, hitCeiling, landedSpeed };
  }

  /** Is there solid ground within `dist` below the feet? */
  groundBelow(pos, dist = 0.35) {
    if (pos.y <= dist) return true;
    const list = this.near(pos.x, pos.z, PLAYER.RADIUS + 2);
    for (const b of list) {
      if (Math.abs(pos.x - b.x) < PLAYER.RADIUS + b.hw &&
          Math.abs(pos.z - b.z) < PLAYER.RADIUS + b.hd &&
          pos.y - (b.y + b.hh) <= dist && pos.y - (b.y + b.hh) >= -0.25) return true;
    }
    return false;
  }

  /** Nearest wall within `reach` — used for wall-clinging. */
  wallNear(pos, reach = 0.55) {
    const list = this.near(pos.x, pos.z, PLAYER.RADIUS + reach + 3);
    const H = PLAYER.HEIGHT;
    let best = null;
    let bestPen = -Infinity;
    for (const b of list) {
      if (Math.abs(pos.y + H / 2 - b.y) > H / 2 + b.hh - 0.2) continue;
      const dx = Math.abs(pos.x - b.x) - (PLAYER.RADIUS + b.hw);
      const dz = Math.abs(pos.z - b.z) - (PLAYER.RADIUS + b.hd);
      if (dx > reach || dz > reach) continue;
      // Only touching on one axis counts as a flat wall.
      if (dx > dz) {
        if (dz > 0) continue;
        const pen = -dx;
        if (pen > bestPen) { bestPen = pen; best = new THREE.Vector3(Math.sign(pos.x - b.x) || 1, 0, 0); }
      } else {
        if (dx > 0) continue;
        const pen = -dz;
        if (pen > bestPen) { bestPen = pen; best = new THREE.Vector3(0, 0, Math.sign(pos.z - b.z) || 1); }
      }
    }
    return best;
  }

  /** Ray against the city + ground plane. Returns {point, normal, dist} or null. */
  raycast(origin, dir, maxDist) {
    let best = maxDist;
    let bestBox = null;
    // Walk the grid cells the ray passes through instead of testing every box.
    const step = CELL * 0.6;
    const seen = new Set();
    const candidates = [];
    for (let d = 0; d <= maxDist; d += step) {
      const x = origin.x + dir.x * d;
      const z = origin.z + dir.z * d;
      for (const b of this.near(x, z, CELL)) {
        if (seen.has(b)) continue;
        seen.add(b);
        candidates.push(b);
      }
    }
    for (const b of candidates) {
      const t = rayAabb(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b);
      if (t < best && t >= 0) { best = t; bestBox = b; }
    }
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t > 0 && t < best) {
        return {
          dist: t,
          point: new THREE.Vector3(origin.x + dir.x * t, 0, origin.z + dir.z * t),
          normal: new THREE.Vector3(0, 1, 0),
          box: null,
        };
      }
    }
    if (!bestBox) return null;
    const p = new THREE.Vector3(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    const rel = [(p.x - bestBox.x) / bestBox.hw, (p.y - bestBox.y) / bestBox.hh, (p.z - bestBox.z) / bestBox.hd];
    const a = rel.map(Math.abs);
    const axis = a[0] > a[1] ? (a[0] > a[2] ? 0 : 2) : (a[1] > a[2] ? 1 : 2);
    const n = new THREE.Vector3();
    n.setComponent(axis, Math.sign(rel[axis]) || 1);
    return { dist: best, point: p, normal: n, box: bestBox };
  }
}
