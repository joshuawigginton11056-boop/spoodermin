// Authoritative match server.
//
// Movement is client-simulated (so swinging feels instant) but the server owns
// everything that matters: health, web projectiles and their hits, the storm,
// eliminations and placements. Bots are simulated entirely here so a solo
// player still gets a full battle royale lobby.
//
// Bots are non-combatants: they wander, they run from the storm, and they can
// be webbed, but they never target anyone and never fire. That leaves the
// storm as the only thing that can decide a match, so it closes to nothing
// once the scripted phases run out.

import { COMBAT, MATCH, PHASE, PLAYER, SKINS, HERO_NAMES, STORM, CITY } from '../shared/constants.js';
import { generateCity, raycastCity, aabbContains } from '../shared/citygen.js';

const STATE = { IDLE: 0, RUN: 1, AIR: 2, SWING: 3, CLING: 4, ZIP: 5 };

let nextEntityId = 1;

/**
 * Closest approach between two segments, p0->p1 and q0->q1.
 * Returns the squared distance and how far along the first segment it happens.
 * Used to test a web ball's path for the tick against a player's hit capsule.
 */
function segmentClosest(p0, p1, q0, q1) {
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const vx = q1[0] - q0[0], vy = q1[1] - q0[1], vz = q1[2] - q0[2];
  const wx = p0[0] - q0[0], wy = p0[1] - q0[1], wz = p0[2] - q0[2];
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const det = a * c - b * b;
  const EPS = 1e-9;
  let sN, sD = det, tN, tD = det;

  if (det < EPS) { sN = 0; sD = 1; tN = e; tD = c; } // near parallel
  else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) { sN = 0; tN = e; tD = c; }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c; }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0;
    else if (-d > a) sN = sD;
    else { sN = -d; sD = a; }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0;
    else if (-d + b > a) sN = sD;
    else { sN = -d + b; sD = a; }
  }
  const s = Math.abs(sN) < EPS ? 0 : sN / sD;
  const t = Math.abs(tN) < EPS ? 0 : tN / tD;
  const dx = wx + s * ux - t * vx;
  const dy = wy + s * uy - t * vy;
  const dz = wz + s * uz - t * vz;
  return { d2: dx * dx + dy * dy + dz * dz, s };
}

export class Room {
  constructor(id = 'main') {
    this.id = id;
    this.players = new Map(); // id -> player
    this.projectiles = [];
    this.events = []; // flushed to clients every tick
    this.phase = PHASE.LOBBY;
    this.timer = 0;
    this.matchNumber = 0;
    this.seed = 0;
    this.city = null;
    this.storm = null;
    this.winner = null;
    this.lastTime = Date.now();
    this.newCity((Math.random() * 0xffffffff) >>> 0);
  }

  // ------------------------------------------------------------------ setup
  newCity(seed) {
    this.seed = seed >>> 0;
    this.city = generateCity(this.seed);
  }

  freeSkin() {
    const used = new Set([...this.players.values()].map((p) => p.skin));
    for (let i = 0; i < SKINS.length; i++) if (!used.has(i)) return i;
    return Math.floor(Math.random() * SKINS.length);
  }

  freeName() {
    const used = new Set([...this.players.values()].map((p) => p.name));
    const pool = HERO_NAMES.filter((n) => !used.has(n));
    const base = pool.length ? pool[Math.floor(Math.random() * pool.length)] : HERO_NAMES[0];
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}${n++}`;
    return name;
  }

  makePlayer({ isBot = false, name = null, socket = null }) {
    const id = nextEntityId++;
    const p = {
      id,
      name: (name || '').trim().slice(0, 14) || this.freeName(),
      isBot,
      socket,
      skin: this.freeSkin(),
      hp: COMBAT.MAX_HEALTH,
      fluid: COMBAT.FLUID_MAX,
      alive: false,
      spectating: true,
      pos: [0, MATCH.SPAWN_HEIGHT, 0],
      vel: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      state: STATE.IDLE,
      anchor: null, // web anchor point for swing rendering
      kills: 0,
      damage: 0,
      placement: 0,
      lastShot: -99,
      slowUntil: 0,
      lastSeen: Date.now(),
      hist: [], // recent positions, for rewinding shots (see histPos)
      // bot brain — no target, because bots do not fight
      bot: isBot ? { think: 0, wander: [0, 0, 0], jumpAt: 0 } : null,
    };
    this.players.set(id, p);
    return p;
  }

  addSocketPlayer(socket, name) {
    const p = this.makePlayer({ isBot: false, name, socket });
    if (this.phase === PHASE.PLAYING) this.spawn(p); // drop-ins are allowed, it's arcade
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.phase === PHASE.PLAYING) this.checkMatchOver();
  }

  humans() {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  // ------------------------------------------------------------ match flow
  fillBots() {
    const target = Math.min(MATCH.BOT_FILL + 1, MATCH.MAX_PLAYERS);
    const humanCount = this.humans().length;
    let want = Math.max(0, target - humanCount);
    const bots = [...this.players.values()].filter((p) => p.isBot);
    while (bots.length > want) this.players.delete(bots.pop().id);
    while (bots.length < want) bots.push(this.makePlayer({ isBot: true }));
  }

  dropBots() {
    for (const p of [...this.players.values()]) if (p.isBot) this.players.delete(p.id);
  }

  pickSpawn() {
    let pool = this.city.spawns;
    // Late joiners must land inside the current safe zone — dropping someone
    // into the storm during the final circle is not a game, it is an execution.
    if (this.storm) {
      const inside = pool.filter(
        (p) => Math.hypot(p.x - this.storm.cx, p.z - this.storm.cz) < this.storm.radius * 0.75
      );
      if (inside.length) pool = inside;
    }
    const p = pool[Math.floor(Math.random() * pool.length)];
    return [p.x + (Math.random() - 0.5) * 4, p.y + MATCH.SPAWN_HEIGHT, p.z + (Math.random() - 0.5) * 4];
  }

  spawn(p) {
    p.pos = this.pickSpawn();
    p.vel = [0, 0, 0];
    p.hist.length = 0; // no rewinding to where they stood last life
    p.hp = COMBAT.MAX_HEALTH;
    p.fluid = COMBAT.FLUID_MAX;
    p.alive = true;
    p.spectating = false;
    p.state = STATE.AIR;
    p.placement = 0;
    p.kills = 0;
    p.damage = 0;
    p.yaw = Math.random() * Math.PI * 2;
    if (p.socket) this.send(p, { t: 'spawn', pos: p.pos });
  }

  startMatch() {
    this.matchNumber++;
    this.newCity((Math.random() * 0xffffffff) >>> 0);
    this.fillBots();
    this.projectiles.length = 0;

    const half = CITY.HALF;
    this.storm = {
      cx: (Math.random() - 0.5) * half * 0.55,
      cz: (Math.random() - 0.5) * half * 0.55,
      radius: half * 1.12,
      targetRadius: half * 1.12,
      startRadius: half * 1.12,
      phaseIndex: -1,
      mode: 'hold',
      timeLeft: 12,
      damage: STORM.DAMAGE_START,
      collapsing: false,
    };
    for (const p of this.players.values()) this.spawn(p);
    this.phase = PHASE.PLAYING;
    this.winner = null;
    this.broadcast({
      t: 'matchStart',
      seed: this.seed,
      match: this.matchNumber,
      storm: this.stormPacket(),
      players: this.rosterPacket(),
    });
  }

  endMatch(winner) {
    this.phase = PHASE.ENDED;
    this.timer = MATCH.END_SCREEN;
    this.winner = winner ? { id: winner.id, name: winner.name, skin: winner.skin, isBot: winner.isBot } : null;

    // Anyone still standing when the match is called shares the top of the
    // table: the winner takes #1, the rest are ranked behind them by kills.
    const survivors = this.alivePlayers().sort((a, b) => {
      if (a === winner) return -1;
      if (b === winner) return 1;
      return b.kills - a.kills || b.damage - a.damage;
    });
    survivors.forEach((p, i) => { p.placement = i + 1; });

    const board = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, skin: p.skin, kills: p.kills, placement: p.placement || this.players.size, bot: p.isBot }))
      .sort((a, b) => a.placement - b.placement || b.kills - a.kills);
    this.broadcast({ t: 'matchEnd', winner: this.winner, board });
  }

  checkMatchOver() {
    if (this.phase !== PHASE.PLAYING) return;
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.endMatch(alive[0] || null);
      return;
    }
    // If every human is out, wrap it up quickly rather than making them watch
    // bots duel for two minutes.
    const humansAlive = alive.some((p) => !p.isBot);
    if (!humansAlive && this.humans().length > 0) {
      this.timer = Math.min(this.timer || 4, 4);
      this.pendingWrap = true;
    }
  }

  // ---------------------------------------------------------------- storm
  stormPacket() {
    const s = this.storm;
    if (!s) return null;
    return {
      cx: +s.cx.toFixed(2), cz: +s.cz.toFixed(2),
      r: +s.radius.toFixed(2), tr: +s.targetRadius.toFixed(2),
      mode: s.mode, left: +s.timeLeft.toFixed(1), dmg: +s.damage.toFixed(1),
      phase: Math.min(s.phaseIndex + 1, STORM.PHASES.length), total: STORM.PHASES.length,
    };
  }

  updateStorm(dt) {
    const s = this.storm;
    if (!s) return;
    s.timeLeft -= dt;
    if (s.mode === 'shrink') {
      const span = Math.max(0.001, s.shrinkTime);
      const k = 1 - Math.max(0, s.timeLeft) / span;
      s.radius = s.startRadius + (s.targetRadius - s.startRadius) * Math.min(1, k);
    }
    if (s.timeLeft <= 0) {
      if (s.mode === 'hold') {
        const next = STORM.PHASES[s.phaseIndex + 1];
        if (!next) { this.beginFinalCollapse(s); return; }
        s.mode = 'shrink';
        s.startRadius = s.radius;
        s.targetRadius = CITY.HALF * 1.12 * next.radius;
        s.timeLeft = next.shrink;
        s.shrinkTime = next.shrink;
        s.phaseIndex++;
        s.damage = STORM.DAMAGE_START + STORM.DAMAGE_RAMP * (s.phaseIndex + 1);
        // Drift the safe zone a little so nobody camps one rooftop forever.
        const drift = (s.startRadius - s.targetRadius) * 0.45;
        s.cx += (Math.random() - 0.5) * drift;
        s.cz += (Math.random() - 0.5) * drift;
        this.broadcast({ t: 'storm', storm: this.stormPacket(), warn: 'shrinking' });
      } else if (s.mode === 'shrink') {
        s.radius = s.targetRadius;
        const next = STORM.PHASES[s.phaseIndex + 1];
        // The last phase used to settle into a 9999-second hold, which is how a
        // final circle nobody can be pushed out of lasts forever.
        if (!next && !s.collapsing) { this.beginFinalCollapse(s); return; }
        s.mode = 'hold';
        s.timeLeft = next ? next.hold : 9999;
        this.broadcast({ t: 'storm', storm: this.stormPacket(), warn: 'stable' });
      }
    }
  }

  /**
   * Closes the safe zone to nothing after the last scripted phase. With nobody
   * shooting back, the storm is the only thing left that can decide a match, so
   * it has to actually finish the job.
   */
  beginFinalCollapse(s) {
    if (s.collapsing) return;
    s.collapsing = true;
    s.mode = 'shrink';
    s.startRadius = s.radius;
    s.targetRadius = 0;
    s.timeLeft = STORM.FINAL_COLLAPSE;
    s.shrinkTime = STORM.FINAL_COLLAPSE;
    s.damage = STORM.DAMAGE_START + STORM.DAMAGE_RAMP * (STORM.PHASES.length + 1);
    this.broadcast({ t: 'storm', storm: this.stormPacket(), warn: 'shrinking' });
  }

  // ------------------------------------------------------------- shooting
  /** Remember where everyone is, so a client's shot can be judged against the
   *  world as that client saw it rather than the world a fifth of a second on. */
  recordHistory() {
    for (const p of this.players.values()) {
      p.hist.push({ t: this.now, x: p.pos[0], y: p.pos[1], z: p.pos[2] });
      while (p.hist.length > 2 && this.now - p.hist[0].t > COMBAT.LAG_COMP_MAX + 0.5) p.hist.shift();
      if (p.hist.length > 64) p.hist.shift();
    }
  }

  /** Where `p` was at time `t`, interpolated between recorded samples. */
  histPos(p, t, out) {
    const h = p.hist;
    if (!h.length) { out[0] = p.pos[0]; out[1] = p.pos[1]; out[2] = p.pos[2]; return out; }
    const last = h[h.length - 1];
    if (t >= last.t) { out[0] = p.pos[0]; out[1] = p.pos[1]; out[2] = p.pos[2]; return out; }
    if (t <= h[0].t) { out[0] = h[0].x; out[1] = h[0].y; out[2] = h[0].z; return out; }
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      if (a.t > t) continue;
      const b = h[i];
      const k = (t - a.t) / Math.max(1e-4, b.t - a.t);
      out[0] = a.x + (b.x - a.x) * k;
      out[1] = a.y + (b.y - a.y) * k;
      out[2] = a.z + (b.z - a.z) * k;
      return out;
    }
    out[0] = last.x; out[1] = last.y; out[2] = last.z;
    return out;
  }

  handleShoot(p, origin, dir, rewind = 0) {
    const now = this.now;
    if (!p.alive) return;
    if (now - p.lastShot < COMBAT.FIRE_COOLDOWN) return;
    if (p.fluid < COMBAT.FLUID_PER_SHOT) return;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    // Trust the client's muzzle only if it is plausibly near its own body.
    const dx = origin[0] - p.pos[0];
    const dy = origin[1] - p.pos[1];
    const dz = origin[2] - p.pos[2];
    if (Math.hypot(dx, dy, dz) > 6) {
      origin = [p.pos[0], p.pos[1] + PLAYER.EYE * 0.75, p.pos[2]];
    }
    p.lastShot = now;
    p.fluid -= COMBAT.FLUID_PER_SHOT;
    // The ball is simulated `lag` seconds behind wall clock for its whole
    // flight, so every frame of it is tested against the world the shooter was
    // looking at.
    const lag = Math.min(COMBAT.LAG_COMP_MAX, Math.max(0, Number(rewind) || 0));
    const proj = {
      id: nextEntityId++,
      owner: p.id,
      pos: [origin[0], origin[1], origin[2]],
      vel: [d[0] * COMBAT.SHOT_SPEED, d[1] * COMBAT.SHOT_SPEED, d[2] * COMBAT.SHOT_SPEED],
      life: COMBAT.PROJECTILE_LIFE,
      time: now - lag,
    };
    this.projectiles.push(proj);
    this.events.push({
      t: 'shot', id: proj.id, owner: p.id,
      o: proj.pos.map((v) => +v.toFixed(2)),
      v: proj.vel.map((v) => +v.toFixed(2)),
    });
  }

  updateProjectiles(dt) {
    const keep = [];
    const from = [0, 0, 0];
    const to = [0, 0, 0];
    const cap0 = [0, 0, 0];
    const cap1 = [0, 0, 0];
    const at = [0, 0, 0];
    const reach = COMBAT.HIT_RADIUS + COMBAT.SHOT_RADIUS;
    for (const pr of this.projectiles) {
      pr.life -= dt;
      if (pr.life <= 0) { this.events.push({ t: 'despawn', id: pr.id }); continue; }
      // Substep so fast web balls cannot tunnel through thin players.
      const steps = 3;
      const h = dt / steps;
      let dead = false;
      for (let s = 0; s < steps && !dead; s++) {
        pr.vel[1] -= COMBAT.SHOT_GRAVITY * h;
        pr.time += h;
        const nx = pr.pos[0] + pr.vel[0] * h;
        const ny = pr.pos[1] + pr.vel[1] * h;
        const nz = pr.pos[2] + pr.vel[2] * h;

        // Players first: sweep this substep's whole path against each hero's
        // hit capsule, at the moment in time this ball is judging. Sampling
        // points instead let a 140m/s ball step clean through someone.
        from[0] = pr.pos[0]; from[1] = pr.pos[1]; from[2] = pr.pos[2];
        to[0] = nx; to[1] = ny; to[2] = nz;
        let victim = null;
        let victimAt = 2;
        for (const p of this.players.values()) {
          if (!p.alive || p.id === pr.owner) continue;
          this.histPos(p, pr.time, at);
          cap0[0] = at[0]; cap0[1] = at[1] + COMBAT.HIT_LOW; cap0[2] = at[2];
          cap1[0] = at[0]; cap1[1] = at[1] + COMBAT.HIT_HIGH; cap1[2] = at[2];
          const near = segmentClosest(from, to, cap0, cap1);
          // Whoever the ball reaches first along its path takes it.
          if (near.d2 < reach * reach && near.s < victimAt) { victimAt = near.s; victim = p; }
        }
        if (victim) {
          const ix = from[0] + (to[0] - from[0]) * victimAt;
          const iy = from[1] + (to[1] - from[1]) * victimAt;
          const iz = from[2] + (to[2] - from[2]) * victimAt;
          this.damagePlayer(victim, this.players.get(pr.owner) || null, COMBAT.SHOT_DAMAGE, [ix, iy, iz]);
          this.events.push({ t: 'splat', id: pr.id, p: [+ix.toFixed(2), +iy.toFixed(2), +iz.toFixed(2)], hit: victim.id });
          dead = true;
          break;
        }

        // Then the city.
        if (ny <= 0.2) {
          this.events.push({ t: 'splat', id: pr.id, p: [+nx.toFixed(2), 0.2, +nz.toFixed(2)], hit: 0 });
          dead = true;
          break;
        }
        let blocked = false;
        for (const b of this.city.colliders) {
          if (aabbContains(b, nx, ny, nz, COMBAT.SHOT_RADIUS)) { blocked = true; break; }
        }
        if (blocked) {
          this.events.push({ t: 'splat', id: pr.id, p: [+nx.toFixed(2), +ny.toFixed(2), +nz.toFixed(2)], hit: 0 });
          dead = true;
          break;
        }
        pr.pos[0] = nx; pr.pos[1] = ny; pr.pos[2] = nz;
      }
      if (!dead) keep.push(pr);
    }
    this.projectiles = keep;
  }

  damagePlayer(victim, attacker, amount, at) {
    if (!victim.alive) return;
    victim.hp -= amount;
    victim.slowUntil = this.now + COMBAT.IMPACT_SLOW_TIME;
    if (attacker) attacker.damage += amount;
    this.send(victim, { t: 'hurt', by: attacker ? attacker.id : 0, hp: Math.max(0, victim.hp), at });
    if (attacker && attacker.socket) this.send(attacker, { t: 'hitmark', target: victim.id, hp: Math.max(0, victim.hp) });
    if (victim.hp <= 0) this.eliminate(victim, attacker);
  }

  eliminate(victim, attacker) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.spectating = true;
    victim.state = STATE.IDLE;
    victim.placement = this.alivePlayers().length + 1;
    if (attacker && attacker !== victim) attacker.kills++;
    this.broadcast({
      t: 'kill',
      killer: attacker ? { id: attacker.id, name: attacker.name } : null,
      victim: { id: victim.id, name: victim.name },
      placement: victim.placement,
      at: victim.pos.map((v) => +v.toFixed(2)),
    });
    this.send(victim, { t: 'died', placement: victim.placement, kills: victim.kills, by: attacker ? attacker.name : 'the storm' });
    this.checkMatchOver();
  }

  // ------------------------------------------------------------------ bots
  groundHeight(x, z, fromY = 400) {
    const hit = raycastCity(this.city.colliders, [x, fromY, z], [0, -1, 0], fromY + 5);
    return hit ? hit.point[1] : 0;
  }

  /** Somewhere inside the safe zone for a bot to head towards next. */
  pickWander(b) {
    const s = this.storm;
    const ang = Math.random() * Math.PI * 2;
    const rr = (s ? s.radius : CITY.HALF) * 0.75 * Math.random();
    const cx = s ? s.cx : 0;
    const cz = s ? s.cz : 0;
    b.wander = [cx + Math.cos(ang) * rr, 0, cz + Math.sin(ang) * rr];
  }

  updateBot(p, dt) {
    const b = p.bot;
    b.think -= dt;
    const s = this.storm;

    const distToCentre = s ? Math.hypot(p.pos[0] - s.cx, p.pos[2] - s.cz) : 0;
    const outside = s && distToCentre > s.radius - 12;

    // Bots do not fight. They wander the city and run for the safe zone; they
    // never pick a target and never shoot, so the only things that can hurt a
    // player are the storm and another human.
    const arrived = Math.hypot(b.wander[0] - p.pos[0], b.wander[2] - p.pos[2]) < 8;
    if (b.think <= 0 || arrived) {
      b.think = 2.5 + Math.random() * 3;
      this.pickWander(b);
    }

    const goal = outside ? [s.cx, 0, s.cz] : b.wander;

    let gx = goal[0] - p.pos[0];
    let gz = goal[2] - p.pos[2];
    const gd = Math.hypot(gx, gz) || 1;
    gx /= gd; gz /= gd;

    const speed = PLAYER.WALK * (outside ? 1.35 : 1.0);
    p.yaw = Math.atan2(gx, gz);

    const slow = this.now < p.slowUntil ? COMBAT.IMPACT_SLOW : 1;
    p.vel[0] += gx * speed * slow * dt * 6;
    p.vel[2] += gz * speed * slow * dt * 6;
    const hs = Math.hypot(p.vel[0], p.vel[2]);
    const max = speed * slow;
    if (hs > max) { p.vel[0] *= max / hs; p.vel[2] *= max / hs; }

    // Gravity + very simple grounding.
    p.vel[1] -= (p.grounded ? 0 : 1) * 30 * dt;
    if (p.vel[1] < -PLAYER.MAX_FALL) p.vel[1] = -PLAYER.MAX_FALL;

    let nx = p.pos[0] + p.vel[0] * dt;
    let ny = p.pos[1] + p.vel[1] * dt;
    let nz = p.pos[2] + p.vel[2] * dt;

    // Push out of any building we ended up inside of (gives wall sliding).
    for (const bx of this.city.colliders) {
      if (!aabbContains(bx, nx, ny + PLAYER.HEIGHT * 0.5, nz, PLAYER.RADIUS)) continue;
      const px = bx.hw + PLAYER.RADIUS - Math.abs(nx - bx.x);
      const pz = bx.hd + PLAYER.RADIUS - Math.abs(nz - bx.z);
      const py = bx.hh + PLAYER.HEIGHT * 0.5 - Math.abs(ny + PLAYER.HEIGHT * 0.5 - bx.y);
      if (py <= px && py <= pz) {
        if (ny + PLAYER.HEIGHT * 0.5 > bx.y) { ny = bx.y + bx.hh; p.vel[1] = 0; p.grounded = true; }
        else { ny = bx.y - bx.hh - PLAYER.HEIGHT; p.vel[1] = Math.min(0, p.vel[1]); }
      } else if (px < pz) {
        nx += Math.sign(nx - bx.x) * px;
        p.vel[0] = 0;
        if (this.now > b.jumpAt) { p.vel[1] = PLAYER.JUMP; b.jumpAt = this.now + 1.2; p.grounded = false; }
      } else {
        nz += Math.sign(nz - bx.z) * pz;
        p.vel[2] = 0;
        if (this.now > b.jumpAt) { p.vel[1] = PLAYER.JUMP; b.jumpAt = this.now + 1.2; p.grounded = false; }
      }
    }

    if (ny <= 0) { ny = 0; p.vel[1] = 0; p.grounded = true; }
    else {
      const gh = this.groundHeight(nx, nz, ny + PLAYER.HEIGHT);
      if (ny <= gh + 0.05 && p.vel[1] <= 0) { ny = gh; p.vel[1] = 0; p.grounded = true; }
      else p.grounded = false;
    }

    p.pos[0] = nx; p.pos[1] = ny; p.pos[2] = nz;
    p.state = !p.grounded ? STATE.AIR : (Math.hypot(p.vel[0], p.vel[2]) > 1.5 ? STATE.RUN : STATE.IDLE);
  }

  // ------------------------------------------------------------------ loop
  tick() {
    const t = Date.now();
    let dt = (t - this.lastTime) / 1000;
    this.lastTime = t;
    if (dt > 0.25) dt = 0.25;
    this.now = t / 1000;

    switch (this.phase) {
      case PHASE.LOBBY: {
        const humans = this.humans().length;
        if (humans >= 1) {
          this.timer -= dt;
          if (this.timer <= 0) { this.phase = PHASE.COUNTDOWN; this.timer = MATCH.COUNTDOWN; }
        } else {
          this.timer = MATCH.LOBBY_WAIT;
          this.dropBots();
        }
        break;
      }
      case PHASE.COUNTDOWN: {
        this.timer -= dt;
        if (this.timer <= 0) this.startMatch();
        break;
      }
      case PHASE.PLAYING: {
        this.updateStorm(dt);
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          p.fluid = Math.min(COMBAT.FLUID_MAX, p.fluid + COMBAT.FLUID_REGEN * dt);
          if (p.isBot) this.updateBot(p, dt);
          // Storm damage.
          const s = this.storm;
          if (s) {
            const d = Math.hypot(p.pos[0] - s.cx, p.pos[2] - s.cz);
            if (d > s.radius) this.damagePlayer(p, null, s.damage * dt, p.pos);
          }
          // Fell out of the world somehow.
          if (p.pos[1] < -60) this.damagePlayer(p, null, 999, p.pos);
        }
        // Logged after everyone has moved and before any ball is stepped, so
        // the newest sample is the truth this tick.
        this.recordHistory();
        this.updateProjectiles(dt);
        if (this.pendingWrap) {
          this.timer -= dt;
          if (this.timer <= 0) {
            this.pendingWrap = false;
            const alive = this.alivePlayers().sort((a, b) => b.kills - a.kills);
            this.endMatch(alive[0] || null);
          }
        }
        break;
      }
      case PHASE.ENDED: {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.projectiles.length = 0;
          this.pendingWrap = false;
          for (const p of this.players.values()) { p.alive = false; p.spectating = true; }
          this.phase = PHASE.LOBBY;
          this.timer = MATCH.LOBBY_WAIT;
          this.fillBots();
          this.broadcast({ t: 'lobby', players: this.rosterPacket() });
        }
        break;
      }
    }

    this.broadcastSnapshot();
  }

  // -------------------------------------------------------------- networking
  rosterPacket() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, skin: p.skin, bot: p.isBot,
    }));
  }

  snapshot() {
    const ps = [];
    for (const p of this.players.values()) {
      ps.push({
        i: p.id,
        p: [+p.pos[0].toFixed(2), +p.pos[1].toFixed(2), +p.pos[2].toFixed(2)],
        y: +p.yaw.toFixed(3),
        h: +p.pitch.toFixed(3),
        s: p.state,
        v: [+p.vel[0].toFixed(1), +p.vel[1].toFixed(1), +p.vel[2].toFixed(1)],
        hp: Math.max(0, Math.round(p.hp)),
        f: Math.round(p.fluid),
        a: p.alive ? 1 : 0,
        k: p.kills,
        n: p.name,
        c: p.skin,
        b: p.isBot ? 1 : 0,
        w: p.anchor ? p.anchor.map((v) => +v.toFixed(1)) : null,
      });
    }
    return {
      t: 'state',
      time: +(this.now || 0).toFixed(2),
      phase: this.phase,
      timer: +Math.max(0, this.timer).toFixed(1),
      alive: this.alivePlayers().length,
      total: this.players.size,
      storm: this.phase === PHASE.PLAYING ? this.stormPacket() : null,
      players: ps,
      events: this.events,
    };
  }

  broadcastSnapshot() {
    const snap = this.snapshot();
    const msg = JSON.stringify(snap);
    for (const p of this.players.values()) {
      if (p.socket && p.socket.readyState === 1) p.socket.send(msg);
    }
    this.events = [];
  }

  send(p, obj) {
    if (p.socket && p.socket.readyState === 1) p.socket.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.socket && p.socket.readyState === 1) p.socket.send(msg);
    }
  }

  // ------------------------------------------------------- client messages
  onMessage(p, msg) {
    switch (msg.t) {
      case 'input': {
        if (!p.alive) return;
        if (Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(Number.isFinite)) {
          p.pos[0] = msg.p[0]; p.pos[1] = msg.p[1]; p.pos[2] = msg.p[2];
        }
        if (Array.isArray(msg.v) && msg.v.length === 3 && msg.v.every(Number.isFinite)) {
          p.vel[0] = msg.v[0]; p.vel[1] = msg.v[1]; p.vel[2] = msg.v[2];
        }
        if (Number.isFinite(msg.y)) p.yaw = msg.y;
        if (Number.isFinite(msg.h)) p.pitch = msg.h;
        if (Number.isFinite(msg.s)) p.state = msg.s | 0;
        p.anchor = Array.isArray(msg.w) && msg.w.length === 3 ? msg.w : null;
        p.lastSeen = Date.now();
        break;
      }
      case 'shoot':
        if (Array.isArray(msg.o) && Array.isArray(msg.d)) this.handleShoot(p, msg.o, msg.d, msg.r);
        break;
      case 'zip':
        if (p.alive && p.fluid >= COMBAT.FLUID_PER_ZIP) p.fluid -= COMBAT.FLUID_PER_ZIP;
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 90);
        if (text) this.broadcast({ t: 'chat', from: p.name, skin: p.skin, text });
        break;
      }
      case 'ping':
        this.send(p, { t: 'pong', c: msg.c });
        break;
    }
  }

  welcomePacket(p) {
    return {
      t: 'welcome',
      id: p.id,
      name: p.name,
      skin: p.skin,
      seed: this.seed,
      phase: this.phase,
      timer: +Math.max(0, this.timer).toFixed(1),
      players: this.rosterPacket(),
      storm: this.phase === PHASE.PLAYING ? this.stormPacket() : null,
      alive: p.alive,
      pos: p.pos,
    };
  }
}

export { STATE };
