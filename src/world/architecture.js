// Procedural architecture.
//
// Three culture packs, all built from parametric primitives so every
// structure is unique yet stylistically coherent:
//   * dynasty  — timber-frame halls, sweeping tiled roofs with flared eaves,
//                pagodas, paifang gates, stone arch bridges, lantern strings
//   * metro    — glass-and-steel towers with per-window emissive grids,
//                holographic billboards, elevated ramps,街 signage
//   * alpine   — timber chalets under deep snow, a stone chapel, cable cars

import * as THREE from 'three';
import { makeRng, fbm2, clamp, TAU } from '../util/noise.js';
import {
  woodMaps, paintedWoodMaps, roofTileMaps, plasterMaps, stoneWallMaps, marbleMaps,
  concreteMaps, metalMaps, glassFacadeMaps, snowMaps, lanternTexture, neonSignTexture, cobbleMaps,
} from '../util/tex.js';
import { mergeGeometries } from './flora.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// Shared materials (built once, reused across every structure)
// ---------------------------------------------------------------------------

let MATS = null;
export function architectureMaterials() {
  if (MATS) return MATS;
  const std = (maps, extra = {}) => new THREE.MeshStandardMaterial({
    map: maps.map, normalMap: maps.normalMap, roughnessMap: maps.roughnessMap,
    roughness: 1.0, metalness: 0.0, ...extra,
  });
  const tile = (maps, rx, ry, extra) => {
    const m = std(maps, extra);
    for (const k of ['map', 'normalMap', 'roughnessMap']) {
      m[k] = m[k].clone();
      m[k].needsUpdate = true;
      m[k].repeat.set(rx, ry);
    }
    return m;
  };
  MATS = {
    wood: std(woodMaps()),
    redWood: std(paintedWoodMaps([0.60, 0.10, 0.09], 'redwood')),
    greenWood: std(paintedWoodMaps([0.09, 0.28, 0.20], 'greenwood')),
    goldWood: std(paintedWoodMaps([0.72, 0.55, 0.16], 'goldwood')),
    roof: tile(roofTileMaps(), 2, 3),
    roofGreen: tile(roofTileMaps(), 2, 3, { color: 0x5f7f6e }),
    roofGold: tile(roofTileMaps(), 2, 3, { color: 0xc8a24a, metalness: 0.35, roughness: 0.5 }),
    plaster: tile(plasterMaps(), 2, 2),
    stone: tile(stoneWallMaps(), 2, 2),
    marble: std(marbleMaps(), { roughness: 0.3, metalness: 0.05 }),
    concrete: tile(concreteMaps(), 3, 3),
    metal: std(metalMaps(), { metalness: 0.9, roughness: 0.35 }),
    darkMetal: std(metalMaps(), { metalness: 0.95, roughness: 0.42, color: 0x3a4048 }),
    snow: tile(snowMaps(), 2, 2, { roughness: 0.7 }),
    cobble: tile(cobbleMaps(), 4, 4),
  };
  return MATS;
}

/** Emissive lattice/window material — cells light up individually at night. */
export function makeWindowMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: opts.frame ?? 0x1a1d24,
    roughness: opts.roughness ?? 0.25,
    metalness: opts.metalness ?? 0.5,
    emissive: new THREE.Color(opts.emissive ?? 0xffc27a),
    emissiveIntensity: 0.0,
  });
  // The window grid is driven from UVs, so the varying must exist even though
  // these materials carry no colour map.
  mat.defines = { USE_UV: '' };
  const u = {
    uTime: { value: 0 },
    uCols: { value: opts.cols ?? 6 },
    uRows: { value: opts.rows ?? 10 },
    uLit: { value: opts.lit ?? 0.55 },
    uGlow: { value: opts.glow ?? 3.0 },
    uSeed: { value: opts.seed ?? 3.7 },
    uWarm: { value: new THREE.Color(opts.emissive ?? 0xffc27a) },
    uCool: { value: new THREE.Color(opts.emissive2 ?? 0x7fd8ff) },
    uMix: { value: opts.coolMix ?? 0.25 },
  };
  mat.userData.uniforms = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vLocal = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vLocal;
        uniform float uTime, uCols, uRows, uLit, uGlow, uSeed, uMix;
        uniform vec3 uWarm, uCool;
        float h2(vec2 p) {
          p = fract(p * vec2(127.1, 311.7) + uSeed);
          p += dot(p, p + 34.23);
          return fract(p.x * p.y);
        }`)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        {
          vec2 cell = vec2(floor(vUv.x * uCols), floor(vUv.y * uRows));
          vec2 f = fract(vec2(vUv.x * uCols, vUv.y * uRows));
          // Mullion gap keeps each pane distinct.
          float pane = step(0.12, f.x) * step(f.x, 0.88) * step(0.14, f.y) * step(f.y, 0.86);
          float r = h2(cell);
          float on = step(1.0 - uLit, r) * pane;
          // Occupancy flickers slowly and a few panes blink.
          float life = 0.75 + 0.25 * sin(uTime * (0.35 + r * 1.4) + r * 40.0);
          float blink = step(0.965, h2(cell + 7.7)) * step(0.5, fract(uTime * 0.7 + r * 10.0));
          vec3 tint = mix(uWarm, uCool, step(1.0 - uMix, h2(cell + 3.3)));
          // Brightness falls off toward the top floors of tall facades.
          totalEmissiveRadiance += tint * on * uGlow * life * (1.0 - blink * 0.8);
        }`);
    mat.userData.shader = shader;
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Dynasty pack
// ---------------------------------------------------------------------------

/**
 * The signature East-Asian roof: a ridge that sags into a concave slope and
 * flares upward at the eaves, with the corners kicking highest.
 */
export function sweepRoof(w, d, h, opts = {}) {
  const segX = opts.segX ?? 14, segZ = opts.segZ ?? 12;
  const overhang = opts.overhang ?? 0.5;
  const flare = opts.flare ?? 0.42;
  const corner = opts.corner ?? 2.6;
  const concave = opts.concave ?? 1.42;

  const W = w / 2 + overhang * w * 0.5;
  const D = d / 2 + overhang * d * 0.5;

  const pos = [], nrm = [], uv = [], idx = [];
  const heightAt = (nx, nz) => {
    const az = Math.abs(nz);
    // Concave slope from ridge (nz=0) to eave (|nz|=1).
    let y = h * (1 - Math.pow(az, concave));
    // Upward flare, strongest at the corners.
    const cb = 1 + corner * Math.pow(Math.abs(nx), 4.0);
    y += flare * h * Math.pow(az, 5.0) * cb;
    return y;
  };
  for (let j = 0; j <= segZ; j++) {
    const nz = (j / segZ) * 2 - 1;
    for (let i = 0; i <= segX; i++) {
      const nx = (i / segX) * 2 - 1;
      // Eaves push out at the corners as well as up.
      const stretch = 1 + 0.10 * Math.pow(Math.abs(nz), 4) * Math.pow(Math.abs(nx), 3);
      pos.push(nx * W * stretch, heightAt(nx, nz), nz * D * stretch);
      nrm.push(0, 1, 0);
      uv.push((nx * 0.5 + 0.5) * (opts.uvX ?? 3), (nz * 0.5 + 0.5) * (opts.uvZ ?? 2.4));
    }
  }
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i, b = a + 1, c = a + segX + 1, dd = c + 1;
      idx.push(a, c, b, b, c, dd);
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

function roofAssembly(w, d, h, mats, opts = {}) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(sweepRoof(w, d, h, opts), opts.material ?? mats.roof);
  shell.castShadow = true; shell.receiveShadow = true;
  g.add(shell);

  // Under-eave soffit gives the roof visible thickness from below.
  if (!mats._soffit) {
    mats._soffit = mats.redWood.clone();
    mats._soffit.side = THREE.BackSide;
  }
  const under = new THREE.Mesh(sweepRoof(w * 0.995, d * 0.995, h * 0.97, opts), mats._soffit);
  under.position.y = -0.22;
  g.add(under);

  // Ridge beam with end ornaments.
  const ridge = new THREE.Mesh(
    new THREE.BoxGeometry(w * (1 + (opts.overhang ?? 0.5) * 0.5) * 1.02, h * 0.14, d * 0.09),
    mats.roofGold);
  ridge.position.y = h + h * 0.06;
  ridge.castShadow = true;
  g.add(ridge);
  for (const sx of [-1, 1]) {
    const orn = new THREE.Mesh(new THREE.ConeGeometry(h * 0.13, h * 0.4, 6), mats.roofGold);
    orn.position.set(sx * w * 0.5 * (1 + (opts.overhang ?? 0.5) * 0.5), h + h * 0.24, 0);
    orn.rotation.z = sx * -0.35;
    g.add(orn);
  }
  return g;
}

/** Bracket set (斗拱) suggested with stacked blocks under the eaves. */
function dougong(w, d, mats, count = 5) {
  const geos = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = (t - 0.5) * w * 0.86;
    for (const sz of [-1, 1]) {
      const b1 = new THREE.BoxGeometry(0.42, 0.22, 0.42);
      b1.translate(x, 0, sz * d * 0.5);
      const b2 = new THREE.BoxGeometry(0.9, 0.16, 0.3);
      b2.translate(x, 0.24, sz * d * 0.5);
      const b3 = new THREE.BoxGeometry(0.3, 0.16, 0.95);
      b3.translate(x, 0.44, sz * d * 0.5);
      geos.push(b1, b2, b3);
    }
  }
  const m = new THREE.Mesh(mergeGeometries(geos), mats.goldWood);
  m.castShadow = true;
  return m;
}

/** Timber hall: stone plinth, red columns, lattice screens, sweeping roof. */
export function dynastyHall(opts = {}) {
  const mats = architectureMaterials();
  const rng = makeRng(opts.seed ?? 3);
  const w = opts.w ?? 9 + rng() * 5;
  const d = opts.d ?? 7 + rng() * 4;
  const storeys = opts.storeys ?? (rng() < 0.35 ? 2 : 1);
  const storeyH = opts.storeyH ?? 3.4;
  const g = new THREE.Group();

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.14, 0.75, d * 1.14), mats.stone);
  plinth.position.y = 0.375;
  plinth.castShadow = plinth.receiveShadow = true;
  g.add(plinth);

  const winMat = opts.windowMaterial ?? makeWindowMaterial({
    cols: 5, rows: 2, lit: opts.lit ?? 0.7, glow: opts.glow ?? 2.6,
    emissive: 0xffb457, frame: 0x2a1410, coolMix: 0.0, seed: rng() * 10,
  });

  for (let s = 0; s < storeys; s++) {
    const shrink = 1 - s * 0.12;
    const y = 0.75 + s * storeyH;
    const sw = w * shrink, sd = d * shrink;

    // Plaster infill wall
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sw * 0.94, storeyH, sd * 0.94), mats.plaster);
    wall.position.y = y + storeyH / 2;
    wall.castShadow = wall.receiveShadow = true;
    g.add(wall);

    // Lattice screens on the long faces
    for (const sz of [-1, 1]) {
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw * 0.8, storeyH * 0.62), winMat);
      screen.position.set(0, y + storeyH * 0.55, sz * (sd * 0.472 + 0.02));
      screen.rotation.y = sz > 0 ? 0 : Math.PI;
      g.add(screen);
    }

    // Corner columns
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, storeyH, 8), mats.redWood);
        col.position.set(sx * sw * 0.47, y + storeyH / 2, sz * sd * 0.47);
        col.castShadow = true;
        g.add(col);
      }
    }

    const brackets = dougong(sw, sd, mats, 4);
    brackets.position.y = y + storeyH - 0.1;
    g.add(brackets);

    const roof = roofAssembly(sw, sd, storeyH * (s === storeys - 1 ? 0.85 : 0.5), mats, {
      overhang: 0.55, flare: 0.46, corner: 2.8,
      material: opts.roofMaterial ?? (rng() < 0.25 ? mats.roofGreen : mats.roof),
    });
    roof.position.y = y + storeyH;
    g.add(roof);
  }

  // Entrance steps
  const steps = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.26, 1.4), mats.stone);
  steps.position.set(0, 0.13, d * 0.6);
  g.add(steps);

  g.userData.windowMaterial = winMat;
  g.userData.footprint = Math.max(w, d) * 0.75;
  return g;
}

/** Multi-eave pagoda — the skyline anchor of the dynasty theme. */
export function pagoda(opts = {}) {
  const mats = architectureMaterials();
  const rng = makeRng(opts.seed ?? 17);
  const levels = opts.levels ?? 5 + Math.floor(rng() * 3);
  const baseW = opts.baseW ?? 8.5;
  const storeyH = opts.storeyH ?? 3.6;
  const g = new THREE.Group();

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(baseW * 0.82, baseW * 0.92, 1.2, 8), mats.stone);
  plinth.position.y = 0.6;
  plinth.castShadow = plinth.receiveShadow = true;
  g.add(plinth);

  const winMat = makeWindowMaterial({
    cols: 4, rows: 1, lit: 0.85, glow: 3.4, emissive: 0xffb457, frame: 0x2a1410, coolMix: 0, seed: rng() * 9,
  });

  for (let i = 0; i < levels; i++) {
    const k = 1 - i / (levels + 1.6);
    const w = baseW * k;
    const y = 1.2 + i * storeyH * (0.92 - i * 0.015);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.46, w * 0.49, storeyH * 0.78, 8), mats.redWood);
    body.position.y = y + storeyH * 0.39;
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Balcony railing
    const rail = new THREE.Mesh(new THREE.TorusGeometry(w * 0.56, 0.07, 6, 24), mats.goldWood);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = y + storeyH * 0.16;
    g.add(rail);

    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * TAU + Math.PI / 4;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.4, storeyH * 0.4), winMat);
      screen.position.set(Math.cos(a) * w * 0.47, y + storeyH * 0.46, Math.sin(a) * w * 0.47);
      screen.lookAt(Math.cos(a) * 100, y + storeyH * 0.46, Math.sin(a) * 100);
      g.add(screen);
    }

    const roof = roofAssembly(w * 1.28, w * 1.28, storeyH * 0.5, mats, {
      overhang: 0.62, flare: 0.55, corner: 3.2, segX: 12, segZ: 12,
      material: mats.roof,
    });
    roof.position.y = y + storeyH * 0.78;
    g.add(roof);

    // Corner bells
    for (let c = 0; c < 4; c++) {
      const a = (c / 4) * TAU + Math.PI / 4;
      const r = w * 0.82;
      const bell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 6), mats.roofGold);
      bell.position.set(Math.cos(a) * r, y + storeyH * 0.78 + storeyH * 0.32, Math.sin(a) * r);
      g.add(bell);
    }
  }

  // Finial spire with rings
  const topY = 1.2 + levels * storeyH * 0.86;
  const spire = new THREE.Mesh(new THREE.ConeGeometry(0.5, 5.2, 8), mats.roofGold);
  spire.position.y = topY + 2.6;
  spire.castShadow = true;
  g.add(spire);
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5 - i * 0.06, 0.06, 5, 12), mats.roofGold);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = topY + 1.1 + i * 0.42;
    g.add(ring);
  }
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshStandardMaterial({
    color: 0xffcf6a, metalness: 1.0, roughness: 0.22, emissive: 0xff9a2e, emissiveIntensity: 0.8,
  }));
  orb.position.y = topY + 5.4;
  g.add(orb);

  g.userData.windowMaterial = winMat;
  g.userData.footprint = baseW;
  return g;
}

/** Paifang: the ceremonial gateway straddling the road. */
export function paifang(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const span = opts.span ?? 26;
  const h = opts.height ?? 11;
  const colR = 0.55;

  const xs = [-span / 2, -span / 6, span / 6, span / 2];
  for (const x of xs) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 1.8), mats.stone);
    base.position.set(x, 0.55, 0);
    base.castShadow = base.receiveShadow = true;
    g.add(base);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(colR, colR * 1.08, h, 12), mats.redWood);
    col.position.set(x, 1.1 + h / 2, 0);
    col.castShadow = true;
    g.add(col);
  }

  // Horizontal beams tying the columns together
  for (const y of [h * 0.62, h * 0.86]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 2.2, 0.62, 0.9), mats.redWood);
    beam.position.set(0, 1.1 + y, 0);
    beam.castShadow = true;
    g.add(beam);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(span + 2.4, 0.14, 1.04), mats.goldWood);
    trim.position.set(0, 1.1 + y + 0.38, 0);
    g.add(trim);
  }

  // Name plaque
  const plaqueTex = lanternTexture(opts.glyph ?? '飞');
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.0), new THREE.MeshStandardMaterial({
    map: plaqueTex, emissiveMap: plaqueTex, emissive: 0xffffff, emissiveIntensity: 0.55,
    roughness: 0.6, metalness: 0.1,
  }));
  plaque.position.set(0, 1.1 + h * 0.74, 0.52);
  g.add(plaque);
  const plaqueB = plaque.clone();
  plaqueB.position.z = -0.52;
  plaqueB.rotation.y = Math.PI;
  g.add(plaqueB);

  // Tiered roofs: a tall centre flanked by two lower wings
  const centre = roofAssembly(span * 0.46, 3.4, 2.1, mats, { overhang: 0.7, flare: 0.6, corner: 3.0 });
  centre.position.y = 1.1 + h;
  g.add(centre);
  for (const sx of [-1, 1]) {
    const wing = roofAssembly(span * 0.34, 3.0, 1.6, mats, { overhang: 0.7, flare: 0.6, corner: 3.0 });
    wing.position.set(sx * span * 0.38, 1.1 + h * 0.86, 0);
    g.add(wing);
  }
  g.userData.footprint = span * 0.6;
  return g;
}

/** Hanging paper lanterns — the strongest night-time signature of the theme. */
export function lanternString(count, spacing, opts = {}) {
  const g = new THREE.Group();
  const tex = lanternTexture(opts.glyph ?? '福');
  const mat = new THREE.MeshStandardMaterial({
    map: tex, emissiveMap: tex, emissive: 0xffffff,
    emissiveIntensity: opts.glow ?? 2.6, roughness: 0.75, metalness: 0.0,
  });
  const capMat = architectureMaterials().goldWood;
  const body = new THREE.SphereGeometry(0.44, 14, 12);
  body.scale(1, 0.82, 1);
  const inst = new THREE.InstancedMesh(body, mat, count);
  const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8), capMat, count * 2);
  const m = new THREE.Matrix4();
  const rng = makeRng(opts.seed ?? 5);
  const sway = [];
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    // Catenary droop between the posts.
    const t = (i / Math.max(1, count - 1)) * 2 - 1;
    const y = -Math.cos(t * 1.15) * (opts.droop ?? 0.9) + (opts.droop ?? 0.9);
    sway.push({ x, y, phase: rng() * TAU, scale: 0.85 + rng() * 0.4 });
    m.makeTranslation(x, -y, 0);
    inst.setMatrixAt(i, m);
    m.makeTranslation(x, -y + 0.5, 0); caps.setMatrixAt(i * 2, m);
    m.makeTranslation(x, -y - 0.5, 0); caps.setMatrixAt(i * 2 + 1, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  g.add(inst, caps);

  // Cord
  const pts = sway.map((s) => V(s.x, -s.y + 0.55, 0));
  const cord = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.035, 5, false),
    new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.9 }));
  g.add(cord);

  g.userData.update = (t) => {
    const mm = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const s = sway[i];
      const a = Math.sin(t * 1.3 + s.phase) * 0.09;
      mm.makeRotationZ(a);
      mm.setPosition(s.x + Math.sin(t * 0.9 + s.phase) * 0.06, -s.y, Math.sin(t * 0.7 + s.phase) * 0.08);
      mm.scale(new THREE.Vector3(s.scale, s.scale, s.scale));
      inst.setMatrixAt(i, mm);
    }
    inst.instanceMatrix.needsUpdate = true;
  };
  return g;
}

/** Stone arch bridge for crossing water or ravines beside the track. */
export function archBridge(opts = {}) {
  const mats = architectureMaterials();
  const span = opts.span ?? 22;
  const rise = opts.rise ?? 5;
  const width = opts.width ?? 5;
  const g = new THREE.Group();

  const segs = 26;
  const geos = [];
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const y0 = Math.sin(t0 * Math.PI) * rise;
    const y1 = Math.sin(t1 * Math.PI) * rise;
    const x0 = (t0 - 0.5) * span, x1 = (t1 - 0.5) * span;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const deck = new THREE.BoxGeometry(len * 1.02, 0.55, width);
    deck.rotateZ(Math.atan2(y1 - y0, x1 - x0));
    deck.translate((x0 + x1) / 2, (y0 + y1) / 2 + 0.3, 0);
    geos.push(deck);
  }
  // Arch ring under the deck
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = Math.PI * t;
    const r = span * 0.5;
    const x = -Math.cos(a) * r;
    const y = Math.sin(a) * r * (rise / (span * 0.5)) * 0.92;
    const b = new THREE.BoxGeometry(1.3, 0.9, width * 0.9);
    b.rotateZ(a - Math.PI / 2);
    b.translate(x, y - 0.35, 0);
    geos.push(b);
  }
  const body = new THREE.Mesh(mergeGeometries(geos), mats.stone);
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // Balustrades
  for (const sz of [-1, 1]) {
    const posts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const x = (t - 0.5) * span;
      const y = Math.sin(t * Math.PI) * rise + 0.6;
      const p = new THREE.BoxGeometry(0.22, 1.0, 0.22);
      p.translate(x, y + 0.5, sz * width * 0.46);
      posts.push(p);
    }
    const rail = [];
    for (let i = 0; i < 12; i++) {
      const t0 = i / 12, t1 = (i + 1) / 12;
      const x0 = (t0 - 0.5) * span, x1 = (t1 - 0.5) * span;
      const y0 = Math.sin(t0 * Math.PI) * rise + 1.5;
      const y1 = Math.sin(t1 * Math.PI) * rise + 1.5;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const r = new THREE.BoxGeometry(len * 1.05, 0.18, 0.3);
      r.rotateZ(Math.atan2(y1 - y0, x1 - x0));
      r.translate((x0 + x1) / 2, (y0 + y1) / 2, sz * width * 0.46);
      rail.push(r);
    }
    const m = new THREE.Mesh(mergeGeometries([...posts, ...rail]), mats.marble);
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Metro pack
// ---------------------------------------------------------------------------

/** Glass tower with setbacks, crown lighting and an emissive window grid. */
export function skyscraper(opts = {}) {
  const mats = architectureMaterials();
  const rng = makeRng(opts.seed ?? 91);
  const g = new THREE.Group();
  const w = opts.w ?? 14 + rng() * 20;
  const d = opts.d ?? 14 + rng() * 20;
  const h = opts.h ?? 60 + rng() * 150;
  const tiers = 1 + Math.floor(rng() * 3);

  const facade = makeWindowMaterial({
    cols: Math.max(4, Math.round(w / 3.2)),
    rows: Math.max(8, Math.round(h / 3.6)),
    lit: opts.lit ?? 0.42,
    glow: opts.glow ?? 2.4,
    emissive: 0xffd9a0,
    emissive2: 0x8fd8ff,
    coolMix: 0.4,
    frame: 0x0d1016,
    roughness: 0.14,
    metalness: 0.72,
    seed: rng() * 100,
  });
  const glass = glassFacadeMaps();
  facade.map = glass.map.clone();
  facade.map.repeat.set(Math.max(1, w / 18), Math.max(1, h / 26));
  facade.map.needsUpdate = true;
  facade.normalMap = glass.normalMap;
  facade.envMapIntensity = 1.5;

  // Tiers share one material, and so do the bands and mast, so each tower
  // collapses to two draw calls instead of a dozen — the skyline is dense
  // enough that this matters.
  const tierGeos = [], trimGeos = [];
  let y = 0, cw = w, cd = d;
  for (let t = 0; t < tiers; t++) {
    const th = h * (t === 0 ? 0.55 : 0.45 / (tiers - 1 || 1)) * (0.8 + rng() * 0.5);
    const box = new THREE.BoxGeometry(cw, th, cd);
    box.translate(0, y + th / 2, 0);
    tierGeos.push(box);

    // Structural banding between tiers.
    const band = new THREE.BoxGeometry(cw * 1.035, 0.9, cd * 1.035);
    band.translate(0, y + th, 0);
    trimGeos.push(band);

    y += th;
    cw *= 0.78 + rng() * 0.12;
    cd *= 0.78 + rng() * 0.12;
  }

  // Crown: an antenna mast, merged into the trim.
  const mast = new THREE.CylinderGeometry(0.25, 0.5, h * 0.16, 6);
  mast.translate(0, y + h * 0.08, 0);
  trimGeos.push(mast);

  const shell = new THREE.Mesh(mergeGeometries(tierGeos), facade);
  shell.castShadow = true;
  shell.receiveShadow = true;
  g.add(shell);
  const trim = new THREE.Mesh(mergeGeometries(trimGeos), mats.darkMetal);
  trim.castShadow = true;
  g.add(trim);
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0xff2a3a, emissive: 0xff2030, emissiveIntensity: 5, roughness: 0.4,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), beaconMat);
  beacon.position.y = y + h * 0.16;
  g.add(beacon);
  g.userData.beacon = beaconMat;
  g.userData.windowMaterial = facade;
  g.userData.footprint = Math.max(w, d) * 0.75;
  g.userData.height = y;
  return g;
}

/** Free-standing holographic billboard. */
export function hologramSign(opts = {}) {
  const g = new THREE.Group();
  const text = opts.text ?? '飞';
  const hue = opts.hue ?? 0.55;
  const tex = neonSignTexture(text, hue, 256);
  const w = opts.w ?? 8, h = opts.h ?? 8;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  panel.position.y = h / 2;
  g.add(panel);

  const frameMat = architectureMaterials().darkMetal;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.3, 0.3), frameMat);
  frame.position.y = 0;
  g.add(frame);
  const top = frame.clone(); top.position.y = h;
  g.add(top);

  g.userData.update = (t) => {
    mat.opacity = 0.72 + 0.24 * (0.5 + 0.5 * Math.sin(t * 3.1 + hue * 10));
  };
  return g;
}

/** Street lamp with a real light where it matters and emissive glass always. */
export function streetLamp(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const h = opts.height ?? 8;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, h, 8), mats.darkMetal);
  pole.position.y = h / 2;
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.16), mats.darkMetal);
  arm.position.set(1.0, h - 0.2, 0);
  g.add(arm);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x22262e, emissive: new THREE.Color(opts.color ?? 0xffd9a8),
    emissiveIntensity: opts.glow ?? 4.5, roughness: 0.35,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.26, 0.5), headMat);
  head.position.set(1.9, h - 0.32, 0);
  g.add(head);
  g.userData.lightAnchor = V(1.9, h - 0.5, 0);
  g.userData.emissive = headMat;
  return g;
}

// ---------------------------------------------------------------------------
// Alpine pack
// ---------------------------------------------------------------------------

export function chalet(opts = {}) {
  const mats = architectureMaterials();
  const rng = makeRng(opts.seed ?? 61);
  const g = new THREE.Group();
  const w = opts.w ?? 8 + rng() * 4;
  const d = opts.d ?? 7 + rng() * 3;
  const h = opts.h ?? 3.2 + rng() * 2.4;

  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, 1.0, d * 1.05), mats.stone);
  base.position.y = 0.5;
  base.castShadow = base.receiveShadow = true;
  g.add(base);

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.wood);
  body.position.y = 1.0 + h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  const winMat = makeWindowMaterial({
    cols: 4, rows: 2, lit: 0.75, glow: 3.2, emissive: 0xffc379, frame: 0x2c2018, coolMix: 0, seed: rng() * 20,
  });
  for (const sz of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, h * 0.42), winMat);
    win.position.set(0, 1.0 + h * 0.58, sz * (d / 2 + 0.02));
    win.rotation.y = sz > 0 ? 0 : Math.PI;
    g.add(win);
  }

  // Deep gable roof under a snow load
  const roofH = h * 0.9;
  const prism = new THREE.BufferGeometry();
  {
    const W = w * 0.62, D = d * 0.62, H = roofH;
    const verts = [];
    const add = (a, b, c) => verts.push(...a, ...b, ...c);
    const p = {
      fl: [-W, 0, D], fr: [W, 0, D], bl: [-W, 0, -D], br: [W, 0, -D],
      rf: [0, H, D], rb: [0, H, -D],
    };
    add(p.fl, p.fr, p.rf);
    add(p.br, p.bl, p.rb);
    add(p.fr, p.br, p.rb); add(p.fr, p.rb, p.rf);
    add(p.bl, p.fl, p.rf); add(p.bl, p.rf, p.rb);
    prism.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    prism.computeVertexNormals();
    const uvs = [];
    for (let i = 0; i < verts.length / 3; i++) uvs.push((i % 3) * 0.5, Math.floor(i / 3) % 2);
    prism.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  }
  const roofMesh = new THREE.Mesh(prism, mats.wood);
  roofMesh.position.y = 1.0 + h;
  roofMesh.castShadow = roofMesh.receiveShadow = true;
  g.add(roofMesh);

  const snowCap = new THREE.Mesh(prism.clone().scale(1.04, 1.0, 1.04), mats.snow);
  snowCap.position.y = 1.0 + h + 0.14;
  snowCap.castShadow = true;
  g.add(snowCap);

  // Balcony
  const balcony = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, 0.16, 1.4), mats.wood);
  balcony.position.set(0, 1.0 + h * 0.52, d / 2 + 0.6);
  balcony.castShadow = true;
  g.add(balcony);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 1.1, 0.7, 0.12), mats.wood);
  rail.position.set(0, 1.0 + h * 0.52 + 0.42, d / 2 + 1.24);
  g.add(rail);

  g.userData.windowMaterial = winMat;
  g.userData.footprint = Math.max(w, d) * 0.8;
  return g;
}

/** Cable car line strung across the valley, with gondolas that actually run. */
export function cableCar(from, to, opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const sag = opts.sag ?? 18;
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y -= sag;
  const curve = new THREE.CatmullRomCurve3([from, mid, to]);

  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 48, 0.16, 5, false),
    mats.darkMetal);
  g.add(cable);

  for (const p of [from, to]) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.1, 26, 8), mats.darkMetal);
    tower.position.set(p.x, p.y - 13, p.z);
    tower.castShadow = true;
    g.add(tower);
  }

  const cabins = [];
  const cabinGeo = new THREE.BoxGeometry(2.6, 2.4, 3.2);
  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0xd8443a, roughness: 0.4, metalness: 0.3,
    emissive: 0x331008, emissiveIntensity: 1.0,
  });
  const n = opts.count ?? 5;
  for (let i = 0; i < n; i++) {
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.castShadow = true;
    const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), mats.darkMetal);
    hanger.position.y = 2.0;
    cabin.add(hanger);
    cabins.push({ mesh: cabin, t: i / n });
    g.add(cabin);
  }

  g.userData.update = (dt) => {
    for (const c of cabins) {
      c.t = (c.t + dt * (opts.speed ?? 0.012)) % 1;
      const p = curve.getPointAt(c.t);
      c.mesh.position.set(p.x, p.y - 1.8, p.z);
      c.mesh.rotation.z = Math.sin(c.t * 20) * 0.05;
    }
  };
  return g;
}

/** Stone chapel with a bell spire — the alpine skyline landmark. */
export function chapel(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const w = opts.w ?? 9, d = opts.d ?? 15, h = opts.h ?? 7;

  const nave = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.stone);
  nave.position.y = h / 2;
  nave.castShadow = nave.receiveShadow = true;
  g.add(nave);

  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, w * 0.78, h * 0.55, 4, 1), mats.snow);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + h * 0.27;
  roof.scale.set(1, 1, d / w);
  roof.castShadow = true;
  g.add(roof);

  const tower = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, h * 2.1, w * 0.42), mats.stone);
  tower.position.set(0, h * 1.05, -d * 0.42);
  tower.castShadow = true;
  g.add(tower);

  const spire = new THREE.Mesh(new THREE.ConeGeometry(w * 0.32, h * 1.3, 4), mats.darkMetal);
  spire.position.set(0, h * 2.1 + h * 0.65, -d * 0.42);
  spire.rotation.y = Math.PI / 4;
  spire.castShadow = true;
  g.add(spire);

  const winMat = makeWindowMaterial({
    cols: 3, rows: 4, lit: 0.85, glow: 3.6, emissive: 0xffb14e, emissive2: 0xff6a8a, coolMix: 0.4, seed: 4,
  });
  for (const sz of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(d * 0.7, h * 0.5), winMat);
    win.position.set(sz * (w / 2 + 0.02), h * 0.55, 0);
    win.rotation.y = sz * Math.PI / 2;
    g.add(win);
  }
  g.userData.windowMaterial = winMat;
  g.userData.footprint = Math.max(w, d) * 0.8;
  return g;
}

// ---------------------------------------------------------------------------
// Shared roadside props
// ---------------------------------------------------------------------------

export function torii(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const w = opts.w ?? 9, h = opts.h ?? 8;
  for (const sx of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, h, 12), mats.redWood);
    col.position.set(sx * w / 2, h / 2, 0);
    col.rotation.z = sx * 0.02;
    col.castShadow = true;
    g.add(col);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(w * 1.5, 0.55, 1.0), mats.redWood);
  top.position.y = h;
  top.rotation.z = 0;
  top.castShadow = true;
  g.add(top);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 1.62, 0.3, 1.25), mats.roof);
  cap.position.y = h + 0.42;
  g.add(cap);
  const tie = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, 0.4, 0.6), mats.redWood);
  tie.position.y = h - 1.6;
  g.add(tie);
  return g;
}

export function banner(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const tex = lanternTexture(opts.glyph ?? '速');
  const mat = new THREE.MeshStandardMaterial({
    map: tex, side: THREE.DoubleSide, roughness: 0.85,
    emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: opts.glow ?? 0.5,
  });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 6, 8), mats.wood);
  pole.position.y = 3;
  pole.castShadow = true;
  g.add(pole);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 3.2, 4, 8), mat);
  cloth.position.set(0.5, 3.4, 0);
  g.add(cloth);
  const geo = cloth.geometry;
  const base = geo.attributes.position.array.slice();
  g.userData.update = (t) => {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1];
      const k = (x + 0.45) / 0.9;
      p.setZ(i, Math.sin(t * 3.4 + y * 1.6 + k * 2.0) * 0.18 * k);
    }
    p.needsUpdate = true;
  };
  return g;
}

/** Spectator grandstand with a crowd of instanced silhouettes. */
export function grandstand(opts = {}) {
  const mats = architectureMaterials();
  const g = new THREE.Group();
  const w = opts.w ?? 34;
  const rows = opts.rows ?? 8;
  const rowH = 0.7, rowD = 1.05;

  const geos = [];
  for (let r = 0; r < rows; r++) {
    const step = new THREE.BoxGeometry(w, rowH, rowD);
    step.translate(0, r * rowH + rowH / 2, -r * rowD);
    geos.push(step);
  }
  const stand = new THREE.Mesh(mergeGeometries(geos), mats.concrete);
  stand.castShadow = stand.receiveShadow = true;
  g.add(stand);

  // Crowd
  const rng = makeRng(opts.seed ?? 12);
  const perRow = Math.floor(w / 0.85);
  const count = perRow * rows;
  const person = new THREE.CapsuleGeometry(0.22, 0.5, 3, 6);
  const crowdMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const crowd = new THREE.InstancedMesh(person, crowdMat, count);
  const color = new THREE.Color();
  const m = new THREE.Matrix4();
  const phases = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < perRow; c++) {
      const x = (c / (perRow - 1) - 0.5) * w * 0.94;
      const y = r * rowH + rowH + 0.5;
      const z = -r * rowD + 0.1;
      phases.push({ x, y, z, p: rng() * TAU, s: 0.9 + rng() * 0.3 });
      m.makeTranslation(x, y, z);
      crowd.setMatrixAt(i, m);
      color.setHSL(rng(), 0.55, 0.42 + rng() * 0.2);
      crowd.setColorAt(i, color);
      i++;
    }
  }
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  crowd.castShadow = true;
  g.add(crowd);

  // Canopy
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.3, rows * rowD + 2), mats.darkMetal);
  canopy.position.set(0, rows * rowH + 3.6, -rows * rowD * 0.5 + 0.6);
  canopy.castShadow = true;
  g.add(canopy);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, rows * rowH + 3.6), mats.darkMetal);
    post.position.set(sx * w * 0.48, (rows * rowH + 3.6) / 2, -rows * rowD + 0.5);
    g.add(post);
  }

  g.userData.update = (t) => {
    const mm = new THREE.Matrix4();
    for (let k = 0; k < phases.length; k++) {
      const ph = phases[k];
      // Mexican-wave style bob so the crowd never looks frozen.
      const bob = Math.abs(Math.sin(t * 2.4 + ph.p)) * 0.16;
      mm.makeTranslation(ph.x, ph.y + bob, ph.z);
      mm.scale(new THREE.Vector3(ph.s, ph.s, ph.s));
      crowd.setMatrixAt(k, mm);
    }
    crowd.instanceMatrix.needsUpdate = true;
  };
  g.userData.footprint = w * 0.6;
  return g;
}
