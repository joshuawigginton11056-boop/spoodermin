// All the sticky visual feedback: web lines, flying web balls, splat decals,
// impact puffs and floating damage numbers.

import * as THREE from 'three';
import { COMBAT } from '/shared/constants.js';
import { splatTexture, puffTexture } from '../util/textures.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// A slack web line: a fixed-topology tube whose vertices are rewritten each
// frame. Building it by hand (rather than rebuilding a TubeGeometry) keeps the
// buffers stable and lets the rope sag under its own weight.
const SEGS = 10;
const RADIAL = 5;
const ROPE_R = 0.16;

class WebLine {
  constructor(scene) {
    this.scene = scene;
    this.mat = new THREE.MeshBasicMaterial({ color: 0xf2f6ff, fog: false });

    const vertCount = (SEGS + 1) * (RADIAL + 1);
    this.positions = new Float32Array(vertCount * 3);
    this.normals = new Float32Array(vertCount * 3);
    const indices = [];
    for (let s = 0; s < SEGS; s++) {
      for (let r = 0; r < RADIAL; r++) {
        const a = s * (RADIAL + 1) + r;
        const b = a + RADIAL + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geo.setIndex(indices);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);

    this._p = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._n1 = new THREE.Vector3();
    this._n2 = new THREE.Vector3();
    this._pts = Array.from({ length: SEGS + 1 }, () => new THREE.Vector3());
  }

  set(from, to, sag = 1) {
    const pts = this._pts;
    const len = from.distanceTo(to);
    const droop = Math.min(3.2, len * 0.05) * sag;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      pts[i].lerpVectors(from, to, t);
      pts[i].y -= Math.sin(t * Math.PI) * droop;
    }

    // Rotation-minimising-ish frame: reuse the previous normal so the tube does
    // not spin when the rope passes through vertical.
    this._n1.set(0, 1, 0);
    for (let i = 0; i <= SEGS; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(SEGS, i + 1)];
      this._tan.subVectors(b, a);
      if (this._tan.lengthSq() < 1e-10) this._tan.set(0, 1, 0);
      this._tan.normalize();
      // Pick a reference axis that is never parallel to the tangent.
      const ref = Math.abs(this._tan.y) > 0.9 ? this._n2.set(1, 0, 0) : this._n2.set(0, 1, 0);
      this._n1.crossVectors(this._tan, ref).normalize();
      const bi = this._p.crossVectors(this._tan, this._n1).normalize();

      for (let r = 0; r <= RADIAL; r++) {
        const ang = (r / RADIAL) * Math.PI * 2;
        const cx = Math.cos(ang);
        const cy = Math.sin(ang);
        const nx = this._n1.x * cx + bi.x * cy;
        const ny = this._n1.y * cx + bi.y * cy;
        const nz = this._n1.z * cx + bi.z * cy;
        const idx = (i * (RADIAL + 1) + r) * 3;
        this.positions[idx] = p.x + nx * ROPE_R;
        this.positions[idx + 1] = p.y + ny * ROPE_R;
        this.positions[idx + 2] = p.z + nz * ROPE_R;
        this.normals[idx] = nx;
        this.normals[idx + 1] = ny;
        this.normals[idx + 2] = nz;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.normal.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.scene.remove(this.mesh);
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    // ---- web lines (one for the local player, a pool for everyone else)
    this.localLine = new WebLine(scene);
    this.lines = new Map(); // playerId -> WebLine

    // ---- flying web balls
    const ballGeo = new THREE.IcosahedronGeometry(COMBAT.SHOT_RADIUS, 0);
    this.ballMesh = new THREE.InstancedMesh(
      ballGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x557799, emissiveIntensity: 0.5, flatShading: true }),
      96
    );
    this.ballMesh.frustumCulled = false;
    this.ballMesh.count = 0;
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.ballMesh);
    this.projectiles = new Map(); // id -> {pos, vel, life}

    // ---- splat decals
    this.splatMat = new THREE.MeshBasicMaterial({
      map: splatTexture(), transparent: true, depthWrite: false, opacity: 0.95, side: THREE.DoubleSide,
    });
    this.splats = [];
    this.splatPool = [];
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), this.splatMat.clone());
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.splatPool.push(m);
    }

    // ---- puffs
    this.puffMat = new THREE.SpriteMaterial({ map: puffTexture(), transparent: true, depthWrite: false, opacity: 0.8 });
    this.puffs = [];
    this.puffPool = [];
    for (let i = 0; i < 26; i++) {
      const s = new THREE.Sprite(this.puffMat.clone());
      s.visible = false;
      scene.add(s);
      this.puffPool.push(s);
    }
  }

  // ------------------------------------------------------------- web lines
  webLine(from, to) {
    this.localLine.set(from, to, 1);
    this.puff(to, 1.6, 0.35);
  }

  updateLocalLine(from, to) {
    if (!to) { this.localLine.hide(); return; }
    this.localLine.set(from, to, 1);
  }

  cutWeb() { this.localLine.hide(); }

  /**
   * A web that found nothing to stick to. Puffing at whatever the crosshair
   * was over makes the whiff legible — silence reads as "the button did not
   * work" rather than "you missed".
   */
  miss(at) {
    if (at) this.puff(at, 1.1, 0.28, 0xbcc6da);
  }

  remoteLine(id, from, to) {
    let line = this.lines.get(id);
    // Only players who are actually swinging get a rope; building one for
    // everybody else put a dozen unused meshes in the scene.
    if (!to) { if (line) line.hide(); return; }
    if (!line) { line = new WebLine(this.scene); this.lines.set(id, line); }
    line.set(from, to, 1);
  }

  dropRemote(id) {
    const line = this.lines.get(id);
    if (line) { line.dispose(); this.lines.delete(id); }
  }

  // ----------------------------------------------------------- projectiles
  spawnProjectile(id, o, v) {
    this.projectiles.set(id, {
      pos: new THREE.Vector3(o[0], o[1], o[2]),
      vel: new THREE.Vector3(v[0], v[1], v[2]),
      life: COMBAT.PROJECTILE_LIFE,
    });
  }

  killProjectile(id) {
    const p = this.projectiles.get(id);
    this.projectiles.delete(id);
    return p;
  }

  /** Splat oriented against the direction the ball was travelling. */
  splatFromProjectile(id, point, playerHit) {
    const p = this.killProjectile(id);
    const at = new THREE.Vector3(point[0], point[1], point[2]);
    if (playerHit) {
      this.puff(at, 2.4, 0.45, 0xffffff);
      this.puff(at, 1.4, 0.7, 0xdfe6f2);
      return;
    }
    const n = p && p.vel.lengthSq() > 1
      ? p.vel.clone().normalize().multiplyScalar(-1)
      : new THREE.Vector3(0, 1, 0);
    this.splat(at, n, 1);
  }

  // ---------------------------------------------------------------- decals
  splat(point, normal, scale = 1) {
    const m = this.splatPool.pop();
    if (!m) return;
    const n = normal || UP;
    m.position.copy(point).addScaledVector(n, 0.06);
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.quaternion.copy(_q);
    m.scale.setScalar(scale * (0.8 + Math.random() * 0.6));
    m.rotateZ(Math.random() * Math.PI * 2);
    m.material.opacity = 0.95;
    m.visible = true;
    this.splats.push({ mesh: m, t: 0, life: 9 });
    this.puff(point, 1.2, 0.3);
  }

  puff(at, size = 2, life = 0.4, color = 0xffffff) {
    const s = this.puffPool.pop();
    if (!s) return;
    s.position.copy(at);
    s.material.color.set(color);
    s.material.opacity = 0.85;
    s.scale.setScalar(size);
    s.visible = true;
    this.puffs.push({ sprite: s, t: 0, life, size });
  }

  landPuff(pos, strength) {
    const n = THREE.MathUtils.clamp(Math.floor(strength / 12), 1, 5);
    for (let i = 0; i < n; i++) {
      _v.copy(pos);
      _v.x += (Math.random() - 0.5) * 2.2;
      _v.z += (Math.random() - 0.5) * 2.2;
      _v.y += 0.3;
      this.puff(_v, 1.6 + Math.random() * 1.4, 0.5, 0xdfe6f2);
    }
  }

  // ------------------------------------------------------------------ tick
  update(dt) {
    this.time += dt;

    // projectiles
    let i = 0;
    for (const [id, p] of this.projectiles) {
      p.life -= dt;
      if (p.life <= 0) { this.projectiles.delete(id); continue; }
      p.vel.y -= COMBAT.SHOT_GRAVITY * dt;
      p.pos.addScaledVector(p.vel, dt);
      // Stretch the ball along its velocity so it reads as a fast blob.
      const sp = p.vel.length();
      _q.setFromUnitVectors(UP, _v.copy(p.vel).divideScalar(sp || 1));
      _m.compose(p.pos, _q, _v2.set(1, 1 + Math.min(2.2, sp / 60), 1));
      this.ballMesh.setMatrixAt(i, _m);
      i++;
      if (i >= this.ballMesh.instanceMatrix.count) break;
    }
    this.ballMesh.count = i;
    this.ballMesh.instanceMatrix.needsUpdate = true;

    // splats fade out and return to the pool
    for (let k = this.splats.length - 1; k >= 0; k--) {
      const s = this.splats[k];
      s.t += dt;
      if (s.t > s.life) {
        s.mesh.visible = false;
        this.splatPool.push(s.mesh);
        this.splats.splice(k, 1);
        continue;
      }
      const fade = THREE.MathUtils.clamp((s.life - s.t) / 2.5, 0, 1);
      s.mesh.material.opacity = 0.95 * fade;
      // Quick pop-in scale.
      if (s.t < 0.12) s.mesh.scale.setScalar(THREE.MathUtils.lerp(0.3, 1, s.t / 0.12) * 1.2);
    }

    // puffs
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k];
      p.t += dt;
      if (p.t > p.life) {
        p.sprite.visible = false;
        this.puffPool.push(p.sprite);
        this.puffs.splice(k, 1);
        continue;
      }
      const u = p.t / p.life;
      p.sprite.scale.setScalar(p.size * (1 + u * 1.8));
      p.sprite.material.opacity = 0.85 * (1 - u);
      p.sprite.position.y += dt * 1.2;
    }
  }
}
