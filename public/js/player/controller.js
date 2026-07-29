// Local player: movement, web-swinging, wall-crawling, zipping, aiming and the
// third-person camera. This is where the game feel lives.

import * as THREE from 'three';
import { PLAYER, GRAVITY, WEB, COMBAT, CITY, CAMERA } from '/shared/constants.js';
import { Hero } from '../entities/hero.js';

export const STATE = { IDLE: 0, RUN: 1, AIR: 2, SWING: 3, CLING: 4, ZIP: 5 };

// Offsets for the spring-arm probes, in the camera's right/up axes. Five rays
// instead of one stop the arm from slicing through corners and railings.
const ARM_PROBES = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.55], [0, -0.55]];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _back = new THREE.Vector3();
const _right = new THREE.Vector3();
const _off = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _look = new THREE.Vector3();

export class LocalPlayer {
  constructor({ scene, camera, world, input, skin, onShoot, onZip, fx, targets }) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.input = input;
    this.onShoot = onShoot;
    this.onZip = onZip;
    this.fx = fx;
    // Live enemies, used only for bullet magnetism. Returns whatever the
    // renderer is currently drawing, which is what the player is aiming at.
    this.targets = targets || (() => []);

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
    this.swingSide = 1;
    this.swingTime = 0;
    this.zipTarget = null;
    this.zipTime = 0;
    this.clingNormal = null;

    this.camDist = 0;
    this.camPos = new THREE.Vector3(0, 70, 20);
    this.camEye = new THREE.Vector3(0, 70, 20); // camera position before shake
    this.camLook = new THREE.Vector3();
    this.fov = CAMERA.FOV;
    this.shake = 0;

    this.aimPoint = new THREE.Vector3();
    this.aimDist = 400;
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
    this.camPos.copy(this.pos).add(new THREE.Vector3(0, 6, 12));
    this.camEye.copy(this.camPos);
    this.updateAim(); // so a shot on the very first frame has somewhere to go
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
  // Analytic look direction. The camera is built from yaw/pitch and points
  // along exactly this vector, so it is the ray under the crosshair — and it
  // stays correct on the frames where the arm is still easing into place or
  // has been pushed in by a wall.
  lookDir(out = _v) {
    return out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }

  /** Eye position — where webs are shot from. */
  eye(out = _v2) {
    return out.set(this.pos.x, this.pos.y + PLAYER.EYE, this.pos.z);
  }

  /**
   * Closest enemy inside the magnetism cone with a clear line to them.
   * Returns {dir, dist, angle} or null. Never leads a target: this forgives a
   * reticle that is slightly off, it does not do the aiming.
   */
  assistTarget(from, dir) {
    let best = null;
    let bestAngle = COMBAT.AIM_ASSIST_ANGLE;
    for (const t of this.targets()) {
      if (!t.alive) continue;
      const to = _v3.copy(t.pos);
      to.y += PLAYER.HEIGHT * 0.55;
      to.sub(from);
      const d = to.length();
      if (d < 5 || d > COMBAT.AIM_ASSIST_RANGE) continue;
      to.divideScalar(d);
      const dot = to.dot(dir);
      if (dot <= 0) continue;
      const angle = Math.acos(Math.min(1, dot));
      if (angle >= bestAngle) continue;
      if (this.world.raycast(from, to, d - 1.6)) continue; // something in the way
      bestAngle = angle;
      best = { dir: to.clone(), dist: d, angle };
    }
    return best;
  }

  /**
   * Where the crosshair is pointing, in the world. The ray starts at the
   * camera — with an over-the-shoulder rig the camera and the hero's eye see
   * different things, and the crosshair belongs to the camera.
   */
  updateAim() {
    const dir = this.lookDir(_look).clone();
    const from = this.camEye;
    const hit = this.world.raycast(from, dir, 400);
    let dist = hit ? hit.dist : 400;

    const target = this.assistTarget(from, dir);
    if (target && target.dist < dist + 2) {
      // Ease off the nudge as the reticle drifts to the edge of the cone.
      const w = COMBAT.AIM_ASSIST_STRENGTH * (1 - target.angle / COMBAT.AIM_ASSIST_ANGLE);
      dir.lerp(target.dir, w).normalize();
      dist = target.dist;
    }
    this.aimPoint.copy(from).addScaledVector(dir, dist);
    this.aimDist = dist;
  }

  /**
   * Launch direction that puts a web ball on `target`. Balls are fired at a
   * fixed speed and droop under SHOT_GRAVITY, so firing straight down the
   * crosshair always lands low — aim high by the drop over the flight time
   * instead. Two passes converge far inside the hit radius.
   */
  launchDir(muzzle, target, out) {
    let t = out.copy(target).sub(muzzle).length() / COMBAT.SHOT_SPEED;
    for (let i = 0; i < 2; i++) {
      out.copy(target).sub(muzzle);
      out.y += 0.5 * COMBAT.SHOT_GRAVITY * t * t;
      t = out.length() / COMBAT.SHOT_SPEED;
    }
    return out.normalize();
  }

  // ------------------------------------------------------------- webbing
  findAnchor() {
    const from = this.eye(_v2).clone();
    const dir = this.lookDir(_v3).clone();
    let hit = this.world.raycast(from, dir, WEB.MAX_LENGTH * 1.3);
    if (hit && hit.point.y > this.pos.y + 1.5 && hit.normal.y < 0.85) return hit.point.clone();

    // Aim assist: sweep a cone up and around the look direction so a casual
    // flick still finds a corner to swing from.
    const base = dir.clone();
    for (const up of [0.35, 0.6, 0.9, 1.3]) {
      for (const side of [0, 0.25, -0.25, 0.5, -0.5]) {
        const d = base.clone();
        d.y += up;
        d.applyAxisAngle(new THREE.Vector3(0, 1, 0), side);
        d.normalize();
        hit = this.world.raycast(from, d, WEB.MAX_LENGTH * 1.25);
        if (hit && hit.point.y > this.pos.y + 6 && hit.normal.y < 0.9) return hit.point.clone();
      }
    }
    return null;
  }

  startSwing() {
    const a = this.findAnchor();
    if (!a) {
      this.fx?.miss();
      return false;
    }
    this.anchor = a;
    // Attach with a little slack rather than pre-tensioned: the line catches
    // smoothly a moment later instead of yanking on the frame it lands.
    this.ropeLen = THREE.MathUtils.clamp(
      this.pos.distanceTo(a) + WEB.ATTACH_SLACK, WEB.MIN_LENGTH, WEB.MAX_LENGTH
    );
    this.state = STATE.SWING;
    this.swingTime = 0;
    // Launching from a standstill: give a hop so the line actually lifts you
    // off the roof instead of instantly going slack.
    if (this.grounded) {
      this.vel.y = Math.max(this.vel.y, WEB.LAUNCH_HOP);
      this.pos.y += 0.1;
    }
    this.grounded = false;
    // Shoot the line from whichever hand is closer to the anchor.
    const rel = _v.copy(a).sub(this.pos);
    const right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.swingSide = rel.dot(right) >= 0 ? 1 : -1;
    this.hero.triggerShoot(this.swingSide);
    this.fx?.webLine(this.hero.handWorld(this.swingSide, new THREE.Vector3()), a);
    return true;
  }

  endSwing(boost = true) {
    if (!this.anchor) return;
    this.anchor = null;
    if (boost) {
      this.vel.multiplyScalar(WEB.RELEASE_BOOST);
      this.vel.y += 1.5;
    }
    this.state = STATE.AIR;
    this.fx?.cutWeb();
  }

  tryZip() {
    if (this.fluid < COMBAT.FLUID_PER_ZIP) return;
    // Zip exactly where the crosshair is, which with a shoulder camera is not
    // quite where the eye is looking.
    const from = this.eye(_v2).clone();
    const dir = _v3.copy(this.aimPoint).sub(from).normalize().clone();
    const hit = this.world.raycast(from, dir, WEB.MAX_LENGTH * 1.6);
    if (!hit) { this.fx?.miss(); return; }
    this.fluid -= COMBAT.FLUID_PER_ZIP;
    this.zipTarget = hit.point.clone().addScaledVector(hit.normal, 1.2);
    this.zipTime = 2.2;
    this.state = STATE.ZIP;
    this.anchor = null;
    this.swingSide = 1;
    this.hero.triggerShoot(1);
    this.fx?.webLine(this.hero.handWorld(1, new THREE.Vector3()), this.zipTarget);
    this.onZip?.();
  }

  shoot() {
    if (this.cooldown > 0 || this.fluid < COMBAT.FLUID_PER_SHOT) return;
    this.cooldown = COMBAT.FIRE_COOLDOWN;
    this.fluid -= COMBAT.FLUID_PER_SHOT;
    const side = this.state === STATE.SWING ? -this.swingSide : (Math.random() < 0.5 ? 1 : -1);
    this.hero.triggerShoot(side);
    const muzzle = this.hero.handWorld(side, new THREE.Vector3());
    // Aim the ball at whatever the crosshair is over — and high enough that
    // gravity drops it onto that point rather than short of it.
    const dir = this.launchDir(muzzle, this.aimPoint, new THREE.Vector3());
    this.onShoot?.(muzzle, dir);
    this.shake = Math.min(0.5, this.shake + 0.12);
  }

  // ------------------------------------------------------------- the loop
  update(dt) {
    const input = this.input;
    const m = input.mouse;

    // ---- look
    // Positive pitch parks the camera above the hero, i.e. looking down.
    this.yaw -= m.dx * CAMERA.SENSITIVITY;
    this.pitch += m.dy * CAMERA.SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    if (input.hit('KeyV')) this.camDist = (this.camDist + 1) % CAMERA.DISTANCE.length;

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

    // ---- actions
    if (m.leftEdge || (m.left && this.cooldown <= 0)) this.shoot();
    if (input.hit('KeyE')) this.tryZip();
    if (input.hit('Space')) this.jumpBuffer = 0.16;
    this.jumpBuffer -= dt;

    if (m.rightEdge && this.state !== STATE.SWING) this.startSwing();
    if (!m.right && this.state === STATE.SWING) this.endSwing(true);

    // ---- per-state simulation
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

    this.updateHero(dt);
    this.updateCamera(dt, false);
    this.updateAim();

    // Crosshair feedback: is there something swingable out there?
    if (this.state !== STATE.SWING) {
      const hit = this.world.raycast(this.eye(_v2).clone(), this.lookDir(_v3).clone(), WEB.MAX_LENGTH * 1.3);
      this.canWeb = !!(hit && hit.point.y > this.pos.y + 1.5);
    } else this.canWeb = true;
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
    this.vel.y -= GRAVITY * dt;

    // Steering: push along the tangent of the arc.
    const rope = _v.copy(this.pos).sub(this.anchor);
    const out = rope.divideScalar(rope.length() || 1e-4); // unit, anchor -> hero
    if (wx || wz) {
      const wish = _v2.set(wx, 0, wz);
      // Remove the component pointing along the rope so we do not fight it.
      wish.addScaledVector(out, -wish.dot(out));
      this.vel.addScaledVector(wish, WEB.SWING_ACCEL * dt);
    }

    // Reel in for altitude / speed, pay out to drop. Deliberately not on W/S:
    // those steer, and reeling in every time you held forward was most of why
    // swings ran away with themselves.
    if (this.input.down('KeyC') || this.input.down('ShiftLeft') || this.input.down('ShiftRight')) {
      this.ropeLen = Math.max(WEB.MIN_LENGTH, this.ropeLen - WEB.REEL_SPEED * dt);
    }
    if (this.input.down('KeyX') || this.input.down('ControlLeft')) {
      this.ropeLen = Math.min(WEB.MAX_LENGTH, this.ropeLen + WEB.REEL_SPEED * dt);
    }

    // Rope constraint, solved against the position we are about to move to so
    // the line goes taut on the frame it would have overstretched.
    const next = _v3.copy(this.pos).addScaledVector(this.vel, dt).sub(this.anchor);
    const d = next.length() || 1e-4;
    if (d > this.ropeLen) {
      const n = next.divideScalar(d);
      // Cancel only the outward component. The tangential speed that makes the
      // arc feel good is left alone — rewriting the whole velocity vector every
      // frame (the old behaviour) is what made swinging feel like a series of
      // jerks, and made it framerate-dependent on top of that.
      const radial = this.vel.dot(n);
      if (radial > 0) this.vel.addScaledVector(n, -radial);
      // Whatever stretch is left bleeds off over a few frames rather than being
      // teleported away in one.
      const stretch = d - this.ropeLen;
      this.pos.addScaledVector(n, -stretch * Math.min(1, WEB.ROPE_CORRECT * dt));
      // A gentle pump on the downswing replaces the energy the taut line eats.
      // Per second, not per frame: the old multiply fed a 144Hz display more
      // than twice the speed it fed a 60Hz one.
      if (this.vel.y < 0) this.vel.multiplyScalar(1 + WEB.PUMP * dt);
    }

    // Speed ceiling, eased in so touching it never pops.
    const sp = this.vel.length();
    if (sp > WEB.MAX_SPEED) {
      const k = Math.min(1, WEB.DRAG * dt);
      this.vel.multiplyScalar(1 - k + k * (WEB.MAX_SPEED / sp));
    }

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
      anchorLocal = h.root.worldToLocal(_v.copy(this.anchor)).clone();
    } else if (this.zipTarget) {
      anchorLocal = h.root.worldToLocal(_v.copy(this.zipTarget)).clone();
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

  /**
   * Over-the-shoulder third-person rig, Fortnite style.
   *
   * The camera hangs off a spring arm behind the hero and is then pushed to the
   * right and slightly up, and it points along the aim direction rather than
   * back at the hero. That is the whole trick: the body sits low and left of
   * centre, the crosshair looks down a clear lane, and turning the camera does
   * not swing the character across the screen.
   */
  updateCamera(dt, dead) {
    const arm = CAMERA.DISTANCE[this.camDist];
    _pivot.copy(this.pos);
    _pivot.y += PLAYER.EYE + CAMERA.RISE;

    // Camera basis from yaw/pitch. `back` runs from the pivot out to the camera.
    const cp = Math.cos(this.pitch);
    _back.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    // Kept level rather than rolled with pitch, so the shoulder offset does not
    // slide across the screen as you look up and down.
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    _off.copy(_back).multiplyScalar(arm).addScaledVector(_right, CAMERA.SHOULDER);
    const reach = _off.length() || 1e-4;
    _v3.copy(_off).divideScalar(reach); // spring-arm direction

    // Pull the whole arm in if a building is in the way — shoulder offset
    // included, otherwise the camera clips walls on its right.
    let allowed = reach;
    for (const [su, sv] of ARM_PROBES) {
      _probe.copy(_pivot).addScaledVector(_right, su);
      _probe.y += sv;
      const hit = this.world.raycast(_probe, _v3, reach + 1.4);
      if (hit) allowed = Math.min(allowed, Math.max(CAMERA.MIN_DISTANCE, hit.dist - 1.1));
    }
    if (allowed < reach) _off.multiplyScalar(allowed / reach);
    // Once the camera is right on top of the hero, hide the model so the view
    // is not filled with the inside of a shoulder.
    this.hero.root.visible = this.alive && allowed > CAMERA.HIDE_HERO;

    const want = _v2.copy(_pivot).add(_off);
    // Position is smoothed, rotation never is: a shoulder camera that lags the
    // mouse feels broken, while a little positional give hides physics noise.
    const k = 1 - Math.pow(2, -dt / CAMERA.FOLLOW_HALFLIFE);
    this.camPos.lerp(want, dead ? k * 0.5 : k);
    this.camEye.copy(this.camPos);
    this.camera.position.copy(this.camPos);

    // Look along the aim direction, not at the hero. The camera's forward
    // vector is then exactly the analytic look direction, so the crosshair and
    // the aim ray agree to the pixel.
    this.camLook.copy(this.camPos).add(this.lookDir(_look));
    this.camera.lookAt(this.camLook);

    // Speed FOV + a touch of shake. Kept subtle — a FOV that breathes hard on
    // every swing reads as the world lurching rather than as speed.
    const targetFov = CAMERA.FOV + THREE.MathUtils.clamp(
      (this.speed - CAMERA.FOV_SPEED_FROM) * CAMERA.FOV_SPEED_GAIN, 0, CAMERA.FOV_SPEED_MAX
    );
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    this.camera.fov = this.fov;
    if (this.shake > 0.001) {
      this.shake *= Math.pow(0.02, dt);
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.camera.updateProjectionMatrix();
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
