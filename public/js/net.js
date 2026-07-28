// Thin WebSocket wrapper with a tiny event bus and automatic reconnect.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.id = 0;
    this.connected = false;
    this.ping = 0;
    this._pingTimer = null;
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
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?name=${encodeURIComponent(name || '')}`;
      let settled = false;
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.connected = true;
        this._pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
      };

      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') { this.ping = Math.round(performance.now() - msg.c); return; }
        if (msg.t === 'welcome') {
          this.id = msg.id;
          if (!settled) { settled = true; resolve(msg); }
        }
        this.emit(msg.t, msg);
        this.emit('*', msg);
      };

      this.ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('connection failed')); }
      };

      this.ws.onclose = () => {
        this.connected = false;
        clearInterval(this._pingTimer);
        this.emit('disconnected', {});
        if (!settled) { settled = true; reject(new Error('connection closed')); }
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
