// Keyboard + pointer-lock mouse input.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false, wheel: 0 };
    this.locked = false;
    this.enabled = true;
    this.onLockChange = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.pressed.add(k);
      if (this.locked && (k === 'Space' || k === 'Tab')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftEdge = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightEdge = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.locked) this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.keys.clear(); this.mouse.left = this.mouse.right = false; }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  lock() {
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  unlock() { document.exitPointerLock?.(); }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
    this.mouse.wheel = 0;
  }
}
