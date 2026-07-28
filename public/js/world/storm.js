// The shrinking play area, drawn as a translucent web-purple wall you can see
// from either side, plus a bright ring where it meets the ground.

import * as THREE from 'three';
import { CITY } from '/shared/constants.js';

// Vertical alpha ramp: dense at street level, gone well before the skybox, so
// the wall reads as a curtain instead of tinting the whole screen purple.
function curtainTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  // Faint vertical web strands running down the curtain.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 3; i++) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(i * 3 + 1, 0, 1, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(60, 1);
  return t;
}

export class StormWall {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xc879ff,
      map: curtainTexture(),
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    scene.add(this.mesh);

    const ringGeo = new THREE.RingGeometry(0.985, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xe6a3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.renderOrder = 11;
    this.ring.visible = false;
    scene.add(this.ring);

    // The next circle, shown as a thin outline while the storm is shrinking.
    const nextGeo = new THREE.RingGeometry(0.995, 1, 96);
    nextGeo.rotateX(-Math.PI / 2);
    this.next = new THREE.Mesh(nextGeo, new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    this.next.renderOrder = 11;
    this.next.visible = false;
    scene.add(this.next);

    this.state = null;
    this.display = { cx: 0, cz: 0, r: CITY.HALF, tr: CITY.HALF };
    this.t = 0;
  }

  set(storm) {
    this.state = storm;
    if (!storm) {
      this.mesh.visible = this.ring.visible = this.next.visible = false;
      return;
    }
    this.mesh.visible = this.ring.visible = true;
  }

  update(dt) {
    if (!this.state) return;
    this.t += dt;
    const s = this.state;
    // Smooth the networked radius so the wall glides rather than steps at 20Hz.
    const k = 1 - Math.pow(0.001, dt);
    this.display.cx += (s.cx - this.display.cx) * k;
    this.display.cz += (s.cz - this.display.cz) * k;
    this.display.r += (s.r - this.display.r) * k;

    const H = 300;
    const r = Math.max(2, this.display.r);
    this.mesh.scale.set(r, H, r);
    this.mesh.position.set(this.display.cx, H / 2 - 14, this.display.cz);
    this.mat.opacity = 0.34 + Math.sin(this.t * 2) * 0.05;
    this.mat.map.offset.x = this.t * 0.03;

    this.ring.scale.set(r, 1, r);
    this.ring.position.set(this.display.cx, 0.6, this.display.cz);

    const shrinking = s.mode === 'shrink';
    this.next.visible = shrinking;
    if (shrinking) {
      this.next.scale.set(Math.max(2, s.tr), 1, Math.max(2, s.tr));
      this.next.position.set(s.cx, 0.75, s.cz);
    }
  }

  isOutside(pos) {
    if (!this.state) return false;
    return Math.hypot(pos.x - this.state.cx, pos.z - this.state.cz) > this.state.r;
  }
}
