// Broad-phase grid + swept AABB resolution against the city.
// The player is treated as an axis-aligned box; at this art scale it feels
// identical to a capsule and is far cheaper and more stable.
//
// Everything in here runs several times a frame (movement, the aim ray, the
// camera probes), so the hot paths keep a stamp on each collider for
// duplicate rejection and reuse their scratch buffers instead of allocating.

import * as THREE from 'three';
import { PLAYER } from '/shared/constants.js';
import { rayAabb } from '/shared/citygen.js';

const CELL = 40;
// No integration step may carry the player further than this, or a fast swing
// release can pass clean through a wall between two samples.
const MAX_STEP = PLAYER.RADIUS * 0.8;

const cellKey = (x, z) => (x * 73856093) ^ (z * 19349663);

export class WorldCollision {
  constructor(colliders) {
    this.boxes = colliders;
    this.grid = new Map();
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      b._stamp = 0;
      const x0 = Math.floor((b.x - b.hw) / CELL);
      const x1 = Math.floor((b.x + b.hw) / CELL);
      const z0 = Math.floor((b.z - b.hd) / CELL);
      const z1 = Math.floor((b.z + b.hd) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellKey(x, z);
          let arr = this.grid.get(key);
          if (!arr) this.grid.set(key, (arr = []));
          arr.push(b);
        }
      }
    }
    this._near = [];
    this._ray = [];
    this._stamp = 0;
    // Reused so the ray and move helpers never allocate a result object.
    this._hit = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), box: null };
    this._res = { grounded: false, wall: null, hitCeiling: false, landedSpeed: 0 };
  }

  /** Appends the colliders in one grid cell that this pass has not seen yet. */
  _collect(gx, gz, stamp, out) {
    const arr = this.grid.get(cellKey(gx, gz));
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (b._stamp === stamp) continue;
      b._stamp = stamp;
      out.push(b);
    }
  }

  near(x, z, pad = 2) {
    const out = this._near;
    out.length = 0;
    const stamp = ++this._stamp;
    const x0 = Math.floor((x - pad) / CELL);
    const x1 = Math.floor((x + pad) / CELL);
    const z0 = Math.floor((z - pad) / CELL);
    const z1 = Math.floor((z + pad) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) this._collect(gx, gz, stamp, out);
    }
    return out;
  }

  /**
   * Moves a player box by `vel * dt`, resolving one axis at a time. Long moves
   * are split so nothing can tunnel through a wall.
   * Mutates `pos` (feet position) and `vel`.
   * @returns {{grounded:boolean, wall:THREE.Vector3|null, hitCeiling:boolean, landedSpeed:number}}
   */
  move(pos, vel, dt) {
    const res = this._res;
    res.grounded = false;
    res.wall = null;
    res.hitCeiling = false;
    res.landedSpeed = 0;
    if (dt <= 0) return res;

    const travel = Math.hypot(vel.x, vel.y, vel.z) * dt;
    const steps = Math.min(16, Math.max(1, Math.ceil(travel / MAX_STEP)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(pos, vel, h, res);
    return res;
  }

  _step(pos, vel, dt, res) {
    const R = PLAYER.RADIUS;
    const H = PLAYER.HEIGHT;

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
      if (Math.abs(vel.x) > 0.5) res.wall = new THREE.Vector3(dir, 0, 0);
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
      if (Math.abs(vel.z) > 0.5) res.wall = new THREE.Vector3(0, 0, dir);
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
        if (vel.y < 0) { res.grounded = true; res.landedSpeed = Math.max(res.landedSpeed, -vel.y); }
        vel.y = 0;
      } else {
        pos.y = b.y - b.hh - H;
        if (vel.y > 0) res.hitCeiling = true;
        vel.y = Math.min(0, vel.y);
      }
    }

    if (pos.y <= 0) {
      if (vel.y < 0) { res.grounded = true; res.landedSpeed = Math.max(res.landedSpeed, -vel.y); }
      pos.y = 0;
      vel.y = 0;
    }
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

  /**
   * Ray against the city + ground plane.
   * Returns a hit record or null. The record is reused between calls — copy
   * anything you intend to keep.
   */
  raycast(origin, dir, maxDist) {
    // Walk only the grid columns the ray actually crosses (2D DDA in XZ)
    // instead of sampling along it; a 400-unit aim ray touches a handful of
    // cells rather than a hundred overlapping neighbourhoods.
    const stamp = ++this._stamp;
    const cand = this._ray;
    cand.length = 0;

    let gx = Math.floor(origin.x / CELL);
    let gz = Math.floor(origin.z / CELL);
    const stepX = dir.x >= 0 ? 1 : -1;
    const stepZ = dir.z >= 0 ? 1 : -1;
    const dtX = Math.abs(dir.x) > 1e-9 ? Math.abs(CELL / dir.x) : Infinity;
    const dtZ = Math.abs(dir.z) > 1e-9 ? Math.abs(CELL / dir.z) : Infinity;
    let nextX = dtX === Infinity ? Infinity
      : ((dir.x >= 0 ? (gx + 1) * CELL : gx * CELL) - origin.x) / dir.x;
    let nextZ = dtZ === Infinity ? Infinity
      : ((dir.z >= 0 ? (gz + 1) * CELL : gz * CELL) - origin.z) / dir.z;

    this._collect(gx, gz, stamp, cand);
    // The player box straddles cell borders, so pick up the neighbours of the
    // starting cell too — a wall right behind the origin still has to block.
    this._collect(gx + stepX, gz, stamp, cand);
    this._collect(gx, gz + stepZ, stamp, cand);

    for (let guard = 0; guard < 256; guard++) {
      if (nextX > maxDist && nextZ > maxDist) break;
      if (nextX < nextZ) { gx += stepX; nextX += dtX; } else { gz += stepZ; nextZ += dtZ; }
      this._collect(gx, gz, stamp, cand);
    }

    let best = maxDist;
    let bestBox = null;
    for (let i = 0; i < cand.length; i++) {
      const b = cand[i];
      const t = rayAabb(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b);
      if (t < best && t >= 0) { best = t; bestBox = b; }
    }

    const hit = this._hit;
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t > 0 && t < best) {
        hit.dist = t;
        hit.point.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
        hit.normal.set(0, 1, 0);
        hit.box = null;
        return hit;
      }
    }
    if (!bestBox) return null;
    hit.dist = best;
    hit.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    const rx = Math.abs((hit.point.x - bestBox.x) / bestBox.hw);
    const ry = Math.abs((hit.point.y - bestBox.y) / bestBox.hh);
    const rz = Math.abs((hit.point.z - bestBox.z) / bestBox.hd);
    const axis = rx > ry ? (rx > rz ? 0 : 2) : (ry > rz ? 1 : 2);
    hit.normal.set(0, 0, 0);
    const sign = axis === 0 ? hit.point.x - bestBox.x : axis === 1 ? hit.point.y - bestBox.y : hit.point.z - bestBox.z;
    hit.normal.setComponent(axis, Math.sign(sign) || 1);
    hit.box = bestBox;
    return hit;
  }
}
