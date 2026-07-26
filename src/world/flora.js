// Vegetation and atmosphere scatter.
//
// Trees, undergrowth, boulders, drifting petals/snow/rain, fireflies and
// birds. Everything is instanced (one draw call per species) and animated in
// the vertex shader, so tens of thousands of wind-driven elements cost
// essentially nothing on the CPU.

import * as THREE from 'three';
import { makeRng, fbm2, clamp, smoothstep, TAU } from '../util/noise.js';
import { foliageTexture, grassTuftTexture, woodMaps, rockMaps, radialSprite } from '../util/tex.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Inject wind sway into any material (including the depth pass). */
export function applyWind(material, uniforms, opts = {}) {
  const bendPower = opts.bendPower ?? 1.6;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        attribute float aPhase;
        attribute float aStiff;`)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        {
          // Bend proportional to height above the instance origin, so trunks
          // stay planted while canopies and blades whip.
          float h = max(transformed.y, 0.0);
          float bend = pow(h, ${bendPower.toFixed(2)}) * aStiff * uWindStrength;
          float gust = sin(uTime * 1.15 + aPhase) * 0.65
                     + sin(uTime * 2.7 + aPhase * 1.7) * 0.25
                     + sin(uTime * 5.3 + aPhase * 3.1) * 0.10;
          transformed.x += uWindDir.x * bend * gust;
          transformed.z += uWindDir.y * bend * gust;
          transformed.y -= abs(bend * gust) * 0.18;
        }`);
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'wind' + bendPower;
  return material;
}

function instAttrs(geo, count, rng) {
  const phase = new Float32Array(count);
  const stiff = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    phase[i] = rng() * TAU;
    stiff[i] = 0.6 + rng() * 0.8;
  }
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute('aStiff', new THREE.InstancedBufferAttribute(stiff, 1));
}

// ---------------------------------------------------------------------------
// Tree geometry
// ---------------------------------------------------------------------------

function trunkGeometry(height, radius, lean = 0.1, seed = 1) {
  const rng = makeRng(seed);
  const segments = 6, rings = 5;
  const pos = [], nrm = [], uv = [], idx = [];
  let ox = 0, oz = 0;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = t * height;
    // Trunks taper and drift, which reads far more natural than a cylinder.
    const rad = radius * (1 - t * 0.72) * (1 + (rng() - 0.5) * 0.18);
    ox += (rng() - 0.5) * lean * height * 0.12;
    oz += (rng() - 0.5) * lean * height * 0.12;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * TAU;
      const cx = Math.cos(a), cz = Math.sin(a);
      const flute = 1 + Math.sin(a * 5 + r) * 0.07;
      pos.push(ox + cx * rad * flute, y, oz + cz * rad * flute);
      nrm.push(cx, 0.12, cz);
      uv.push(s / segments * 2, t * height * 0.22);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s, b = a + 1, c = a + segments + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
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

/** Canopy built from overlapping alpha cards arranged on a rough sphere. */
function canopyGeometry(cards, radius, baseY, spread, seed = 7, shape = 'round') {
  const rng = makeRng(seed);
  const geos = [];
  for (let i = 0; i < cards; i++) {
    const t = i / cards;
    let y, r;
    if (shape === 'conical') {
      y = baseY + t * radius * 2.2;
      r = radius * (1 - t * 0.85) + radius * 0.15;
    } else if (shape === 'weeping') {
      y = baseY + radius * (0.5 + rng() * 0.9);
      r = radius * (0.55 + rng() * 0.6);
    } else {
      const phi = Math.acos(1 - 2 * ((i + 0.5) / cards));
      y = baseY + radius * (0.9 + Math.cos(phi) * 0.55);
      r = radius * (0.55 + Math.sin(phi) * 0.55);
    }
    const size = radius * spread * (0.75 + rng() * 0.6);
    const plane = new THREE.PlaneGeometry(size, size * 0.86, 1, 1);
    const ang = rng() * TAU;
    const tilt = (rng() - 0.5) * 1.1;
    plane.rotateX(tilt);
    plane.rotateY(ang);
    const rr = r * (0.35 + rng() * 0.75);
    plane.translate(Math.cos(ang * 1.7) * rr, y + (rng() - 0.5) * radius * 0.3, Math.sin(ang * 1.7) * rr);
    geos.push(plane);
  }
  return mergeGeometries(geos);
}

function mergeGeometries(geos) {
  let posCount = 0, idxCount = 0;
  for (const g of geos) {
    posCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(posCount * 3);
  const nrm = new Float32Array(posCount * 3);
  const uv = new Float32Array(posCount * 2);
  const idx = new Uint32Array(idxCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const u = g.attributes.uv.array;
    pos.set(p, vo * 3);
    nrm.set(n, vo * 3);
    uv.set(u, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export const TREE_SPECIES = {
  sakura: { height: 7.5, radius: 0.34, canopyR: 4.4, cards: 12, leaf: 'sakura', shape: 'weeping', spread: 1.4, tint: 0xffffff },
  pine: { height: 15, radius: 0.42, canopyR: 3.4, cards: 14, leaf: 'pine', shape: 'conical', spread: 1.5, tint: 0xdfe8dd },
  broadleaf: { height: 11, radius: 0.5, canopyR: 5.2, cards: 12, leaf: 'broadleaf', shape: 'round', spread: 1.35, tint: 0xffffff },
  bamboo: { height: 12, radius: 0.13, canopyR: 1.5, cards: 6, leaf: 'bamboo', shape: 'conical', spread: 1.1, tint: 0xf0ffe8 },
  autumn: { height: 10, radius: 0.46, canopyR: 4.6, cards: 11, leaf: 'autumn', shape: 'round', spread: 1.35, tint: 0xffffff },
};

/**
 * Scatter a forest.
 * @param {object} opts { species: [{key, count, weight}], radius, near, far }
 */
export function createForest(terrain, track, opts, windUniforms) {
  const group = new THREE.Group();
  group.name = 'forest';
  const rng = makeRng(opts.seed ?? 1337);
  const wood = woodMaps(256);

  for (const spec of opts.species) {
    const S = TREE_SPECIES[spec.key];
    if (!S) continue;
    const placements = [];
    let attempts = 0;
    let hint = -1;
    const maxAttempts = spec.count * 26;
    while (placements.length < spec.count && attempts++ < maxAttempts) {
      let x, z;
      if (rng() < (spec.roadside ?? 0.55)) {
        // Hug the track so the racing corridor is dense and readable.
        const s = rng() * track.length;
        const side = rng() < 0.5 ? -1 : 1;
        const w = track.widthAtS(s);
        const off = side * (w * 0.5 + 5 + Math.pow(rng(), 1.6) * (spec.band ?? 90));
        track.pointAtS(s, off, _p);
        x = _p.x + (rng() - 0.5) * 12;
        z = _p.z + (rng() - 0.5) * 12;
      } else {
        const a = rng() * TAU;
        const r = Math.sqrt(rng()) * (opts.radius ?? 2200);
        x = terrain._center.x + Math.cos(a) * r;
        z = terrain._center.z + Math.sin(a) * r;
      }

      const surf = track.sampleAt(x, z, hint);
      if (surf) hint = surf.index;
      if (surf && Math.abs(surf.lateral) < surf.width * 0.5 + 4.5) continue;

      // Cheap slope test first — it rejects most candidates without touching
      // the spline again.
      const slope = terrain.fastSlopeAt(x, z);
      if (slope > (spec.maxSlope ?? 0.38)) continue;
      const h = terrain.heightAt(x, z, hint);
      if (h < (spec.minH ?? -1e9) || h > (spec.maxH ?? 1e9)) continue;

      // Clumping: species cluster instead of dusting evenly over the map.
      const clump = fbm2(x * (spec.clumpScale ?? 0.004) + (spec.seedOffset ?? 0),
                         z * (spec.clumpScale ?? 0.004), 4);
      if (clump < (spec.clumpThreshold ?? 0.36)) continue;

      placements.push([x, h - 0.25, z, 0.7 + Math.pow(rng(), 1.4) * 0.85, rng() * TAU]);
    }
    if (!placements.length) continue;

    const count = placements.length;
    const trunkGeo = trunkGeometry(S.height, S.radius, spec.key === 'bamboo' ? 0.02 : 0.14, 11 + spec.count);
    const canopyGeo = canopyGeometry(S.cards, S.canopyR, S.height * (spec.key === 'bamboo' ? 0.75 : 0.52),
                                     S.spread, 23 + spec.count, S.shape);

    const trunkMat = new THREE.MeshStandardMaterial({
      map: wood.map, normalMap: wood.normalMap, roughnessMap: wood.roughnessMap,
      roughness: 1.0, metalness: 0.0,
      color: spec.key === 'bamboo' ? 0x9fbf62 : 0xffffff,
    });
    applyWind(trunkMat, windUniforms, { bendPower: 2.0 });

    const leafTex = foliageTexture(S.leaf);
    // The card's alpha lives in the colour map itself. Do NOT also set
    // alphaMap: three reads its GREEN channel, which would cut away every
    // dark-green needle on the pines.
    const canopyMat = new THREE.MeshStandardMaterial({
      map: leafTex,
      transparent: false,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.86,
      metalness: 0.0,
      color: S.tint,
    });
    applyWind(canopyMat, windUniforms, { bendPower: 1.35 });

    instAttrs(trunkGeo, count, rng);
    instAttrs(canopyGeo, count, rng);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
    trunks.castShadow = true; trunks.receiveShadow = true;
    canopies.castShadow = true; canopies.receiveShadow = true;

    // Canopy shadows need alpha-tested depth or trees cast solid blocks.
    const depthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: leafTex, alphaTest: 0.42,
    });
    applyWind(depthMat, windUniforms, { bendPower: 1.35 });
    canopies.customDepthMaterial = depthMat;

    for (let i = 0; i < count; i++) {
      const [x, y, z, sc, rot] = placements[i];
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      _p.set(x, y, z);
      _s.set(sc, sc * (0.85 + (i % 7) * 0.05), sc);
      _m.compose(_p, _q, _s);
      trunks.setMatrixAt(i, _m);
      canopies.setMatrixAt(i, _m);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;
    group.add(trunks, canopies);
  }
  return group;
}

/** Dense wind-blown undergrowth along the racing corridor. */
export function createGrassField(terrain, track, opts, windUniforms) {
  const rng = makeRng(opts.seed ?? 991);
  const count = opts.count ?? 26000;
  const tex = grassTuftTexture(128, opts.colors);

  // Crossed quads: two blades per instance so tufts read from every angle.
  const h = opts.height ?? 1.5;
  const a = new THREE.PlaneGeometry(h * 1.1, h, 1, 2);
  a.translate(0, h / 2, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const geo = mergeGeometries([a, b]);

  const mat = new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.36, side: THREE.DoubleSide,
    roughness: 0.95, metalness: 0.0, color: opts.tint ?? 0xffffff,
  });
  applyWind(mat, windUniforms, { bendPower: 1.15 });

  const placements = [];
  let attempts = 0;
  let hint = -1;
  while (placements.length < count && attempts++ < count * 12) {
    const s = rng() * track.length;
    const side = rng() < 0.5 ? -1 : 1;
    const w = track.widthAtS(s);
    const off = side * (w * 0.5 + 1.6 + Math.pow(rng(), 1.7) * (opts.band ?? 46));
    track.pointAtS(s, off, _p);
    const x = _p.x + (rng() - 0.5) * 6;
    const z = _p.z + (rng() - 0.5) * 6;
    const surf = track.sampleAt(x, z, hint);
    if (surf) hint = surf.index;
    if (surf && Math.abs(surf.lateral) < surf.width * 0.5 + 1.4) continue;
    const slope = terrain.fastSlopeAt(x, z);
    if (slope > (opts.maxSlope ?? 0.5)) continue;
    const gh = terrain.heightAt(x, z, hint);
    if (gh < (opts.minH ?? -1e9)) continue;
    const sp = terrain.splatAt(x, z, gh, slope);
    if (sp[0] < (opts.minGrass ?? 0.32)) continue;
    placements.push([x, gh - 0.1, z, 0.6 + rng() * 0.9, rng() * TAU]);
  }

  const n = placements.length;
  instAttrs(geo, n, rng);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  for (let i = 0; i < n; i++) {
    const [x, y, z, sc, rot] = placements[i];
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    _p.set(x, y, z);
    _s.set(sc, sc, sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'grass';
  return mesh;
}

/** Boulders and scree, placed on steep ground where nothing grows. */
export function createRocks(terrain, track, opts) {
  const rng = makeRng(opts.seed ?? 4242);
  const rk = rockMaps(256);
  const mat = new THREE.MeshStandardMaterial({
    map: rk.map, normalMap: rk.normalMap, roughnessMap: rk.roughnessMap,
    roughness: 1.0, metalness: 0.0, color: opts.tint ?? 0xffffff,
  });

  const base = new THREE.IcosahedronGeometry(1, 1);
  const p = base.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const n = 0.62 + fbm2(p.getX(i) * 2.4 + 7, p.getZ(i) * 2.4, 3) * 0.85;
    p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.72, p.getZ(i) * n);
  }
  base.computeVertexNormals();

  const placements = [];
  const count = opts.count ?? 320;
  let attempts = 0;
  while (placements.length < count && attempts++ < count * 30) {
    const a = rng() * TAU;
    const r = Math.sqrt(rng()) * (opts.radius ?? 1500);
    const x = terrain._center.x + Math.cos(a) * r;
    const z = terrain._center.z + Math.sin(a) * r;
    const surf = track.sampleAt(x, z, -1);
    if (surf && Math.abs(surf.lateral) < surf.width * 0.5 + 6) continue;
    const slope = terrain.fastSlopeAt(x, z);
    if (slope < (opts.minSlope ?? 0.06) && rng() > 0.25) continue;
    const h = terrain.heightAt(x, z, surf ? surf.index : -1);
    if (h < (opts.minH ?? -1e9)) continue;
    placements.push([x, h - 0.35, z, (opts.scale ?? 2.2) * (0.4 + Math.pow(rng(), 1.8) * 2.4), rng() * TAU, rng()]);
  }

  const n = placements.length;
  const mesh = new THREE.InstancedMesh(base, mat, n);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  for (let i = 0; i < n; i++) {
    const [x, y, z, sc, rot, tiltSeed] = placements[i];
    _q.setFromEuler(new THREE.Euler((tiltSeed - 0.5) * 0.5, rot, (tiltSeed - 0.5) * 0.4));
    _p.set(x, y, z);
    _s.set(sc * (0.8 + tiltSeed * 0.5), sc * (0.6 + tiltSeed * 0.4), sc);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'rocks';
  return mesh;
}

// ---------------------------------------------------------------------------
// Atmospheric particles
// ---------------------------------------------------------------------------

const particleVert = /* glsl */`
  uniform float uTime;
  uniform float uSize;
  uniform vec3 uCamPos;
  uniform vec3 uWind;
  uniform float uFall;
  uniform float uSwirl;
  uniform float uBoxY;
  uniform vec3 uOrigin;
  attribute vec3 seed;
  varying float vAlpha;
  varying float vRot;

  void main() {
    vec3 p = position;
    float t = uTime;
    // Wrap the field around the camera so particles are always where you look.
    p.x += uWind.x * t + sin(t * (0.4 + seed.x) + seed.y * 6.28) * uSwirl;
    p.z += uWind.z * t + cos(t * (0.35 + seed.y) + seed.x * 6.28) * uSwirl;
    p.y -= (uFall * (0.6 + seed.z * 0.8)) * t;

    vec3 rel = p - uOrigin;
    float span = uBoxY;
    rel.y = mod(rel.y, span);
    rel.x = mod(rel.x - uCamPos.x + uOrigin.x + 220.0, 440.0) - 220.0;
    rel.z = mod(rel.z - uCamPos.z + uOrigin.z + 220.0, 440.0) - 220.0;
    vec3 wp = vec3(uCamPos.x + rel.x, uOrigin.y + rel.y, uCamPos.z + rel.z);

    vec4 mv = viewMatrix * vec4(wp, 1.0);
    float dist = -mv.z;
    vAlpha = smoothstep(320.0, 60.0, dist) * (0.45 + seed.z * 0.55);
    vRot = t * (0.7 + seed.x * 2.2) + seed.y * 6.28;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + seed.z) * (260.0 / max(dist, 1.0));
  }
`;

const particleFrag = /* glsl */`
  uniform sampler2D tSprite;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vRot;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    vec4 tex = texture2D(tSprite, uv);
    float a = tex.a * vAlpha * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * tex.rgb, a);
  }
`;

/** Petal / snow / rain / ember field that follows the camera. */
export function createParticleField(opts) {
  const count = opts.count ?? 2500;
  const rng = makeRng(opts.seed ?? 77);
  const span = opts.span ?? 220;
  const height = opts.height ?? 120;

  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (rng() - 0.5) * span * 2;
    pos[i * 3 + 1] = rng() * height;
    pos[i * 3 + 2] = (rng() - 0.5) * span * 2;
    seed[i * 3] = rng();
    seed[i * 3 + 1] = rng();
    seed[i * 3 + 2] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const sprite = opts.sprite ?? radialSprite(64, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)', 1.6);
  const uniforms = {
    uTime: { value: 0 },
    uSize: { value: opts.size ?? 2.4 },
    uCamPos: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector3(...(opts.wind ?? [1.2, 0, 0.4])) },
    uFall: { value: opts.fall ?? 1.6 },
    uSwirl: { value: opts.swirl ?? 3.0 },
    uBoxY: { value: height },
    uOrigin: { value: new THREE.Vector3(0, opts.baseY ?? 0, 0) },
    tSprite: { value: sprite },
    uColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
    uOpacity: { value: opts.opacity ?? 0.9 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: particleVert,
    fragmentShader: particleFrag,
    transparent: true,
    depthWrite: false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.name = opts.name ?? 'particles';
  points.userData.update = (dt, camera) => {
    uniforms.uTime.value += dt;
    uniforms.uCamPos.value.copy(camera.position);
  };
  return points;
}

/** Petal sprite: a soft ellipse rather than a round dot. */
export function petalSprite(color = '#ffd7e6') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, color);
  g.addColorStop(0.55, color + 'cc');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(32, 32, 30, 18, 0.5, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Rain streak sprite. */
export function rainSprite() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(200,225,255,0)');
  g.addColorStop(0.5, 'rgba(210,235,255,0.85)');
  g.addColorStop(1, 'rgba(200,225,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(13, 0, 6, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Flock of birds wheeling over the course. */
export function createBirds(terrain, opts = {}) {
  const count = opts.count ?? 44;
  const rng = makeRng(opts.seed ?? 555);
  const shape = new THREE.BufferGeometry();
  // A simple two-triangle gull silhouette; wings flap in the vertex shader.
  const verts = new Float32Array([
    0, 0, -0.6, -2.4, 0, 0.5, 0, 0, 0.4,
    0, 0, -0.6, 0, 0, 0.4, 2.4, 0, 0.5,
  ]);
  shape.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  shape.computeVertexNormals();

  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ color: opts.color ?? 0x1c1f26, side: THREE.DoubleSide, fog: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float aPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y += sin(uTime * 7.0 + aPhase) * abs(transformed.x) * 0.42;`);
  };

  const mesh = new THREE.InstancedMesh(shape, mat, count);
  const phases = new Float32Array(count);
  const paths = [];
  const cx = terrain._center.x, cz = terrain._center.z;
  for (let i = 0; i < count; i++) {
    phases[i] = rng() * TAU;
    paths.push({
      r: 180 + rng() * 900,
      y: (opts.altitude ?? 160) + rng() * 160,
      speed: 0.06 + rng() * 0.09,
      a: rng() * TAU,
      wobble: rng() * TAU,
      scale: 0.7 + rng() * 0.9,
    });
  }
  shape.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  mesh.frustumCulled = false;
  mesh.name = 'birds';

  mesh.userData.update = (dt) => {
    uniforms.uTime.value += dt;
    const t = uniforms.uTime.value;
    for (let i = 0; i < count; i++) {
      const b = paths[i];
      b.a += b.speed * dt;
      const x = cx + Math.cos(b.a) * b.r;
      const z = cz + Math.sin(b.a) * b.r;
      const y = b.y + Math.sin(t * 0.4 + b.wobble) * 14;
      _p.set(x, y, z);
      _q.setFromEuler(new THREE.Euler(0, -b.a + Math.PI / 2, Math.sin(t * 0.6 + b.wobble) * 0.3));
      _s.setScalar(b.scale);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  return mesh;
}

export { mergeGeometries };
