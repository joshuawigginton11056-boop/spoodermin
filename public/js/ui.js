// All DOM-side presentation: HUD bars, kill feed, toasts, overlays, scoreboard
// and the radar minimap.

import { SKINS, PHASE } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'),
      menu: $('menu'),
      deploy: $('deploy'),
      results: $('results'),
      scoreboard: $('scoreboard'),
      fatal: $('fatal'),
      crosshair: $('crosshair'),
      alive: $('alive-count'),
      kills: $('kill-count'),
      phaseText: $('phase-text'),
      phaseSub: $('phase-sub'),
      phasePill: $('phase-pill'),
      healthFill: $('health-fill'),
      healthText: $('health-text'),
      fluidFill: $('fluid-fill'),
      speed: $('speed-text'),
      feed: $('killfeed'),
      toast: $('toast'),
      vignette: $('damage-vignette'),
      hitmarker: $('hitmarker'),
      minimap: $('minimap'),
      status: $('connect-status'),
      playBtn: $('play-btn'),
      nameInput: $('name-input'),
      deployTitle: $('deploy-title'),
      deployTimer: $('deploy-timer'),
      deploySub: $('deploy-sub'),
      roster: $('roster'),
      resultsTitle: $('results-title'),
      resultsSub: $('results-sub'),
      resultsBoard: $('results-board'),
      scoreBoard: $('score-board'),
      againBtn: $('again-btn'),
      resume: $('resume-hint'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.toastTimer = 0;
    this.hurtTimer = 0;
    this.feedItems = [];
    this.myId = 0;
    // The HUD is rewritten from the frame loop, so every setter here is
    // guarded: touching textContent or innerHTML sixty times a second for
    // values that did not change is a surprising amount of layout work.
    this.last = {};
    this.mmNext = 0;

    try { this.el.nameInput.value = localStorage.getItem('spoodermin.name') || ''; } catch { /* sandboxed iframe */ }
  }

  // ------------------------------------------------------------- overlays
  showMenu(show) { this.el.menu.classList.toggle('hidden', !show); }
  showHud(show) { this.el.hud.classList.toggle('hidden', !show); }
  showResults(show) { this.el.results.classList.toggle('hidden', !show); }
  showDeploy(show) { this.el.deploy.classList.toggle('hidden', !show); }
  showScoreboard(show) { this.el.scoreboard.classList.toggle('hidden', !show); }

  status(text, cls = '') {
    this.el.status.textContent = text;
    this.el.status.className = `status ${cls}`;
  }

  fatal(text) {
    this.el.fatal.classList.remove('hidden');
    $('fatal-text').textContent = text;
  }

  /** Writes `value` to a HUD node only when it actually differs. */
  _set(key, node, value) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    node.textContent = value;
  }

  // ----------------------------------------------------------------- HUD
  setHealth(hp) {
    const shown = Math.ceil(Math.max(0, hp));
    if (this.last.hp !== shown) {
      this.last.hp = shown;
      this.el.healthFill.style.transform = `scaleX(${Math.max(0, Math.min(1, hp / 100))})`;
      this.el.healthText.textContent = shown;
    }
  }

  setFluid(v) {
    const shown = Math.round(Math.max(0, Math.min(100, v)));
    if (this.last.fluid === shown) return;
    this.last.fluid = shown;
    this.el.fluidFill.style.transform = `scaleX(${shown / 100})`;
  }

  setSpeed(v) {
    this._set('speed', this.el.speed, Math.round(v * 3.6));
  }

  setCounts(alive, kills) {
    this._set('alive', this.el.alive, alive);
    this._set('kills', this.el.kills, kills);
  }

  setCanWeb(can) {
    this.el.crosshair.classList.toggle('can-web', !!can);
  }

  /**
   * Puts the reticle over the point the web and the web balls will actually
   * hit. It is not the middle of the screen: the camera eases into position
   * behind the hero, so while you are turning, the camera's forward and your
   * aim are two different directions, and a crosshair nailed to the centre of
   * the screen quietly lies about where you are pointing.
   */
  setCrosshair(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (this.last.chx === px && this.last.chy === py) return;
    this.last.chx = px;
    this.last.chy = py;
    this.el.crosshair.style.left = `${px}px`;
    this.el.crosshair.style.top = `${py}px`;
  }

  /** "Click to take back the mouse" — shown whenever the controls are idle. */
  setPaused(on) {
    if (this.last.paused === !!on) return;
    this.last.paused = !!on;
    this.el.resume?.classList.toggle('hidden', !on);
  }

  setPhase(phase, timer, storm) {
    const el = this.el;
    let main;
    let sub;
    let danger = false;
    if (phase === PHASE.PLAYING && storm) {
      if (storm.mode === 'shrink') {
        main = 'CLOSING';
        sub = `ZONE ${storm.phase}/${storm.total}`;
        danger = true;
      } else {
        main = fmt(storm.left);
        sub = `ZONE ${storm.phase + 1} IN`;
      }
    } else if (phase === PHASE.COUNTDOWN) {
      main = fmt(timer);
      sub = 'DROPPING';
    } else {
      main = 'LOBBY';
      sub = fmt(timer);
    }
    this._set('phaseText', el.phaseText, main);
    this._set('phaseSub', el.phaseSub, sub);
    el.phasePill.classList.toggle('danger', danger);
  }

  toast(main, sub = '', seconds = 2.2) {
    this.el.toast.innerHTML = `${main}${sub ? `<small>${sub}</small>` : ''}`;
    this.el.toast.classList.add('show');
    this.toastTimer = seconds;
  }

  hitmarker() {
    const el = this.el.hitmarker;
    el.classList.remove('pop');
    void el.offsetWidth; // restart the animation
    el.classList.add('pop');
  }

  hurt(amount = 1) {
    this.hurtTimer = Math.min(0.9, 0.28 + amount * 0.02);
    this.el.vignette.style.opacity = '0.85';
  }

  stormVignette(on) {
    this.el.vignette.classList.toggle('storm', on);
  }

  killFeed(killerName, victimName, isMeKiller, isMeVictim) {
    const div = document.createElement('div');
    div.className = 'feed-item';
    const k = killerName ? `<span class="${isMeKiller ? 'me' : ''}">${esc(killerName)}</span>` : '<span>THE STORM</span>';
    const v = `<span class="${isMeVictim ? 'me' : ''}">${esc(victimName)}</span>`;
    div.innerHTML = `${k} &nbsp;🕸️&nbsp; ${v}`;
    this.el.feed.appendChild(div);
    this.feedItems.push({ el: div, t: 0 });
    if (this.feedItems.length > 6) {
      const old = this.feedItems.shift();
      old.el.remove();
    }
  }

  update(dt) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
    if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
      if (this.hurtTimer <= 0) this.el.vignette.style.opacity = '0';
    }
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const f = this.feedItems[i];
      f.t += dt;
      if (f.t > 7) { f.el.remove(); this.feedItems.splice(i, 1); }
    }
  }

  // -------------------------------------------------------------- lobby
  setDeploy({ title, timer, sub, roster }) {
    this._set('deployTitle', this.el.deployTitle, title);
    this._set('deployTimer', this.el.deployTimer, timer);
    this._set('deploySub', this.el.deploySub, sub);
    if (!roster) return;
    // This runs every frame for the whole lobby; rebuilding the chip list each
    // time tore down and re-created a dozen elements sixty times a second.
    const sig = roster.map((p) => `${p.id}:${p.name}:${p.skin}:${p.bot ? 1 : 0}`).join('|');
    if (sig === this.last.roster) return;
    this.last.roster = sig;
    this.el.roster.innerHTML = roster.map((p) => {
      const c = hex(SKINS[p.skin % SKINS.length].primary);
      return `<div class="chip ${p.bot ? 'bot' : ''}"><i style="background:${c}"></i>${esc(p.name)}${p.bot ? ' <small>AI</small>' : ''}</div>`;
    }).join('');
  }

  // ---------------------------------------------------------- scoreboard
  /**
   * @param {boolean} live  mid-match view: rank by KOs and show who is still in
   *                        the fight, instead of final placements.
   */
  renderBoard(target, rows, live = false) {
    // The live scoreboard is redrawn for as long as Tab is held down, so it
    // gets the same treatment as the lobby roster.
    const sig = `${live}|${this.myId}|${rows.map((r) => `${r.id}:${r.kills}:${r.alive ? 1 : 0}:${r.placement || 0}`).join(',')}`;
    if (target._sig === sig) return;
    target._sig = sig;
    const html = [
      `<div class="row"><span class="rank hdr">#</span><span class="who hdr">HERO</span><span class="num hdr">KOs</span><span class="num hdr">${live ? 'STATUS' : 'PLACE'}</span></div>`,
      ...rows.map((r, i) => {
        const c = hex(SKINS[r.skin % SKINS.length].primary);
        const rank = live ? i + 1 : r.placement || '—';
        const lastCol = live
          ? (r.alive ? '<span style="color:#6be07f">ALIVE</span>' : '<span style="opacity:.45">OUT</span>')
          : (r.placement ? `#${r.placement}` : '—');
        return `<div class="row ${r.id === this.myId ? 'me' : ''}">
          <span class="rank ${!live && r.placement === 1 ? 'gold' : ''}">${rank}</span>
          <span class="who"><i style="background:${c}"></i>${esc(r.name)}${r.bot ? ' <small style="opacity:.5">AI</small>' : ''}</span>
          <span class="num">${r.kills}</span>
          <span class="num">${lastCol}</span>
        </div>`;
      }),
    ].join('');
    target.innerHTML = html;
  }

  showMatchResults({ placement, kills, killedBy, board, won }) {
    this.el.resultsTitle.textContent = won ? 'WEB SLINGER' : `#${placement}`;
    this.el.resultsSub.textContent = won
      ? `Last hero swinging — ${kills} KO${kills === 1 ? '' : 's'}`
      : `${killedBy ? `Webbed by ${killedBy}` : 'Eliminated'} — ${kills} KO${kills === 1 ? '' : 's'}`;
    this.renderBoard(this.el.resultsBoard, board);
    this.showResults(true);
  }

  // ------------------------------------------------------------- minimap
  /**
   * The radar is a canvas redraw of a few hundred rectangles. At 20Hz it is
   * indistinguishable from redrawing it every frame, and costs a third as much
   * on a 60Hz display — more on a 144Hz one.
   */
  drawMinimap({ me, storm, others, city, yaw }) {
    const now = performance.now();
    if (now < this.mmNext) return;
    this.mmNext = now + 50;

    const g = this.mm;
    const W = this.el.minimap.width;
    const H = this.el.minimap.height;
    const R = W / 2;
    const VIEW = 320; // world units across the radar
    const scale = R / (VIEW / 2);

    g.clearRect(0, 0, W, H);
    g.save();
    g.beginPath();
    g.arc(R, R, R, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#151a29';
    g.fillRect(0, 0, W, H);

    g.translate(R, R);
    g.rotate(-yaw);

    const wx = (x) => (x - me.x) * scale;
    const wz = (z) => (z - me.z) * scale;

    // city blocks
    if (city) {
      g.fillStyle = 'rgba(140,155,180,0.5)';
      for (const b of city.buildings) {
        const x = wx(b.x);
        const z = wz(b.z);
        if (Math.abs(x) > R + 30 || Math.abs(z) > R + 30) continue;
        g.fillRect(x - b.w * scale / 2, z - b.d * scale / 2, b.w * scale, b.d * scale);
      }
      g.fillStyle = 'rgba(230,180,90,0.55)';
      for (const s of city.shops) {
        const x = wx(s.x);
        const z = wz(s.z);
        if (Math.abs(x) > R + 20 || Math.abs(z) > R + 20) continue;
        g.fillRect(x - s.w * scale / 2, z - s.d * scale / 2, s.w * scale, s.d * scale);
      }
      g.strokeStyle = 'rgba(120,200,255,0.5)';
      g.lineWidth = 3;
      for (const h of city.highways) {
        g.strokeRect(wx(h.x) - h.w * scale / 2, wz(h.z) - h.d * scale / 2, h.w * scale, h.d * scale);
      }
    }

    // storm circle
    if (storm) {
      g.strokeStyle = '#d08bff';
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(wx(storm.cx), wz(storm.cz), storm.r * scale, 0, Math.PI * 2);
      g.stroke();
      if (storm.mode === 'shrink') {
        g.strokeStyle = '#9fe8ff';
        g.setLineDash([5, 5]);
        g.beginPath();
        g.arc(wx(storm.cx), wz(storm.cz), storm.tr * scale, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
    }

    // other players
    for (const o of others) {
      const x = wx(o.x);
      const z = wz(o.z);
      const d = Math.hypot(x, z);
      if (d > R - 6) continue;
      g.fillStyle = hex(SKINS[o.skin % SKINS.length].primary);
      g.beginPath();
      g.arc(x, z, 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1.5;
      g.stroke();
    }

    g.restore();

    // player arrow, always dead centre pointing up
    g.save();
    g.translate(R, R);
    g.fillStyle = '#ffd166';
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(6, 7);
    g.lineTo(0, 3.5);
    g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.restore();

    // compass N
    g.save();
    g.translate(R, R);
    g.rotate(-yaw);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = 'bold 12px Trebuchet MS';
    g.textAlign = 'center';
    g.fillText('N', 0, -R + 15);
    g.restore();
  }
}

function fmt(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
