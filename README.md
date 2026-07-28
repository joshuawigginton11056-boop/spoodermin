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
| `C` while swinging | Haul the line in harder than it already does on its own |
| `E` | Web-zip: yank yourself straight to whatever the crosshair is on |
| `Tab` | Live scoreboard |
| `V` | Cycle camera distance |
| `Esc` | Release the mouse (click anywhere to grab it again) |

Whenever the mouse is loose the game says **PAUSED** on screen, and a click
anywhere takes it back — including during the lobby countdown, where the panel
covers the whole screen.

If the browser refuses pointer lock — a sandboxed iframe, for instance — the
game says so and switches to cursor steering: the further the cursor sits from
the middle of the screen, the faster you turn. Everything else is unchanged.
The refusal is not assumed to be permanent: a later click tries for the real
thing again, and the game only stops asking after three refusals in a row.

**Wall-crawling:** hold a movement key into a wall while airborne and you stick
to it. `W`/`S` climb and descend, `A`/`D` shuffle sideways, `Space` kicks off.

---

## How a match works

1. **Lobby** — heroes gather; AI heroes fill the lobby up to 8.
2. **Drop in** — everyone spawns on rooftops, streets and elevated highways
   scattered across a freshly generated city.
3. **The web closes in** — a shrinking safe zone drives everyone together over
   six phases, then closes to nothing. Outside the storm curtain you take
   escalating damage.
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

**Swinging** is tuned to glide rather than sprint. The line looks for the best
anchor in a cone rather than the first thing it touches, and runs up the face of
whatever it hits to the roofline — a wall at head height gives a five-metre rope
and a pirouette, which is not a swing. Gravity on the line is lighter than
walking gravity, because an arc bought at 30m/s² is over before it starts;
letting go converts part of the arc into lift so you carry into the next one;
and the line takes up slack on its own so the bottom of the arc clears the
street. The line also reels itself in on the way down through each arc and eases
off on the way up — a swing pumps itself, with nothing to hold — stopping at a
share of the line you fired so a long arc off a tower stays a long arc. `C`
hauls in harder for whipping round a corner. `W` no longer reels at all: holding
forward used to wind every swing down to the shortest rope, which is what made
it run away from you.

**Frame-rate independence.** The player is simulated in sub-steps of at most
1/90 s, and every rate — gravity, the swing's energy gain, camera easing — is
expressed per second. A swing therefore traces the same arc at 30fps as it does
at 144fps, and a fast release cannot pass through a wall between two frames.

**Adaptive quality.** `main.js` watches its own frame time and moves between
four tiers, trading render scale, shadow-map size and shadow range for a steady
frame rate; it steps down quickly and back up slowly so the setting does not
flap. The shadow frustum follows the player snapped to whole shadow texels,
which stops shadow edges crawling as you move. Current tier and average frame
time are readable from the console as `__spoodermin.quality` and
`__spoodermin.frameAvg`, and `__spoodermin.setQuality(0..3)` pins one.

**Bots** are simulated entirely on the server, and they are non-combatants.
They wander between points inside the safe zone, sprint for the middle when the
storm catches them out, and hop when they bump into a wall — but they never
pick a target and never fire. You can web them; they will not web you back. The
only things that can take a human's health are the storm and another human.

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
