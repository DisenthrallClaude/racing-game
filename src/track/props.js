// Track furniture generated from the spline: barriers, boost pads, tunnels,
// support pylons, the start/finish gantry and checkpoint arches. Each theme
// picks a barrier style so the same geometry pipeline produces a timber
// balustrade, a glowing energy rail or a snow bank.

import * as THREE from 'three';
import { makeRng, TAU, clamp } from '../util/noise.js';
import { architectureMaterials } from '../world/architecture.js';
import { mergeGeometries } from '../world/flora.js';

const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function frameAt(track, i) {
  return {
    p: new THREE.Vector3(track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]),
    t: new THREE.Vector3(track.tan[i * 3], track.tan[i * 3 + 1], track.tan[i * 3 + 2]),
    n: new THREE.Vector3(track.up[i * 3], track.up[i * 3 + 1], track.up[i * 3 + 2]),
    r: new THREE.Vector3(track.right[i * 3], track.right[i * 3 + 1], track.right[i * 3 + 2]),
    w: track.width[i],
  };
}

/** Guardrails / balustrades / energy fences hugging both road edges. */
export function buildBarriers(track, theme) {
  const mats = architectureMaterials();
  const group = new THREE.Group();
  group.name = 'barriers';
  const style = theme.barrier ?? 'wood';
  const step = Math.max(1, Math.round(4.2 / track.sampleStep));
  const postGeos = [];
  const rng = makeRng(88);

  // --- posts ---
  const postProto = style === 'energy'
    ? new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6)
    : style === 'snow'
      ? new THREE.CylinderGeometry(0.11, 0.14, 1.9, 6)
      : new THREE.BoxGeometry(0.3, 1.6, 0.3);

  const postMat = style === 'energy'
    ? new THREE.MeshStandardMaterial({ color: 0x141a24, metalness: 0.85, roughness: 0.3,
        emissive: new THREE.Color(theme.barrierColor ?? 0x30d8ff), emissiveIntensity: 2.4 })
    : style === 'snow'
      ? new THREE.MeshStandardMaterial({ color: 0x5a4634, roughness: 0.85 })
      : mats.redWood;

  const posts = [];
  for (let i = 0; i < track.count; i += step) {
    if (track.kindFlags[i] === 2) continue; // tunnels have their own walls
    const f = frameAt(track, i);
    for (const side of [-1, 1]) {
      const off = side * (f.w * 0.5 + 1.9);
      posts.push({ f, off, side });
    }
  }
  const postMesh = new THREE.InstancedMesh(postProto, postMat, posts.length);
  postMesh.castShadow = true;
  postMesh.receiveShadow = true;
  posts.forEach((entry, i) => {
    const { f, off } = entry;
    _p.copy(f.p).addScaledVector(f.r, off).addScaledVector(f.n, 0.8);
    _q.setFromUnitVectors(UP, f.n);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    postMesh.setMatrixAt(i, _m);
  });
  postMesh.instanceMatrix.needsUpdate = true;
  postMesh.frustumCulled = false;
  group.add(postMesh);

  // --- continuous rail ribbon ---
  const railHeights = style === 'energy' ? [0.6, 1.5, 2.3] : style === 'snow' ? [0.7, 1.3] : [0.75, 1.35];
  const railMat = style === 'energy'
    ? new THREE.MeshBasicMaterial({
        color: new THREE.Color(theme.barrierColor ?? 0x30d8ff),
        transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide, depthWrite: false, toneMapped: true,
      })
    : style === 'snow'
      ? new THREE.MeshStandardMaterial({ color: 0x8a6d4c, roughness: 0.9 })
      : mats.redWood;

  for (const hy of railHeights) {
    for (const side of [-1, 1]) {
      const geo = railRibbon(track, side, hy, style === 'energy' ? 0.22 : 0.16);
      const m = new THREE.Mesh(geo, railMat);
      m.castShadow = style !== 'energy';
      m.frustumCulled = false;
      group.add(m);
    }
  }

  // --- snow banks / hedges as a solid visual backing ---
  if (style === 'snow') {
    for (const side of [-1, 1]) {
      const geo = bankRibbon(track, side);
      const m = new THREE.Mesh(geo, mats.snow);
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false;
      group.add(m);
    }
  }

  // --- tyre stacks in the highest-curvature corners ---
  if (theme.tyreStacks !== false) {
    const tyreGeo = new THREE.TorusGeometry(0.55, 0.22, 8, 14);
    tyreGeo.rotateX(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
    const stacks = [];
    for (let i = 0; i < track.count; i += Math.round(6 / track.sampleStep)) {
      if (Math.abs(track.curvature[i]) < 0.012 || track.kindFlags[i] === 2) continue;
      const f = frameAt(track, i);
      const side = track.curvature[i] > 0 ? 1 : -1;
      for (let k = 0; k < 3; k++) {
        stacks.push({ f, off: side * (f.w * 0.5 + 2.6), y: 0.55 + k * 0.42 });
      }
    }
    if (stacks.length) {
      const tyres = new THREE.InstancedMesh(tyreGeo, tyreMat, stacks.length);
      tyres.castShadow = true;
      stacks.forEach((e, i) => {
        _p.copy(e.f.p).addScaledVector(e.f.r, e.off).addScaledVector(e.f.n, e.y);
        _q.setFromUnitVectors(UP, e.f.n);
        _m.compose(_p, _q, _s.set(1, 1, 1));
        tyres.setMatrixAt(i, _m);
      });
      tyres.instanceMatrix.needsUpdate = true;
      tyres.frustumCulled = false;
      group.add(tyres);
    }
  }

  return group;
}

function railRibbon(track, side, height, thickness) {
  const N = track.count;
  const pos = [], nrm = [], uv = [], idx = [];
  let verts = 0;
  const runs = [];
  let cur = null;
  for (let i = 0; i <= N; i++) {
    const ii = i % N;
    const solid = track.kindFlags[ii] !== 2;
    if (solid && !cur) cur = [ii];
    if (!solid && cur) { cur.push(ii); runs.push(cur); cur = null; }
  }
  if (cur) { cur.push(N % N); runs.push(cur); }
  if (!runs.length) runs.push([0, N]);

  for (const [start, end] of runs) {
    const len = (end - start + N) % N || N;
    const first = verts;
    for (let k = 0; k <= len; k++) {
      const ii = (start + k) % N;
      const f = frameAt(track, ii);
      const off = side * (f.w * 0.5 + 1.9);
      const base = f.p.clone().addScaledVector(f.r, off);
      const out = f.r.clone().multiplyScalar(side);
      for (let e = 0; e < 2; e++) {
        const y = height + (e === 0 ? -thickness : thickness);
        const v = base.clone().addScaledVector(f.n, y);
        pos.push(v.x, v.y, v.z);
        nrm.push(out.x, out.y, out.z);
        uv.push(k * track.sampleStep * 0.12, e);
        verts++;
      }
    }
    for (let k = 0; k < len; k++) {
      const a = first + k * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
      idx.push(a, b, c, b, d, c); // double-sided without a material flag
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function bankRibbon(track, side) {
  const N = track.count;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const ii = i % N;
    const f = frameAt(track, ii);
    const inner = f.p.clone().addScaledVector(f.r, side * (f.w * 0.5 + 1.2));
    const crest = f.p.clone().addScaledVector(f.r, side * (f.w * 0.5 + 2.6)).addScaledVector(f.n, 1.5);
    const outer = f.p.clone().addScaledVector(f.r, side * (f.w * 0.5 + 5.5)).addScaledVector(f.n, -0.6);
    for (const v of [inner, crest, outer]) { pos.push(v.x, v.y, v.z); }
    uv.push(i * 0.1, 0, i * 0.1, 0.5, i * 0.1, 1);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 3;
    const b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Boost pads
// ---------------------------------------------------------------------------

const boostFrag = /* glsl */`
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    // Chevrons streaming toward the driver.
    float v = fract(vUv.y * 3.0 - uTime * 1.6);
    float x = abs(vUv.x - 0.5) * 2.0;
    float chevron = smoothstep(0.42, 0.12, abs(v - x * 0.42 - 0.25));
    float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
    float pulse = 0.65 + 0.35 * sin(uTime * 5.0);
    float a = chevron * edge * pulse;
    gl_FragColor = vec4(uColor * (0.55 + a * 2.4), a * 0.92 + 0.15);
  }
`;

export function buildBoostPads(track, list, theme) {
  const group = new THREE.Group();
  group.name = 'boostPads';
  const zones = [];
  const uniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(theme.boostColor ?? 0x46e8ff) } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: boostFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  for (const item of list) {
    const s = typeof item === 'number' ? item : item.s;
    const lateral = (typeof item === 'object' && item.lateral) || 0;
    const len = (typeof item === 'object' && item.length) || 14;
    const wid = (typeof item === 'object' && item.width) || 6;

    const idx = Math.floor((s / track.sampleStep) % track.count);
    const steps = Math.max(2, Math.round(len / track.sampleStep));
    const pos = [], uv = [], indices = [];
    for (let k = 0; k <= steps; k++) {
      const i = (idx + k) % track.count;
      const f = frameAt(track, i);
      for (let e = 0; e < 2; e++) {
        const off = lateral + (e === 0 ? -wid / 2 : wid / 2);
        const v = f.p.clone().addScaledVector(f.r, off).addScaledVector(f.n, 0.06);
        pos.push(v.x, v.y, v.z);
        uv.push(e, k / steps);
      }
    }
    for (let k = 0; k < steps; k++) {
      const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 3;
    group.add(mesh);

    zones.push({ s, length: len, lateral, width: wid });
  }
  group.userData.update = (dt) => { uniforms.uTime.value += dt; };
  return { group, zones };
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------

export function buildTunnels(track, theme) {
  const group = new THREE.Group();
  group.name = 'tunnels';
  const mats = architectureMaterials();
  const N = track.count;

  // Collect contiguous tunnel runs.
  const runs = [];
  let start = -1;
  for (let i = 0; i < N; i++) {
    if (track.kindFlags[i] === 2 && start < 0) start = i;
    if (track.kindFlags[i] !== 2 && start >= 0) { runs.push([start, i]); start = -1; }
  }
  if (start >= 0) runs.push([start, N]);
  if (!runs.length) return { group, lights: [] };

  const lightStrips = [];
  const wallMat = theme.tunnelMaterial === 'stone' ? mats.stone : mats.concrete;

  for (const [a, b] of runs) {
    const pos = [], nrm = [], uv = [], idx = [];
    const RING = 13;
    let v = 0;
    for (let i = a; i <= b; i++) {
      const ii = i % N;
      const f = frameAt(track, ii);
      const R = f.w * 0.62;
      for (let k = 0; k < RING; k++) {
        const ang = (k / (RING - 1)) * Math.PI;
        const off = -Math.cos(ang) * R;
        const up = Math.sin(ang) * R * 0.92 + 0.2;
        const p = f.p.clone().addScaledVector(f.r, off).addScaledVector(f.n, up);
        pos.push(p.x, p.y, p.z);
        const n = f.r.clone().multiplyScalar(Math.cos(ang)).addScaledVector(f.n, -Math.sin(ang));
        nrm.push(n.x, n.y, n.z);
        uv.push(k / (RING - 1) * 3, (i - a) * track.sampleStep * 0.08);
        v++;
      }
    }
    for (let i = 0; i < b - a; i++) {
      for (let k = 0; k < RING - 1; k++) {
        const p0 = i * RING + k, p1 = p0 + 1, p2 = p0 + RING, p3 = p2 + 1;
        idx.push(p0, p1, p2, p1, p3, p2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, wallMat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);

    // Ceiling light strips: emissive ribbons plus a few real point lights.
    const stripMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(theme.tunnelLight ?? 0xffd9a0), toneMapped: true,
    });
    const spos = [], sidx = [], suv = [];
    let sv = 0;
    for (let i = a; i <= b; i++) {
      const ii = i % N;
      const f = frameAt(track, ii);
      const c = f.p.clone().addScaledVector(f.n, f.w * 0.55);
      for (const e of [-1, 1]) {
        const p = c.clone().addScaledVector(f.r, e * 0.5);
        spos.push(p.x, p.y, p.z);
        suv.push(e * 0.5 + 0.5, (i - a) * 0.1);
        sv++;
      }
    }
    for (let i = 0; i < b - a; i++) {
      const p0 = i * 2, p1 = p0 + 1, p2 = p0 + 2, p3 = p0 + 3;
      sidx.push(p0, p2, p1, p1, p2, p3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(spos, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
    sg.setIndex(sidx);
    sg.computeVertexNormals();
    group.add(new THREE.Mesh(sg, stripMat));

    const every = Math.max(1, Math.round(26 / track.sampleStep));
    for (let i = a; i < b; i += every) {
      const f = frameAt(track, i % N);
      lightStrips.push(f.p.clone().addScaledVector(f.n, f.w * 0.5));
    }
  }
  return { group, lights: lightStrips };
}

// ---------------------------------------------------------------------------
// Pylons under elevated sections
// ---------------------------------------------------------------------------

export function buildPylons(track, terrain, theme) {
  const mats = architectureMaterials();
  const group = new THREE.Group();
  group.name = 'pylons';
  const mat = theme.pylon === 'stone' ? mats.stone : mats.concrete;
  const geos = [];
  const step = Math.max(1, Math.round(22 / track.sampleStep));

  for (let i = 0; i < track.count; i += step) {
    const f = frameAt(track, i);
    const ground = terrain.baseHeight(f.p.x, f.p.z);
    const drop = f.p.y - ground;
    if (drop < 6) continue;
    for (const side of [-1, 1]) {
      const top = f.p.clone().addScaledVector(f.r, side * f.w * 0.34);
      const h = top.y - ground + 1.5;
      const col = new THREE.CylinderGeometry(1.1, 1.9, h, 10);
      col.translate(top.x, top.y - h / 2, top.z);
      geos.push(col);
    }
    // Cross-brace under the deck
    const brace = new THREE.BoxGeometry(f.w * 0.8, 1.0, 1.4);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.r);
    brace.applyQuaternion(q);
    brace.translate(f.p.x, f.p.y - 1.6, f.p.z);
    geos.push(brace);
  }
  if (!geos.length) return group;
  const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// Start / finish gantry
// ---------------------------------------------------------------------------

export function buildStartGantry(track, theme) {
  const mats = architectureMaterials();
  const group = new THREE.Group();
  const f = frameAt(track, 0);
  const w = f.w;

  // Checkered strip on the tarmac
  const checkCanvas = document.createElement('canvas');
  checkCanvas.width = checkCanvas.height = 128;
  const cx = checkCanvas.getContext('2d');
  const cells = 8;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      cx.fillStyle = (x + y) % 2 ? '#f2f2f2' : '#14151a';
      cx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const checkTex = new THREE.CanvasTexture(checkCanvas);
  checkTex.colorSpace = THREE.SRGBColorSpace;
  checkTex.wrapS = checkTex.wrapT = THREE.RepeatWrapping;
  checkTex.repeat.set(Math.round(w / 2), 1);

  const stripPos = [], stripUv = [], stripIdx = [];
  const steps = Math.max(2, Math.round(3.0 / track.sampleStep));
  for (let k = 0; k <= steps; k++) {
    const ff = frameAt(track, k % track.count);
    for (const e of [-1, 1]) {
      const p = ff.p.clone().addScaledVector(ff.r, e * ff.w * 0.5).addScaledVector(ff.n, 0.05);
      stripPos.push(p.x, p.y, p.z);
      stripUv.push(e * 0.5 + 0.5, k / steps);
    }
  }
  for (let k = 0; k < steps; k++) {
    const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
    stripIdx.push(a, c, b, b, c, d);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(stripPos, 3));
  sg.setAttribute('uv', new THREE.Float32BufferAttribute(stripUv, 2));
  sg.setIndex(stripIdx);
  sg.computeVertexNormals();
  const strip = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ map: checkTex, roughness: 0.7 }));
  strip.renderOrder = 2;
  group.add(strip);

  // Gantry structure
  const gantry = new THREE.Group();
  const legH = 9;
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.0, legH, 1.0), mats.darkMetal);
    leg.position.copy(f.p).addScaledVector(f.r, side * (w * 0.5 + 2.2)).addScaledVector(f.n, legH / 2);
    leg.castShadow = true;
    gantry.add(leg);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 6, 1.6, 1.6), mats.darkMetal);
  beam.position.copy(f.p).addScaledVector(f.n, legH);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.r);
  beam.castShadow = true;
  gantry.add(beam);

  // Start lights: five red bulbs that go out at GO.
  const lights = [];
  const bulbGeo = new THREE.SphereGeometry(0.42, 12, 10);
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x220505, emissive: 0xff1122, emissiveIntensity: 0.0, roughness: 0.35,
    });
    const bulb = new THREE.Mesh(bulbGeo, mat);
    bulb.position.copy(f.p)
      .addScaledVector(f.r, (i - 2) * 2.2)
      .addScaledVector(f.n, legH - 1.4);
    gantry.add(bulb);
    lights.push(mat);
  }

  // Sponsor banner across the beam
  const bannerTex = neonBanner(theme.title ?? 'NEON DRIFT', theme.bannerHue ?? 0.55);
  const bmat = new THREE.MeshStandardMaterial({
    map: bannerTex, emissiveMap: bannerTex, emissive: 0xffffff, emissiveIntensity: 1.4,
    roughness: 0.5, side: THREE.DoubleSide,
  });
  const bannerMesh = new THREE.Mesh(new THREE.PlaneGeometry(w + 4, 2.6), bmat);
  bannerMesh.position.copy(f.p).addScaledVector(f.n, legH + 2.0);
  bannerMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.t.clone().negate());
  gantry.add(bannerMesh);

  group.add(gantry);
  group.userData.startLights = lights;
  return group;
}

function neonBanner(text, hue) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 1024, 0);
  const a = new THREE.Color().setHSL(hue, 0.9, 0.5);
  const b = new THREE.Color().setHSL((hue + 0.25) % 1, 0.9, 0.5);
  grad.addColorStop(0, a.getStyle());
  grad.addColorStop(1, b.getStyle());
  ctx.fillStyle = '#07080d';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 8);
  ctx.fillRect(0, 120, 1024, 8);
  ctx.font = 'bold 76px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = grad;
  ctx.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Checkpoint arches that also read as sector markers. */
export function buildCheckpointArches(track, positions, theme) {
  const mats = architectureMaterials();
  const group = new THREE.Group();
  const color = new THREE.Color(theme.boostColor ?? 0x46e8ff);
  for (const s of positions) {
    const i = Math.floor((s / track.sampleStep) % track.count);
    const f = frameAt(track, i);
    const w = f.w;
    const arch = new THREE.Group();
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 7, 8), mats.darkMetal);
      leg.position.copy(f.p).addScaledVector(f.r, side * (w * 0.5 + 1.6)).addScaledVector(f.n, 3.5);
      leg.castShadow = true;
      arch.add(leg);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 4, 0.8, 0.8), mats.darkMetal);
    top.position.copy(f.p).addScaledVector(f.n, 7);
    top.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), f.r);
    arch.add(top);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(w + 3.6, 0.22, 0.22),
      new THREE.MeshBasicMaterial({ color, toneMapped: true }));
    glow.position.copy(f.p).addScaledVector(f.n, 6.6);
    glow.quaternion.copy(top.quaternion);
    arch.add(glow);
    group.add(arch);
  }
  return group;
}
