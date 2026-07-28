// Keyboard + mouse input.
//
// Two rules drive the design here:
//
//  1. The keyboard must never go dead. Movement keys are read from the raw
//     key state, independently of whether the mouse is captured, and a tap
//     that starts and ends between two frames is still delivered — at a low
//     frame rate that is the difference between "responsive" and "the
//     controls are gone".
//
//  2. Pointer lock is the good path but it is refused for all sorts of
//     reasons, some permanent (a sandboxed iframe) and some transient (the
//     browser's cool-down right after you press Escape). A transient refusal
//     must not permanently downgrade the game to cursor steering, so the
//     fallback is entered optimistically and left again the moment a real
//     lock succeeds.

// Refusals in a row before we stop asking. Browsers do not reliably
// distinguish "this frame may never have the lock" from "you pressed Escape a
// moment ago", and guessing from the error name gets the second case wrong —
// which would strand a player in cursor steering for the rest of the match.
// Counting instead is dull and always right: a sandbox refuses every time, a
// cool-down does not.
const REFUSALS_BEFORE_GIVING_UP = 3;
// Don't hammer requestPointerLock while playing in the fallback.
const RETRY_INTERVAL = 2000;
// Cursor steering: how far out the cursor has to be, as a fraction of the
// half-screen, before the view starts turning, and how fast it turns at full
// deflection (in the same units as a mouse delta, so ~2 rad/s).
const EDGE_TURN_FROM = 0.55;
const EDGE_TURN_RATE = 900;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.released = new Set(); // keys let go of this frame, held one frame more
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false, wheel: 0 };
    this.cursor = { x: 0, y: 0 };
    this.pointerLocked = false;
    this.freeLook = false;
    this.lockRefused = false; // pointer lock will never be granted here
    this._refusals = 0;
    this.active = false; // controls engaged, by either method
    this.onLockChange = null;
    this.onFreeLook = null;
    this._lockProbe = null;
    this._lastAttempt = -Infinity;
    this._announcedFreeLook = false;

    // The canvas has to be focusable, or a click on it leaves the keyboard
    // pointed at whatever was focused before (or at the parent document, when
    // the game is embedded in an iframe).
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

    addEventListener('keydown', (e) => {
      const k = e.code;
      // A held key re-fires keydown; only the first one is an edge, but the
      // key state has to be re-asserted either way in case a stray keyup or a
      // lost focus event cleared it.
      this.keys.add(k);
      this.released.delete(k);
      if (e.repeat) return;
      this.pressed.add(k);
      if (this.active && (k === 'Space' || k === 'Tab')) e.preventDefault();
      // With no pointer lock to exit, Escape has to release the controls itself.
      if (k === 'Escape' && this.freeLook && this.active) this.unlock();
    });
    // Deferred so a press and release that both land between two frames still
    // reads as one frame of movement instead of vanishing.
    addEventListener('keyup', (e) => this.released.add(e.code));
    addEventListener('blur', () => this.clearHeld());

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
        // A real lock always wins: leave the cursor-steering fallback behind.
        this._refusals = 0;
        this.freeLook = false;
        this.canvas.style.cursor = '';
        this.active = true;
      } else if (!this.freeLook) {
        this.active = false;
        this.clearHeld();
      }
      if (this.onLockChange) this.onLockChange(this.active);
    });
  }

  /** Back-compat alias: "are the controls engaged?" */
  get locked() { return this.active; }
  set locked(v) { this.active = !!v; }

  /** Drop every held key and button — used when focus or the lock goes away. */
  clearHeld() {
    this.keys.clear();
    this.released.clear();
    this.mouse.left = this.mouse.right = false;
  }

  /**
   * Take control of the mouse. Called on the click that starts or resumes the
   * game, and — while playing in the cursor-steering fallback — retried
   * quietly on later clicks in case whatever refused the lock has passed.
   */
  lock() {
    const el = this.canvas;
    el.focus?.({ preventScroll: true });

    if (this.lockRefused || !el.requestPointerLock) {
      this.useFreeLook();
      return;
    }
    const now = performance.now();
    if (this.freeLook && now - this._lastAttempt < RETRY_INTERVAL) {
      this.active = true;
      return;
    }
    this._lastAttempt = now;

    // Every request below must have a rejection handler. A stray rejected
    // pointer-lock promise surfaces as an unhandled rejection, which is not a
    // crash but looks exactly like one.
    const request = (opts) => {
      let p;
      try {
        p = opts ? el.requestPointerLock(opts) : el.requestPointerLock();
      } catch {
        return undefined;
      }
      return p && typeof p.catch === 'function' ? p : null;
    };

    const failed = () => {
      if (++this._refusals >= REFUSALS_BEFORE_GIVING_UP) this.lockRefused = true;
      this.useFreeLook();
    };

    const first = request({ unadjustedMovement: true });
    if (first === undefined) { failed(); return; }
    if (first) {
      first.catch((err) => {
        // Only the raw-movement option is worth a second try; anything else
        // will fail again for the same reason.
        if (err && err.name === 'NotSupportedError') {
          const retry = request(null);
          if (retry === undefined) { failed(); return; }
          if (retry) retry.catch(failed);
          return;
        }
        failed();
      });
    }

    // Belt and braces: some browsers resolve the promise but never actually
    // hand over the lock. Falling back here is not treated as a refusal — the
    // next click still asks for the real thing.
    clearTimeout(this._lockProbe);
    this._lockProbe = setTimeout(() => {
      if (!this.pointerLocked) this.useFreeLook();
    }, 900);
  }

  useFreeLook() {
    this.active = true;
    // The game draws its own reticle on the cursor, so the system one would
    // just be a second pointer sitting next to it. It comes back the moment
    // the controls are released, or there is nothing to aim the click with.
    this.canvas.style.cursor = 'none';
    if (this.freeLook) return;
    this.freeLook = true;
    if (!this._announcedFreeLook) {
      this._announcedFreeLook = true;
      if (this.onFreeLook) this.onFreeLook();
    }
    if (this.onLockChange) this.onLockChange(true);
  }

  unlock() {
    clearTimeout(this._lockProbe);
    document.exitPointerLock?.();
    if (this.freeLook) {
      this.active = false;
      this.canvas.style.cursor = '';
      this.clearHeld();
      if (this.onLockChange) this.onLockChange(false);
    }
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  /**
   * Is the cursor itself the aim, rather than a turn-rate control? True
   * whenever pointer lock was refused and we are steering by cursor.
   */
  get absoluteAim() { return this.freeLook && this.active; }

  /**
   * Swings the view round when the cursor is pushed out to the edge of the
   * screen. Aiming itself is absolute — the cursor *is* the crosshair — so
   * this only has to cover turning past what is currently on screen, and it
   * stays out of the way across the middle of the picture.
   */
  beginFrame(dt) {
    if (!this.absoluteAim) return;
    const r = this.canvas.getBoundingClientRect();
    const nx = (this.cursor.x - r.width / 2) / (r.width / 2);
    const ny = (this.cursor.y - r.height / 2) / (r.height / 2);
    const past = (n) => {
      const over = Math.abs(n) - EDGE_TURN_FROM;
      return over <= 0 ? 0 : Math.sign(n) * Math.min(1, over / (1 - EDGE_TURN_FROM));
    };
    const ex = past(nx);
    const ey = past(ny);
    if (!ex && !ey) return;
    this.mouse.dx += ex * EDGE_TURN_RATE * dt;
    this.mouse.dy += ey * EDGE_TURN_RATE * dt;
  }

  endFrame() {
    this.pressed.clear();
    // Keys released during this frame stay "down" for exactly the frame that
    // observed them, then go.
    for (const k of this.released) this.keys.delete(k);
    this.released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
    this.mouse.wheel = 0;
  }
}
