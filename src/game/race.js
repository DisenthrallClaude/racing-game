// Race director: grid, countdown, lap and sector timing, live positions,
// boost-pad triggers and the finish sequence.

import * as THREE from 'three';
import { clamp } from '../util/noise.js';

export const RACE_STATE = {
  INTRO: 'intro',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

export class Race {
  constructor(world, entries, def) {
    this.world = world;
    this.track = world.track;
    this.def = def;
    this.laps = def.laps ?? 3;
    this.entries = entries;             // [{ vehicle, ai, name, isPlayer }]
    this.state = RACE_STATE.INTRO;
    this.countdown = 3.999;
    this.time = 0;
    this.padCooldown = new Map();
    this.events = [];

    for (const e of entries) {
      e.lap = 0;
      e.finished = false;
      e.finishTime = 0;
      e.lapTimes = [];
      e.bestLap = Infinity;
      e.lastLapStart = 0;
      e.position = 1;
      e.lastLapAnnounced = 0;
    }
    this.grid();
  }

  /** Stagger the field behind the line in a classic two-by-two grid. */
  grid() {
    const L = this.track.length;
    this.entries.forEach((e, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const w = this.track.widthAtS(L - 18 - row * 9);
      const s = L - 18 - row * 9;
      e.vehicle.placeAtS(s, col * Math.min(5.0, w * 0.22));
      // Progress starts negative so crossing the line begins lap 1.
      e.vehicle.progress = s - L;
      e.vehicle.prevS = s;
      e.startProgress = e.vehicle.progress;
    });
  }

  startCountdown() {
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = 3.999;
  }

  get player() { return this.entries.find((e) => e.isPlayer); }

  update(dt, playerInput) {
    this.time += dt;

    if (this.state === RACE_STATE.COUNTDOWN) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (after !== before) {
        this.onCountdownTick?.(after);
        // Start lights: red bulbs light up one per second, then all go green.
        const lights = this.world.startLights || [];
        if (after > 0) {
          const lit = Math.min(lights.length, (4 - after) * 2);
          lights.forEach((m, i) => {
            m.emissive.set(0xff1122);
            m.emissiveIntensity = i < lit ? 5 : 0;
          });
        } else {
          lights.forEach((m) => { m.emissive.set(0x22ff44); m.emissiveIntensity = 6; });
        }
      }
      if (this.countdown <= 0) {
        this.state = RACE_STATE.RACING;
        this.startedAt = this.time;
        for (const e of this.entries) e.lastLapStart = this.time;
        this.onStart?.();
      }
    }

    const racing = this.state === RACE_STATE.RACING || this.state === RACE_STATE.FINISHED;
    const frozen = this.state === RACE_STATE.COUNTDOWN || this.state === RACE_STATE.INTRO;

    // Leader progress drives the rubber band applied to the AI.
    let leader = -Infinity;
    for (const e of this.entries) leader = Math.max(leader, e.vehicle.progress);

    const ctx = {
      time: this.time,
      vehicles: this.entries.map((e) => e.vehicle),
    };

    for (const e of this.entries) {
      const v = e.vehicle;
      let input;
      if (e.isPlayer) {
        input = frozen
          ? { throttle: 0, brake: 0, steer: playerInput.steer * 0.4, drift: false, boost: false }
          : playerInput;
        v.setBraking(input.brake > 0.1);
      } else if (frozen) {
        input = { throttle: 0, brake: 0, steer: 0, drift: false, boost: false };
      } else {
        // Behind -> up to +12% pace, ahead -> down to -8%.
        const gap = leader - v.progress;
        ctx.rubberBand = clamp(1 + gap * 0.0006 - 0.0004 * Math.max(0, v.progress - leader + 40), 0.92, 1.12);
        input = e.ai.update(dt, ctx);
        v.setBraking(input.brake > 0.1);
      }
      if (e.finished) {
        // Finished cars coast and gently slow rather than stopping dead.
        input = { throttle: 0.2, brake: 0, steer: input.steer * 0.6, drift: false, boost: false };
      }
      v.update(dt, input);
      if (racing && !e.finished) this._checkBoostPads(e);
      if (racing) this._checkLap(e);
    }

    this._updatePositions();
    return this.state;
  }

  _checkBoostPads(entry) {
    const v = entry.vehicle;
    const key = entry;
    const until = this.padCooldown.get(key) ?? 0;
    if (this.time < until) return;
    for (const z of this.world.boostZones || []) {
      let ds = v.s - z.s;
      const L = this.track.length;
      if (ds > L * 0.5) ds -= L;
      if (ds < -L * 0.5) ds += L;
      if (ds >= -1 && ds <= z.length && Math.abs(v.lateral - z.lateral) < z.width * 0.5 + 1.2) {
        v.applyPadBoost?.(1.15, 1.5);
        this.padCooldown.set(key, this.time + 1.2);
        if (entry.isPlayer) this.onPadBoost?.();
        break;
      }
    }
  }

  _checkLap(entry) {
    const v = entry.vehicle;
    const L = this.track.length;
    const done = Math.floor(v.progress / L);
    if (done > entry.lap && v.progress > 0) {
      entry.lap = done;
      const lapTime = this.time - entry.lastLapStart;
      entry.lastLapStart = this.time;
      entry.lapTimes.push(lapTime);
      entry.bestLap = Math.min(entry.bestLap, lapTime);
      if (entry.isPlayer) this.onLap?.(entry.lap, lapTime, entry.bestLap);
      if (entry.lap >= this.laps && !entry.finished) {
        entry.finished = true;
        entry.finishTime = this.time;
        entry.finishPosition = this.entries.filter((e) => e.finished).length;
        if (entry.isPlayer) {
          this.state = RACE_STATE.FINISHED;
          this.onFinish?.(entry);
        }
      }
    }
  }

  _updatePositions() {
    const sorted = [...this.entries].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.vehicle.progress - a.vehicle.progress;
    });
    sorted.forEach((e, i) => { e.position = i + 1; });
    this.standings = sorted;
  }

  /** Current lap fraction for the player, used by the mini-map marker. */
  lapFraction(entry) {
    const L = this.track.length;
    return ((entry.vehicle.progress % L) + L) % L / L;
  }
}

export function formatTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
