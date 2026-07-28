// The playable superhero: a rounded, cartoon, web-suited figure built entirely
// from capsules and spheres, with a hand-written procedural animation rig
// (idle / run / airborne / swinging / wall-cling / shooting).

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { SKINS, PLAYER } from '/shared/constants.js';
import { suitTexture, emblemTexture } from '../util/textures.js';

const S = {
  THIGH: 0.66,
  SHIN: 0.64,
  TORSO: 1.16,
  UPPER: 0.6,
  FORE: 0.58,
  HEAD: 0.36,
};
const HIP_Y = S.THIGH + S.SHIN + 0.12; // ~1.42
const SHOULDER_Y = HIP_Y + S.TORSO * 0.84;
const NECK_Y = S.TORSO + 0.27; // above the hips — clears the top of the chest
// Crown of the head in local units; used to normalise the rig to PLAYER.HEIGHT.
const TOP_Y = HIP_Y + NECK_Y + S.HEAD * 1.05;

// Segment counts: high enough to read as genuinely round, low enough that
// sixteen of these on screen stays cheap.
const CAP_SEGS = 5;
const RADIAL = 12;

// A capsule pivoted at its top, so rotating the parent group swings the limb
// from the joint like a real arm or leg.
function limbGeo(radius, len, squashZ = 1) {
  const body = Math.max(0.02, len - radius * 2);
  const g = new THREE.CapsuleGeometry(radius, body, CAP_SEGS, RADIAL);
  if (squashZ !== 1) g.scale(1, 1, squashZ);
  g.translate(0, -len / 2, 0);
  return g;
}

// A sphere used to fill a joint so limbs never show a seam when they bend.
function jointGeo(radius, sy = 1) {
  const g = new THREE.SphereGeometry(radius, RADIAL, 8);
  if (sy !== 1) g.scale(1, sy, 1);
  return g;
}

// A limb plus the ball at its joint, as one geometry — same material, same
// group, so there is no reason to spend two draw calls on it.
function boneGeo(jointR, limbR, len) {
  return BufferGeometryUtils.mergeGeometries([jointGeo(jointR), limbGeo(limbR, len)], false);
}

export class Hero {
  constructor(skinIndex = 0) {
    this.skin = SKINS[skinIndex % SKINS.length];
    this.root = new THREE.Group();
    this.root.name = 'hero';
    this.t = 0;
    this.shootTimer = 0;
    this.shootArm = 1; // 1 = right
    this.blend = { run: 0, air: 0, swing: 0, cling: 0 };
    this.build();
  }

  build() {
    const sk = this.skin;
    const suit = suitTexture(sk.primary, sk.accent);
    const matPrimary = new THREE.MeshLambertMaterial({ map: suit, color: 0xffffff });
    const matSecondary = new THREE.MeshLambertMaterial({ color: sk.secondary });
    const matAccent = new THREE.MeshLambertMaterial({ color: sk.accent });
    this.materials = [matPrimary, matSecondary, matAccent];

    const add = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // ------------------------------------------------------------- torso
    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    // A capsule flattened front-to-back gives a rounded chest with no hard
    // edges anywhere on the silhouette.
    const torsoGeo = new THREE.CapsuleGeometry(0.42, S.TORSO - 0.84, CAP_SEGS, RADIAL);
    torsoGeo.scale(1.04, 1, 0.66);
    torsoGeo.translate(0, S.TORSO / 2, 0);
    // Pinch the waist and swell the chest for a heroic silhouette.
    const tp = torsoGeo.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i) / S.TORSO; // 0 at the waist, 1 at the collar
      const taper = 0.76 + 0.42 * Math.min(1, Math.max(0, y)) ** 1.3;
      tp.setX(i, tp.getX(i) * taper);
      tp.setZ(i, tp.getZ(i) * (0.86 + 0.2 * y));
    }
    tp.needsUpdate = true;
    torsoGeo.computeVertexNormals();
    this.torso = add(this.hips, torsoGeo, matPrimary);

    // Chest emblem, bowed slightly so it sits on the curve of the chest.
    const emblemGeo = new THREE.SphereGeometry(0.42, 16, 12, Math.PI / 2 - 0.62, 1.24, 0.95, 0.85);
    const emblem = new THREE.Mesh(
      emblemGeo,
      new THREE.MeshBasicMaterial({ map: emblemTexture(sk.accent), transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    emblem.position.set(0, S.TORSO * 0.63, 0.02);
    emblem.scale.set(0.96, 0.96, 0.76);
    this.torso.add(emblem);

    // Belt: a torus, so it reads as a band wrapped around a round waist.
    const beltGeo = new THREE.TorusGeometry(0.33, 0.075, 8, RADIAL);
    beltGeo.rotateX(Math.PI / 2);
    beltGeo.scale(1.06, 1, 0.72);
    add(this.hips, beltGeo, matAccent, 0, 0.06, 0);

    // --------------------------------------------------------------- head
    this.neck = new THREE.Group();
    this.neck.position.y = NECK_Y;
    this.hips.add(this.neck);
    // Neck stub so the head does not float off the shoulders when it turns.
    add(this.hips, limbGeo(0.135, 0.3), matPrimary, 0, NECK_Y + 0.06, 0);
    const headGeo = new THREE.SphereGeometry(S.HEAD, 20, 16);
    headGeo.scale(0.95, 1.05, 0.99);
    this.head = add(this.neck, headGeo, matPrimary);

    // Big cartoon lenses. Both sides are baked into one geometry per layer, so
    // the whole face costs two draw calls instead of four.
    const eyeMat = new THREE.MeshBasicMaterial({ color: sk.eye });
    const rimMat = new THREE.MeshBasicMaterial({ color: sk.accent });
    const lens = (radius, z) => {
      const halves = [-1, 1].map((side) => {
        const g = new THREE.SphereGeometry(radius, 14, 10);
        g.scale(1.18, 0.88, 0.45);
        g.rotateZ(side * -0.32);
        g.translate(side * 0.145, 0.03, z);
        return g;
      });
      return BufferGeometryUtils.mergeGeometries(halves, false);
    };
    this.head.add(new THREE.Mesh(lens(0.16, S.HEAD * 0.8), rimMat));
    this.head.add(new THREE.Mesh(lens(0.138, S.HEAD * 0.86), eyeMat));
    this.materials.push(eyeMat, rimMat);

    // --------------------------------------------------------------- arms
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.46, SHOULDER_Y - HIP_Y, 0);
      this.hips.add(shoulder);
      // Deltoid ball caps the shoulder so the arm can swing to any angle.
      add(shoulder, boneGeo(0.2, 0.16, S.UPPER), matPrimary);
      const elbow = new THREE.Group();
      elbow.position.y = -S.UPPER;
      shoulder.add(elbow);
      add(elbow, boneGeo(0.145, 0.138, S.FORE), matSecondary);
      // Glove.
      const hand = new THREE.Group();
      hand.position.y = -S.FORE;
      elbow.add(hand);
      const glove = add(hand, jointGeo(0.155), matPrimary, 0, -0.06, 0);
      glove.scale.set(1, 1.15, 0.92);
      this.arms.push({ side, shoulder, elbow, hand });
    }

    // --------------------------------------------------------------- legs
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.2, 0, 0);
      this.hips.add(hip);
      add(hip, boneGeo(0.2, 0.185, S.THIGH), matSecondary);
      const knee = new THREE.Group();
      knee.position.y = -S.THIGH;
      hip.add(knee);
      add(knee, boneGeo(0.16, 0.15, S.SHIN), matSecondary);
      const foot = new THREE.Group();
      foot.position.y = -S.SHIN;
      knee.add(foot);
      // Boot: a capsule lying forward, so the toe is a dome rather than a corner.
      const bootGeo = new THREE.CapsuleGeometry(0.15, 0.24, CAP_SEGS, RADIAL);
      bootGeo.rotateX(Math.PI / 2);
      bootGeo.scale(1, 0.86, 1);
      add(foot, bootGeo, matPrimary, 0, -0.05, 0.1);
      this.legs.push({ side, hip, knee, foot });
    }

    // Normalise the rig so the crown of the head lands exactly at the collision
    // capsule's height, whatever the proportions above happen to add up to.
    this.root.scale.setScalar(PLAYER.HEIGHT / TOP_Y);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }

  triggerShoot(side = 1) {
    this.shootTimer = 0.34;
    this.shootArm = side;
  }

  /**
   * @param {number} dt
   * @param {object} o
   * @param {number} o.state       movement state id (see shared STATE)
   * @param {number} o.speed       horizontal speed
   * @param {number} o.vy          vertical velocity
   * @param {number} o.pitch       look pitch, radians
   * @param {THREE.Vector3|null} o.anchorLocal  web anchor in hero-local space
   */
  update(dt, o) {
    this.t += dt;
    const lerp = THREE.MathUtils.lerp;
    const k = 1 - Math.pow(0.0001, dt); // frame-rate independent smoothing

    const running = o.state === 1;
    const air = o.state === 2 || o.state === 5;
    const swinging = o.state === 3;
    const clinging = o.state === 4;

    this.blend.run = lerp(this.blend.run, running ? Math.min(1, o.speed / 12) : 0, k);
    this.blend.air = lerp(this.blend.air, air ? 1 : 0, k);
    this.blend.swing = lerp(this.blend.swing, swinging ? 1 : 0, k);
    this.blend.cling = lerp(this.blend.cling, clinging ? 1 : 0, k);
    const b = this.blend;

    if (this.shootTimer > 0) this.shootTimer -= dt;

    // ------------------------------------------------------------ base pose
    const cycle = this.t * (6 + o.speed * 0.42);
    const swingPhase = Math.sin(cycle);
    const swingPhase2 = Math.cos(cycle);
    const bob = Math.sin(this.t * 2.1) * 0.03;

    let hipY = HIP_Y + bob * (1 - b.run) - b.run * 0.08 + Math.abs(Math.sin(cycle)) * 0.07 * b.run;
    let torsoLean = 0.05 + b.run * 0.34 + b.air * 0.12;
    let hipsRot = 0;
    let hipsRoll = 0;

    // Legs.
    let lHip = swingPhase * 0.95 * b.run;
    let rHip = -swingPhase * 0.95 * b.run;
    let lKnee = Math.max(0, -swingPhase * 0.9) * b.run + 0.08;
    let rKnee = Math.max(0, swingPhase * 0.9) * b.run + 0.08;

    // Arms.
    let lSh = -swingPhase * 0.85 * b.run;
    let rSh = swingPhase * 0.85 * b.run;
    let lEl = -0.35 - Math.abs(swingPhase) * 0.45 * b.run;
    let rEl = -0.35 - Math.abs(swingPhase) * 0.45 * b.run;
    let armSpreadL = 0.14;
    let armSpreadR = 0.14;

    // ------------------------------------------------------------- in air
    if (b.air > 0.01) {
      const tuck = THREE.MathUtils.clamp(0.5 - o.vy * 0.02, 0, 1);
      lHip = lerp(lHip, -0.9 * tuck - 0.15, b.air);
      rHip = lerp(rHip, -0.35 * tuck + 0.35, b.air);
      lKnee = lerp(lKnee, 1.5 * tuck, b.air);
      rKnee = lerp(rKnee, 0.7 * tuck, b.air);
      lSh = lerp(lSh, -2.3, b.air * 0.85);
      rSh = lerp(rSh, -1.1, b.air * 0.85);
      lEl = lerp(lEl, -0.55, b.air);
      rEl = lerp(rEl, -1.1, b.air);
      armSpreadL = lerp(armSpreadL, 0.42, b.air);
      armSpreadR = lerp(armSpreadR, 0.5, b.air);
      torsoLean = lerp(torsoLean, 0.28, b.air);
    }

    // ----------------------------------------------------------- swinging
    if (b.swing > 0.01) {
      // Lean into the arc and trail the legs behind.
      const trail = THREE.MathUtils.clamp(o.speed / 40, 0, 1);
      torsoLean = lerp(torsoLean, 0.55 + trail * 0.5, b.swing);
      lHip = lerp(lHip, -0.55 - trail * 0.5, b.swing);
      rHip = lerp(rHip, -0.2 - trail * 0.2, b.swing);
      lKnee = lerp(lKnee, 0.9, b.swing);
      rKnee = lerp(rKnee, 1.5, b.swing);
      armSpreadL = lerp(armSpreadL, 0.1, b.swing);
      armSpreadR = lerp(armSpreadR, 0.1, b.swing);
      hipsRoll = lerp(hipsRoll, Math.sin(this.t * 1.6) * 0.12, b.swing);
    }

    // -------------------------------------------------------- wall-cling
    if (b.cling > 0.01) {
      torsoLean = lerp(torsoLean, -0.35, b.cling);
      lSh = lerp(lSh, -2.5, b.cling);
      rSh = lerp(rSh, -2.5, b.cling);
      armSpreadL = lerp(armSpreadL, 0.95, b.cling);
      armSpreadR = lerp(armSpreadR, 0.95, b.cling);
      lHip = lerp(lHip, 0.5, b.cling);
      rHip = lerp(rHip, 0.5, b.cling);
      lKnee = lerp(lKnee, 1.3, b.cling);
      rKnee = lerp(rKnee, 1.3, b.cling);
      hipY = lerp(hipY, HIP_Y - 0.15, b.cling);
    }

    // ------------------------------------------------------------- commit
    this.hips.position.y = hipY;
    this.hips.rotation.set(torsoLean * 0.35, hipsRot, hipsRoll);
    this.torso.rotation.x = torsoLean * 0.65;
    // Head counter-rotates so the hero keeps looking where you aim.
    this.neck.rotation.x = THREE.MathUtils.clamp(-o.pitch * 0.55 - torsoLean, -0.9, 0.9);
    this.neck.rotation.z = Math.sin(this.t * 1.3) * 0.03;

    const [L, R] = this.arms;
    L.shoulder.rotation.set(lSh, 0, -armSpreadL);
    R.shoulder.rotation.set(rSh, 0, armSpreadR);
    L.elbow.rotation.x = lEl;
    R.elbow.rotation.x = rEl;

    const [LL, RL] = this.legs;
    LL.hip.rotation.x = lHip;
    RL.hip.rotation.x = rHip;
    LL.knee.rotation.x = lKnee;
    RL.knee.rotation.x = rKnee;
    LL.foot.rotation.x = -lKnee * 0.4;
    RL.foot.rotation.x = -rKnee * 0.4;

    // Web-shooting arm snaps forward, overriding whatever pose we blended.
    if (this.shootTimer > 0) {
      const p = 1 - this.shootTimer / 0.34;
      const punch = Math.sin(Math.min(1, p * 1.6) * Math.PI);
      const arm = this.shootArm > 0 ? R : L;
      arm.shoulder.rotation.x = -1.5 + o.pitch * 0.8 - punch * 0.35;
      arm.shoulder.rotation.z = arm.side * (0.12 + punch * 0.08);
      arm.elbow.rotation.x = -0.15 - (1 - punch) * 0.9;
    }

    // Both hands reach for the web line while swinging.
    if (o.anchorLocal && b.swing > 0.2) {
      const a = o.anchorLocal;
      const yaw = Math.atan2(a.x, a.z);
      const pitch = Math.atan2(a.y, Math.hypot(a.x, a.z));
      const upper = this.arms[o.swingSide > 0 ? 1 : 0];
      upper.shoulder.rotation.x = THREE.MathUtils.clamp(-pitch - 0.4, -2.9, 0.4);
      upper.shoulder.rotation.z = upper.side * 0.1 + THREE.MathUtils.clamp(yaw * 0.25, -0.6, 0.6);
      upper.elbow.rotation.x = -0.18;
    }
  }

  /** World position of a hand, used as the muzzle for web lines. */
  handWorld(side, out = new THREE.Vector3()) {
    const arm = this.arms[side > 0 ? 1 : 0];
    return arm.hand.getWorldPosition(out);
  }
}
