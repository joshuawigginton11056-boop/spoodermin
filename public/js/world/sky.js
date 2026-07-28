// Cartoon sky: gradient dome, chunky low-poly clouds, a fat stylised sun and
// the lighting rig.

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY } from '/shared/constants.js';
import { makeRng } from '/shared/rng.js';
import { puffTexture } from '../util/textures.js';

// Shadow rigs, worst to best. A tighter frustum is both cheaper (fewer
// buildings inside it) and sharper (more texels per metre), so quality drops
// are mostly about how far from the player shadows survive.
export const SHADOW_TIERS = [
  { shadows: false, map: 512, extent: 90 },
  { shadows: true, map: 1024, extent: 110 },
  { shadows: true, map: 1024, extent: 150 },
  { shadows: true, map: 2048, extent: 190 },
];

const SKY_TOP = new THREE.Color(0x2b6fd6);
const SKY_MID = new THREE.Color(0x7fc4f2);
const SKY_LOW = new THREE.Color(0xffd9a8);

export function buildSky(scene, seed = 1) {
  const group = new THREE.Group();
  const R = CITY.SIZE * 2.4;

  // ------------------------------------------------------------ sky dome
  const domeGeo = new THREE.SphereGeometry(R, 24, 16);
  const colors = new Float32Array(domeGeo.attributes.position.count * 3);
  const pos = domeGeo.attributes.position;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / R) * 0.5 + 0.5, 0, 1);
    if (t < 0.5) c.copy(SKY_LOW).lerp(SKY_MID, t / 0.5);
    else c.copy(SKY_MID).lerp(SKY_TOP, (t - 0.5) / 0.5);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -1;
  group.add(dome);

  // ----------------------------------------------------------------- sun
  const sunDir = new THREE.Vector3(0.42, 0.62, 0.28).normalize();
  const sunPos = sunDir.clone().multiplyScalar(R * 0.82);
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(R * 0.055, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff2c4, fog: false, depthWrite: false })
  );
  sun.position.copy(sunPos);
  sun.lookAt(0, 0, 0);
  group.add(sun);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: puffTexture(), color: 0xffe9a8, transparent: true, opacity: 0.55, depthWrite: false, fog: false,
  }));
  glow.position.copy(sunPos);
  glow.scale.setScalar(R * 0.36);
  group.add(glow);

  // -------------------------------------------------------------- clouds
  const rng = makeRng(seed ^ 0x5eed);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, fog: false, emissive: 0x8899bb, emissiveIntensity: 0.35 });
  const clouds = new THREE.Group();
  for (let i = 0; i < 34; i++) {
    // Each cloud's lumps are baked into one geometry. As separate meshes they
    // were roughly a hundred and sixty draw calls of pure background.
    const lumps = 3 + Math.floor(rng() * 4);
    const parts = [];
    for (let j = 0; j < lumps; j++) {
      const s = rng.range(12, 26);
      const g = new THREE.IcosahedronGeometry(s, 0);
      g.scale(1, 0.55, 1);
      g.translate(rng.range(-s, s) * 1.6, rng.range(-s, s) * 0.25 * 0.55, rng.range(-s, s) * 0.9);
      parts.push(g);
    }
    const cloud = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(parts, false), cloudMat);
    for (const g of parts) g.dispose();
    const a = rng() * Math.PI * 2;
    const rad = rng.range(CITY.SIZE * 0.25, CITY.SIZE * 1.3);
    cloud.position.set(Math.cos(a) * rad, rng.range(170, 340), Math.sin(a) * rad);
    cloud.userData.drift = rng.range(0.6, 2.2);
    clouds.add(cloud);
  }
  group.add(clouds);

  scene.add(group);

  // ------------------------------------------------------------ lighting
  const hemi = new THREE.HemisphereLight(0xcfeaff, 0x8a8f7d, 1.6);
  scene.add(hemi);

  const sunLight = new THREE.DirectionalLight(0xfff0cf, 1.75);
  sunLight.position.copy(sunDir.clone().multiplyScalar(340));
  sunLight.castShadow = true;
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 900;
  sunLight.shadow.bias = -0.0012;
  sunLight.shadow.normalBias = 0.6;
  scene.add(sunLight);
  scene.add(sunLight.target);

  let tier = SHADOW_TIERS[SHADOW_TIERS.length - 1];
  let texel = 1;
  const applyTier = (t) => {
    tier = t;
    sunLight.castShadow = t.shadows;
    sunLight.shadow.mapSize.set(t.map, t.map);
    const c = sunLight.shadow.camera;
    c.left = -t.extent; c.right = t.extent;
    c.top = t.extent; c.bottom = -t.extent;
    c.updateProjectionMatrix();
    // Dispose the old depth target so three rebuilds it at the new size.
    if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
    texel = (t.extent * 2) / t.map;
  };
  applyTier(tier);

  const fill = new THREE.DirectionalLight(0x9fc6ff, 0.35);
  fill.position.set(-200, 160, -180);
  scene.add(fill);

  scene.fog = new THREE.Fog(0xc4dcf2, CITY.SIZE * 0.4, CITY.SIZE * 1.15);

  // The shadow camera's own axes. three builds its basis with +z pointing back
  // along the light (Object3D.lookAt with a world up of +y), so these are the
  // directions the depth map's texels actually run in.
  const shadowZ = sunDir.clone();
  const shadowX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), shadowZ).normalize();
  const shadowY = new THREE.Vector3().crossVectors(shadowZ, shadowX).normalize();
  const centre = new THREE.Vector3();

  return {
    group,
    sunLight,
    /** @param {number} level index into SHADOW_TIERS */
    setShadowQuality(level) {
      const t = SHADOW_TIERS[THREE.MathUtils.clamp(level, 0, SHADOW_TIERS.length - 1)];
      if (t !== tier) applyTier(t);
    },
    get shadowsOn() { return tier.shadows; },
    update(dt, focus) {
      for (const cl of clouds.children) {
        cl.position.x += cl.userData.drift * dt;
        if (cl.position.x > CITY.SIZE * 1.4) cl.position.x = -CITY.SIZE * 1.4;
      }
      if (!focus) return;
      group.position.set(focus.x, 0, focus.z);

      // Keep the shadow frustum centred on the player, but snapped to whole
      // shadow texels — measured along the depth map's own axes, not the
      // world's. Sliding it continuously makes every shadow edge crawl and
      // shimmer as you move, which reads as the whole image being unsteady
      // even when the frame rate is fine.
      const u = Math.round(focus.dot(shadowX) / texel) * texel;
      const v = Math.round(focus.dot(shadowY) / texel) * texel;
      centre.copy(shadowX).multiplyScalar(u)
        .addScaledVector(shadowY, v)
        .addScaledVector(shadowZ, focus.dot(shadowZ));
      sunLight.position.copy(sunDir).multiplyScalar(340).add(centre);
      sunLight.target.position.copy(centre);
      sunLight.target.updateMatrixWorld();
    },
  };
}
