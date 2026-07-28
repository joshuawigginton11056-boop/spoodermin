// Builds the visible city from the shared deterministic layout.
//
// Everything is merged into a handful of draw calls: the whole skyline is one
// geometry, all shops another, props are instanced. That keeps a few hundred
// buildings running at 60fps on a laptop GPU.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { generateCity } from '/shared/citygen.js';
import { CITY } from '/shared/constants.js';
import { windowTexture, roadTexture, grassTexture, sidewalkTexture, signTexture, shopFrontTexture } from '../util/textures.js';

const _c = new THREE.Color();

// A box whose side UVs tile with its real-world size, so windows stay the same
// size on a 20m shop and a 180m tower.
function tiledBox(w, h, d, uvScale = 4) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
  const spans = [
    [d, h], [d, h], // sides along x
    [w, d], [w, d], // top / bottom
    [w, h], [w, h], // sides along z
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * (su / uvScale), uv.getY(idx) * (sv / uvScale));
    }
  }
  uv.needsUpdate = true;
  return geo;
}

// Rewrites a geometry's UVs through a mapping function.
function scaleUV(geo, fn) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = fn(uv.getX(i), uv.getY(i));
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geo;
}

function paint(geo, colorHex) {
  _c.set(colorHex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c.r;
    arr[i * 3 + 1] = _c.g;
    arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// Slight per-face shading variation gives the flat-shaded look more depth.
function tint(geo, amount) {
  const col = geo.attributes.color;
  for (let i = 0; i < col.count; i++) {
    const k = 1 + (Math.random() - 0.5) * amount;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return geo;
}

export class City {
  constructor(seed) {
    this.seed = seed;
    this.data = generateCity(seed);
    this.group = new THREE.Group();
    this.group.name = 'city';
    this.colliders = this.data.colliders;
    this.build();
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    this.group.clear();
  }

  build() {
    this.buildGround();
    this.buildTowers();
    this.buildShops();
    this.buildHighways();
    this.buildProps();
  }

  // ------------------------------------------------------------- ground
  buildGround() {
    const { SIZE, HALF, CELL, ROAD, BLOCK, GRID } = CITY;

    // Flat base slab. Deliberately untextured — the actual road markings are
    // laid down as separate strips so they line up with the real street grid.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(SIZE * 1.8, SIZE * 1.8),
      new THREE.MeshLambertMaterial({ color: 0x8e95a2 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);

    // Roads: one strip per street, with the texture oriented along the lane so
    // the centre dashes actually run the length of the road.
    const roadGeos = [];
    const span = SIZE + ROAD * 2;
    const repeats = span / ROAD;
    for (let g = 0; g <= GRID; g++) {
      const c = -HALF + g * CELL + ROAD / 2;

      const nsGeo = new THREE.PlaneGeometry(ROAD, span);
      nsGeo.rotateX(-Math.PI / 2);
      scaleUV(nsGeo, (u, v) => [u, v * repeats]);
      nsGeo.translate(c, 0.06, 0);
      roadGeos.push(nsGeo);

      const ewGeo = new THREE.PlaneGeometry(span, ROAD);
      ewGeo.rotateX(-Math.PI / 2);
      scaleUV(ewGeo, (u, v) => [v, u * repeats]); // rotate the texture 90°
      ewGeo.translate(0, 0.05, c);
      roadGeos.push(ewGeo);
    }
    const roads = new THREE.Mesh(
      BufferGeometryUtils.mergeGeometries(roadGeos, false),
      new THREE.MeshLambertMaterial({ map: roadTexture(), color: 0xd8dce4 })
    );
    roads.receiveShadow = true;
    this.group.add(roads);

    // Sidewalk pads under each block, raised a hair to avoid z-fighting.
    const pads = [];
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const x = -HALF + gx * CELL + ROAD / 2 + BLOCK / 2;
        const z = -HALF + gz * CELL + ROAD / 2 + BLOCK / 2;
        const g = tiledBox(BLOCK + 7, 0.7, BLOCK + 7, 8);
        g.translate(x, 0.35, z);
        pads.push(g);
      }
    }
    const padMesh = new THREE.Mesh(
      BufferGeometryUtils.mergeGeometries(pads, false),
      new THREE.MeshLambertMaterial({ map: sidewalkTexture(), color: 0xc8cdd6 })
    );
    padMesh.receiveShadow = true;
    this.group.add(padMesh);

    // Parks.
    if (this.data.parks.length) {
      const gs = this.data.parks.map((p) => {
        const g = tiledBox(p.w, 0.9, p.d, 12);
        g.translate(p.x, 0.9, p.z);
        return g;
      });
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(gs, false),
        new THREE.MeshLambertMaterial({ map: grassTexture(), color: 0x9fd89f })
      );
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  // ------------------------------------------------------------- skyline
  buildTowers() {
    const bodies = [];
    const roofs = [];
    const trims = [];

    for (const b of this.data.buildings) {
      const g = tiledBox(b.w, b.h, b.d, 4.5);
      g.translate(b.x, b.h / 2, b.z);
      paint(g, b.color);
      tint(g, 0.06);
      bodies.push(g);

      // Roof cap so the top does not show window texture.
      const cap = new THREE.BoxGeometry(b.w + 0.6, 1.6, b.d + 0.6);
      cap.translate(b.x, b.h + 0.4, b.z);
      paint(cap, b.roof);
      roofs.push(cap);

      // A smaller stacked box makes tall towers read as art-deco.
      if (b.setback) {
        const sw = b.w * 0.55;
        const sd = b.d * 0.55;
        const sh = Math.min(24, b.h * 0.18);
        const s = tiledBox(sw, sh, sd, 4.5);
        s.translate(b.x, b.h + sh / 2 + 1, b.z);
        paint(s, b.color);
        bodies.push(s);
        const cap2 = new THREE.BoxGeometry(sw + 0.5, 1.2, sd + 0.5);
        cap2.translate(b.x, b.h + sh + 1.4, b.z);
        paint(cap2, b.roof);
        roofs.push(cap2);
      }

      if (b.antenna) {
        const mast = new THREE.CylinderGeometry(0.35, 0.6, 18, 5);
        mast.translate(b.x, b.h + 9 + (b.setback ? 12 : 0), b.z);
        paint(mast, 0xc9ced8);
        trims.push(mast);
        const light = new THREE.SphereGeometry(0.9, 6, 5);
        light.translate(b.x, b.h + 18.5 + (b.setback ? 12 : 0), b.z);
        paint(light, 0xff4444);
        trims.push(light);
      }
    }

    if (bodies.length) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(bodies, false),
        new THREE.MeshLambertMaterial({ map: windowTexture(false), vertexColors: true })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (roofs.length) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(roofs, false),
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (trims.length) {
      this.group.add(new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(trims, false),
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
      ));
    }
  }

  // --------------------------------------------------------------- shops
  buildShops() {
    // Group storefronts by colour so each colour is a single merged mesh.
    const byColor = new Map();
    const awnings = [];
    const signBoards = [];

    for (const s of this.data.shops) {
      const g = new THREE.BoxGeometry(s.w, s.h, s.d);
      g.translate(s.x, s.h / 2, s.z);
      if (!byColor.has(s.color)) byColor.set(s.color, []);
      byColor.get(s.color).push(g);

      // Flat roof lip.
      const lip = new THREE.BoxGeometry(s.w + 0.8, 1.1, s.d + 0.8);
      lip.translate(s.x, s.h + 0.2, s.z);
      paint(lip, 0x39404e);
      awnings.push(lip);

      // Striped awning jutting out of the front face.
      const front = new THREE.Vector3(Math.sin(s.facing), 0, Math.cos(s.facing));
      const along = new THREE.Vector3(front.z, 0, -front.x);
      const width = Math.abs(along.x) > 0.5 ? s.w : s.d;
      const aw = new THREE.BoxGeometry(Math.abs(front.x) > 0.5 ? 3.2 : width * 0.8, 0.5, Math.abs(front.x) > 0.5 ? width * 0.8 : 3.2);
      const depthOut = (Math.abs(front.x) > 0.5 ? s.w : s.d) / 2 + 1.4;
      aw.translate(s.x + front.x * depthOut, s.h * 0.62, s.z + front.z * depthOut);
      paint(aw, s.awning);
      awnings.push(aw);

      // Neon sign board on the facade.
      const board = new THREE.PlaneGeometry(Math.min(width * 0.78, 11), 2.6);
      board.rotateY(s.facing);
      board.translate(
        s.x + front.x * ((Math.abs(front.x) > 0.5 ? s.w : s.d) / 2 + 0.12),
        s.h * 0.8,
        s.z + front.z * ((Math.abs(front.x) > 0.5 ? s.w : s.d) / 2 + 0.12)
      );
      signBoards.push({ geo: board, text: s.sign, color: s.color });
    }

    for (const [color, geos] of byColor) {
      const tex = shopFrontTexture(color);
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(geos, false),
        new THREE.MeshLambertMaterial({ map: tex })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (awnings.length) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(awnings, false),
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
      );
      mesh.castShadow = true;
      this.group.add(mesh);
    }
    // Signs share geometry per word to keep material count sane.
    const byWord = new Map();
    for (const s of signBoards) {
      if (!byWord.has(s.text)) byWord.set(s.text, []);
      byWord.get(s.text).push(s.geo);
    }
    for (const [word, geos] of byWord) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(geos, false),
        new THREE.MeshBasicMaterial({ map: signTexture(word), transparent: true, side: THREE.DoubleSide })
      );
      this.group.add(mesh);
    }
  }

  // ----------------------------------------------------------- highways
  buildHighways() {
    const parts = [];
    const rails = [];
    const road = roadTexture();

    for (const h of this.data.highways) {
      const deck = new THREE.BoxGeometry(h.w, 1.4, h.d);
      // Run the lane markings along the deck, not across it.
      const len = h.axis === 'x' ? h.w : h.d;
      const wide = h.axis === 'x' ? h.d : h.w;
      const reps = len / wide;
      scaleUV(deck, h.axis === 'x' ? (u, v) => [v, u * reps] : (u, v) => [u, v * reps]);
      deck.translate(h.x, CITY.HIGHWAY_Y, h.z);
      parts.push(deck);

      const railH = 1.6;
      if (h.axis === 'x') {
        for (const s of [-1, 1]) {
          const r = new THREE.BoxGeometry(h.w, railH, 0.8);
          r.translate(h.x, CITY.HIGHWAY_Y + railH / 2 + 0.7, h.z + s * (h.d / 2 - 0.4));
          paint(r, 0xd6dbe4);
          rails.push(r);
        }
      } else {
        for (const s of [-1, 1]) {
          const r = new THREE.BoxGeometry(0.8, railH, h.d);
          r.translate(h.x + s * (h.w / 2 - 0.4), CITY.HIGHWAY_Y + railH / 2 + 0.7, h.z);
          paint(r, 0xd6dbe4);
          rails.push(r);
        }
      }
    }

    for (const p of this.data.pillars) {
      const col = new THREE.BoxGeometry(4.5, p.h, 4.5);
      col.translate(p.x, p.h / 2, p.z);
      paint(col, 0x8b93a1);
      rails.push(col);
    }

    if (parts.length) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(parts, false),
        new THREE.MeshLambertMaterial({ map: road, color: 0xc7ccd6 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (rails.length) {
      const mesh = new THREE.Mesh(
        BufferGeometryUtils.mergeGeometries(rails, false),
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
      );
      mesh.castShadow = true;
      this.group.add(mesh);
    }
  }

  // -------------------------------------------------------------- props
  buildProps() {
    const { trees, lamps, cars } = this.data;

    // Trees: instanced cone + trunk.
    if (trees.length) {
      const trunkGeo = new THREE.CylinderGeometry(0.4, 0.55, 3.2, 6);
      trunkGeo.translate(0, 1.6, 0);
      const leafGeo = new THREE.IcosahedronGeometry(2.6, 0);
      leafGeo.translate(0, 4.6, 0);
      const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x6b4a2f, flatShading: true }), trees.length);
      const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0x4c8c3f, flatShading: true }), trees.length);
      const m = new THREE.Matrix4();
      trees.forEach((t, i) => {
        m.makeScale(t.s, t.s, t.s);
        m.setPosition(t.x, 0.9, t.z);
        trunk.setMatrixAt(i, m);
        leaves.setMatrixAt(i, m);
      });
      trunk.castShadow = leaves.castShadow = true;
      this.group.add(trunk, leaves);
    }

    // Street lamps.
    if (lamps.length) {
      const post = new THREE.CylinderGeometry(0.18, 0.22, 7, 5);
      post.translate(0, 3.5, 0);
      const arm = new THREE.BoxGeometry(2.2, 0.28, 0.28);
      arm.translate(1, 6.9, 0);
      const head = new THREE.BoxGeometry(1.1, 0.5, 0.7);
      head.translate(2, 6.7, 0);
      const lampGeo = BufferGeometryUtils.mergeGeometries([post, arm, head], false);
      const mesh = new THREE.InstancedMesh(lampGeo, new THREE.MeshLambertMaterial({ color: 0x3b4250, flatShading: true }), lamps.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(1, 1, 1);
      lamps.forEach((l, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.rot);
        m.compose(new THREE.Vector3(l.x, 0.5, l.z), q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    // Parked cars — chunky two-box shapes.
    if (cars.length) {
      const body = new THREE.BoxGeometry(2.2, 1.1, 4.6);
      body.translate(0, 0.85, 0);
      const cab = new THREE.BoxGeometry(1.9, 0.9, 2.2);
      cab.translate(0, 1.85, -0.2);
      const carGeo = BufferGeometryUtils.mergeGeometries([body, cab], false);
      const mesh = new THREE.InstancedMesh(carGeo, new THREE.MeshLambertMaterial({ flatShading: true }), cars.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3(1, 1, 1);
      const col = new THREE.Color();
      cars.forEach((c, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot);
        m.compose(new THREE.Vector3(c.x, 0.2, c.z), q, s);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.set(c.color));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      this.group.add(mesh);

      // Wheels as a second instanced pass (4 per car would be overkill, so a
      // single dark skirt box reads fine at gameplay distance).
      const skirt = new THREE.BoxGeometry(2.4, 0.45, 4.2);
      skirt.translate(0, 0.35, 0);
      const wheels = new THREE.InstancedMesh(skirt, new THREE.MeshLambertMaterial({ color: 0x22262f }), cars.length);
      cars.forEach((c, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot);
        m.compose(new THREE.Vector3(c.x, 0.2, c.z), q, s);
        wheels.setMatrixAt(i, m);
      });
      this.group.add(wheels);
    }
  }
}
