// Local player: movement, web-swinging, wall-crawling, zipping, aiming and the
// third-person camera. This is where the game feel lives.

import * as THREE from 'three';
import { PLAYER, GRAVITY, WEB, COMBAT, CITY } from '/shared/constants.js';
import { Hero } from '../entities/hero.js';

export const STATE = { IDLE: 0, RUN: 1, AIR: 2, SWING: 3, CLING: 4, ZIP: 5 };

const CAM_DISTANCES = [9.5, 14, 6];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _probeFrom = new THREE.Vector3();
const _probeDir = new THREE.Vector3();

// Look sensitivity, radians per mouse pixel.
const LOOK_SENS = 0.0022;
// A dropped frame or an alt-tab can deliver a huge accumulated delta; cap it
// so a hiccup never whips the view around.
const MAX_LOOK_STEP = 600;

// Camera boom probes: centre, plus four offsets so the camera does not slice
// through corners and railings.
const CAM_PROBES = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.55], [0, -0.55]];

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
    this.swingSide = 1;
    this.swingTime = 0;
    this.zipTarget = null;
    this.zipTime = 0;
    this.clingNormal = null;

    this.camDist = 0;
    this.camBoom = CAM_DISTANCES[0]; // current boom length, the only damped part
    this.camPos = new THREE.Vector3(0, 70, 20);
    this.camLook = new THREE.Vector3();
    this.fov = 70;
    this.shake = 0;

    this.aimPoint = new THREE.Vector3();
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
    this.camBoom = CAM_DISTANCES[this.camDist];
    this.camPos.copy(this.pos).add(new THREE.Vector3(0, 6, 12));
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
    const dir = this.lookDir(_v3).clone();
    const from = this.eye(_v2).clone();
    const hit = this.world.raycast(from, dir, 400);
    if (hit) this.aimPoint.copy(hit.point);
    else this.aimPoint.copy(from).addScaledVector(dir, 400);
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
    this.ropeLen = Math.max(WEB.MIN_LENGTH, this.pos.distanceTo(a) * 0.98);
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
    const dir = this.lookDir(_v3).clone();
    const hit = this.world.raycast(this.eye(_v2).clone(), dir, WEB.MAX_LENGTH * 1.6);
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
    // Aim the ball at whatever the crosshair is over, not just straight ahead,
    // so close-range shots do not fly wide of the reticle.
    const dir = _v.copy(this.aimPoint).sub(muzzle).normalize().clone();
    this.onShoot?.(muzzle, dir);
    // Light: recoil shake is world-space camera jitter, so a heavy one throws
    // off the very reticle you are trying to hold on a target.
    this.shake = Math.min(0.26, this.shake + 0.055);
  }

  // ------------------------------------------------------------- the loop
  update(dt) {
    const input = this.input;
    const m = input.mouse;

    // ---- look
    // Positive pitch parks the camera above the hero, i.e. looking down.
    const dx = THREE.MathUtils.clamp(m.dx, -MAX_LOOK_STEP, MAX_LOOK_STEP);
    const dy = THREE.MathUtils.clamp(m.dy, -MAX_LOOK_STEP, MAX_LOOK_STEP);
    this.yaw -= dx * LOOK_SENS;
    this.pitch += dy * LOOK_SENS;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.15, 1.25);
    if (input.hit('KeyV')) this.camDist = (this.camDist + 1) % CAM_DISTANCES.length;

    if (!this.alive) {
      this.updateCamera(dt);
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
    this.updateCamera(dt);
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
    const toAnchor = _v.copy(this.anchor).sub(this.pos);
    const dist = toAnchor.length();
    toAnchor.divideScalar(dist || 1);
    if (wx || wz) {
      const wish = _v2.set(wx, 0, wz);
      // Remove the component pointing along the rope so we do not fight it.
      wish.addScaledVector(toAnchor, -wish.dot(toAnchor));
      this.vel.addScaledVector(wish, WEB.SWING_ACCEL * dt);
    }

    // Reel in for altitude / speed.
    if (this.input.down('KeyC') || this.input.down('KeyW')) {
      this.ropeLen = Math.max(WEB.MIN_LENGTH, this.ropeLen - WEB.REEL_SPEED * dt);
    }
    if (this.input.down('KeyS')) {
      this.ropeLen = Math.min(WEB.MAX_LENGTH, this.ropeLen + WEB.REEL_SPEED * dt);
    }

    // Rope constraint, applied after gravity: pull back to the sphere surface
    // and kill only the outward radial velocity (classic pendulum).
    const next = _v3.copy(this.pos).addScaledVector(this.vel, dt);
    const d = next.distanceTo(this.anchor);
    if (d > this.ropeLen) {
      const dir = next.sub(this.anchor).divideScalar(d || 1);
      const target = _v2.copy(this.anchor).addScaledVector(dir, this.ropeLen);
      // Correct position implicitly by adjusting velocity toward the target.
      this.vel.copy(target.sub(this.pos).divideScalar(dt));
      // Small tangential energy gain makes long swings feel powerful.
      this.vel.multiplyScalar(1.004);
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

  updateCamera(dt) {
    const targetDist = CAM_DISTANCES[this.camDist];
    // The orbit pivot is the head itself, with nothing smoothing it. Easing the
    // camera's *position* towards where the yaw/pitch want it — the old
    // behaviour — is what made the world slide out from under a crosshair that
    // is nailed to the middle of the screen: the view kept swinging for a
    // couple of hundred milliseconds after the mouse had stopped. Rotation is
    // now rigid, and only the boom length is damped.
    const pivot = _v.copy(this.pos);
    pivot.y += PLAYER.EYE;

    const dir = _v2.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );

    // Pull the camera in if a building is in the way.
    let dist = targetDist;
    const side = _v3.set(dir.z, 0, -dir.x).normalize();
    _probeDir.copy(dir);
    for (const [su, sv] of CAM_PROBES) {
      _probeFrom.copy(pivot).addScaledVector(side, su);
      _probeFrom.y += sv;
      const hit = this.world.raycast(_probeFrom, _probeDir, targetDist + 1.4);
      if (hit) dist = Math.min(dist, Math.max(2.6, hit.dist - 1.1));
    }
    // Snap in the instant something is in the way — clipping through a wall is
    // worse than a hard cut — and ease back out once it is clear.
    if (dist < this.camBoom) this.camBoom = dist;
    else this.camBoom += (dist - this.camBoom) * (1 - Math.exp(-dt / 0.22));

    // Once the camera is right on top of the hero, hide the model so the view
    // is not filled with the inside of a shoulder.
    this.hero.root.visible = this.alive && this.camBoom > 3.4;

    this.camPos.copy(pivot).addScaledVector(dir, this.camBoom);
    this.camera.position.copy(this.camPos);

    // Look back down the same axis we orbited on, so the camera's forward
    // vector is exactly the analytic look direction the crosshair is built
    // from — the reticle and the shot always agree.
    this.camLook.copy(pivot);
    this.camera.lookAt(this.camLook);

    // Speed FOV + a touch of shake. Kept modest: a wide FOV punch is its own
    // kind of drift, warping the edges of the frame while you are trying to
    // track something with a fixed reticle.
    const targetFov = 70 + THREE.MathUtils.clamp((this.speed - 22) * 0.4, 0, 13);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt / 0.35));
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
