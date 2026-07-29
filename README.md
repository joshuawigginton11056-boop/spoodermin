# 🕷️ SPOODERMIN

A low-poly, cartoon-shaded **3D superhero battle royale** that runs in the browser.
Swing between skyscrapers on webs, crawl up walls, and blast rival heroes with
web balls until one slinger is left standing.

![built with three.js](https://img.shields.io/badge/three.js-r185-000?style=flat-square)
![node](https://img.shields.io/badge/node-%E2%89%A518-3c873a?style=flat-square)

---

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000** and hit *ENTER THE CITY*.

Open the same URL in a second tab, on another machine on your LAN, or share the
port — everyone who connects joins the same match. The lobby is topped up with
AI heroes, so a solo player still gets a full 8-hero battle royale.

Set `PORT` to run somewhere other than 3000.

### Single-file offline build

```bash
npm run build:standalone     # → dist/spoodermin-standalone.html
```

Produces one self-contained HTML file you can open straight off disk or host
anywhere static — no server, no network, no assets. The match server in
`server/game.js` is plain JS over the shared modules, so the offline build
swaps `transport.js` for `transport-local.js` and runs that same `Room` inside
the browser tab: identical bots, storm, and server-side hit detection, just
without other humans.

---

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint |
| `Space` | Jump — or wall-jump off a building, or cut loose from a swing with a boost |
| **Left click** | Fire a web ball (damages enemies) |
| **Right click (hold)** | Shoot a web line and swing. Release to let go and keep your momentum |
| `Shift` / `C` while swinging | Reel the line in — shorter rope, faster arc |
| `Ctrl` / `X` while swinging | Pay the line out |
| `E` | Web-zip: yank yourself straight to whatever the crosshair is on |
| `Tab` | Live scoreboard |
| `V` | Cycle camera distance |
| `Esc` | Release the mouse (click the canvas to grab it again) |

If the browser refuses pointer lock — a sandboxed iframe, for instance — the
game says so and switches to cursor steering: the further the cursor sits from
the middle of the screen, the faster you turn. Everything else is unchanged.

**Wall-crawling:** hold a movement key into a wall while airborne and you stick
to it. `W`/`S` climb and descend, `A`/`D` shuffle sideways, `Space` kicks off.

---

## How a match works

1. **Lobby** — heroes gather; AI heroes fill the lobby up to 8.
2. **Drop in** — everyone spawns on rooftops, streets and elevated highways
   scattered across a freshly generated city.
3. **The web closes in** — a shrinking safe zone drives everyone together over
   six phases. Outside the storm curtain you take escalating damage.
4. **Last hero swinging wins.** Getting eliminated drops you into spectator
   mode; the results board and a fresh city follow shortly after.

Web balls do 13 damage and briefly gunk up whoever they hit, slowing them down.
Firing and zipping both drain **web fluid**, which refills on its own — enough
to keep you moving, not enough to hold the trigger down forever.

---

## About the art

Every asset is **generated procedurally at runtime** — there are no model files,
no textures on disk and nothing downloaded at load time:

- **The hero** is built from capsules and spheres — rounded limbs with ball
  joints, a tapered capsule chest, a spherical head — driven by a hand-written
  animation rig (idle, run, airborne, swinging, wall-cling and a web-shooting
  arm snap). The suit's web lattice and the chest spider are painted into
  `<canvas>` elements. Each limb and its joint ball share one merged geometry,
  so a full lobby of heroes stays cheap to draw.
- **The city** — skyscrapers with tiled window textures, art-deco setbacks,
  antennae, storefronts with neon signs and striped awnings, parks, street
  lamps, parked cars and two elevated highways — is generated from a seed and
  merged down to a handful of draw calls.
- **The sky** is a vertex-coloured dome with low-poly drifting clouds and a
  stylised sun.

The same seed produces the same city on the server and on every client, so
everyone plays the same map without shipping a single byte of level data.

---

## Architecture

```
shared/          ES modules imported by BOTH the server and the browser
  constants.js     all gameplay tuning in one place
  rng.js           seeded PRNG (mulberry32)
  citygen.js       deterministic city layout + AABB ray/overlap helpers

server/
  server.js        express static host + WebSocket endpoint
  game.js          authoritative room: match flow, storm, projectiles, AI bots

public/js/
  main.js          bootstrap and frame loop
  net.js           WebSocket client
  ui.js            HUD, kill feed, overlays, radar minimap
  world/           city meshes, sky/lighting, storm curtain
  entities/        hero rig, remote player interpolation
  player/          input, collision, controller (movement + swinging + camera)
  combat/          web lines, projectiles, splat decals, puffs
  util/            canvas texture factory
```

**Authority split.** Movement is simulated on the client so swinging feels
instant, then uploaded at 20 Hz. Everything that can be cheated — health, web
projectiles and their hits, storm damage, eliminations, placements — is owned by
the server. Web balls are ray-marched server-side against player hitspheres and
the city's AABBs. Remote players are rendered ~100 ms in the past and
interpolated between snapshots.

**Bots** are simulated entirely on the server and behave like extra players:
they path toward the safe zone, orbit their target, take line-of-sight shots
with lead and a miss cone, and hop when they bump into a wall.

No build step — the browser loads `three` through an import map served straight
out of `node_modules`.

---

## Tuning

Almost everything worth changing lives in `shared/constants.js`: run and sprint
speed, jump height, gravity, web reach and reel speed, damage, fire rate, fluid
costs, bot count, and the storm's phase timings and radii. Change a value there
and both sides pick it up.

City shape (blocks per side, block size, road width, highway height) is in the
same file under `CITY`; the generator itself is `shared/citygen.js`.

---

## License

MIT
