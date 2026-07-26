// Procedural PBR texture foundry.
//
// Every surface in the game (asphalt, roof tiles, timber, plaster, marble,
// snow, foliage...) is baked here at load time into albedo + normal +
// roughness maps. Nothing is fetched from disk, so the whole game is one
// self-contained bundle and every material is tileable by construction.

import * as THREE from 'three';
import { fbm2, valueNoise2, worley2, hash2, clamp, smoothstep, mix } from './noise.js';

const cache = new Map();

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/**
 * Bake a material from a per-texel shader function.
 * @param {number} size texture resolution (must tile at `size`)
 * @param {(x:number,y:number)=>[number,number,number,number,number]} fn
 *        returns [r, g, b, height(0..1), roughness(0..1)] with r/g/b in 0..1
 * @param {object} opts { repeat, normalScale, aniso }
 */
export function bakeMaterialMaps(key, size, fn, opts = {}) {
  if (cache.has(key)) return cache.get(key);

  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const normal = makeCanvas(size);
  const ac = albedo.getContext('2d');
  const rc = rough.getContext('2d');
  const nc = normal.getContext('2d');

  const aData = ac.createImageData(size, size);
  const rData = rc.createImageData(size, size);
  const nData = nc.createImageData(size, size);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const [r, g, b, h, ro] = fn(x, y);
      aData.data[i * 4 + 0] = clamp(r, 0, 1) * 255;
      aData.data[i * 4 + 1] = clamp(g, 0, 1) * 255;
      aData.data[i * 4 + 2] = clamp(b, 0, 1) * 255;
      aData.data[i * 4 + 3] = 255;
      const rv = clamp(ro, 0, 1) * 255;
      rData.data[i * 4 + 0] = rv;
      rData.data[i * 4 + 1] = rv;
      rData.data[i * 4 + 2] = rv;
      rData.data[i * 4 + 3] = 255;
      heights[i] = h;
    }
  }

  // Sobel the height field into a tangent-space normal map.
  const strength = opts.normalStrength ?? 2.2;
  const at = (x, y) => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      let nx = dx * strength, ny = dy * strength, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      nData.data[i * 4 + 0] = (nx * 0.5 + 0.5) * 255;
      nData.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      nData.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      nData.data[i * 4 + 3] = 255;
    }
  }

  ac.putImageData(aData, 0, 0);
  rc.putImageData(rData, 0, 0);
  nc.putImageData(nData, 0, 0);

  const repeat = opts.repeat || [1, 1];
  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = opts.aniso ?? 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const maps = { map: mk(albedo, true), normalMap: mk(normal, false), roughnessMap: mk(rough, false) };
  cache.set(key, maps);
  return maps;
}

/** Clone a baked map set with an independent repeat (textures share GPU data). */
export function retile(maps, rx, ry) {
  const out = {};
  for (const k of Object.keys(maps)) {
    const t = maps[k].clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    out[k] = t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surface recipes
// ---------------------------------------------------------------------------

export function asphaltMaps(size = 512) {
  return bakeMaterialMaps('asphalt', size, (x, y) => {
    const u = x / size * 8, v = y / size * 8;
    // Aggregate: fine cellular chips embedded in a darker binder.
    const chips = worley2(u * 6, v * 6);
    const grit = fbm2(u * 22, v * 22, 4);
    const macro = fbm2(u * 1.5, v * 1.5, 4);
    const chip = smoothstep(0.18, 0.02, chips);
    // True asphalt sits near 0.08 albedo, which reads as a black void next to
    // lit grass. Lifted into the 0.13-0.32 range so the road stays legibly
    // grey while the aggregate detail survives.
    let l = 0.13 + grit * 0.075 + macro * 0.065 + chip * 0.11;
    // Faint tyre-polished lanes and oil sheen.
    const polish = smoothstep(0.35, 0.5, macro);
    const rough = 0.94 - polish * 0.28 - chip * 0.12;
    const h = grit * 0.5 + chip * 0.5;
    const tint = 1 + (valueNoise2(u * 3.1, v * 3.1) - 0.5) * 0.12;
    return [l * tint * 1.02, l * tint, l * tint * 1.06, h, rough];
  }, { repeat: [1, 1], normalStrength: 1.6 });
}

export function wetAsphaltMaps(size = 512) {
  return bakeMaterialMaps('wetasphalt', size, (x, y) => {
    const u = x / size * 8, v = y / size * 8;
    const chips = worley2(u * 6, v * 6);
    const grit = fbm2(u * 22, v * 22, 4);
    const macro = fbm2(u * 1.7, v * 1.7, 4);
    const chip = smoothstep(0.16, 0.02, chips);
    // Standing water pools flatten the surface and darken it dramatically.
    const puddle = smoothstep(0.42, 0.62, fbm2(u * 0.9 + 11, v * 0.9 - 4, 4));
    let l = 0.085 + grit * 0.045 + chip * 0.07;
    l = mix(l, 0.03, puddle);
    const rough = mix(0.88 - chip * 0.1, 0.06, puddle);
    const h = mix(grit * 0.5 + chip * 0.5, 0.5, puddle);
    return [l * 1.0, l * 1.03, l * 1.14, h, rough];
  }, { repeat: [1, 1], normalStrength: 1.2 });
}

export function concreteMaps(size = 512) {
  return bakeMaterialMaps('concrete', size, (x, y) => {
    const u = x / size * 6, v = y / size * 6;
    const n = fbm2(u * 4, v * 4, 5);
    const blotch = fbm2(u * 0.8, v * 0.8, 3);
    const pores = smoothstep(0.86, 0.95, valueNoise2(u * 60, v * 60));
    const l = 0.42 + n * 0.16 + blotch * 0.12 - pores * 0.18;
    return [l * 1.0, l * 0.99, l * 0.95, n * 0.6 - pores * 0.4 + 0.4, 0.86 - n * 0.1];
  }, { repeat: [1, 1], normalStrength: 1.4 });
}

export function marbleMaps(size = 512) {
  return bakeMaterialMaps('marble', size, (x, y) => {
    const u = x / size * 4, v = y / size * 4;
    const warp = fbm2(u * 2 + 3, v * 2 - 7, 4) * 2.2;
    const vein = Math.abs(Math.sin((u * 2.4 + warp) * Math.PI));
    const fine = fbm2(u * 9, v * 9, 4);
    const veinMask = smoothstep(0.55, 0.06, vein);
    const l = 0.82 + fine * 0.08 - veinMask * 0.34;
    return [l * 1.0, l * 0.985, l * 0.95, 0.5 + veinMask * 0.12, 0.24 + veinMask * 0.3 + fine * 0.1];
  }, { repeat: [1, 1], normalStrength: 0.7 });
}

export function roofTileMaps(size = 512) {
  // East-Asian barrel roof tiles: alternating convex ridges and gutters.
  return bakeMaterialMaps('rooftile', size, (x, y) => {
    const u = x / size, v = y / size;
    const cols = 10, rows = 12;
    const cu = (u * cols) % 1;
    const rv = (v * rows) % 1;
    const rowIdx = Math.floor(v * rows);
    // Barrel profile across the tile, plus the lapped step down each row.
    const barrel = Math.sin(cu * Math.PI);
    const lap = smoothstep(0.0, 0.16, rv) * (1 - smoothstep(0.86, 1.0, rv));
    const wear = fbm2(u * 24, v * 24, 4);
    const grime = fbm2(u * 5 + rowIdx, v * 5, 4);
    let h = barrel * 0.75 * lap + 0.1 + wear * 0.12;
    const shade = 0.35 + barrel * 0.35 * lap;
    const base = [0.19, 0.15, 0.17];
    const glaze = 0.55 + grime * 0.35;
    const l = shade * glaze;
    return [
      base[0] + l * 0.22 + wear * 0.05,
      base[1] + l * 0.16,
      base[2] + l * 0.20,
      h,
      0.42 + wear * 0.28 + (1 - barrel) * 0.15,
    ];
  }, { repeat: [1, 1], normalStrength: 2.6 });
}

export function woodMaps(size = 512) {
  return bakeMaterialMaps('wood', size, (x, y) => {
    const u = x / size * 3, v = y / size * 3;
    const warp = fbm2(u * 3, v * 0.6, 4) * 1.6;
    const rings = Math.abs(Math.sin((v * 9 + warp * 2.2) * Math.PI));
    const grain = fbm2(u * 40, v * 4, 4);
    const dark = smoothstep(0.72, 1.0, rings);
    const l = 0.30 + grain * 0.12 - dark * 0.14;
    return [l * 1.35, l * 0.86, l * 0.58, rings * 0.4 + grain * 0.5, 0.62 + dark * 0.2 + grain * 0.12];
  }, { repeat: [1, 1], normalStrength: 1.1 });
}

export function paintedWoodMaps(color = [0.62, 0.11, 0.10], key = 'paintwood', size = 256) {
  return bakeMaterialMaps(key, size, (x, y) => {
    const u = x / size * 3, v = y / size * 3;
    const grain = fbm2(u * 30, v * 3, 4);
    const chip = smoothstep(0.9, 1.0, valueNoise2(u * 12, v * 12));
    const l = 0.85 + grain * 0.2 - chip * 0.35;
    return [color[0] * l, color[1] * l, color[2] * l, grain * 0.6, 0.4 + grain * 0.25 + chip * 0.3];
  }, { repeat: [1, 1], normalStrength: 0.8 });
}

export function plasterMaps(size = 512) {
  return bakeMaterialMaps('plaster', size, (x, y) => {
    const u = x / size * 5, v = y / size * 5;
    const n = fbm2(u * 6, v * 6, 5);
    const trowel = fbm2(u * 1.4 + 9, v * 1.4, 3);
    // Damp staining creeping up from the base of the wall.
    const stain = smoothstep(0.55, 0.9, fbm2(u * 2.2, v * 0.9 + 4, 4)) * 0.14;
    const l = 0.86 + n * 0.1 + trowel * 0.06 - stain;
    return [l, l * 0.985, l * 0.95, n * 0.7 + trowel * 0.3, 0.9 - n * 0.08];
  }, { repeat: [1, 1], normalStrength: 1.0 });
}

export function stoneWallMaps(size = 512) {
  return bakeMaterialMaps('stonewall', size, (x, y) => {
    const u = x / size * 4, v = y / size * 4;
    const cell = worley2(u * 3.2, v * 4.6);
    const mortar = smoothstep(0.30, 0.06, cell);
    const rock = fbm2(u * 14, v * 14, 5);
    const l = mix(0.34 + rock * 0.22, 0.52, mortar);
    const tint = 1 + (hash2(Math.floor(u * 3.2), Math.floor(v * 4.6)) - 0.5) * 0.25;
    return [l * tint, l * tint * 0.97, l * tint * 0.9, (1 - mortar) * 0.75 + rock * 0.25, 0.88 - rock * 0.1];
  }, { repeat: [1, 1], normalStrength: 2.4 });
}

export function cobbleMaps(size = 512) {
  return bakeMaterialMaps('cobble', size, (x, y) => {
    const u = x / size * 6, v = y / size * 6;
    const cell = worley2(u * 4, v * 4);
    const dome = smoothstep(0.34, 0.04, cell);
    const wet = fbm2(u * 9, v * 9, 4);
    const l = 0.20 + dome * 0.22 + wet * 0.1;
    const tint = 1 + (hash2(Math.floor(u * 4), Math.floor(v * 4)) - 0.5) * 0.3;
    return [l * tint, l * tint * 0.98, l * tint * 0.94, dome, 0.72 - dome * 0.22 + wet * 0.12];
  }, { repeat: [1, 1], normalStrength: 2.6 });
}

export function grassGroundMaps(size = 512) {
  return bakeMaterialMaps('grassground', size, (x, y) => {
    const u = x / size * 8, v = y / size * 8;
    const blades = fbm2(u * 40, v * 40, 3);
    const clumps = fbm2(u * 3, v * 3, 4);
    const dirt = smoothstep(0.62, 0.85, fbm2(u * 1.6 + 20, v * 1.6, 4));
    // Real grass sits around 0.25 albedo; pushed a little higher here so the
    // ground still reads as green under a low, warm sun.
    const g = 0.30 + clumps * 0.26 + blades * 0.16;
    const r = mix(g * 0.46, 0.42, dirt);
    const gg = mix(g * 1.0, 0.34, dirt);
    const b = mix(g * 0.32, 0.24, dirt);
    return [r, gg, b, blades * 0.8 + clumps * 0.2, 0.95 - clumps * 0.08];
  }, { repeat: [1, 1], normalStrength: 1.2 });
}

export function sandMaps(size = 512) {
  return bakeMaterialMaps('sand', size, (x, y) => {
    const u = x / size * 8, v = y / size * 8;
    const ripple = Math.sin((u * 6 + fbm2(u, v, 3) * 4) * Math.PI) * 0.5 + 0.5;
    const grains = fbm2(u * 60, v * 60, 3);
    const l = 0.62 + ripple * 0.08 + grains * 0.1;
    return [l * 1.05, l * 0.96, l * 0.76, ripple * 0.6 + grains * 0.4, 0.93];
  }, { repeat: [1, 1], normalStrength: 1.0 });
}

export function snowMaps(size = 512) {
  return bakeMaterialMaps('snow', size, (x, y) => {
    const u = x / size * 6, v = y / size * 6;
    const drift = fbm2(u * 2.2, v * 2.2, 5);
    const sparkleSeed = valueNoise2(u * 90, v * 90);
    const sparkle = smoothstep(0.94, 1.0, sparkleSeed);
    const l = 0.88 + drift * 0.09 + sparkle * 0.12;
    return [l * 0.97, l * 0.99, l * 1.03, drift * 0.9 + sparkle * 0.1, 0.62 - sparkle * 0.45 - drift * 0.08];
  }, { repeat: [1, 1], normalStrength: 1.1 });
}

export function rockMaps(size = 512) {
  return bakeMaterialMaps('rock', size, (x, y) => {
    const u = x / size * 4, v = y / size * 4;
    const strata = fbm2(u * 2, v * 9, 5);
    const crack = smoothstep(0.10, 0.0, worley2(u * 5, v * 5));
    const detail = fbm2(u * 26, v * 26, 4);
    const l = 0.26 + strata * 0.20 + detail * 0.12 - crack * 0.16;
    return [l * 1.02, l * 0.97, l * 0.92, strata * 0.55 + detail * 0.45 - crack * 0.5, 0.92 - detail * 0.12];
  }, { repeat: [1, 1], normalStrength: 2.8 });
}

export function metalMaps(size = 256) {
  return bakeMaterialMaps('metal', size, (x, y) => {
    const u = x / size * 4, v = y / size * 4;
    const brush = fbm2(u * 80, v * 3, 3);
    const scuff = fbm2(u * 8, v * 8, 4);
    const l = 0.55 + brush * 0.18 + scuff * 0.08;
    return [l, l * 1.005, l * 1.02, brush * 0.8, 0.22 + brush * 0.22 + scuff * 0.16];
  }, { repeat: [1, 1], normalStrength: 0.6 });
}

export function glassFacadeMaps(size = 512) {
  // A curtain-wall: mullion grid with per-pane tint variation.
  return bakeMaterialMaps('glassfacade', size, (x, y) => {
    const u = x / size, v = y / size;
    const cols = 8, rows = 12;
    const cu = (u * cols) % 1, rv = (v * rows) % 1;
    const frame = smoothstep(0.06, 0.10, cu) * (1 - smoothstep(0.90, 0.94, cu)) *
                  smoothstep(0.07, 0.12, rv) * (1 - smoothstep(0.88, 0.93, rv));
    const pane = hash2(Math.floor(u * cols), Math.floor(v * rows));
    const dirt = fbm2(u * 10, v * 10, 4);
    const glassL = 0.05 + pane * 0.05 + dirt * 0.02;
    const r = mix(0.24, glassL * 0.7, frame);
    const g = mix(0.25, glassL * 0.95, frame);
    const b = mix(0.27, glassL * 1.5, frame);
    return [r, g, b, frame * 0.8, mix(0.55, 0.06 + dirt * 0.1, frame)];
  }, { repeat: [1, 1], normalStrength: 1.6 });
}

export function iceMaps(size = 512) {
  return bakeMaterialMaps('ice', size, (x, y) => {
    const u = x / size * 5, v = y / size * 5;
    const crack = smoothstep(0.09, 0.0, worley2(u * 3.4, v * 3.4));
    const swirl = fbm2(u * 4, v * 4, 5);
    const bubbles = smoothstep(0.9, 1.0, valueNoise2(u * 40, v * 40));
    const l = 0.66 + swirl * 0.1 + crack * 0.22 + bubbles * 0.2;
    return [l * 0.86, l * 0.95, l * 1.05, crack * 0.6 + swirl * 0.3 + bubbles * 0.1, 0.14 + crack * 0.35 + swirl * 0.1];
  }, { repeat: [1, 1], normalStrength: 1.4 });
}

/** Soft radial sprite used for particles, headlight cones and light bloom. */
export function radialSprite(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', power = 1) {
  const key = `sprite:${size}:${inner}:${outer}:${power}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    g.addColorStop(t, i === 0 ? inner : i === steps ? outer : blendCss(inner, outer, Math.pow(t, power)));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

function parseCss(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [255, 255, 255, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
function blendCss(a, b, t) {
  const A = parseCss(a), B = parseCss(b);
  const c = A.map((v, i) => v + (B[i] - v) * t);
  return `rgba(${c[0].toFixed(0)},${c[1].toFixed(0)},${c[2].toFixed(0)},${c[3].toFixed(3)})`;
}

/** Leaf/foliage card with alpha — used for tree canopies and grass tufts. */
export function foliageTexture(kind = 'broadleaf', size = 256) {
  const key = `foliage:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const palettes = {
    broadleaf: ['#2e5a1e', '#3c7326', '#4f8c2f', '#26491a', '#5d9c3a'],
    pine: ['#1d3d20', '#26512a', '#2f6234', '#16301a'],
    sakura: ['#f6c3d6', '#ffd9e6', '#e79ebb', '#ffeaf2', '#f2aec9'],
    autumn: ['#c1621f', '#d98724', '#a8431a', '#e0a53a'],
    bamboo: ['#4d8a2b', '#639f36', '#3a6f21', '#77b345'],
  };
  const pal = palettes[kind] || palettes.broadleaf;

  const leaves = kind === 'pine' ? 900 : 520;
  for (let i = 0; i < leaves; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    // Bias the cluster into a rough disc so the card silhouette reads as a canopy.
    const d = Math.hypot(cx - size / 2, cy - size / 2) / (size / 2);
    if (Math.random() < d * d * 1.15) continue;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.random() * Math.PI * 2);
    ctx.fillStyle = pal[(Math.random() * pal.length) | 0];
    ctx.globalAlpha = 0.72 + Math.random() * 0.28;
    if (kind === 'pine') {
      ctx.fillRect(-1, -size * 0.05, 2, size * 0.1);
    } else {
      const w = size * (0.03 + Math.random() * 0.05);
      const h = w * (0.55 + Math.random() * 0.5);
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

/** Vertical grass-tuft alpha card. */
export function grassTuftTexture(size = 128, color = ['#3f7d2a', '#5aa03a', '#2c5c1e']) {
  const key = `tuft:${color.join()}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * size;
    const h = size * (0.45 + Math.random() * 0.5);
    const lean = (Math.random() - 0.5) * size * 0.3;
    ctx.strokeStyle = color[(Math.random() * color.length) | 0];
    ctx.lineWidth = 1.2 + Math.random() * 2.2;
    ctx.globalAlpha = 0.6 + Math.random() * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.quadraticCurveTo(x + lean * 0.4, size - h * 0.6, x + lean, size - h);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Emissive sign / hologram panel for the neon city. */
export function neonSignTexture(text, hue = 0.55, size = 256) {
  const key = `neon:${text}:${hue}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#05060c';
  ctx.fillRect(0, 0, size, size);
  const col = new THREE.Color().setHSL(hue, 0.95, 0.6).getStyle();
  ctx.shadowColor = col;
  ctx.shadowBlur = 26;
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 5;
  ctx.strokeRect(18, 18, size - 36, size - 36);
  ctx.font = `bold ${Math.floor(size * 0.3)}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Paper-lantern surface: warm rice paper with bamboo ribs and a painted glyph. */
export function lanternTexture(glyph = '福', size = 256) {
  const key = `lantern:${glyph}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, '#c8241d');
  grd.addColorStop(0.5, '#f0503f');
  grd.addColorStop(1, '#b41a16');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(90,10,8,0.5)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * size;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
  }
  ctx.fillStyle = '#f7d774';
  ctx.font = `bold ${Math.floor(size * 0.5)}px "PingFang SC", "Microsoft YaHei", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, size / 2, size / 2 + size * 0.02);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}
