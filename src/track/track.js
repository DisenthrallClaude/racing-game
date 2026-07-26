// Track geometry: an arc-length parameterised spline that carries width,
// banking, surface type and elevation, plus the meshes built from it
// (asphalt ribbon with painted markings, curbs, verge skirts, barriers,
// tunnels, support pylons, boost pads) and the surface query the vehicle
// physics runs against every frame.

import * as THREE from 'three';
import { clamp, smoothstep } from '../util/noise.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Catmull-Rom interpolation of a scalar array treated as a closed loop. */
function catmullScalar(arr, t) {
  const n = arr.length;
  const f = t * n;
  const i1 = Math.floor(f) % n;
  const frac = f - Math.floor(f);
  const i0 = (i1 - 1 + n) % n;
  const i2 = (i1 + 1) % n;
  const i3 = (i1 + 2) % n;
  const p0 = arr[i0], p1 = arr[i1], p2 = arr[i2], p3 = arr[i3];
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = frac * frac, t3 = t2 * frac;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * frac + p1;
}

export class Track {
  /**
   * @param {object} def track definition from tracks.js
   */
  constructor(def) {
    this.def = def;
    this.name = def.name;

    const pts = def.points.map((p) => new THREE.Vector3(p.p[0], p.p[1], p.p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.length = this.curve.getLength();

    this.widths = def.points.map((p) => p.w ?? def.width ?? 16);
    this.banks = def.points.map((p) => (p.bank ?? null));
    this.kinds = def.points.map((p) => p.kind ?? 'road');

    this.sampleStep = 2.0;
    this.count = Math.max(64, Math.round(this.length / this.sampleStep));
    this.sampleStep = this.length / this.count;

    this._buildFrames();
    this._buildGrid();
  }

  _buildFrames() {
    const N = this.count;
    this.pos = new Float32Array(N * 3);
    this.tan = new Float32Array(N * 3);
    this.up = new Float32Array(N * 3);
    this.right = new Float32Array(N * 3);
    this.width = new Float32Array(N);
    this.bank = new Float32Array(N);
    this.curvature = new Float32Array(N);
    this.kindFlags = new Uint8Array(N); // 1 = bridge, 2 = tunnel

    const curve = this.curve;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const u = i / N;
      pts.push(curve.getPointAt(u));
    }

    // Tangents from central differences on the uniform samples.
    for (let i = 0; i < N; i++) {
      const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
      _v0.subVectors(b, a).normalize();
      this.tan[i * 3] = _v0.x; this.tan[i * 3 + 1] = _v0.y; this.tan[i * 3 + 2] = _v0.z;
      this.pos[i * 3] = pts[i].x; this.pos[i * 3 + 1] = pts[i].y; this.pos[i * 3 + 2] = pts[i].z;
    }

    // Signed horizontal curvature -> automatic banking.
    for (let i = 0; i < N; i++) {
      const ia = (i - 1 + N) % N, ib = (i + 1) % N;
      _v0.set(this.tan[ia * 3], 0, this.tan[ia * 3 + 2]).normalize();
      _v1.set(this.tan[ib * 3], 0, this.tan[ib * 3 + 2]).normalize();
      const cross = _v0.x * _v1.z - _v0.z * _v1.x;
      const dot = clamp(_v0.dot(_v1), -1, 1);
      const dtheta = Math.atan2(cross, dot);
      this.curvature[i] = dtheta / (this.sampleStep * 2);
    }
    // Light smoothing only: a wide window would average genuine short
    // corners away, and corner curvature is what the drift system reads.
    const smooth = new Float32Array(N);
    const R = Math.max(2, Math.round(9 / this.sampleStep));
    for (let i = 0; i < N; i++) {
      let s = 0, w = 0;
      for (let k = -R; k <= R; k++) {
        const wk = 1 - Math.abs(k) / (R + 1);
        s += this.curvature[(i + k + N) % N] * wk;
        w += wk;
      }
      smooth[i] = s / w;
    }
    this.curvature.set(smooth);

    const maxBank = (this.def.maxBank ?? 26) * Math.PI / 180;
    // Degrees of banking per unit curvature. Linear rather than the physical
    // atan(v²k/g), which saturates at max bank on every corner tighter than
    // ~150 m and would leave the whole circuit tilted.
    const bankGain = this.def.bankGain ?? 1100;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      this.width[i] = catmullScalar(this.widths, u);

      const explicit = this._explicitBank(u);
      let bank;
      if (explicit !== null) {
        bank = explicit * Math.PI / 180;
      } else {
        const k = this.curvature[i];
        bank = clamp(-k * bankGain * Math.PI / 180, -maxBank, maxBank);
      }
      this.bank[i] = bank;

      const kind = this._kindAt(u);
      this.kindFlags[i] = kind === 'bridge' ? 1 : kind === 'tunnel' ? 2 : 0;
    }
    // Smooth banking too — abrupt roll makes the car pop.
    const bs = new Float32Array(N);
    const BR = Math.max(2, Math.round(26 / this.sampleStep));
    for (let i = 0; i < N; i++) {
      let s = 0, w = 0;
      for (let k = -BR; k <= BR; k++) {
        const wk = 1 - Math.abs(k) / (BR + 1);
        s += this.bank[(i + k + N) % N] * wk;
        w += wk;
      }
      bs[i] = s / w;
    }
    this.bank.set(bs);

    // Parallel-transport an up vector around the loop to avoid twist popping.
    let up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < N; i++) {
      _v0.set(this.tan[i * 3], this.tan[i * 3 + 1], this.tan[i * 3 + 2]);
      // Project previous up onto the plane perpendicular to the tangent.
      up.addScaledVector(_v0, -up.dot(_v0));
      if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
      up.normalize();
      const right = _v1.crossVectors(_v0, up).normalize().clone();
      const bankedUp = up.clone().applyAxisAngle(_v0, this.bank[i]);
      const bankedRight = right.clone().applyAxisAngle(_v0, this.bank[i]);
      this.up[i * 3] = bankedUp.x; this.up[i * 3 + 1] = bankedUp.y; this.up[i * 3 + 2] = bankedUp.z;
      this.right[i * 3] = bankedRight.x; this.right[i * 3 + 1] = bankedRight.y; this.right[i * 3 + 2] = bankedRight.z;
    }
  }

  _explicitBank(u) {
    const n = this.banks.length;
    const f = u * n;
    const i1 = Math.floor(f) % n;
    const i2 = (i1 + 1) % n;
    if (this.banks[i1] === null && this.banks[i2] === null) return null;
    const a = this.banks[i1] ?? 0;
    const b = this.banks[i2] ?? 0;
    const frac = f - Math.floor(f);
    const t = frac * frac * (3 - 2 * frac);
    return a + (b - a) * t;
  }

  _kindAt(u) {
    const n = this.kinds.length;
    const i = Math.floor(u * n) % n;
    return this.kinds[i];
  }

  // --- spatial acceleration ------------------------------------------------
  _buildGrid() {
    this.cellSize = 26;
    this.grid = new Map();
    const add = (x, z, i) => {
      const cx = Math.floor(x / this.cellSize), cz = Math.floor(z / this.cellSize);
      const key = cx * 73856093 ^ cz * 19349663;
      let bucket = this.grid.get(key);
      if (!bucket) { bucket = []; this.grid.set(key, bucket); }
      if (bucket[bucket.length - 1] !== i) bucket.push(i);
    };
    for (let i = 0; i < this.count; i++) {
      const px = this.pos[i * 3], pz = this.pos[i * 3 + 2];
      const rx = this.right[i * 3], rz = this.right[i * 3 + 2];
      const hw = this.width[i] * 0.5 + 8;
      add(px, pz, i);
      add(px + rx * hw, pz + rz * hw, i);
      add(px - rx * hw, pz - rz * hw, i);
      add(px + rx * hw * 0.5, pz + rz * hw * 0.5, i);
      add(px - rx * hw * 0.5, pz - rz * hw * 0.5, i);
    }
  }

  /** Nearest sample index to a world XZ position, or -1 if far from the track. */
  nearestIndex(x, z, hint = -1) {
    // Local search around the hint first — the vehicle moves continuously so
    // this hits almost every frame and costs a handful of comparisons.
    if (hint >= 0) {
      const R = 30;
      let best = -1, bestD = Infinity;
      for (let k = -R; k <= R; k++) {
        const i = (hint + k + this.count) % this.count;
        const dx = x - this.pos[i * 3], dz = z - this.pos[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD < (this.cellSize * 2.2) ** 2) return best;
    }
    const cx = Math.floor(x / this.cellSize), cz = Math.floor(z / this.cellSize);
    let best = -1, bestD = Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const key = (cx + i) * 73856093 ^ (cz + j) * 19349663;
        const bucket = this.grid.get(key);
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const s = bucket[b];
          const dx = x - this.pos[s * 3], dz = z - this.pos[s * 3 + 2];
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    return best;
  }

  /**
   * Sample the road surface beneath a world position.
   * @returns {{index, s, lateral, height, normal, tangent, width, onRoad, curvature, bank}|null}
   */
  sampleAt(x, z, hint = -1, out = {}) {
    const i = this.nearestIndex(x, z, hint);
    if (i < 0) return null;

    // Refine between the neighbouring samples by projecting onto the segment.
    const i2 = (i + 1) % this.count;
    const ax = this.pos[i * 3], ay = this.pos[i * 3 + 1], az = this.pos[i * 3 + 2];
    const bx = this.pos[i2 * 3], by = this.pos[i2 * 3 + 1], bz = this.pos[i2 * 3 + 2];
    const ex = bx - ax, ez = bz - az;
    const segLen2 = ex * ex + ez * ez || 1;
    let t = ((x - ax) * ex + (z - az) * ez) / segLen2;
    let idx = i, frac = clamp(t, 0, 1);
    if (t < 0) {
      const i0 = (i - 1 + this.count) % this.count;
      const cx = this.pos[i0 * 3], cz = this.pos[i0 * 3 + 2];
      const dx = ax - cx, dz = az - cz;
      const l2 = dx * dx + dz * dz || 1;
      const t0 = clamp(((x - cx) * dx + (z - cz) * dz) / l2, 0, 1);
      idx = i0; frac = t0;
    }

    const j = idx, k = (idx + 1) % this.count;
    const lerp3 = (arr, o) => {
      o.set(
        arr[j * 3] + (arr[k * 3] - arr[j * 3]) * frac,
        arr[j * 3 + 1] + (arr[k * 3 + 1] - arr[j * 3 + 1]) * frac,
        arr[j * 3 + 2] + (arr[k * 3 + 2] - arr[j * 3 + 2]) * frac,
      );
      return o;
    };

    const p = lerp3(this.pos, out.point || (out.point = new THREE.Vector3()));
    const tang = lerp3(this.tan, out.tangent || (out.tangent = new THREE.Vector3())).normalize();
    const upv = lerp3(this.up, out.normal || (out.normal = new THREE.Vector3())).normalize();
    const rightv = lerp3(this.right, out.right || (out.right = new THREE.Vector3())).normalize();

    const dx = x - p.x, dz = z - p.z;
    const lateral = dx * rightv.x + dz * rightv.z;
    const w = this.width[j] + (this.width[k] - this.width[j]) * frac;

    // Height on the banked plane at this lateral offset.
    const horizLen = Math.hypot(rightv.x, rightv.z) || 1;
    const height = p.y + lateral * (rightv.y / horizLen);

    out.index = j;
    out.s = (j + frac) * this.sampleStep;
    out.lateral = lateral;
    out.height = height;
    out.width = w;
    out.onRoad = Math.abs(lateral) <= w * 0.5;
    out.curvature = this.curvature[j];
    out.bank = this.bank[j];
    out.kind = this.kindFlags[j];
    return out;
  }

  /** World position on the centre line at arc length s, offset laterally. */
  pointAtS(s, lateral = 0, target = new THREE.Vector3()) {
    const f = ((s / this.sampleStep) % this.count + this.count) % this.count;
    const j = Math.floor(f), k = (j + 1) % this.count;
    const t = f - j;
    target.set(
      this.pos[j * 3] + (this.pos[k * 3] - this.pos[j * 3]) * t,
      this.pos[j * 3 + 1] + (this.pos[k * 3 + 1] - this.pos[j * 3 + 1]) * t,
      this.pos[j * 3 + 2] + (this.pos[k * 3 + 2] - this.pos[j * 3 + 2]) * t,
    );
    if (lateral !== 0) {
      _v0.set(
        this.right[j * 3] + (this.right[k * 3] - this.right[j * 3]) * t,
        this.right[j * 3 + 1] + (this.right[k * 3 + 1] - this.right[j * 3 + 1]) * t,
        this.right[j * 3 + 2] + (this.right[k * 3 + 2] - this.right[j * 3 + 2]) * t,
      ).normalize();
      target.addScaledVector(_v0, lateral);
    }
    return target;
  }

  tangentAtS(s, target = new THREE.Vector3()) {
    const f = ((s / this.sampleStep) % this.count + this.count) % this.count;
    const j = Math.floor(f), k = (j + 1) % this.count;
    const t = f - j;
    return target.set(
      this.tan[j * 3] + (this.tan[k * 3] - this.tan[j * 3]) * t,
      this.tan[j * 3 + 1] + (this.tan[k * 3 + 1] - this.tan[j * 3 + 1]) * t,
      this.tan[j * 3 + 2] + (this.tan[k * 3 + 2] - this.tan[j * 3 + 2]) * t,
    ).normalize();
  }

  widthAtS(s) {
    const f = ((s / this.sampleStep) % this.count + this.count) % this.count;
    return this.width[Math.floor(f)];
  }

  curvatureAtS(s) {
    const f = ((s / this.sampleStep) % this.count + this.count) % this.count;
    return this.curvature[Math.floor(f)];
  }

  /**
   * Max safe speed for AI and assists.
   *
   * Not simply "the worst corner in the next 140 m" — that makes a driver
   * crawl from the moment a hairpin enters the lookahead and stay slow all
   * the way through the exit. Instead, for every point ahead, work out how
   * fast you may be *here* and still shed enough speed to make that point:
   * v = sqrt(v_corner² + 2·a·d). The binding constraint is the minimum.
   */
  speedLimitAtS(s, lookahead = 90, grip = 1.0) {
    const lateralG = 3.4 * grip;   // arcade cornering budget
    const braking = 26;            // m/s² available deceleration
    let best = Infinity;
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const d = (i / steps) * lookahead;
      const k = Math.abs(this.curvatureAtS(s + d));
      const vCorner = k < 1e-5 ? 200 : Math.sqrt((9.81 * lateralG) / k);
      best = Math.min(best, Math.sqrt(vCorner * vCorner + 2 * braking * d));
    }
    return clamp(best, 24, 200);
  }
}

// ---------------------------------------------------------------------------
// Mesh construction
// ---------------------------------------------------------------------------

/**
 * Build the visible road: asphalt ribbon with shader-painted markings,
 * curbs, verge skirt, barriers, pylons and tunnels.
 */
export function buildTrackMeshes(track, theme, materials) {
  const group = new THREE.Group();
  group.name = 'track';

  const N = track.count;
  const uvScale = 0.06; // metres -> texture v

  // ---- road surface ----
  const roadPos = [], roadNorm = [], roadUv = [], roadIdx = [], roadAux = [];
  const RING = 7; // cross-section resolution, more verts = smoother banking normals
  for (let i = 0; i <= N; i++) {
    const ii = i % N;
    const px = track.pos[ii * 3], py = track.pos[ii * 3 + 1], pz = track.pos[ii * 3 + 2];
    const rx = track.right[ii * 3], ry = track.right[ii * 3 + 1], rz = track.right[ii * 3 + 2];
    const nx = track.up[ii * 3], ny = track.up[ii * 3 + 1], nz = track.up[ii * 3 + 2];
    const hw = track.width[ii] * 0.5;
    for (let j = 0; j < RING; j++) {
      const t = j / (RING - 1);
      const off = (t - 0.5) * 2 * hw;
      roadPos.push(px + rx * off, py + ry * off, pz + rz * off);
      roadNorm.push(nx, ny, nz);
      roadUv.push(t, i * track.sampleStep * uvScale);
      roadAux.push(t, track.width[ii]);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < RING - 1; j++) {
      const a = i * RING + j, b = a + 1, c = a + RING, d = c + 1;
      roadIdx.push(a, c, b, b, c, d);
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
  roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(roadNorm, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roadUv, 2));
  roadGeo.setAttribute('aux', new THREE.Float32BufferAttribute(roadAux, 2));
  roadGeo.setIndex(roadIdx);
  roadGeo.computeBoundingSphere();

  const roadMesh = new THREE.Mesh(roadGeo, materials.road);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'roadSurface';
  group.add(roadMesh);

  // ---- curbs: rumble strips hugging each edge ----
  const curbGeo = buildRibbon(track, (i) => {
    const hw = track.width[i] * 0.5;
    return [hw, hw + 1.5];
  }, 0.09, true);
  const curbMesh = new THREE.Mesh(curbGeo, materials.curb);
  curbMesh.receiveShadow = true;
  group.add(curbMesh);

  const curbGeoL = buildRibbon(track, (i) => {
    const hw = track.width[i] * 0.5;
    return [-hw - 1.5, -hw];
  }, 0.09, true);
  const curbMeshL = new THREE.Mesh(curbGeoL, materials.curb);
  curbMeshL.receiveShadow = true;
  group.add(curbMeshL);

  // ---- verge skirt: drops from the road edge so the ribbon never floats ----
  const skirt = buildSkirt(track, theme.skirtDepth ?? 3.2);
  const skirtMesh = new THREE.Mesh(skirt, materials.skirt);
  skirtMesh.castShadow = true;
  skirtMesh.receiveShadow = true;
  group.add(skirtMesh);

  return { group, roadMesh };
}

/** Ribbon between two lateral offsets, raised by `lift` along the road normal. */
function buildRibbon(track, offsetsFn, lift, tiled) {
  const N = track.count;
  const pos = [], norm = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const ii = i % N;
    const px = track.pos[ii * 3], py = track.pos[ii * 3 + 1], pz = track.pos[ii * 3 + 2];
    const rx = track.right[ii * 3], ry = track.right[ii * 3 + 1], rz = track.right[ii * 3 + 2];
    const nx = track.up[ii * 3], ny = track.up[ii * 3 + 1], nz = track.up[ii * 3 + 2];
    const [o0, o1] = offsetsFn(ii);
    for (let j = 0; j < 2; j++) {
      const off = j === 0 ? o0 : o1;
      pos.push(px + rx * off + nx * lift, py + ry * off + ny * lift, pz + rz * off + nz * lift);
      norm.push(nx, ny, nz);
      uv.push(j, tiled ? i * track.sampleStep * 0.28 : i / N);
    }
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Vertical apron hanging off both road edges. */
function buildSkirt(track, depth) {
  const N = track.count;
  const pos = [], norm = [], uv = [], idx = [];
  let base = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i <= N; i++) {
      const ii = i % N;
      const px = track.pos[ii * 3], py = track.pos[ii * 3 + 1], pz = track.pos[ii * 3 + 2];
      const rx = track.right[ii * 3], ry = track.right[ii * 3 + 1], rz = track.right[ii * 3 + 2];
      const hw = track.width[ii] * 0.5 + 1.5;
      const ex = px + rx * hw * side, ey = py + ry * hw * side, ez = pz + rz * hw * side;
      const outX = rx * side, outZ = rz * side;
      pos.push(ex, ey, ez);
      norm.push(outX, 0.15, outZ);
      uv.push(i * track.sampleStep * 0.1, 1);
      pos.push(ex + outX * 0.8, ey - depth, ez + outZ * 0.8);
      norm.push(outX, 0.15, outZ);
      uv.push(i * track.sampleStep * 0.1, 0);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (side < 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
    base = pos.length / 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Road material: standard PBR asphalt with lane markings, edge lines and
 * tyre-polished racing line injected in the fragment shader so they stay
 * razor sharp at any speed and never suffer from texture seams.
 */
export function makeRoadMaterial(maps, theme) {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    metalness: theme.roadMetalness ?? 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(1.1, 1.1),
    envMapIntensity: theme.roadEnvIntensity ?? 1.0,
  });
  mat.defines = { USE_UV: '' };
  mat.userData.uniforms = {
    uMarkColor: { value: new THREE.Color(theme.markingColor ?? 0xdedad0) },
    uMarkGlow: { value: theme.markingGlow ?? 0.0 },
    uWet: { value: theme.wetness ?? 0.0 },
    uTime: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n attribute vec2 aux;\n varying vec2 vAux;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vAux = aux;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vAux;
        uniform vec3 uMarkColor;
        uniform float uMarkGlow;
        uniform float uWet;
        uniform float uTime;
        float band(float x, float c, float hw, float soft) {
          return smoothstep(hw + soft, hw, abs(x - c));
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float u = vAux.x;              // 0..1 across the road
          float w = vAux.y;              // metres
          float metresFromCentre = (u - 0.5) * w;
          float v = vMapUv.y / 0.06;     // metres along the road

          // Edge lines: continuous white, inset from the curb.
          float edge = band(abs(metresFromCentre), w * 0.5 - 0.75, 0.16, 0.09);

          // Centre line: dashed 4m on / 6m off, doubled on wide roads.
          float dash = step(0.4, fract(v * 0.1));
          float centre = band(metresFromCentre, 0.0, 0.16, 0.08) * dash;

          // Lane dividers on wide sections.
          float laneOffset = w * 0.25;
          float lanes = (band(abs(metresFromCentre), laneOffset, 0.13, 0.08)) * step(20.0, w) * dash;

          float marks = clamp(edge + centre + lanes, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, marks * 0.92);

          // Racing line: rubber laid down through the middle of the road.
          float rubber = smoothstep(0.42, 0.0, abs(metresFromCentre) / (w * 0.5));
          rubber *= 0.35 + 0.65 * smoothstep(0.2, 0.8, fract(v * 0.013 + 0.3));
          diffuseColor.rgb *= mix(1.0, 0.72, rubber * 0.6);

          // Wet look: darker albedo, mirror-flat where water pools.
          diffuseColor.rgb *= mix(1.0, 0.45, uWet);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          float u = vAux.x, w = vAux.y;
          float metresFromCentre = (u - 0.5) * w;
          float v = vMapUv.y / 0.06;
          float edge = band(abs(metresFromCentre), w * 0.5 - 0.75, 0.16, 0.09);
          float dash = step(0.4, fract(v * 0.1));
          float centre = band(metresFromCentre, 0.0, 0.16, 0.08) * dash;
          float marks = clamp(edge + centre, 0.0, 1.0);
          roughnessFactor = mix(roughnessFactor, 0.55, marks);
          roughnessFactor = mix(roughnessFactor, 0.05, uWet);
        }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.42, uWet);`);

    if (theme.markingGlow) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float u = vAux.x, w = vAux.y;
          float metresFromCentre = (u - 0.5) * w;
          float edge = band(abs(metresFromCentre), w * 0.5 - 0.75, 0.18, 0.1);
          float pulse = 0.7 + 0.3 * sin(uTime * 2.0 - vMapUv.y * 4.0);
          totalEmissiveRadiance += uMarkColor * edge * uMarkGlow * pulse;
        }`);
    }
    mat.userData.shader = shader;
  };
  return mat;
}
