// Offline transport: runs the authoritative match server in the browser tab.
//
// `server/game.js` has no Node dependencies — it is plain JS over the shared
// modules — so the exact same Room that powers multiplayer can be instantiated
// here and driven by a local timer. The WebSocket is replaced by direct calls,
// so the client code cannot tell the difference: you still play against the
// real bots, the real storm and the real hit detection, just with no network
// and no other humans.

import { Room } from '../../server/game.js';
import { TICK_MS } from '/shared/constants.js';

export const MULTIPLAYER = false;

class LocalNet {
  constructor() {
    this.handlers = new Map();
    this.id = 0;
    this.connected = false;
    this.ping = 0;
    this.room = null;
    this.player = null;
    this._timer = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, payload) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(payload);
  }

  connect(name) {
    this.room = new Room('solo');
    // A stand-in for the WebSocket the server would normally write to.
    const socket = {
      readyState: 1,
      send: (text) => this._deliver(text),
      close: () => {},
    };
    this.player = this.room.addSocketPlayer(socket, name);
    this.connected = true;
    this.id = this.player.id;

    const welcome = this.room.welcomePacket(this.player);
    // Hand the welcome to the event handlers the same way a socket would.
    queueMicrotask(() => this.emit('welcome', welcome));

    this._timer = setInterval(() => {
      try { this.room.tick(); } catch (err) { console.error('tick error', err); }
    }, TICK_MS);

    return Promise.resolve(welcome);
  }

  send(obj) {
    if (this.room && this.player) this.room.onMessage(this.player, obj);
  }

  disconnect() {
    clearInterval(this._timer);
    this.connected = false;
  }

  _deliver(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === 'pong') return;
    // `welcome` is delivered explicitly by connect(); skip the echo.
    if (msg.t === 'welcome') return;
    this.emit(msg.t, msg);
    this.emit('*', msg);
  }
}

export function createTransport() {
  return new LocalNet();
}
