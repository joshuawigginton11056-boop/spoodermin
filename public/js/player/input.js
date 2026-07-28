// Keyboard + mouse input.
//
// Pointer lock is the good path. Some embedding contexts (a sandboxed iframe
// without the pointer-lock permission, for instance) refuse it, so there is a
// fallback that keeps the game fully playable. The fallback hides the system
// cursor and turns by how far the hand actually moved, exactly like pointer
// lock does, so the crosshair in the middle of the screen stays the one and
// only aiming point. The only extra is a thin band at the border of the
// canvas: the cursor cannot travel past the window, so parking it there keeps
// turning at a steady rate and you can still spin all the way round.

// Turn rate, in mouse-pixels per second, while the cursor is pinned to an edge.
const EDGE_TURN = 900;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false, wheel: 0 };
    this.cursor = { x: 0, y: 0, seen: false };
    this.pointerLocked = false;
    this.freeLook = false;
    this.active = false; // controls engaged, by either method
    this.enabled = true;
    this.onLockChange = null;
    this.onFreeLook = null;
    this._lockProbe = null;
    this._lastClient = null; // previous cursor position, for free-look deltas

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
      this.cursor.seen = true;
      if (this.pointerLocked) {
        this._lastClient = null;
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
        return;
      }
      // Free-look turns by the distance the hand travelled since the last
      // event. Steering off a fixed offset from the centre instead — the old
      // behaviour — means the view keeps rotating for as long as the cursor is
      // parked off-centre, which reads as the camera drifting on its own.
      // movementX is not dependable outside pointer lock, so measure it here.
      const prev = this._lastClient;
      this._lastClient = { x: e.clientX, y: e.clientY };
      if (!this.freeLook || !this.active || !prev) return;
      this.mouse.dx += e.clientX - prev.x;
      this.mouse.dy += e.clientY - prev.y;
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      clearTimeout(this._lockProbe);
      this._lastClient = null;
      if (this.pointerLocked) {
        this.freeLook = false;
        this.active = true;
      } else if (!this.freeLook) {
        this.active = false;
        this.keys.clear();
        this.mouse.left = this.mouse.right = false;
      }
      this.syncCursorStyle();
      if (this.onLockChange) this.onLockChange(this.active);
    });
  }

  /**
   * The system cursor is hidden whenever free-look has the controls, so the
   * centred crosshair is the only thing on screen that means "you are aiming
   * here". It comes back the moment the controls are released so menus and
   * buttons stay clickable.
   */
  syncCursorStyle() {
    this.canvas.style.cursor = this.freeLook && this.active ? 'none' : '';
  }

  /** Back-compat alias: "are the controls engaged?" */
  get locked() { return this.active; }
  set locked(v) { this.active = !!v; }

  lock() {
    this._lastClient = null;
    if (this.freeLook) { this.active = true; this.syncCursorStyle(); return; }
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
    this._lastClient = null;
    if (this.freeLook) { this.active = true; this.syncCursorStyle(); return; }
    this.freeLook = true;
    this.active = true;
    this.syncCursorStyle();
    if (this.onFreeLook) this.onFreeLook();
    if (this.onLockChange) this.onLockChange(true);
  }

  unlock() {
    document.exitPointerLock?.();
    if (this.freeLook) {
      this.active = false;
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
      this.syncCursorStyle();
      if (this.onLockChange) this.onLockChange(false);
    }
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  /**
   * Free-look only: the hidden cursor cannot leave the window, so once it is
   * pinned against a border there is no travel left to turn with. Keep turning
   * while it sits in that thin band. Anywhere else — the whole middle of the
   * screen — a still hand means a still view.
   */
  beginFrame(dt) {
    if (!this.freeLook || !this.active || !this.cursor.seen) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const band = Math.max(28, Math.min(r.width, r.height) * 0.06);
    const push = (v, size) => {
      if (v < band) return Math.max(-1, (v - band) / band);
      if (v > size - band) return Math.min(1, (v - (size - band)) / band);
      return 0;
    };
    const ex = push(this.cursor.x, r.width);
    const ey = push(this.cursor.y, r.height);
    if (!ex && !ey) return;
    this.mouse.dx += ex * EDGE_TURN * dt;
    this.mouse.dy += ey * EDGE_TURN * 0.6 * dt;
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
