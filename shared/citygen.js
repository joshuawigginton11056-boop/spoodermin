// Deterministic procedural city.
//
// Runs on both sides: the client turns the output into low-poly meshes, the
// server uses `colliders` for bot movement and for stopping web projectiles.
// Same seed in -> byte-identical layout out.

import { CITY } from './constants.js';
import { makeRng } from './rng.js';

const TOWER_COLORS = [0x8fa3bf, 0x7a8ba8, 0xa8b8c9, 0x6f8299, 0x9db0c4, 0x5f7285, 0xb7c3d1];
const TOWER_GLASS = [0x2f4a63, 0x37566f, 0x27405a, 0x40607a];
const SHOP_COLORS = [0xe8734a, 0xf2b134, 0x53b8a0, 0xd9536f, 0x6c8ae4, 0xe0a458, 0x7fbf5a, 0xc45bb0];
const AWNING_COLORS = [0xffffff, 0x2b2b3a, 0xffd166, 0x2f9e70, 0xd94f4f];
const ROOF_COLORS = [0x3d4756, 0x4a5568, 0x2f3846];
const CAR_COLORS = [0xd94f4f, 0x4f7fd9, 0xf2c14e, 0xffffff, 0x2f3846, 0x53b8a0, 0xe07a5f];
const SHOP_SIGNS = [
  'BODEGA', 'PIZZA', 'RAMEN', 'DINER', 'COMICS', 'DONUTS', 'TACOS', 'LAUNDRY',
  'HARDWARE', 'BOOKS', 'COFFEE', 'BARBER', 'ARCADE', 'FLOWERS', 'BURGERS', 'NOODLES',
];

// AABB helper: stored as centre + half extents, which is what both the
// collision resolver and the raycaster want.
function box(x, y, z, w, h, d) {
  return { x, y: y + h / 2, z, hw: w / 2, hh: h / 2, hd: d / 2 };
}

export function generateCity(seed) {
  const rng = makeRng(seed);
  const { GRID, BLOCK, ROAD, CELL, HALF, HIGHWAY_Y } = CITY;

  const buildings = []; // {x,z,w,d,h,color,roof,kind,glass}
  const shops = []; // {x,z,w,d,h,color,awning,sign,facing}
  const parks = []; // {x,z,w,d}
  const trees = []; // {x,z,s}
  const lamps = []; // {x,z,rot}
  const cars = []; // {x,z,rot,color}
  const highways = []; // {x,z,w,d,axis}
  const pillars = [];
  const colliders = [];
  const spawns = [];

  const blockCenter = (g) => -HALF + g * CELL + ROAD / 2 + BLOCK / 2;

  // Which road lanes carry the elevated highway. Kept away from the very edge
  // so the ramps read as "through the middle of downtown".
  const hwRow = 2 + (seed % 2);
  const hwCol = GRID - 3 - (seed % 2);

  // ------------------------------------------------------------- city blocks
  for (let gx = 0; gx < GRID; gx++) {
    for (let gz = 0; gz < GRID; gz++) {
      const cx = blockCenter(gx);
      const cz = blockCenter(gz);
      // Distance from the middle of the map, 0 at the core, 1 at the rim.
      const dist = Math.max(Math.abs(gx - (GRID - 1) / 2), Math.abs(gz - (GRID - 1) / 2)) / ((GRID - 1) / 2);

      let kind;
      if (dist < 0.34) kind = 'downtown';
      else if (dist < 0.7) kind = rng.chance(0.55) ? 'downtown' : 'shops';
      else kind = rng.chance(0.25) ? 'downtown' : 'shops';
      if (rng.chance(0.09)) kind = 'park';

      if (kind === 'park') {
        parks.push({ x: cx, z: cz, w: BLOCK, d: BLOCK });
        const n = rng.int(7, 12);
        for (let i = 0; i < n; i++) {
          trees.push({
            x: cx + rng.range(-BLOCK / 2 + 5, BLOCK / 2 - 5),
            z: cz + rng.range(-BLOCK / 2 + 5, BLOCK / 2 - 5),
            s: rng.range(0.8, 1.6),
          });
        }
        spawns.push({ x: cx, y: 3, z: cz });
        continue;
      }

      if (kind === 'shops') {
        // A strip of small colourful storefronts around the block edge.
        const rows = [
          { axis: 'x', off: -BLOCK / 2 + 9, facing: Math.PI },
          { axis: 'x', off: BLOCK / 2 - 9, facing: 0 },
          { axis: 'z', off: -BLOCK / 2 + 9, facing: -Math.PI / 2 },
          { axis: 'z', off: BLOCK / 2 - 9, facing: Math.PI / 2 },
        ];
        for (const row of rows) {
          if (rng.chance(0.2)) continue;
          let cursor = -BLOCK / 2 + 4;
          while (cursor < BLOCK / 2 - 12) {
            const w = rng.range(11, 19);
            const h = rng.range(7, 15);
            const d = 16;
            const along = cursor + w / 2;
            const sx = row.axis === 'x' ? cx + along : cx + row.off;
            const sz = row.axis === 'x' ? cz + row.off : cz + along;
            const bw = row.axis === 'x' ? w : d;
            const bd = row.axis === 'x' ? d : w;
            shops.push({
              x: sx, z: sz, w: bw, d: bd, h,
              color: rng.pick(SHOP_COLORS),
              awning: rng.pick(AWNING_COLORS),
              sign: rng.pick(SHOP_SIGNS),
              facing: row.facing,
            });
            colliders.push(box(sx, 0, sz, bw, h, bd));
            if (rng.chance(0.35)) spawns.push({ x: sx, y: h + 2, z: sz });
            cursor += w + rng.range(1.5, 4);
          }
        }
        // Little plaza in the middle of the block.
        spawns.push({ x: cx, y: 3, z: cz });
        continue;
      }

      // ------------------------------------------------------ downtown block
      const towers = rng.chance(0.45) ? 1 : rng.int(2, 4);
      const cells = towers === 1 ? [[0, 0, 1, 1]] : splitBlock(rng, towers);
      for (const [ox, oz, sw, sd] of cells) {
        const margin = rng.range(2.5, 6);
        const w = Math.max(10, BLOCK * sw - margin * 2);
        const d = Math.max(10, BLOCK * sd - margin * 2);
        const x = cx + (ox + sw / 2 - 0.5) * BLOCK;
        const z = cz + (oz + sd / 2 - 0.5) * BLOCK;
        // Taller towers downtown, plus the occasional landmark spire.
        const base = 34 + (1 - dist) * 95;
        let h = rng.range(base * 0.55, base * 1.45);
        if (rng.chance(0.06)) h *= rng.range(1.5, 2.2);
        h = Math.round(h);
        const glass = rng.chance(0.35);
        buildings.push({
          x, z, w, d, h,
          color: glass ? rng.pick(TOWER_GLASS) : rng.pick(TOWER_COLORS),
          roof: rng.pick(ROOF_COLORS),
          glass,
          antenna: h > 110 && rng.chance(0.6),
          setback: h > 70 && rng.chance(0.5), // stacked "wedding cake" top
        });
        colliders.push(box(x, 0, z, w, h, d));
        spawns.push({ x, y: h + 3, z });
      }
    }
  }

  // -------------------------------------------------------- street furniture
  for (let g = 0; g <= GRID; g++) {
    const roadC = -HALF + g * CELL + ROAD / 2;
    for (let t = -HALF + 10; t < HALF - 10; t += 26) {
      lamps.push({ x: roadC - ROAD / 2 + 2.5, z: t, rot: 0 });
      lamps.push({ x: t, z: roadC - ROAD / 2 + 2.5, rot: Math.PI / 2 });
      if (rng.chance(0.35)) {
        cars.push({ x: roadC + rng.range(-4, 4), z: t + rng.range(-6, 6), rot: 0, color: rng.pick(CAR_COLORS) });
      }
      if (rng.chance(0.35)) {
        cars.push({ x: t + rng.range(-6, 6), z: roadC + rng.range(-4, 4), rot: Math.PI / 2, color: rng.pick(CAR_COLORS) });
      }
    }
  }

  // ------------------------------------------------------ elevated highways
  const makeHighway = (axis, laneIndex) => {
    const c = -HALF + laneIndex * CELL + ROAD / 2;
    const deckW = 18;
    const seg = CITY.SIZE;
    if (axis === 'x') {
      highways.push({ x: 0, z: c, w: seg, d: deckW, axis: 'x' });
      colliders.push(box(0, HIGHWAY_Y, c, seg, 1.4, deckW));
      for (let x = -HALF + 14; x <= HALF - 14; x += 44) {
        pillars.push({ x, z: c, h: HIGHWAY_Y });
        colliders.push(box(x, 0, c, 4.5, HIGHWAY_Y, 4.5));
      }
      for (let x = -HALF + 30; x <= HALF - 30; x += 70) spawns.push({ x, y: HIGHWAY_Y + 3, z: c });
    } else {
      highways.push({ x: c, z: 0, w: deckW, d: seg, axis: 'z' });
      colliders.push(box(c, HIGHWAY_Y, 0, deckW, 1.4, seg));
      for (let z = -HALF + 14; z <= HALF - 14; z += 44) {
        pillars.push({ x: c, z, h: HIGHWAY_Y });
        colliders.push(box(c, 0, z, 4.5, HIGHWAY_Y, 4.5));
      }
      for (let z = -HALF + 30; z <= HALF - 30; z += 70) spawns.push({ x: c, y: HIGHWAY_Y + 3, z });
    }
  };
  makeHighway('x', hwRow);
  makeHighway('z', hwCol);

  return {
    seed,
    size: CITY.SIZE,
    half: HALF,
    buildings,
    shops,
    parks,
    trees,
    lamps,
    cars,
    highways,
    pillars,
    colliders,
    spawns,
  };
}

// Splits a unit block into `n` sub-rectangles: [offsetX, offsetZ, w, d] in 0..1.
function splitBlock(rng, n) {
  let rects = [[0, 0, 1, 1]];
  while (rects.length < n) {
    // Always split the biggest piece so the towers stay chunky.
    let bi = 0;
    for (let i = 1; i < rects.length; i++) {
      if (rects[i][2] * rects[i][3] > rects[bi][2] * rects[bi][3]) bi = i;
    }
    const [x, z, w, d] = rects.splice(bi, 1)[0];
    const t = rng.range(0.38, 0.62);
    if (w >= d) {
      rects.push([x, z, w * t, d], [x + w * t, z, w * (1 - t), d]);
    } else {
      rects.push([x, z, w, d * t], [x, z + d * t, w, d * (1 - t)]);
    }
  }
  return rects;
}

// ------------------------------------------------------------------ physics
// Shared AABB helpers so the server's bots collide with the same world the
// player sees.

export function aabbContains(b, x, y, z, pad = 0) {
  return (
    x > b.x - b.hw - pad && x < b.x + b.hw + pad &&
    y > b.y - b.hh - pad && y < b.y + b.hh + pad &&
    z > b.z - b.hd - pad && z < b.z + b.hd + pad
  );
}

// Slab-method ray/AABB test. Returns hit distance or Infinity.
export function rayAabb(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const c = [b.x, b.y, b.z];
  const e = [b.hw, b.hh, b.hd];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < c[i] - e[i] || o[i] > c[i] + e[i]) return Infinity;
    } else {
      const inv = 1 / d[i];
      let t1 = (c[i] - e[i] - o[i]) * inv;
      let t2 = (c[i] + e[i] - o[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

// Nearest surface hit along a ray against the whole city (plus ground plane).
// Returns {dist, point:[x,y,z], normal:[x,y,z], box} or null.
export function raycastCity(colliders, origin, dir, maxDist) {
  let best = maxDist;
  let bestBox = null;
  for (const b of colliders) {
    // Cheap reject: skip boxes whose centre is far off the ray.
    const t = rayAabb(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], b);
    if (t < best) { best = t; bestBox = b; }
  }
  // Ground plane at y = 0.
  if (dir[1] < -1e-6) {
    const t = -origin[1] / dir[1];
    if (t > 0 && t < best) {
      return {
        dist: t,
        point: [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t],
        normal: [0, 1, 0],
        box: null,
      };
    }
  }
  if (!bestBox) return null;
  const p = [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best];
  // Pick the face whose plane the hit point sits on.
  const rel = [(p[0] - bestBox.x) / bestBox.hw, (p[1] - bestBox.y) / bestBox.hh, (p[2] - bestBox.z) / bestBox.hd];
  const a = rel.map(Math.abs);
  const axis = a[0] > a[1] ? (a[0] > a[2] ? 0 : 2) : (a[1] > a[2] ? 1 : 2);
  const normal = [0, 0, 0];
  normal[axis] = Math.sign(rel[axis]) || 1;
  return { dist: best, point: p, normal, box: bestBox };
}
