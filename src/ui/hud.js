// HUD rendering: the arc speedometer, the live mini-map, standings, nitro
// and drift meters, countdown and toast messages.

import { formatTime } from '../game/race.js';
import { clamp } from '../util/noise.js';

export class HUD {
  constructor(root) {
    this.root = root;
    this.el = {
      hud: root.querySelector('#hud'),
      pos: root.querySelector('#pos .v'),
      lap: root.querySelector('#lap .v'),
      timer: root.querySelector('#timer .v'),
      best: root.querySelector('#best .v'),
      standings: root.querySelector('#standings'),
      nitro: [...root.querySelectorAll('#nitro .cell')],
      drift: root.querySelector('#drift-meter i'),
      speedNum: root.querySelector('.speed-num .n'),
      gear: root.querySelector('.speed-num .gear'),
      countdown: root.querySelector('#countdown'),
      toast: root.querySelector('#toast'),
    };
    this.speedCanvas = root.querySelector('#speedo canvas');
    this.speedCtx = this.speedCanvas.getContext('2d');
    this.miniCanvas = root.querySelector('#minimap');
    this.miniCtx = this.miniCanvas.getContext('2d');
    this.displaySpeed = 0;
    this.trackPath = null;
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }

  /** Pre-project the circuit into mini-map space once per race. */
  prepareMinimap(track) {
    const pts = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const step = Math.max(1, Math.floor(track.count / 260));
    for (let i = 0; i < track.count; i += step) {
      const x = track.pos[i * 3], z = track.pos[i * 3 + 2];
      pts.push([x, z]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const w = maxX - minX, h = maxZ - minZ;
    const size = Math.max(w, h) * 1.12;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    this.trackPath = { pts, cx, cz, size };
  }

  _project(x, z, W) {
    const p = this.trackPath;
    return [
      W / 2 + ((x - p.cx) / p.size) * W,
      W / 2 + ((z - p.cz) / p.size) * W,
    ];
  }

  drawMinimap(entries, playerVehicle) {
    if (!this.trackPath) return;
    const c = this.miniCtx;
    const W = this.miniCanvas.width;
    c.clearRect(0, 0, W, W);

    // Route
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = 'rgba(140,190,240,0.20)';
    c.lineWidth = 15;
    c.beginPath();
    this.trackPath.pts.forEach(([x, z], i) => {
      const [px, py] = this._project(x, z, W);
      i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    });
    c.closePath();
    c.stroke();

    c.strokeStyle = 'rgba(53,224,255,0.75)';
    c.lineWidth = 3.5;
    c.stroke();

    // Start line marker
    const [sx, sy] = this._project(this.trackPath.pts[0][0], this.trackPath.pts[0][1], W);
    c.fillStyle = '#ffcb6b';
    c.beginPath(); c.arc(sx, sy, 7, 0, Math.PI * 2); c.fill();

    // Cars
    for (const e of entries) {
      const v = e.vehicle;
      const [px, py] = this._project(v.position.x, v.position.z, W);
      const me = e.isPlayer;
      c.beginPath();
      c.arc(px, py, me ? 11 : 8, 0, Math.PI * 2);
      c.fillStyle = me ? '#ffffff' : `#${e.color.toString(16).padStart(6, '0')}`;
      c.fill();
      if (me) {
        c.strokeStyle = '#35e0ff';
        c.lineWidth = 4;
        c.stroke();
        // Heading pip
        const hx = px + Math.sin(v.yaw) * 17, hy = py + Math.cos(v.yaw) * 17;
        c.beginPath(); c.moveTo(px, py); c.lineTo(hx, hy);
        c.strokeStyle = '#ffffff'; c.lineWidth = 3.5; c.stroke();
      }
    }
  }

  drawSpeedo(speedKmh, maxKmh, nitro01, boosting) {
    const c = this.speedCtx;
    const S = this.speedCanvas.width;
    const cx = S / 2, cy = S / 2, r = S * 0.40;
    c.clearRect(0, 0, S, S);

    const start = Math.PI * 0.76;
    const end = Math.PI * 2.24;
    const t = clamp(speedKmh / maxKmh, 0, 1);

    // Track ring
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(160,200,240,0.13)';
    c.lineWidth = S * 0.048;
    c.beginPath(); c.arc(cx, cy, r, start, end); c.stroke();

    // Value arc
    const grad = c.createLinearGradient(0, 0, S, S);
    if (boosting) {
      grad.addColorStop(0, '#9df3ff');
      grad.addColorStop(0.5, '#35e0ff');
      grad.addColorStop(1, '#ff3ea5');
    } else {
      grad.addColorStop(0, '#35e0ff');
      grad.addColorStop(0.62, '#8ef0ff');
      grad.addColorStop(1, '#ffcb6b');
    }
    c.strokeStyle = grad;
    c.lineWidth = S * 0.052;
    c.shadowColor = boosting ? 'rgba(255,62,165,0.85)' : 'rgba(53,224,255,0.7)';
    c.shadowBlur = S * 0.06;
    c.beginPath(); c.arc(cx, cy, r, start, start + (end - start) * t); c.stroke();
    c.shadowBlur = 0;

    // Ticks
    const ticks = 12;
    for (let i = 0; i <= ticks; i++) {
      const a = start + (end - start) * (i / ticks);
      const major = i % 3 === 0;
      const r0 = r - S * 0.075, r1 = r - S * (major ? 0.108 : 0.094);
      c.strokeStyle = i / ticks <= t ? 'rgba(230,245,255,0.85)' : 'rgba(150,185,220,0.28)';
      c.lineWidth = major ? 3 : 1.6;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.stroke();
    }

    // Nitro ring on the inside
    if (nitro01 > 0) {
      c.strokeStyle = 'rgba(255,203,107,0.9)';
      c.lineWidth = S * 0.016;
      c.shadowColor = 'rgba(255,203,107,0.8)';
      c.shadowBlur = S * 0.04;
      c.beginPath();
      c.arc(cx, cy, r - S * 0.135, start, start + (end - start) * nitro01);
      c.stroke();
      c.shadowBlur = 0;
    }
  }

  update(race, playerEntry, dt) {
    const v = playerEntry.vehicle;

    // Needle smoothing makes the readout feel weighty instead of jittery.
    this.displaySpeed += (v.speedKmh - this.displaySpeed) * Math.min(1, dt * 9);
    const maxKmh = v.stats.topSpeed * 3.6 * 1.35;
    this.drawSpeedo(this.displaySpeed, maxKmh, v.nitro / v.maxNitro, v.boostTimer > 0);
    this.el.speedNum.textContent = Math.round(this.displaySpeed);

    const gear = v.speed < 0.5 ? 'N' : v.speed < 0 ? 'R'
      : String(Math.min(6, 1 + Math.floor((v.speed / v.stats.topSpeed) * 5.4)));
    this.el.gear.textContent = v.boostTimer > 0 ? 'NOS' : gear;

    this.el.pos.innerHTML = `${playerEntry.position}<small>/${race.entries.length}</small>`;
    this.el.lap.innerHTML = `${Math.min(race.laps, playerEntry.lap + 1)}<small>/${race.laps}</small>`;
    const elapsed = race.startedAt === undefined ? 0 : Math.max(0, race.time - race.startedAt);
    this.el.timer.textContent = formatTime(elapsed);
    this.el.best.textContent = formatTime(playerEntry.bestLap);

    for (let i = 0; i < this.el.nitro.length; i++) {
      this.el.nitro[i].classList.toggle('on', i < v.nitro);
    }
    const charge = clamp(v.driftCharge / 2.4, 0, 1);
    this.el.drift.style.width = `${charge * 100}%`;

    // Standings
    const rows = (race.standings || race.entries).slice(0, 8).map((e) => {
      const gap = e.isPlayer ? '' : formatGap(e.vehicle.progress - v.progress);
      return `<div class="${e.isPlayer ? 'me' : ''}"><span><b>${e.position}</b>${e.name}</span><span>${gap}</span></div>`;
    }).join('');
    if (rows !== this._lastRows) {
      this.el.standings.innerHTML = rows;
      this._lastRows = rows;
    }

    this.drawMinimap(race.entries, v);
  }

  countdown(text) {
    const el = this.el.countdown;
    el.textContent = text;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  toast(text, color = '#ffffff') {
    const d = document.createElement('div');
    d.className = 'toast-item';
    d.textContent = text;
    d.style.color = color;
    this.el.toast.appendChild(d);
    setTimeout(() => d.remove(), 1600);
  }
}

function formatGap(delta) {
  const d = Math.abs(delta);
  if (d < 1) return '±0m';
  const s = delta > 0 ? '+' : '-';
  if (d > 1000) return `${s}${(d / 1000).toFixed(1)}km`;
  return `${s}${Math.round(d)}m`;
}
