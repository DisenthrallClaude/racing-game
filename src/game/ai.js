// AI drivers.
//
// Each opponent follows a racing line derived from the track's curvature
// (turn in wide, clip the apex, drift out), brakes for the speed limit the
// upcoming corners impose, drifts through the tight stuff to bank nitro and
// spends it on the straights. A light rubber band keeps the pack around the
// player without ever making them uncatchable.

import * as THREE from 'three';
import { clamp, smoothstep, makeRng } from '../util/noise.js';

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

export class AIDriver {
  constructor(vehicle, track, opts = {}) {
    this.v = vehicle;
    this.track = track;
    this.skill = opts.skill ?? 0.85;         // 0..1
    this.aggression = opts.aggression ?? 0.9;
    this.rng = makeRng(opts.seed ?? 7);
    this.lineBias = (this.rng() - 0.5) * 0.5;
    this.noisePhase = this.rng() * 100;
    this.driftHold = 0;
    this.boostCooldown = this.rng() * 3;
    this.input = { throttle: 0, brake: 0, steer: 0, drift: false, boost: false };
    this.stuckTimer = 0;
  }

  /** Lateral offset of the ideal line at arc length s. */
  racingLine(s) {
    const w = this.track.widthAtS(s);
    const k = this.track.curvatureAtS(s);
    const kNext = this.track.curvatureAtS(s + 45);
    // Sit on the outside approaching a corner, cut to the inside at the apex.
    const apex = clamp(k * 260, -1, 1);
    const entry = clamp(kNext * 190, -1, 1);
    const offset = (-entry * 0.55 + apex * 0.85) * (w * 0.5 - 3.0);
    return clamp(offset + this.lineBias * w * 0.18, -w * 0.5 + 2.2, w * 0.5 - 2.2);
  }

  update(dt, ctx) {
    const v = this.v;
    const track = this.track;
    const speed = v.speed;

    // ---- target point -----------------------------------------------------
    const lookahead = 12 + speed * 0.62;
    const sT = v.s + lookahead;
    let lateral = this.racingLine(sT);

    // Avoid whoever is directly ahead by picking the roomier side.
    if (ctx?.vehicles) {
      for (const other of ctx.vehicles) {
        if (other === v) continue;
        let ds = other.s - v.s;
        const L = track.length;
        if (ds > L * 0.5) ds -= L;
        if (ds < -L * 0.5) ds += L;
        if (ds > 1 && ds < 26 && Math.abs(other.lateral - v.lateral) < 4.0) {
          const w = track.widthAtS(sT);
          const room = other.lateral > 0 ? -1 : 1;
          lateral = clamp(other.lateral + room * 5.2, -w * 0.5 + 2.4, w * 0.5 - 2.4);
        }
      }
    }

    track.pointAtS(sT, lateral, _p);

    // ---- steering ---------------------------------------------------------
    const dx = _p.x - v.position.x, dz = _p.z - v.position.z;
    const desiredYaw = Math.atan2(dx, dz);
    let diff = desiredYaw - v.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Wobble keeps the pack from looking like it is on rails.
    const wobble = Math.sin(ctx.time * 0.9 + this.noisePhase) * 0.03 * (1 - this.skill);
    this.input.steer = clamp(diff * 2.4 + wobble, -1, 1);

    // ---- speed target -----------------------------------------------------
    const limit = track.speedLimitAtS(v.s, 70 + speed * 1.4, 0.72 + this.skill * 0.5);
    let target = Math.min(limit, v.stats.topSpeed) * (0.86 + this.aggression * 0.16);

    // Rubber band: fall behind and you get a nudge; run away and you ease off.
    if (ctx?.rubberBand !== undefined) target *= ctx.rubberBand;

    if (speed < target - 1.5) {
      this.input.throttle = 1;
      this.input.brake = 0;
    } else if (speed > target + 3.5) {
      this.input.throttle = 0;
      this.input.brake = clamp((speed - target) / 14, 0, 1);
    } else {
      this.input.throttle = 0.55;
      this.input.brake = 0;
    }

    // ---- drifting ---------------------------------------------------------
    // A well-tracking driver's steering *error* stays tiny even in a hairpin,
    // so the decision has to come from the corner itself. Once committed the
    // AI deliberately over-steers into the turn — otherwise the tyres never
    // break traction and it banks no nitro.
    const kNow = track.curvatureAtS(v.s + 14);
    const wantDrift = Math.abs(kNow) > 0.011 && speed > 26 && this.skill > 0.45;
    if (wantDrift) this.driftHold = Math.max(this.driftHold, 0.5);
    this.driftHold = Math.max(0, this.driftHold - dt);
    this.input.drift = this.driftHold > 0;
    if (this.input.drift) {
      // Positive steer raises yaw, which corresponds to negative curvature.
      const into = -Math.sign(kNow);
      this.input.steer = clamp(this.input.steer + into * 0.34, -1, 1);
    }

    // ---- nitro ------------------------------------------------------------
    this.boostCooldown -= dt;
    const straightAhead = Math.abs(track.curvatureAtS(v.s + 60)) < 0.006;
    this.input.boost = v.nitro > 0 && straightAhead && this.boostCooldown <= 0 && speed > 30;
    if (this.input.boost) this.boostCooldown = 2.6 + this.rng() * 2.5;

    // ---- unstick ----------------------------------------------------------
    if (speed < 3 && this.input.throttle > 0.4) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 2.4) { v.respawn(); this.stuckTimer = 0; }
    } else {
      this.stuckTimer = 0;
    }

    return this.input;
  }
}

export const AI_NAMES = [
  '风间·凛', '夜光·K', '苍岚', '赤羽', '流星·S',
  '幻音', '疾影', '白鸦', '雷刻', '零度',
];
