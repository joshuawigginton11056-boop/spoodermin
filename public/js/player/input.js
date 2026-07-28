// Keyboard + mouse input.
//
// Pointer lock is the good path. Some embedding contexts (a sandboxed iframe
// without the pointer-lock permission, for instance) refuse it, so there is a
// steer-with-the-cursor fallback that keeps the game fully playable: the
// further the cursor sits from the middle of the canvas, the faster you turn.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false, wheel: 0 };
    this.cursor = { x: 0, y: 0 };
    this.pointerLocked = false;
    this.freeLook = false;
    this.active = false; // controls engaged, by either method
    this.enabled = true;
    this.onLockChange = null;
    this.onFreeLook = null;
    this._lockProbe = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.pressed.add(k);
      if (this.active && (k === 'Space' || k === 'Tab')) e.preventDefault();
      // With no pointer lock to exit, Escape has to release the controls itself.
      if (k === 'Escape' && this.freeLook && this.active) this.unlock();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftEdge = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightEdge = true; }
      e.preventDefault();
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.active) this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.cursor.x = e.clientX - r.left;
      this.cursor.y = e.clientY - r.top;
      if (!this.pointerLocked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      clearTimeout(this._lockProbe);
      if (this.pointerLocked) {
        this.freeLook = false;
        this.active = true;
      } else if (!this.freeLook) {
        this.active = false;
        this.keys.clear();
        this.mouse.left = this.mouse.right = false;
      }
      if (this.onLockChange) this.onLockChange(this.active);
    });
  }

  /** Back-compat alias: "are the controls engaged?" */
  get locked() { return this.active; }
  set locked(v) { this.active = !!v; }

  lock() {
    if (this.freeLook) { this.active = true; return; }
    const el = this.canvas;
    if (!el.requestPointerLock) { this.useFreeLook(); return; }

    const giveUp = () => this.useFreeLook();
    // Every request below must have a rejection handler. A stray rejected
    // pointer-lock promise surfaces as an unhandled rejection, which is not a
    // crash but looks exactly like one.
    const request = (opts) => {
      let p;
      try {
        p = opts ? el.requestPointerLock(opts) : el.requestPointerLock();
      } catch {
        giveUp();
        return null;
      }
      return p && typeof p.catch === 'function' ? p : null;
    };

    const first = request({ unadjustedMovement: true });
    if (first) {
      first.catch((err) => {
        // Only the raw-movement option is worth a second try; anything else
        // (a sandboxed frame with no pointer-lock permission, a user-gesture
        // problem) will fail again for the same reason.
        if (err && err.name === 'NotSupportedError') {
          const retry = request(null);
          if (retry) retry.catch(giveUp);
          return;
        }
        giveUp();
      });
    }

    // Belt and braces: some browsers resolve the promise but never actually
    // hand over the lock.
    clearTimeout(this._lockProbe);
    this._lockProbe = setTimeout(() => {
      if (!this.pointerLocked) this.useFreeLook();
    }, 700);
  }

  useFreeLook() {
    if (this.freeLook) { this.active = true; return; }
    this.freeLook = true;
    this.active = true;
    this.canvas.style.cursor = 'crosshair';
    if (this.onFreeLook) this.onFreeLook();
    if (this.onLockChange) this.onLockChange(true);
  }

  unlock() {
    document.exitPointerLock?.();
    if (this.freeLook) {
      this.active = false;
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
      if (this.onLockChange) this.onLockChange(false);
    }
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  /** Synthesises look deltas for the cursor-steering fallback. */
  beginFrame(dt) {
    if (!this.freeLook || !this.active) return;
    const r = this.canvas.getBoundingClientRect();
    const ox = this.cursor.x - r.width / 2;
    const oy = this.cursor.y - r.height / 2;
    const mag = Math.hypot(ox, oy);
    const dead = Math.min(r.width, r.height) * 0.07;
    if (mag <= dead) return;
    // Ramp from the edge of the dead zone so small nudges stay gentle.
    const gain = ((mag - dead) / mag) * 2.0 * dt;
    this.mouse.dx += ox * gain;
    this.mouse.dy += oy * gain;
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
    this.mouse.wheel = 0;
  }
}
