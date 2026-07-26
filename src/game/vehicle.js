// The car: a lofted body with clear-coat paint, and an arcade physics model
// tuned for the drift-to-charge-nitro loop the genre is built on.
//
// Physics summary
//   * heading is a yaw angle; a bicycle model turns it from steering input
//   * grip pulls velocity toward the heading — dropping grip is what makes
//     the car slide, and holding a slide charges nitro
//   * gravity is resolved against the road normal, so banking pulls you into
//     the corner and hills genuinely cost or give speed
//   * leaving the tarmac drops grip and top speed; hitting a barrier scrubs
//     speed and kicks the car back onto the road

import * as THREE from 'three';
import { clamp, smoothstep, TAU } from '../util/noise.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 22.0;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Loft a car body from a stack of superellipse cross-sections. */
function bodyGeometry(profile, ringPoints = 16) {
  const pos = [], nrm = [], uv = [], idx = [];
  const stations = profile.length;
  for (let i = 0; i < stations; i++) {
    const st = profile[i];
    for (let k = 0; k < ringPoints; k++) {
      const a = (k / ringPoints) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Superellipse keeps corners crisp at the sills and soft over the roof.
      const n = st.n ?? 2.6;
      const ex = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n);
      const ey = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n);
      const x = ex * st.w;
      const y = st.y + (ey > 0 ? ey * st.hUp : ey * st.hDn);
      pos.push(x, y, st.z);
      nrm.push(ex, ey, 0);
      uv.push(k / ringPoints, i / (stations - 1));
    }
  }
  for (let i = 0; i < stations - 1; i++) {
    for (let k = 0; k < ringPoints; k++) {
      const k2 = (k + 1) % ringPoints;
      const a = i * ringPoints + k, b = i * ringPoints + k2;
      const c = (i + 1) * ringPoints + k, d = (i + 1) * ringPoints + k2;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Cap the nose and tail.
  const capStart = pos.length / 3;
  for (const [st, dir] of [[0, -1], [stations - 1, 1]]) {
    const base = st * ringPoints;
    const centreIdx = pos.length / 3;
    const s = profile[st];
    pos.push(0, s.y, s.z);
    nrm.push(0, 0, dir);
    uv.push(0.5, 0.5);
    for (let k = 0; k < ringPoints; k++) {
      const k2 = (k + 1) % ringPoints;
      if (dir < 0) idx.push(centreIdx, base + k2, base + k);
      else idx.push(centreIdx, base + k, base + k2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export const CAR_PRESETS = [
  {
    id: 'blade', name: '疾风·BLADE', color: 0xff3b3b, accent: 0xffe066,
    topSpeed: 78, accel: 26, grip: 1.0, handling: 1.0,
    blurb: '均衡型 · 起步迅猛，操控稳定',
  },
  {
    id: 'aurora', name: '极光·AURORA', color: 0x2ec4ff, accent: 0xa6f4ff,
    topSpeed: 86, accel: 22, grip: 0.94, handling: 0.92,
    blurb: '极速型 · 直线之王，过弯稍沉',
  },
  {
    id: 'phantom', name: '幻影·PHANTOM', color: 0xb64bff, accent: 0xffb3f0,
    topSpeed: 74, accel: 29, grip: 1.08, handling: 1.12,
    blurb: '漂移型 · 转向锐利，集气极快',
  },
];

function buildCarMesh(preset) {
  const g = new THREE.Group();
  const L = 4.5;

  const profile = [
    { z: -L * 0.50, y: 0.42, w: 0.72, hUp: 0.20, hDn: 0.20, n: 3.0 },
    { z: -L * 0.40, y: 0.44, w: 0.88, hUp: 0.28, hDn: 0.26, n: 3.0 },
    { z: -L * 0.22, y: 0.46, w: 0.96, hUp: 0.34, hDn: 0.30, n: 3.2 },
    { z: -L * 0.05, y: 0.48, w: 1.00, hUp: 0.36, hDn: 0.32, n: 3.4 },
    { z: L * 0.10, y: 0.48, w: 1.00, hUp: 0.34, hDn: 0.32, n: 3.4 },
    { z: L * 0.24, y: 0.46, w: 0.95, hUp: 0.30, hDn: 0.30, n: 3.2 },
    { z: L * 0.38, y: 0.44, w: 0.84, hUp: 0.24, hDn: 0.26, n: 3.0 },
    { z: L * 0.50, y: 0.42, w: 0.66, hUp: 0.16, hDn: 0.20, n: 2.8 },
  ];

  const paint = new THREE.MeshPhysicalMaterial({
    color: preset.color,
    metalness: 0.62,
    roughness: 0.24,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.6,
    sheen: 0.3,
    sheenColor: new THREE.Color(preset.accent),
  });
  const body = new THREE.Mesh(bodyGeometry(profile), paint);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Cabin: a smaller loft in smoked glass sitting on the deck.
  const cabinProfile = [
    { z: -L * 0.18, y: 0.78, w: 0.60, hUp: 0.06, hDn: 0.16, n: 3.0 },
    { z: -L * 0.05, y: 0.86, w: 0.76, hUp: 0.14, hDn: 0.22, n: 3.2 },
    { z: L * 0.10, y: 0.86, w: 0.78, hUp: 0.14, hDn: 0.22, n: 3.2 },
    { z: L * 0.26, y: 0.74, w: 0.62, hUp: 0.06, hDn: 0.18, n: 3.0 },
  ];
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x101820, metalness: 0.2, roughness: 0.06,
    transmission: 0.55, thickness: 0.4, transparent: true, opacity: 0.86,
    envMapIntensity: 2.0, clearcoat: 1.0,
  });
  const cabin = new THREE.Mesh(bodyGeometry(cabinProfile, 14), glass);
  cabin.castShadow = true;
  g.add(cabin);

  // Accent stripes running over the nose and deck.
  const stripeMat = new THREE.MeshPhysicalMaterial({
    color: preset.accent, metalness: 0.5, roughness: 0.3,
    clearcoat: 1.0, emissive: new THREE.Color(preset.accent), emissiveIntensity: 0.12,
  });
  for (const sx of [-0.26, 0.26]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, L * 0.94), stripeMat);
    stripe.position.set(sx, 0.83, 0);
    g.add(stripe);
  }

  // Splitter, diffuser and side skirts in carbon.
  const carbon = new THREE.MeshStandardMaterial({ color: 0x14161b, metalness: 0.5, roughness: 0.42 });
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.55), carbon);
  splitter.position.set(0, 0.22, L * 0.5);
  g.add(splitter);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.24, 0.5), carbon);
  diffuser.position.set(0, 0.3, -L * 0.5 + 0.1);
  g.add(diffuser);
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, L * 0.6), carbon);
    skirt.position.set(sx * 0.97, 0.26, 0);
    g.add(skirt);
  }

  // Rear wing on swan-neck mounts.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.07, 0.42), carbon);
  wing.position.set(0, 1.05, -L * 0.46);
  wing.rotation.x = -0.16;
  wing.castShadow = true;
  g.add(wing);
  for (const sx of [-0.7, 0.7]) {
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.2), carbon);
    mount.position.set(sx, 0.88, -L * 0.44);
    g.add(mount);
  }

  // Lights
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xdfefff, emissiveIntensity: 4.0, roughness: 0.15,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x33060a, emissive: 0xff1830, emissiveIntensity: 3.0, roughness: 0.25,
  });
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.1), headMat);
    head.position.set(sx * 0.62, 0.62, L * 0.49);
    g.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.08), tailMat);
    tail.position.set(sx * 0.6, 0.66, -L * 0.5);
    g.add(tail);
  }

  // Exhaust nozzles — these flare when nitro fires.
  const nozzleMat = new THREE.MeshStandardMaterial({
    color: 0x2a2f38, metalness: 1.0, roughness: 0.3,
    emissive: new THREE.Color(0x3fd0ff), emissiveIntensity: 0.0,
  });
  const nozzles = [];
  for (const sx of [-0.42, 0.42]) {
    const n = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.3, 12), nozzleMat);
    n.rotation.x = Math.PI / 2;
    n.position.set(sx, 0.42, -L * 0.52);
    g.add(n);
    nozzles.push(n);
  }

  // Wheels: treaded tyre plus a spoked rim.
  const wheels = [];
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.92, metalness: 0.0 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xcfd6e0, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.8,
  });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x551208, emissive: 0xff3a10, emissiveIntensity: 0.0, roughness: 0.5,
  });
  const tyreGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.34, 22, 1);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.36, 16, 1);
  rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.37, 0.06, 0.5);

  const wheelPositions = [
    [-0.98, 0.46, L * 0.32, 'FL'], [0.98, 0.46, L * 0.32, 'FR'],
    [-1.02, 0.46, -L * 0.30, 'RL'], [1.02, 0.46, -L * 0.30, 'RR'],
  ];
  for (const [x, y, z, tag] of wheelPositions) {
    const hub = new THREE.Group();
    hub.position.set(x, y, z);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, tyreMat);
    tyre.castShadow = true;
    spin.add(tyre);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    spin.add(rim);
    for (let s = 0; s < 5; s++) {
      const sp = new THREE.Mesh(spokeGeo, rimMat);
      sp.rotation.x = (s / 5) * Math.PI;
      spin.add(sp);
    }
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 16), brakeMat);
    disc.rotateZ(Math.PI / 2);
    disc.position.x = x > 0 ? -0.1 : 0.1;
    spin.add(disc);
    hub.add(spin);
    g.add(hub);
    wheels.push({ hub, spin, tag, front: tag[0] === 'F', side: Math.sign(x) });
  }

  // Under-glow strip: pure style, and it sells the nitro state at night.
  const glowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(preset.accent), transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, L * 0.95), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  g.add(glow);

  return { group: g, wheels, nozzles, nozzleMat, glowMat, brakeMat, paint, headMat, tailMat };
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

export class Vehicle {
  constructor(track, terrain, preset, opts = {}) {
    this.track = track;
    this.terrain = terrain;
    this.preset = preset;
    this.isPlayer = !!opts.isPlayer;

    const built = buildCarMesh(preset);
    this.mesh = built.group;
    this.parts = built;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.vy = 0;
    this.grounded = true;
    this.airTime = 0;
    this.surfaceNormal = new THREE.Vector3(0, 1, 0);
    this.rideHeight = 0.05;

    this.steer = 0;
    this.wheelSpin = 0;
    this.drifting = false;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.driftLevel = 0;
    this.driftTime = 0;
    this.nitro = 0;
    this.maxNitro = 3;
    this.boostTimer = 0;
    this.boostStrength = 0;
    this.offroad = false;
    this.wallHit = 0;
    this.lastImpact = 0;
    this.respawnTimer = 0;

    this.trackHint = -1;
    this.surf = {};
    this.s = 0;
    this.lateral = 0;
    this.lap = 0;
    this.progress = 0;      // total distance travelled along the spline
    this.prevS = 0;

    // Roll/pitch are visual only, driven from lateral load and acceleration.
    this.visualRoll = 0;
    this.visualPitch = 0;

    this.stats = {
      topSpeed: preset.topSpeed * (opts.speedScale ?? 1),
      accel: preset.accel * (opts.accelScale ?? 1),
      grip: preset.grip * (opts.gripScale ?? 1),
      handling: preset.handling,
    };
  }

  placeAtS(s, lateral = 0) {
    this.track.pointAtS(s, lateral, this.position);
    const t = this.track.tangentAtS(s, _v);
    this.yaw = Math.atan2(t.x, t.z);
    this.velocity.set(0, 0, 0);
    this.vy = 0;
    this.s = s;
    this.prevS = s;
    this.progress = s;
    this.position.y += this.rideHeight;
    this.mesh.position.copy(this.position);
    this.trackHint = -1;
  }

  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get speedKmh() { return this.speed * 3.6; }

  respawn() {
    const s = this.s;
    this.track.pointAtS(s, clamp(this.lateral, -4, 4), this.position);
    this.position.y += 1.2;
    const t = this.track.tangentAtS(s, _v);
    this.yaw = Math.atan2(t.x, t.z);
    this.velocity.set(t.x, 0, t.z).multiplyScalar(12);
    this.vy = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.boostTimer = 0;
    this.respawnTimer = 0;
  }

  update(dt, input) {
    const st = this.stats;

    // ---- surface query -----------------------------------------------------
    const surf = this.track.sampleAt(this.position.x, this.position.z, this.trackHint, this.surf);
    let groundY, normal = this.surfaceNormal;
    if (surf) {
      this.trackHint = surf.index;
      this.s = surf.s;
      this.lateral = surf.lateral;
      this.onRoad = surf.onRoad;
      const halfW = surf.width * 0.5;
      if (surf.onRoad) {
        groundY = surf.height;
        normal.copy(surf.normal);
      } else {
        const edge = Math.abs(surf.lateral) - halfW;
        const terrainY = this.terrain.heightAt(this.position.x, this.position.z, surf.index);
        // Blend across the verge so dropping a wheel isn't a vertical step.
        const k = smoothstep(0, 3.0, edge);
        groundY = surf.height * (1 - k) + terrainY * k;
        normal.copy(surf.normal).lerp(UP, k * 0.7).normalize();
      }
      this.offroad = !surf.onRoad;
    } else {
      groundY = this.terrain.heightAt(this.position.x, this.position.z);
      normal.set(0, 1, 0);
      this.offroad = true;
    }

    // ---- vertical / airborne ----------------------------------------------
    const targetY = groundY + this.rideHeight;
    if (this.position.y > targetY + 0.12) {
      this.grounded = false;
      this.airTime += dt;
      this.vy -= GRAVITY * dt;
    } else {
      if (!this.grounded) {
        this.lastImpact = Math.min(1, Math.abs(this.vy) / 18);
        this.airTime = 0;
      }
      this.grounded = true;
      this.vy = Math.max(this.vy, 0);
    }
    this.position.y += this.vy * dt;
    if (this.position.y < targetY) {
      // Suspension: snap up quickly but not instantly, so crests feel springy.
      this.position.y += (targetY - this.position.y) * Math.min(1, dt * 26);
      this.vy = 0;
      this.grounded = true;
    }

    // Fell off the world -> auto respawn.
    if (this.position.y < groundY - 60 || this.position.y < -600) {
      this.respawnTimer += dt;
      if (this.respawnTimer > 0.6) this.respawn();
    } else {
      this.respawnTimer = 0;
    }

    // ---- heading & steering ------------------------------------------------
    const speed = this.speed;
    const heading = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    const steerTarget = clamp(input.steer, -1, 1);
    const steerRate = this.drifting ? 9.0 : 7.0;
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * steerRate);

    // Steering authority falls off with speed — otherwise the car is twitchy.
    const speedFactor = 0.42 + 0.58 * Math.exp(-speed / 34);
    const maxSteerAngle = 0.62 * st.handling * speedFactor;
    const steerAngle = this.steer * maxSteerAngle;

    // ---- drift state -------------------------------------------------------
    const wantDrift = input.drift && speed > 9 && this.grounded;
    if (wantDrift && !this.drifting) {
      // Entering a drift needs a direction; steering picks it, otherwise the
      // current lateral slide does.
      const dir = Math.abs(this.steer) > 0.15 ? Math.sign(this.steer) : 0;
      if (dir !== 0) {
        this.drifting = true;
        this.driftDir = dir;
        this.driftTime = 0;
        // A kick of yaw to break traction, like the genre's tap-drift.
        this.yaw += dir * 0.12;
      }
    }
    if (this.drifting) {
      this.driftTime += dt;
      const holding = input.drift && speed > 7 && this.grounded;
      const opposite = this.steer * this.driftDir < -0.55;
      if (!holding || opposite) {
        this.drifting = false;
        this.releaseDrift();
      }
    }

    if (this.grounded) {
      // Bicycle-model yaw, with an extra rotation term while drifting so the
      // car rotates faster than the velocity vector follows.
      const wheelbase = 2.9;
      let yawRate = (speed / wheelbase) * Math.tan(steerAngle);
      if (this.drifting) {
        const push = clamp(0.4 + this.driftTime * 0.8, 0, 1.4);
        yawRate += this.driftDir * push * (0.7 + speed / 90) * st.handling;
        // Counter-steering out of the slide tightens or opens the arc.
        yawRate += this.steer * 0.55 * st.handling;
      }
      this.yaw += yawRate * dt;
    } else {
      // Mild air control keeps big jumps landable.
      this.yaw += this.steer * 1.1 * dt;
    }

    heading.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // ---- longitudinal ------------------------------------------------------
    let fwd = this.velocity.x * heading.x + this.velocity.z * heading.z;

    if (this.boostTimer > 0) {
      this.boostTimer -= dt;
      if (this.boostTimer <= 0) this.boostStrength = 0;
    }
    const boosting = this.boostTimer > 0;

    const surfaceGrip = this.offroad ? 0.5 : 1.0;
    const topSpeed = st.topSpeed * (boosting ? 1.0 + 0.28 * this.boostStrength : 1.0)
                                 * (this.offroad ? 0.6 : 1.0)
                                 * (this.drifting ? 0.94 : 1.0);

    if (this.grounded) {
      const throttle = clamp(input.throttle, 0, 1);
      const brake = clamp(input.brake, 0, 1);
      const powerCurve = 1 - clamp(fwd / Math.max(topSpeed, 1), 0, 1);
      let accel = throttle * st.accel * (0.35 + 0.65 * powerCurve) * (this.offroad ? 0.55 : 1);
      // Nitro scales the whole torque curve rather than adding a constant, so
      // it stays a percentage gain instead of running away at high speed.
      if (boosting) accel *= 1.0 + 0.7 * this.boostStrength;
      fwd += accel * dt;

      if (brake > 0) {
        if (fwd > 0.5) fwd -= brake * 34 * dt;
        else fwd -= brake * 12 * dt;       // reverse
        fwd = Math.max(fwd, -11);
      }
      // Rolling resistance and aero drag set the real terminal velocity.
      fwd -= (this.offroad ? 5.2 : 1.1) * dt * Math.sign(fwd) * Math.min(Math.abs(fwd), 3);
      fwd -= 0.0012 * fwd * Math.abs(fwd) * dt;
      // Drifting must cost *some* speed or it would dominate, but not so much
      // that banking nitro is a net loss.
      fwd *= 1 - Math.min(0.6, (this.drifting ? 0.24 : 0.06) * dt);
    } else {
      fwd *= 1 - Math.min(0.4, 0.05 * dt);
    }

    // ---- lateral grip ------------------------------------------------------
    const lat = _v2.copy(this.velocity).addScaledVector(heading, -fwd);
    let gripCoef;
    if (!this.grounded) gripCoef = 0.35;
    else if (this.drifting) gripCoef = 2.0 * surfaceGrip * st.grip;
    else gripCoef = 11.0 * surfaceGrip * st.grip;
    lat.multiplyScalar(Math.max(0, 1 - gripCoef * dt));

    this.velocity.copy(lat).addScaledVector(heading, fwd);

    // ---- slope / banking ---------------------------------------------------
    if (this.grounded) {
      // Component of gravity in the road plane. On a banked corner this points
      // downhill toward the inside, which is exactly the assist real banking
      // gives, and it also makes climbs and descents matter.
      const gDotN = -GRAVITY * normal.y;
      const slopeAccel = _v2.set(0, -GRAVITY, 0).addScaledVector(normal, -gDotN);
      this.velocity.x += slopeAccel.x * dt * 0.55;
      this.velocity.z += slopeAccel.z * dt * 0.55;
    }

    // ---- integrate ---------------------------------------------------------
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // ---- barrier collision -------------------------------------------------
    // Re-sample after integrating: at 400 km/h the car covers ~2 m per frame,
    // and testing against the pre-integration offset would let it clip through
    // the rail on tight corners.
    this.wallHit = Math.max(0, this.wallHit - dt * 3);
    const post = this.track.sampleAt(this.position.x, this.position.z, this.trackHint, this._post || (this._post = {}));
    if (post) {
      this.trackHint = post.index;
      this.s = post.s;
      this.lateral = post.lateral;
      this.onRoad = post.onRoad;
      const limit = post.width * 0.5 + 1.6;
      if (Math.abs(this.lateral) > limit) {
        const over = Math.abs(this.lateral) - limit;
        const side = Math.sign(this.lateral);
        const right = post.right;
        // Push back onto the road and kill the outward velocity component.
        this.position.addScaledVector(right, -side * over * Math.min(1, dt * 40 + 0.15));
        const outward = this.velocity.x * right.x * side + this.velocity.z * right.z * side;
        if (outward > 0) {
          this.velocity.addScaledVector(right, -side * outward * 1.5);
          const scrub = clamp(outward / 24, 0.05, 0.55);
          this.velocity.multiplyScalar(1 - scrub);
          this.wallHit = Math.min(1, this.wallHit + scrub * 2.4);
          this.drifting = false;
          this.driftCharge *= 0.4;
        }
        // Scrape along the wall so you can still creep forward.
        this.velocity.multiplyScalar(1 - Math.min(0.9, 1.6 * dt));
      }
    }

    // ---- lap progress ------------------------------------------------------
    if (post) {
      let ds = this.s - this.prevS;
      const half = this.track.length * 0.5;
      if (ds > half) ds -= this.track.length;
      if (ds < -half) ds += this.track.length;
      this.progress += ds;
      this.prevS = this.s;
    }

    // ---- nitro -------------------------------------------------------------
    if (this.drifting) {
      const slide = Math.abs(lat.length());
      this.driftCharge += clamp(slide / 12, 0, 1.3) * dt * (this.preset.id === 'phantom' ? 1.35 : 1.0);
      this.driftLevel = this.driftCharge < 0.9 ? 0 : this.driftCharge < 1.9 ? 1 : 2;
    } else {
      this.driftLevel = 0;
    }
    if (input.boost && this.nitro > 0 && this.boostTimer <= 0.25) {
      this.nitro--;
      this.boostTimer = 2.1;
      this.boostStrength = 1.0;
      this.onBoost?.();
    }

    this._updateVisuals(dt, normal, fwd, lat.length());
    return { surf, lateralSlide: lat.length() };
  }

  /** Instant boost from a pad — stacks with, but does not consume, nitro. */
  applyPadBoost(strength = 1.2, time = 1.6) {
    this.boostTimer = Math.max(this.boostTimer, time);
    this.boostStrength = Math.max(this.boostStrength, strength);
  }

  releaseDrift() {
    if (this.driftCharge > 0.55) {
      const gained = this.driftCharge < 1.4 ? 1 : this.driftCharge < 2.4 ? 2 : 3;
      this.nitro = Math.min(this.maxNitro, this.nitro + gained);
      this.onDriftBanked?.(gained);
    }
    this.driftCharge = 0;
    this.driftTime = 0;
  }

  _updateVisuals(dt, normal, fwd, slide) {
    this.mesh.position.copy(this.position);

    // Align the chassis to the surface, then apply yaw around that normal.
    const up = this.grounded ? normal : UP;
    _q.setFromUnitVectors(UP, up);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(up, this.yaw);
    this.mesh.quaternion.copy(yawQ).multiply(_q);

    // Body roll from lateral load, pitch from acceleration.
    const targetRoll = clamp(-slide * 0.028 * Math.sign(this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw)), -0.22, 0.22);
    const targetPitch = clamp((this._lastFwd !== undefined ? (fwd - this._lastFwd) / Math.max(dt, 1e-3) : 0) * -0.0035, -0.1, 0.1);
    this._lastFwd = fwd;
    this.visualRoll += (targetRoll - this.visualRoll) * Math.min(1, dt * 6);
    this.visualPitch += (targetPitch - this.visualPitch) * Math.min(1, dt * 5);
    this.mesh.rotateZ(this.visualRoll);
    this.mesh.rotateX(this.visualPitch);

    // Wheels
    const wheelSpeed = fwd / 0.46;
    this.wheelSpin += wheelSpeed * dt;
    for (const w of this.parts.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      if (w.front) {
        w.hub.rotation.y = this.steer * 0.5 + (this.drifting ? this.driftDir * -0.18 : 0);
      }
    }

    // Nitro visuals
    const boosting = this.boostTimer > 0;
    const nozzleGlow = boosting ? 6.0 : this.drifting ? 1.2 + this.driftLevel * 1.4 : 0.0;
    this.parts.nozzleMat.emissiveIntensity += (nozzleGlow - this.parts.nozzleMat.emissiveIntensity) * Math.min(1, dt * 12);
    const driftColor = this.driftLevel === 0 ? 0x3fd0ff : this.driftLevel === 1 ? 0xff8a2b : 0xff3ea5;
    this.parts.nozzleMat.emissive.lerp(new THREE.Color(boosting ? 0x9fe8ff : driftColor), Math.min(1, dt * 8));
    this.parts.glowMat.opacity += ((boosting ? 0.85 : this.drifting ? 0.4 : 0.12) - this.parts.glowMat.opacity) * Math.min(1, dt * 8);
    this.parts.brakeMat.emissiveIntensity += (((this._braking ? 3.0 : 0) + (this.drifting ? 1.5 : 0)) - this.parts.brakeMat.emissiveIntensity) * Math.min(1, dt * 10);
    this.parts.tailMat.emissiveIntensity = this._braking ? 6.0 : 3.0;
  }

  setBraking(b) { this._braking = b; }
}
