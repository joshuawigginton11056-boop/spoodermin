// Local player: movement, web-swinging, wall-crawling, zipping, aiming and the
// third-person camera. This is where the game feel lives.
//
// The simulation is stepped at a bounded rate rather than once per rendered
// frame: every rate in here is per-second, and no single step is allowed to be
// long enough for the pendulum to overshoot or for a fast release to pass
// through a wall. A swing therefore traces the same arc at 30fps and at 144fps.

import * as THREE from 'three';
import { PLAYER, GRAVITY, WEB, COMBAT, CITY } from '/shared/constants.js';
import { Hero } from '../entities/hero.js';

export const STATE = { IDLE: 0, RUN: 1, AIR: 2, SWING: 3, CLING: 4, ZIP: 5 };

const CAM_DISTANCES = [9.5, 14, 6];
// Longest physics step. Anything above this and the rope constraint starts to
// visibly overshoot, which is what made fast swings feel like they stuttered.
const MAX_SUBSTEP = 1 / 90;
const MAX_SUBSTEPS = 8;
// Tangential speed-up per second of swinging, replacing a per-frame multiplier
// that used to hand out more speed the higher your frame rate was. Kept gentle:
// a pendulum already converts height into speed, and stacking a fat multiplier
// on top of that is what turned a glide into a 300km/h slingshot.
const SWING_PUMP = 1.07;
// Cruising ceiling. Sprinting is 21m/s, so this still reads as flying.
const SWING_MAX_SPEED = 46;
// How much of the outward velocity a taut line takes away in one step. A hair
// under one gives the rope a little give, so catching a line halfway through a
// fall lands as a firm tug over two or three frames instead of a single jolt.
const ROPE_BITE = 0.86;
// Ceiling on the positional part of the constraint, so a step that starts
// deeply overstretched cannot fire the player off the end of the line.
const ROPE_MAX_PULL = 55;
// The camera pull-in probes, as (sideways, vertical) offsets from the head.
const CAM_PROBES = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.55], [0, -0.55]];
// Aim-assist cone for finding a swing anchor: (extra pitch, yaw offset) pairs.
const ANCHOR_CONE = [];
for (const up of [0, 0.35, 0.6, 0.9, 1.3]) {
  for (const side of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8]) ANCHOR_CONE.push([up, side]);
}
// What makes a line worth swinging on. Anchoring to the wall at head height
// gives a five-metre rope and a violent little pirouette at street level —
// technically a swing, but it is where "too fast and going nowhere" came from.
const ANCHOR_MIN_RISE = 12; // the anchor has to be properly overhead
const ANCHOR_MIN_DIST = 26; // and far enough away to arc on
// A deliberately aimed shot only has to clear your own arm's length.
const ANCHOR_MIN_DIRECT = 5;
// Relaxed pass, used only when the good kind of anchor is nowhere to be found,
// so the web still fires rather than failing silently.
const ANCHOR_FALLBACK_RISE = 4;
const ANCHOR_FALLBACK_DIST = 12;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class LocalPlayer {
  constructor({ scene, camera, world, input, skin, onShoot, onZip, fx }) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.input = input;
    this.onShoot = onShoot;
    this.onZip = onZip;
    this.fx = fx;

    this.hero = new Hero(skin);
    this.hero.root.visible = false;
    scene.add(this.hero.root);

    this.pos = new THREE.Vector3(0, 60, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.12;
    this.state = STATE.AIR;
    this.grounded = false;
    this.alive = false;

    this.fluid = COMBAT.FLUID_MAX;
    this.health = COMBAT.MAX_HEALTH;
    this.cooldown = 0;
    this.slowUntil = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;

    // swing state
    this.anchor = null; // THREE.Vector3
    this.ropeLen = 0;
    this.ropeLen0 = 0;
    this.swingSide = 1;
    this.swingTime = 0;
    this.zipTarget = null;
    this.zipTime = 0;
    this.clingNormal = null;

    this.camDist = 0;
    this.camPos = new THREE.Vector3(0, 70, 20);
    this.camLook = new THREE.Vector3();
    this.fov = 70;
    this.shake = 0;

    this.aimPoint = new THREE.Vector3();
    this.aimDist = Infinity;
    this.canWeb = false;
  }

  setWorld(world) { this.world = world; }

  spawn(pos) {
    this.pos.set(pos[0], pos[1], pos[2]);
    this.vel.set(0, 0, 0);
    this.alive = true;
    this.state = STATE.AIR;
    this.anchor = null;
    this.zipTarget = null;
    this.health = COMBAT.MAX_HEALTH;
    this.fluid = COMBAT.FLUID_MAX;
    this.hero.root.visible = true;
    this.camPos.copy(this.pos);
    this.camPos.y += 6;
    this.camPos.z += 12;
  }

  die() {
    this.alive = false;
    this.anchor = null;
    this.zipTarget = null;
    this.state = STATE.IDLE;
    this.vel.set(0, 0, 0);
    this.hero.root.visible = false;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  // -------------------------------------------------------------- aiming
  // Analytic look direction. The camera sits at head + offset(yaw,pitch) and
  // looks back at the head, so this is exactly the camera's forward vector —
  // but it stays correct even on the frames where the camera is still easing
  // into place or has been pushed in by a wall.
  lookDir(out = _v) {
    return out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }

  /** Eye position used as the origin for every aiming ray. */
  eye(out = _v2) {
    return out.set(this.pos.x, this.pos.y + PLAYER.EYE, this.pos.z);
  }

  updateAim() {
    const dir = this.lookDir(_v3);
    const from = this.eye(_v2);
    const hit = this.world.raycast(from, dir, 400);
    if (hit) {
      this.aimPoint.copy(hit.point);
      this.aimDist = hit.dist;
    } else {
      this.aimPoint.copy(from).addScaledVector(dir, 400);
      this.aimDist = Infinity;
    }
    // The crosshair's "you can swing from that" state falls out of the aim ray
    // we already cast, instead of costing a second one every frame. Anything
    // within reach counts now that the web goes wherever it is pointed.
    this.canWeb = this.state === STATE.SWING ||
      (this.aimDist >= ANCHOR_MIN_DIRECT && this.aimDist <= WEB.MAX_LENGTH);
  }

  // ------------------------------------------------------------- webbing
  /**
   * Sweeps a cone around the look direction and keeps the *best* anchor rather
   * than the first one found. High and far beats near and low: that is the
   * difference between arcing across a street and pirouetting around a doorway.
   */
  findAnchor() {
    const from = this.eye(_v2);
    const dir = this.lookDir(_v3);

    // Whatever the crosshair is actually on wins, wherever it is — a ledge, a
    // low wall, the underside of a highway. If you are pointing at something,
    // that is where the web goes; the assist below is for when you are not
    // pointing at anything in particular, not a second opinion on where you
    // meant to shoot.
    const direct = this.world.raycast(from, dir, WEB.MAX_LENGTH);
    if (direct && direct.dist >= ANCHOR_MIN_DIRECT) return _v5.copy(direct.point);

    let best = -Infinity;
    let found = false;

    const sweep = (minRise, minDist) => {
      for (let i = -1; i < ANCHOR_CONE.length; i++) {
        const d = _v4.copy(dir);
        if (i >= 0) {
          d.y += ANCHOR_CONE[i][0];
          d.applyAxisAngle(UP, ANCHOR_CONE[i][1]);
          d.normalize();
        }
        const h = this.world.raycast(from, d, WEB.MAX_LENGTH * 1.3);
        if (!h) continue;
        if (h.normal.y > 0.9) continue; // a floor is not something to hang from

        // Run the line up the face to the roofline rather than sticking it
        // wherever the ray happened to touch. Hitting a wall at chest height
        // is what buried the whole game at street level: a low anchor is a
        // short rope, and a short rope is a spin, not a swing.
        const dx = h.point.x - this.pos.x;
        const dz = h.point.z - this.pos.z;
        const horiz = Math.hypot(dx, dz);
        let y = h.point.y;
        if (h.box) {
          const reachUp = Math.sqrt(Math.max(0, WEB.MAX_LENGTH * WEB.MAX_LENGTH - horiz * horiz));
          y = Math.min(h.box.y + h.box.hh - 0.6, this.pos.y + reachUp);
          if (y < h.point.y) y = h.point.y;
        }

        const rise = y - this.pos.y;
        const dist = Math.hypot(horiz, rise);
        if (rise < minRise || dist < minDist) continue;
        // Height matters more than reach — altitude is what the next swing
        // spends, so a line that lifts you keeps the whole run going.
        const score = rise * 1.6 + dist;
        if (score > best) { best = score; _v5.set(h.point.x, y, h.point.z); found = true; }
      }
    };

    sweep(ANCHOR_MIN_RISE, ANCHOR_MIN_DIST);
    if (!found) sweep(ANCHOR_FALLBACK_RISE, ANCHOR_FALLBACK_DIST);
    return found ? _v5 : null;
  }

  startSwing() {
    const a = this.findAnchor();
    if (!a) {
      this.fx?.miss(this.aimPoint);
      return false;
    }
    this.anchor = a.clone();
    // Hang on exactly the length that was fired, so the line goes taut as the
    // arc reaches it instead of pre-tensioned and yanking on contact.
    this.ropeLen = THREE.MathUtils.clamp(this.pos.distanceTo(this.anchor), WEB.MIN_LENGTH, WEB.MAX_LENGTH);
    // Remembered so the automatic reel can pull in a share of *this* line
    // rather than towards one fixed length for every swing.
    this.ropeLen0 = this.ropeLen;
    this.state = STATE.SWING;
    this.swingTime = 0;
    // Launching from a standstill: give a hop so the line actually lifts you
    // off the roof instead of instantly going slack.
    if (this.grounded) {
      this.vel.y = Math.max(this.vel.y, 10);
      this.pos.y += 0.1;
    }
    this.grounded = false;
    // Shoot the line from whichever hand is closer to the anchor.
    const rel = _v.copy(this.anchor).sub(this.pos);
    const right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.swingSide = rel.dot(right) >= 0 ? 1 : -1;
    this.hero.triggerShoot(this.swingSide);
    this.fx?.webLine(this.hero.handWorld(this.swingSide, _v3), this.anchor);
    return true;
  }

  endSwing(boost = true) {
    if (!this.anchor) return;
    this.anchor = null;
    if (boost) {
      this.vel.multiplyScalar(WEB.RELEASE_BOOST);
      // Lift scaled by how fast the arc was going, so a good swing throws you
      // upward into the next one. A flat nudge was worth nothing against a
      // gravity of 30 and left every release sinking towards the street.
      const hs = Math.hypot(this.vel.x, this.vel.z);
      this.vel.y += Math.min(WEB.RELEASE_LIFT, 2 + hs * 0.32);
    }
    this.state = STATE.AIR;
    this.fx?.cutWeb();
  }

  tryZip() {
    if (this.fluid < COMBAT.FLUID_PER_ZIP) return;
    const dir = this.lookDir(_v3);
    const hit = this.world.raycast(this.eye(_v2), dir, WEB.MAX_LENGTH * 1.6);
    if (!hit) { this.fx?.miss(this.aimPoint); return; }
    this.fluid -= COMBAT.FLUID_PER_ZIP;
    this.zipTarget = hit.point.clone().addScaledVector(hit.normal, 1.2);
    this.zipTime = 2.2;
    this.state = STATE.ZIP;
    this.anchor = null;
    this.swingSide = 1;
    this.hero.triggerShoot(1);
    this.fx?.webLine(this.hero.handWorld(1, _v4), this.zipTarget);
    this.onZip?.();
  }

  shoot() {
    if (this.cooldown > 0 || this.fluid < COMBAT.FLUID_PER_SHOT) return;
    this.cooldown = COMBAT.FIRE_COOLDOWN;
    this.fluid -= COMBAT.FLUID_PER_SHOT;
    const side = this.state === STATE.SWING ? -this.swingSide : (Math.random() < 0.5 ? 1 : -1);
    this.hero.triggerShoot(side);
    const muzzle = this.hero.handWorld(side, new THREE.Vector3());
    // Aim the ball at whatever the crosshair is over, not just straight ahead,
    // so close-range shots do not fly wide of the reticle.
    const dir = _v.copy(this.aimPoint).sub(muzzle).normalize().clone();
    this.onShoot?.(muzzle, dir);
    this.shake = Math.min(0.5, this.shake + 0.12);
  }

  // ------------------------------------------------------------- the loop
  /**
   * One rendered frame: read input once, then advance the simulation in
   * however many bounded steps `dt` is worth.
   */
  update(dt) {
    const input = this.input;
    const m = input.mouse;

    // ---- look
    // Positive pitch parks the camera above the hero, i.e. looking down.
    const sens = 0.0022;
    this.yaw -= m.dx * sens;
    this.pitch += m.dy * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.15, 1.25);
    if (input.hit('KeyV')) this.camDist = (this.camDist + 1) % CAM_DISTANCES.length;

    if (!this.alive) {
      this.updateCamera(dt, true);
      return;
    }

    this.cooldown -= dt;
    this.fluid = Math.min(COMBAT.FLUID_MAX, this.fluid + COMBAT.FLUID_REGEN * dt);

    // ---- wish direction in camera space
    const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let wx = 0;
    let wz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) { wx += f.x; wz += f.z; }
    if (input.down('KeyS') || input.down('ArrowDown')) { wx -= f.x; wz -= f.z; }
    if (input.down('KeyD') || input.down('ArrowRight')) { wx += r.x; wz += r.z; }
    if (input.down('KeyA') || input.down('ArrowLeft')) { wx -= r.x; wz -= r.z; }
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const wishing = wl > 0;

    const slowed = performance.now() / 1000 < this.slowUntil;
    const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const maxSpeed = (sprint ? PLAYER.SPRINT : PLAYER.WALK) * (slowed ? COMBAT.IMPACT_SLOW : 1);

    // ---- actions (edge-triggered, so exactly once per frame)
    if (m.leftEdge || (m.left && this.cooldown <= 0)) this.shoot();
    if (input.hit('KeyE')) this.tryZip();
    if (input.hit('Space')) this.jumpBuffer = 0.16;

    if (m.rightEdge && this.state !== STATE.SWING) this.startSwing();
    if (!m.right && this.state === STATE.SWING) this.endSwing(true);

    // ---- simulate
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / MAX_SUBSTEP)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.simulate(h, wx, wz, wishing, maxSpeed);

    this.updateHero(dt);
    this.updateCamera(dt, false);
    this.updateAim();
  }

  /** One bounded physics step. */
  simulate(dt, wx, wz, wishing, maxSpeed) {
    this.jumpBuffer -= dt;

    switch (this.state) {
      case STATE.ZIP: this.stepZip(dt); break;
      case STATE.SWING: this.stepSwing(dt, wx, wz); break;
      case STATE.CLING: this.stepCling(dt, wx, wz); break;
      default: this.stepWalk(dt, wx, wz, wishing, maxSpeed); break;
    }

    // ---- integrate + collide
    const res = this.world.move(this.pos, this.vel, dt);
    this.grounded = res.grounded;

    if (res.grounded) {
      this.coyote = 0.12;
      if (res.landedSpeed > 26) {
        this.shake = Math.min(0.6, this.shake + res.landedSpeed / 160);
        this.fx?.landPuff(this.pos, res.landedSpeed);
      }
      // Touching down mid-swing is fine as long as the line is still taut
      // above us — that is a wall-run, not a landing.
      if (this.state === STATE.SWING && !(this.anchor && this.anchor.y > this.pos.y + 5)) {
        this.endSwing(false);
      }
      if (this.state === STATE.ZIP) { this.zipTarget = null; this.state = STATE.IDLE; }
      if (this.state !== STATE.SWING && this.state !== STATE.ZIP) {
        this.state = this.speed > 1.2 ? STATE.RUN : STATE.IDLE;
      }
      this.clingNormal = null;
    } else {
      this.coyote -= dt;
      if (this.state === STATE.IDLE || this.state === STATE.RUN) this.state = STATE.AIR;
    }

    // ---- wall cling: hug any wall we are pressed against while airborne
    if (!res.grounded && this.state === STATE.AIR && this.vel.y < 4) {
      const n = this.world.wallNear(this.pos, 0.5);
      if (n && (wishing || this.clingNormal)) {
        const into = -(wx * n.x + wz * n.z);
        if (into > 0.15 || this.clingNormal) {
          this.clingNormal = n;
          this.state = STATE.CLING;
          this.vel.y = Math.max(this.vel.y, -PLAYER.WALL_SLIDE);
        }
      }
    }

    // ---- jump
    if (this.jumpBuffer > 0) {
      if (this.state === STATE.CLING && this.clingNormal) {
        this.vel.y = PLAYER.WALL_JUMP;
        this.vel.x += this.clingNormal.x * PLAYER.WALL_JUMP * 0.75;
        this.vel.z += this.clingNormal.z * PLAYER.WALL_JUMP * 0.75;
        this.state = STATE.AIR;
        this.clingNormal = null;
        this.jumpBuffer = 0;
        this.fx?.landPuff(this.pos, 20);
      } else if (res.grounded || this.coyote > 0) {
        this.vel.y = PLAYER.JUMP;
        this.state = STATE.AIR;
        this.coyote = 0;
        this.jumpBuffer = 0;
      } else if (this.state === STATE.SWING) {
        // Space while swinging = release with a strong upward kick.
        this.endSwing(true);
        this.vel.y += 5;
        this.jumpBuffer = 0;
      }
    }

    if (this.vel.y < -PLAYER.MAX_FALL) this.vel.y = -PLAYER.MAX_FALL;

    // ---- keep the fight inside the map
    const lim = CITY.HALF + 90;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -lim, lim);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -lim, lim);
  }

  // ------------------------------------------------------------ movement
  stepWalk(dt, wx, wz, wishing, maxSpeed) {
    const accel = this.grounded ? PLAYER.ACCEL : PLAYER.AIR_ACCEL;
    if (wishing) {
      this.vel.x += wx * accel * dt;
      this.vel.z += wz * accel * dt;
      const hs = Math.hypot(this.vel.x, this.vel.z);
      // Only clamp when the player is actively driving; momentum from a swing
      // release is allowed to exceed run speed.
      if (hs > maxSpeed && this.grounded) {
        this.vel.x *= maxSpeed / hs;
        this.vel.z *= maxSpeed / hs;
      } else if (hs > maxSpeed * 3.2) {
        this.vel.x *= (maxSpeed * 3.2) / hs;
        this.vel.z *= (maxSpeed * 3.2) / hs;
      }
    } else if (this.grounded) {
      const drop = PLAYER.FRICTION * dt;
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const k = Math.max(0, 1 - drop * (hs > 1 ? 1 : 2));
      this.vel.x *= k;
      this.vel.z *= k;
    }
    this.vel.y -= GRAVITY * dt;
  }

  stepSwing(dt, wx, wz) {
    if (!this.anchor) { this.state = STATE.AIR; return; }
    this.swingTime += dt;
    this.vel.y -= WEB.SWING_GRAVITY * dt;

    // The line reels itself in on the way down through the arc and lets be on
    // the way up, so a swing pumps without anyone holding a key. It stops at
    // AUTO_REEL_MIN — run all the way in and every swing finishes as a short,
    // fast spin, which is the thing that made this feel out of control.
    const reelFloor = Math.max(WEB.AUTO_REEL_MIN, this.ropeLen0 * WEB.AUTO_REEL_KEEP);
    if (this.vel.y < 0 && this.ropeLen > reelFloor) {
      this.ropeLen = Math.max(reelFloor, this.ropeLen - WEB.AUTO_REEL * dt);
    }

    // C hauls in harder than the automatic reel, and all the way down, for
    // anyone who wants to whip round a corner or climb a face.
    if (this.input.down('KeyC')) {
      this.ropeLen = Math.max(WEB.MIN_LENGTH, this.ropeLen - WEB.REEL_SPEED * dt);
    }

    // Take up slack so the bottom of the arc stays above the street. Done as a
    // steady reel rather than a clamp at fire time, so it reads as the line
    // pulling tight through the swing instead of a yank the moment it sticks.
    const safe = Math.max(WEB.MIN_LENGTH, this.anchor.y - WEB.GROUND_CLEARANCE);
    if (this.ropeLen > safe) {
      this.ropeLen = Math.max(safe, this.ropeLen - WEB.REEL_SPEED * 1.6 * dt);
    }

    // Steering: push along the tangent of the arc.
    const rope = _v.copy(this.pos).sub(this.anchor);
    const dist = rope.length() || 1;
    rope.divideScalar(dist);
    if (wx || wz) {
      const wish = _v2.set(wx, 0, wz);
      // Remove the component pointing along the rope so we do not fight it.
      wish.addScaledVector(rope, -wish.dot(rope));
      this.vel.addScaledVector(wish, WEB.SWING_ACCEL * dt);
    }

    // Rope constraint. The line is inextensible, so all that happens at full
    // stretch is that the outward part of the velocity stops existing — the
    // tangential part, steering included, is carried straight through. The old
    // version rebuilt the whole velocity vector from a position delta, which
    // both threw the steering away and turned every frame-time wobble into a
    // visible kick.
    const next = _v3.copy(this.pos).addScaledVector(this.vel, dt).sub(this.anchor);
    const d = next.length();
    if (d > this.ropeLen) {
      const n = next.divideScalar(d);
      const radial = this.vel.dot(n);
      if (radial > 0) this.vel.addScaledVector(n, -radial * ROPE_BITE);
      // Pull the overshoot out over this step rather than snapping. The
      // overshoot scales with dt², so dividing by dt leaves a correction that
      // behaves the same at any frame rate.
      const pull = Math.min(((d - this.ropeLen) / dt) * 0.65, ROPE_MAX_PULL);
      this.vel.addScaledVector(n, -pull);

      // A swing that is already moving picks up a little energy, which is what
      // makes long arcs feel powerful. Per second, not per frame.
      const sp = this.vel.length();
      if (sp > 1 && sp < SWING_MAX_SPEED) this.vel.multiplyScalar(Math.pow(SWING_PUMP, dt));
    }

    // Soft ceiling, then a hard one as a backstop.
    this.vel.multiplyScalar(Math.max(0, 1 - WEB.SWING_DRAG * dt));
    const sp = this.vel.length();
    if (sp > SWING_MAX_SPEED) this.vel.multiplyScalar(SWING_MAX_SPEED / sp);

    // Bail out if the rope goes slack behind us near the ground.
    if (this.anchor.y < this.pos.y + 1 && this.grounded) this.endSwing(false);
    if (this.pos.distanceTo(this.anchor) > WEB.MAX_LENGTH * 1.5) this.endSwing(false);
  }

  stepCling(dt, wx, wz) {
    const n = this.world.wallNear(this.pos, 0.6);
    if (!n) { this.state = STATE.AIR; this.clingNormal = null; return; }
    this.clingNormal = n;
    // Crawl: W climbs, S descends, A/D shuffle sideways along the wall.
    const up = this.input.down('KeyW') ? 1 : this.input.down('KeyS') ? -1 : 0;
    this.vel.y = up ? up * 7.5 : -PLAYER.WALL_SLIDE * 0.35;
    // Project desired horizontal motion onto the wall plane.
    const wish = _v.set(wx, 0, wz);
    wish.addScaledVector(n, -wish.dot(n));
    this.vel.x = wish.x * 7;
    this.vel.z = wish.z * 7;
    // Stick to the wall.
    this.vel.addScaledVector(n, -3);
    if (this.pos.y <= 0.05) { this.state = STATE.IDLE; this.clingNormal = null; }
  }

  stepZip(dt) {
    if (!this.zipTarget) { this.state = STATE.AIR; return; }
    this.zipTime -= dt;
    const to = _v.copy(this.zipTarget).sub(this.pos);
    const d = to.length();
    if (d < WEB.ZIP_ARRIVE || this.zipTime <= 0) {
      this.zipTarget = null;
      this.state = STATE.AIR;
      this.vel.multiplyScalar(0.55);
      this.fx?.cutWeb();
      return;
    }
    to.divideScalar(d);
    this.vel.copy(to).multiplyScalar(WEB.ZIP_SPEED);
  }

  // --------------------------------------------------------------- visuals
  updateHero(dt) {
    const h = this.hero;
    h.root.position.copy(this.pos);

    // Face the way we are moving, or the way we look when standing still.
    // The mesh's face is +Z, while the look direction is (-sin yaw, -cos yaw),
    // hence the half turn for the idle case.
    let faceYaw = this.yaw + Math.PI;
    if (this.state === STATE.SWING || this.speed > 3) {
      faceYaw = Math.atan2(this.vel.x, this.vel.z);
    }
    if (this.state === STATE.CLING && this.clingNormal) {
      faceYaw = Math.atan2(-this.clingNormal.x, -this.clingNormal.z);
    }
    // Shortest-arc smoothing.
    let diff = ((faceYaw - h.root.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    h.root.rotation.y += diff * Math.min(1, dt * 12);

    let anchorLocal = null;
    if (this.anchor) {
      anchorLocal = h.root.worldToLocal(_v.copy(this.anchor));
    } else if (this.zipTarget) {
      anchorLocal = h.root.worldToLocal(_v.copy(this.zipTarget));
    }

    h.update(dt, {
      state: this.state,
      speed: this.speed,
      vy: this.vel.y,
      pitch: this.pitch,
      anchorLocal,
      swingSide: this.swingSide,
    });
  }

  updateCamera(dt, dead) {
    const targetDist = CAM_DISTANCES[this.camDist];
    const head = _v.copy(this.pos);
    head.y += PLAYER.EYE;

    const dir = _v2.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );

    // Pull the camera in if a building is in the way. A few offset probes
    // around the centre ray stop the camera from slicing through corners.
    let dist = targetDist;
    const side = _v3.set(dir.z, 0, -dir.x).normalize();
    const from = _v4;
    for (const [su, sv] of CAM_PROBES) {
      from.copy(head).addScaledVector(side, su);
      from.y += sv;
      const hit = this.world.raycast(from, dir, targetDist + 1.4);
      if (hit) dist = Math.min(dist, Math.max(2.6, hit.dist - 1.1));
    }
    // Once the camera is right on top of the hero, hide the model so the view
    // is not filled with the inside of a shoulder.
    this.hero.root.visible = this.alive && dist > 3.4;

    const want = _v5.copy(head).addScaledVector(dir, dist);
    const k = 1 - Math.pow(0.0008, dt);
    this.camPos.lerp(want, dead ? k * 0.5 : k);
    this.camera.position.copy(this.camPos);

    // Aim straight at the hero's head: this makes the camera's forward vector
    // exactly the analytic look direction the crosshair is built from.
    this.camLook.copy(head);
    this.camera.lookAt(this.camLook);

    // Speed FOV + a touch of shake.
    const targetFov = 70 + THREE.MathUtils.clamp((this.speed - 16) * 0.55, 0, 26);
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 4);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    if (this.shake > 0.001) {
      this.shake *= Math.pow(0.02, dt);
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
  }

  netState() {
    return {
      t: 'input',
      p: [+this.pos.x.toFixed(2), +this.pos.y.toFixed(2), +this.pos.z.toFixed(2)],
      v: [+this.vel.x.toFixed(1), +this.vel.y.toFixed(1), +this.vel.z.toFixed(1)],
      y: +this.hero.root.rotation.y.toFixed(3),
      h: +this.pitch.toFixed(3),
      s: this.state,
      w: this.anchor ? [+this.anchor.x.toFixed(1), +this.anchor.y.toFixed(1), +this.anchor.z.toFixed(1)] : null,
    };
  }
}
