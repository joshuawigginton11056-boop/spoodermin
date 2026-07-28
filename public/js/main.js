// Boot, wire everything together, run the frame loop.

import * as THREE from 'three';
import { PHASE, CITY, COMBAT, TICK_RATE } from '/shared/constants.js';
import { City } from './world/city.js';
import { buildSky } from './world/sky.js';
import { StormWall } from './world/storm.js';
import { WorldCollision } from './player/physics.js';
import { Input } from './player/input.js';
import { LocalPlayer, STATE } from './player/controller.js';
import { RemoteManager } from './entities/remote.js';
import { Effects } from './combat/effects.js';
import { createTransport, MULTIPLAYER } from './transport.js';
import { UI } from './ui.js';

const canvas = document.getElementById('scene');
const ui = new UI();

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;

// ------------------------------------------------------- adaptive quality
// A skyline this size is fill-rate bound long before it is CPU bound, and a
// high-DPI screen quietly asks for four times the pixels. Rather than pick one
// setting and hope, the game watches its own frame time and moves between
// these tiers — the point is a steady frame rate, which reads as "smooth" far
// more than any single effect does.
const MAX_DPR = Math.min(devicePixelRatio || 1, 2);
const QUALITY = [
  { name: 'low', dpr: 0.7, shadow: 0, heroShadowDist: 0 },
  { name: 'medium', dpr: 1.0, shadow: 1, heroShadowDist: 45 },
  { name: 'high', dpr: 1.25, shadow: 2, heroShadowDist: 90 },
  { name: 'ultra', dpr: 1.5, shadow: 3, heroShadowDist: 160 },
];
let quality = 2;
let appliedDpr = 0;

function applyQuality(level, skyRig) {
  quality = THREE.MathUtils.clamp(level, 0, QUALITY.length - 1);
  const q = QUALITY[quality];
  const dpr = Math.min(MAX_DPR, q.dpr);
  // setPixelRatio reallocates the drawing buffer, so only when it moves.
  if (dpr !== appliedDpr) {
    appliedDpr = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight);
  }
  renderer.shadowMap.enabled = q.shadow > 0;
  skyRig?.setShadowQuality(q.shadow);
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.25, CITY.SIZE * 4);
camera.position.set(0, 80, 60);

const sky = buildSky(scene, 1);
const stormWall = new StormWall(scene);
const effects = new Effects(scene);
const remotes = new RemoteManager(scene);
const input = new Input(canvas);
const net = createTransport();

applyQuality(quality, sky);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// A refused pointer lock is expected in some embeddings and is handled by the
// input layer's cursor-steering fallback — it must never look like a crash.
const isPointerLockNoise = (text) => /pointer\s*lock/i.test(text || '');

addEventListener('error', (e) => {
  if (isPointerLockNoise(e.message)) return;
  ui.fatal(`${e.message}\n${e.filename}:${e.lineno}`);
});
addEventListener('unhandledrejection', (e) => {
  const text = String(e.reason?.stack || e.reason || '');
  if (isPointerLockNoise(text) || isPointerLockNoise(e.reason?.message)) {
    e.preventDefault();
    input.useFreeLook();
    return;
  }
  ui.fatal(text);
});

// ------------------------------------------------------------------- state
const game = {
  city: null,
  world: null,
  player: null,
  myId: 0,
  mySkin: 0,
  myName: '',
  phase: PHASE.LOBBY,
  timer: 0,
  storm: null,
  alive: 0,
  total: 0,
  kills: 0,
  roster: [],
  started: false,
  lastSend: 0,
  spectateId: 0,
  deadInfo: null,
  serverTime: 0,
  scoreRows: [],
};

function buildCity(seed) {
  if (game.city) {
    scene.remove(game.city.group);
    game.city.dispose();
  }
  game.city = new City(seed);
  scene.add(game.city.group);
  game.world = new WorldCollision(game.city.colliders);
  if (game.player) game.player.setWorld(game.world);
}

// -------------------------------------------------------------- networking
function connect() {
  const name = ui.el.nameInput.value.trim();
  try { localStorage.setItem('spoodermin.name', name); } catch { /* sandboxed iframe */ }
  ui.el.playBtn.disabled = true;
  ui.status('connecting…');

  net.connect(name)
    .then((welcome) => {
      ui.status(`connected as ${welcome.name}`, 'ok');
      game.myId = welcome.id;
      game.mySkin = welcome.skin;
      game.myName = welcome.name;
      game.roster = welcome.players;
      ui.myId = welcome.id;
      buildCity(welcome.seed);

      game.player = new LocalPlayer({
        scene,
        camera,
        world: game.world,
        input,
        skin: welcome.skin,
        fx: effects,
        onShoot: (muzzle, dir) => {
          net.send({ t: 'shoot', o: [+muzzle.x.toFixed(2), +muzzle.y.toFixed(2), +muzzle.z.toFixed(2)], d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)] });
        },
        onZip: () => net.send({ t: 'zip' }),
      });
      if (welcome.alive) game.player.spawn(welcome.pos);
      else game.player.pos.set(0, 90, 0);

      ui.showMenu(false);
      ui.showHud(true);
      game.started = true;
      input.lock();
    })
    .catch((err) => {
      ui.el.playBtn.disabled = false;
      ui.status(`could not connect: ${err.message}`, 'err');
    });
}

ui.el.playBtn.addEventListener('click', connect);
ui.el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
ui.el.againBtn.addEventListener('click', () => {
  ui.showResults(false);
  input.lock();
});

// Clicking anywhere after Esc re-grabs the mouse. This deliberately listens on
// the window rather than the canvas: the lobby panel is a full-screen overlay,
// so a canvas-only handler meant that losing the mouse during the countdown
// left you with no way at all to get the controls back.
addEventListener('mousedown', (e) => {
  if (!game.started) return;
  if (e.target.closest?.('button, input, a')) return;
  if (!ui.el.results.classList.contains('hidden')) return;
  if (!input.locked) input.lock();
  // Playing on the cursor-steering fallback: a click is a cheap moment to see
  // whether whatever refused pointer lock has since let go of it.
  else if (input.freeLook && !input.lockRefused) input.lock();
});
input.onLockChange = (locked) => {
  if (!locked && game.started) ui.status('paused — click to resume');
};
// Pointer lock can be refused (sandboxed iframe); say so once and explain the
// cursor-steering fallback rather than leaving the player unable to turn.
input.onFreeLook = () => {
  ui.toast('MOUSE LOOK', 'This browser will not hold the mouse — nudge an edge to keep turning', 5);
};

// ------------------------------------------------------------ net handlers
net.on('state', (msg) => {
  game.phase = msg.phase;
  game.timer = msg.timer;
  game.storm = msg.storm;
  game.alive = msg.alive;
  game.total = msg.total;
  game.serverTime = msg.time;
  stormWall.set(msg.storm);

  const now = performance.now() / 1000;
  remotes.applySnapshot(msg.players, game.myId, now);

  const me = msg.players.find((p) => p.i === game.myId);
  if (me && game.player) {
    game.kills = me.k;
    // The server owns health and fluid; adopt its numbers.
    game.player.health = me.hp;
    if (Math.abs(game.player.fluid - me.f) > 12) game.player.fluid = me.f;
    if (me.a && !game.player.alive) game.player.spawn(me.p);
    if (!me.a && game.player.alive) game.player.die();
  }

  game.scoreRows = msg.players
    .map((p) => ({ id: p.i, name: p.n, skin: p.c, kills: p.k, bot: !!p.b, alive: !!p.a }))
    .sort((a, b) => (b.alive - a.alive) || (b.kills - a.kills));

  for (const ev of msg.events || []) handleEvent(ev);
});

function handleEvent(ev) {
  switch (ev.t) {
    case 'shot': {
      effects.spawnProjectile(ev.id, ev.o, ev.v);
      if (ev.owner !== game.myId) {
        const rp = remotes.get(ev.owner);
        if (rp) rp.hero.triggerShoot(1);
      }
      break;
    }
    case 'splat':
      effects.splatFromProjectile(ev.id, ev.p, !!ev.hit);
      break;
    case 'despawn':
      effects.killProjectile(ev.id);
      break;
  }
}

net.on('welcome', (msg) => { game.roster = msg.players; });
net.on('joined', (msg) => {
  if (!game.roster.some((p) => p.id === msg.player.id)) game.roster.push(msg.player);
});
net.on('left', (msg) => {
  game.roster = game.roster.filter((p) => p.id !== msg.id);
  remotes.remove(msg.id);
  effects.dropRemote(msg.id);
});

net.on('matchStart', (msg) => {
  buildCity(msg.seed);
  remotes.clear();
  game.deadInfo = null;
  game.spectateId = 0;
  ui.showResults(false);
  ui.showDeploy(false);
  ui.toast('DROP IN', 'Last hero swinging wins', 2.4);
  if (!input.locked) input.lock();
});

net.on('spawn', (msg) => {
  if (game.player) game.player.spawn(msg.pos);
  game.deadInfo = null;
});

net.on('hurt', (msg) => {
  if (!game.player) return;
  const before = game.player.health;
  game.player.health = msg.hp;
  // by === 0 means the storm is chewing on us; that already has its own
  // purple vignette, so skip the red hit flash and the camera kick.
  if (!msg.by) return;
  game.player.slowUntil = performance.now() / 1000 + COMBAT.IMPACT_SLOW_TIME;
  ui.hurt(before - msg.hp);
  game.player.shake = Math.min(0.6, game.player.shake + 0.18);
});

net.on('hitmark', () => ui.hitmarker());

net.on('kill', (msg) => {
  ui.killFeed(
    msg.killer ? msg.killer.name : null,
    msg.victim.name,
    msg.killer?.id === game.myId,
    msg.victim.id === game.myId
  );
  if (msg.killer?.id === game.myId) {
    ui.toast('WEBBED!', `${msg.victim.name} is out`, 1.6);
  }
  const rp = remotes.get(msg.victim.id);
  if (rp) effects.puff(rp.pos.clone().add(new THREE.Vector3(0, 1.8, 0)), 4, 0.6, 0xffffff);
});

net.on('died', (msg) => {
  game.deadInfo = msg;
  game.player?.die();
  ui.toast(`#${msg.placement}`, `Webbed by ${msg.by}`, 3);
  // Spectate whoever is still swinging.
  const alive = [...remotes.players.values()].filter((p) => p.alive);
  game.spectateId = alive.length ? alive[0].id : 0;
});

net.on('matchEnd', (msg) => {
  const mine = msg.board.find((r) => r.id === game.myId);
  ui.showMatchResults({
    placement: mine?.placement || msg.board.length,
    kills: mine?.kills || 0,
    killedBy: game.deadInfo?.by,
    board: msg.board,
    won: msg.winner?.id === game.myId,
  });
  input.unlock();
});

net.on('lobby', (msg) => {
  game.roster = msg.players;
  ui.showResults(false);
});

net.on('storm', (msg) => {
  if (msg.warn === 'shrinking') ui.toast('THE WEB CLOSES IN', 'Get to the safe zone', 2.2);
});

net.on('full', () => ui.status('server is full — try again in a minute', 'err'));
net.on('disconnected', () => {
  ui.status('disconnected from server', 'err');
  ui.showMenu(true);
  ui.el.playBtn.disabled = false;
  game.started = false;
});

// ------------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
let orbitAngle = 0;

// Frame-time watchdog driving the quality tiers. The average is deliberately
// slow to react and the cool-downs are long: a quality setting that flaps back
// and forth is more distracting than either setting on its own.
let frameAvg = 16.7;
let qualityCheck = 0;
let downgradeGuard = 0;
const _aim = new THREE.Vector3();

function tuneQuality(dtMs, dt) {
  frameAvg += (Math.min(dtMs, 200) - frameAvg) * 0.06;
  qualityCheck -= dt;
  downgradeGuard -= dt;
  if (qualityCheck > 0) return;
  qualityCheck = 1.5;
  if (frameAvg > 23 && quality > 0) {
    applyQuality(quality - 1, sky);
    downgradeGuard = 8;
  } else if (frameAvg < 11 && quality < QUALITY.length - 1 && downgradeGuard <= 0) {
    applyQuality(quality + 1, sky);
  }
}

// Cinematic sweep over the skyline, used on the menu and between matches.
function cinematicCamera(dt) {
  orbitAngle += dt * 0.05;
  const r = CITY.HALF * 1.3;
  camera.position.set(
    Math.cos(orbitAngle) * r,
    195 + Math.sin(orbitAngle * 1.7) * 45,
    Math.sin(orbitAngle) * r
  );
  camera.lookAt(0, 60, 0);
  camera.fov = 58;
  camera.updateProjectionMatrix();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = now - last;
  last = now;
  let dt = dtMs / 1000;
  // A long frame is still simulated in full — the physics is sub-stepped, so
  // there is nothing to protect against here except a tab that was in the
  // background. Clamping this to a tenth of a second used to put the whole
  // game into slow motion the moment the frame rate dipped, which feels far
  // more like broken controls than a dropped frame does.
  if (dt > 0.2) dt = 0.2;
  tuneQuality(dtMs, dt);

  input.beginFrame(dt);
  const spectatingNobody = game.started && game.player && !game.player.alive && !game.spectateId;
  if (!game.started || spectatingNobody) cinematicCamera(dt);

  if (game.started && game.player) {
    const p = game.player;
    if (!spectatingNobody) p.update(dt);

    // Spectator camera rides along with a survivor.
    if (!p.alive && game.spectateId) {
      const rp = remotes.get(game.spectateId);
      if (rp && rp.alive) p.pos.lerp(rp.pos, 1 - Math.pow(0.001, dt));
      else {
        const alive = [...remotes.players.values()].filter((x) => x.alive);
        game.spectateId = alive.length ? alive[0].id : 0;
      }
    }

    // Live web line from hand to anchor.
    if (p.alive && (p.anchor || p.zipTarget)) {
      effects.updateLocalLine(p.hero.handWorld(p.anchor ? p.swingSide : 1, new THREE.Vector3()), p.anchor || p.zipTarget);
    } else {
      effects.cutWeb();
    }

    // 20Hz state upload.
    acc += dt;
    if (acc >= 1 / TICK_RATE) {
      acc = 0;
      if (p.alive) net.send(p.netState());
    }

    // One reticle, sitting on what the shot will hit. Not the middle of the
    // screen: the camera eases into place behind the hero, so while you turn,
    // its forward direction and your aim are two different things.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    _aim.copy(p.aimPoint).applyMatrix4(camera.matrixWorldInverse);
    const behind = _aim.z > -0.05;
    _aim.applyMatrix4(camera.projectionMatrix);
    const cx = behind ? 0 : (_aim.x * 0.5 + 0.5) * innerWidth;
    const cy = behind ? 0 : (-_aim.y * 0.5 + 0.5) * innerHeight;
    const edge = 26;
    ui.setCrosshair(
      THREE.MathUtils.clamp(cx, edge, innerWidth - edge),
      THREE.MathUtils.clamp(cy, edge, innerHeight - edge)
    );

    // HUD
    ui.setPaused(!input.locked);
    ui.setHealth(p.health);
    ui.setFluid(p.fluid);
    ui.setSpeed(p.speed);
    ui.setCounts(game.alive, game.kills);
    ui.setCanWeb(p.canWeb && p.alive);
    ui.setPhase(game.phase, game.timer, game.storm);
    ui.stormVignette(p.alive && stormWall.isOutside(p.pos));

    ui.drawMinimap({
      me: p.pos,
      storm: game.storm,
      yaw: p.yaw,
      city: game.city?.data,
      others: [...remotes.players.values()].filter((r) => r.alive).map((r) => ({ x: r.pos.x, z: r.pos.z, skin: r.skin })),
    });

    // Lobby / countdown panel (the results screen takes priority over it).
    const resultsUp = !ui.el.results.classList.contains('hidden');
    const inLobby = !resultsUp && (game.phase === PHASE.LOBBY || game.phase === PHASE.COUNTDOWN);
    ui.showDeploy(inLobby);
    if (inLobby) {
      ui.setDeploy({
        title: game.phase === PHASE.COUNTDOWN ? 'DROPPING IN' : 'ASSEMBLING HEROES',
        timer: `${Math.max(0, Math.ceil(game.timer))}`,
        sub: game.phase === PHASE.COUNTDOWN
          ? 'Get ready to swing'
          : `${game.total} hero${game.total === 1 ? '' : 'es'} in the lobby`,
        roster: game.roster,
      });
    }

    // Scoreboard on Tab.
    const showScore = input.down('Tab');
    ui.showScoreboard(showScore);
    if (showScore) ui.renderBoard(ui.el.scoreBoard, game.scoreRows, true);
  }

  remotes.update(dt, performance.now() / 1000, camera, effects, QUALITY[quality].heroShadowDist);
  effects.update(dt);
  stormWall.update(dt);
  sky.update(dt, game.player && game.player.alive ? game.player.pos : camera.position);
  ui.update(dt);

  input.endFrame();
  renderer.render(scene, camera);
}

// Debug hook — handy from the browser console, and used by the smoke test.
Object.defineProperty(globalThis, '__spoodermin', {
  get: () => ({
    get player() { return game.player; },
    get phase() { return game.phase; },
    get alive() { return game.alive; },
    get total() { return game.total; },
    get remotes() { return remotes.players.size; },
    get colliders() { return game.city?.colliders.length ?? 0; },
    get drawCalls() { return renderer.info.render.calls; },
    get triangles() { return renderer.info.render.triangles; },
    get quality() { return QUALITY[quality].name; },
    get frameAvg() { return frameAvg; },
    setQuality: (n) => applyQuality(n, sky),
    refs: { scene, camera, renderer, game, remotes, effects, net, sky, input },
    game,
  }),
});

// A quiet idle scene behind the menu so the game never opens on a black page.
buildCity(1234567);
camera.position.set(CITY.HALF * 0.5, 120, CITY.HALF * 0.75);
camera.lookAt(0, 40, 0);
requestAnimationFrame(frame);
