// Every texture in the game is painted into a <canvas> at runtime — no image
// files, no downloads, and the whole thing works offline.

import * as THREE from 'three';

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, { repeat = [1, 1], nearest = false } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (nearest) tex.magFilter = THREE.NearestFilter;
  tex.anisotropy = 4;
  return tex;
}

function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

// --------------------------------------------------------------- buildings
// One tile == roughly 4x4 world units, so we can repeat it per building face.
export function windowTexture(glass = false) {
  return memo(`win-${glass}`, () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.fillStyle = glass ? '#20364a' : '#ffffff';
    g.fillRect(0, 0, S, S);

    // Mullions.
    g.fillStyle = glass ? 'rgba(10,20,32,0.9)' : 'rgba(45,55,72,0.85)';
    g.fillRect(0, 0, S, 10);
    g.fillRect(0, 0, 10, S);

    // Two window panes per tile with random-ish light levels.
    const lights = ['#ffe6a3', '#cfe9ff', '#2b3a4d', '#2b3a4d', '#8fb8d8', '#ffd27a'];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const x = 14 + i * 58;
        const y = 14 + j * 58;
        const lit = lights[(i * 3 + j * 5 + (glass ? 1 : 0)) % lights.length];
        g.fillStyle = lit;
        g.fillRect(x, y, 48, 48);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(x, y, 48, 12);
      }
    }
    return finish(c);
  });
}

export function roadTexture() {
  return memo('road', () => {
    const S = 256;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.fillStyle = '#3b3f4b';
    g.fillRect(0, 0, S, S);
    // speckle
    for (let i = 0; i < 600; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
      g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
    // centre dashes
    g.fillStyle = '#f2d16b';
    for (let y = 8; y < S; y += 48) g.fillRect(S / 2 - 4, y, 8, 26);
    // kerbs
    g.fillStyle = '#8d939f';
    g.fillRect(0, 0, 12, S);
    g.fillRect(S - 12, 0, 12, S);
    return finish(c);
  });
}

export function grassTexture() {
  return memo('grass', () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.fillStyle = '#57a35a';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(${20 + Math.random() * 60 | 0},${120 + Math.random() * 70 | 0},60,0.35)`;
      g.fillRect(Math.random() * S, Math.random() * S, 3, 5);
    }
    return finish(c);
  });
}

export function sidewalkTexture() {
  return memo('walk', () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.fillStyle = '#9aa1ad';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(60,66,78,0.5)';
    g.lineWidth = 3;
    for (let i = 0; i <= S; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(S, i); g.stroke();
    }
    return finish(c);
  });
}

// ------------------------------------------------------------------- shops
export function signTexture(text, bg = 0x1b2233, fg = '#ffe9a8') {
  return memo(`sign-${text}-${bg}`, () => {
    const W = 256;
    const H = 64;
    const c = canvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = hex(bg);
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 4;
    g.strokeRect(4, 4, W - 8, H - 8);
    g.fillStyle = fg;
    g.font = 'bold 34px Trebuchet MS, Verdana, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = fg;
    g.shadowBlur = 14;
    g.fillText(text, W / 2, H / 2 + 2);
    return finish(c);
  });
}

export function shopFrontTexture(color) {
  return memo(`front-${color}`, () => {
    const W = 128;
    const H = 128;
    const c = canvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = hex(color);
    g.fillRect(0, 0, W, H);
    // big glass storefront on the lower half
    g.fillStyle = 'rgba(180,225,245,0.9)';
    g.fillRect(10, 58, 48, 60);
    g.fillRect(70, 58, 48, 60);
    g.strokeStyle = 'rgba(30,40,55,0.8)';
    g.lineWidth = 4;
    g.strokeRect(10, 58, 48, 60);
    g.strokeRect(70, 58, 48, 60);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(14, 62, 40, 14);
    g.fillRect(74, 62, 40, 14);
    // door
    g.fillStyle = 'rgba(40,50,70,0.85)';
    g.fillRect(56, 78, 16, 40);
    return finish(c);
  });
}

// -------------------------------------------------------------------- hero
// The suit: a web lattice over the hero's primary colour.
export function suitTexture(primary, secondary) {
  return memo(`suit-${primary}-${secondary}`, () => {
    const S = 256;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.fillStyle = hex(primary);
    g.fillRect(0, 0, S, S);

    const cx = S / 2;
    const cy = S / 2;
    g.strokeStyle = hex(secondary);
    g.lineWidth = 2.2;
    g.globalAlpha = 0.85;

    // radial spokes
    const spokes = 12;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * S, cy + Math.sin(a) * S);
      g.stroke();
    }
    // concentric sagging rings
    for (let r = 16; r < S * 0.8; r += 20) {
      g.beginPath();
      for (let i = 0; i <= spokes; i++) {
        const a0 = (i / spokes) * Math.PI * 2;
        const a1 = ((i + 1) / spokes) * Math.PI * 2;
        const x0 = cx + Math.cos(a0) * r;
        const y0 = cy + Math.sin(a0) * r;
        const mx = cx + Math.cos((a0 + a1) / 2) * r * 0.9;
        const my = cy + Math.sin((a0 + a1) / 2) * r * 0.9;
        const x1 = cx + Math.cos(a1) * r;
        const y1 = cy + Math.sin(a1) * r;
        if (i === 0) g.moveTo(x0, y0);
        g.quadraticCurveTo(mx, my, x1, y1);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    return finish(c, { repeat: [1, 1] });
  });
}

// Chest emblem: a chunky cartoon spider.
export function emblemTexture(color) {
  return memo(`emblem-${color}`, () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    g.fillStyle = hex(color);
    g.strokeStyle = hex(color);
    g.lineCap = 'round';
    g.lineWidth = 7;
    const cx = S / 2;
    const cy = S / 2;
    // body + head
    g.beginPath();
    g.ellipse(cx, cy + 8, 13, 20, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(cx, cy - 17, 10, 10, 0, 0, Math.PI * 2);
    g.fill();
    // four legs each side, bent at the knee
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const y = cy - 12 + i * 12;
        const spread = 26 + i * 5;
        g.beginPath();
        g.moveTo(cx + side * 8, y);
        g.quadraticCurveTo(cx + side * spread, y - 14 + i * 5, cx + side * (spread + 16), y + 12 + i * 4);
        g.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

// A splatted web decal used where projectiles land.
export function splatTexture() {
  return memo('splat', () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 3;
    const cx = S / 2;
    const cy = S / 2;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      const r = S * (0.28 + Math.random() * 0.2);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.stroke();
    }
    for (let ring = 12; ring < S * 0.42; ring += 12) {
      g.beginPath();
      g.arc(cx, cy, ring, 0, Math.PI * 2);
      g.globalAlpha = 0.5;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(cx, cy, 9, 0, Math.PI * 2);
    g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

// Soft round sprite used for the sun glow and impact puffs.
export function puffTexture() {
  return memo('puff', () => {
    const S = 128;
    const c = canvas(S, S);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

// Floating name tag above remote heroes.
export function nameTagTexture(name, color) {
  const key = `tag-${name}-${color}`;
  return memo(key, () => {
    const W = 256;
    const H = 64;
    const c = canvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(10,14,26,0.72)';
    roundRect(g, 6, 12, W - 12, 40, 12);
    g.fill();
    g.fillStyle = hex(color);
    roundRect(g, 6, 12, 8, 40, 4);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 26px Trebuchet MS, Verdana, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name.slice(0, 14), W / 2 + 4, 33);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
