// Procedural landscape.
//
// A single analytic height field drives everything: the mesh, the physics
// query used when the car leaves the tarmac, and every scatter decision for
// trees, grass and buildings. The field is carved so the road always sits in
// believable ground — valleys open beneath elevated sections, and the terrain
// blends smoothly up to the verge instead of clipping through it.

import * as THREE from 'three';
import { fbm2, ridge2, valueNoise2, worley2, clamp, smoothstep, mix } from '../util/noise.js';

export class Terrain {
  /**
   * @param {import('../track/track.js').Track} track
   * @param {object} theme terrain parameters from the track definition
   */
  constructor(track, theme) {
    this.track = track;
    this.t = Object.assign({
      scale: 0.0016,        // horizontal frequency of the mountains
      amplitude: 210,       // peak height
      ridged: 0.55,         // ridged vs rolling mix
      seaLevel: -34,
      basin: 60,            // how far below the road the valley floor sits
      blend: 34,            // metres of ground->road blending outside the verge
      roughness: 1.0,
      snowLine: 150,
      warp: 1.0,
    }, theme.terrain || {});

    this._sample = {};
    this._center = new THREE.Vector3();
    const box = new THREE.Box3();
    for (let i = 0; i < track.count; i++) {
      box.expandByPoint(new THREE.Vector3(track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]));
    }
    box.getCenter(this._center);
    this.bounds = box;
    this.radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5;
  }

  /** Raw landscape height ignoring the road. */
  baseHeight(x, z) {
    const t = this.t;
    const sx = x * t.scale, sz = z * t.scale;
    // Domain warp gives ridges that meander instead of running in straight bands.
    const wx = fbm2(sx * 0.5 + 4.2, sz * 0.5 - 1.7, 3) - 0.5;
    const wz = fbm2(sx * 0.5 - 3.1, sz * 0.5 + 6.4, 3) - 0.5;
    const px = sx + wx * t.warp, pz = sz + wz * t.warp;

    const rolling = fbm2(px, pz, 6) - 0.5;
    const ridges = ridge2(px * 0.9, pz * 0.9, 6) - 0.35;
    let h = mix(rolling, ridges, t.ridged) * 2.0 * t.amplitude;

    // Large-scale mass so the far horizon has real relief.
    h += (fbm2(px * 0.22, pz * 0.22, 4) - 0.42) * t.amplitude * 1.35;
    // Fine detail keeps close-up slopes from reading as flat shading.
    h += (fbm2(px * 7.0, pz * 7.0, 4) - 0.5) * 5.0 * t.roughness;
    return h;
  }

  /** Final height including the road carve. */
  heightAt(x, z, hint = -1) {
    const s = this.track.sampleAt(x, z, hint, this._sample);
    let base = this.baseHeight(x, z);
    if (!s) { this.lastIndex = -1; return base; }
    this.lastIndex = s.index;

    const half = s.width * 0.5;
    const d = Math.abs(s.lateral) - half;
    if (d > this.t.blend + 90) return base;

    // Just outside the verge the ground meets the road edge, then falls into
    // a basin and finally releases into the untouched landscape.
    const edgeY = s.height;
    if (d <= 1.6) return edgeY - 0.12;

    const near = smoothstep(this.t.blend + 90, 1.6, d); // 1 at the verge, 0 far away
    const shoulder = edgeY - 0.12 - smoothstep(1.6, this.t.blend, d) * this.t.basin * 0.35;
    let target = mix(base, shoulder, near * near);

    // Push the ground down beneath high bridges so pylons have somewhere to go.
    if (s.kind === 1) {
      const drop = edgeY - this.t.basin;
      target = mix(target, Math.min(base, drop), smoothstep(this.t.blend + 90, 4, d) * 0.85);
    }
    return target;
  }

  normalAt(x, z, eps = 2.0) {
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  }

  slopeAt(x, z) {
    const n = this.normalAt(x, z, 3.0);
    return 1.0 - n.y;
  }

  /**
   * Slope of the uncarved landscape. Four cheap noise evaluations instead of
   * four spline queries — used by the scatter systems, which reject anything
   * near the road anyway, so the carve does not matter there.
   */
  fastSlopeAt(x, z, eps = 3.0) {
    const hL = this.baseHeight(x - eps, z);
    const hR = this.baseHeight(x + eps, z);
    const hD = this.baseHeight(x, z - eps);
    const hU = this.baseHeight(x, z + eps);
    const nx = hL - hR, ny = 2 * eps, nz = hD - hU;
    return 1.0 - ny / Math.hypot(nx, ny, nz);
  }

  /**
   * Surface class weights: [grass/base, rock, snow/sand]. Used both by the
   * splatting shader and by the scatter systems to decide what grows where.
   */
  splatAt(x, z, h, slope) {
    const t = this.t;
    const rockiness = smoothstep(0.12, 0.42, slope) + smoothstep(t.amplitude * 0.55, t.amplitude * 1.1, h) * 0.5;
    const snow = smoothstep(t.snowLine, t.snowLine + 120, h) * (1.0 - smoothstep(0.45, 0.75, slope));
    const patch = fbm2(x * 0.004, z * 0.004, 4);
    let rock = clamp(rockiness + (patch - 0.5) * 0.5, 0, 1);
    let sn = clamp(snow + (patch - 0.5) * 0.35, 0, 1);
    let grass = clamp(1 - rock - sn, 0, 1);
    const sum = rock + sn + grass || 1;
    return [grass / sum, rock / sum, sn / sum];
  }

  /** Build the LOD ring meshes. */
  build(material) {
    const group = new THREE.Group();
    group.name = 'terrain';
    const c = this._center;

    // Holes are slightly smaller than the ring inside them, so the two LODs
    // overlap and no crack shows at the resolution change.
    const rings = [
      { half: 700, seg: 200, hole: 0 },
      { half: 2100, seg: 150, hole: 672 },
      { half: 6500, seg: 110, hole: 2040 },
    ];

    for (const ring of rings) {
      const geo = this._buildRing(c.x, c.z, ring.half, ring.seg, ring.hole);
      const m = new THREE.Mesh(geo, material);
      m.receiveShadow = ring.half <= 2200;
      m.castShadow = false;
      m.name = `terrain-${ring.half}`;
      group.add(m);
    }
    this.group = group;
    return group;
  }

  _buildRing(cx, cz, half, seg, hole) {
    const step = (half * 2) / seg;
    const pos = [], nrm = [], uv = [], splat = [], idx = [];
    const indexMap = new Int32Array((seg + 1) * (seg + 1)).fill(-1);
    let vi = 0;

    const inHole = (x, z) => hole > 0 && Math.abs(x - cx) < hole && Math.abs(z - cz) < hole;

    // Walk the grid in scanline order and feed each sample's spline index in
    // as the next one's hint — neighbouring vertices land on the same stretch
    // of track, so this turns a spatial-hash lookup into a short local scan.
    const heights = new Float32Array((seg + 1) * (seg + 1));
    let hint = -1;
    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const x = cx - half + i * step;
        const z = cz - half + j * step;
        heights[j * (seg + 1) + i] = this.heightAt(x, z, hint);
        hint = this.lastIndex;
      }
    }

    for (let j = 0; j <= seg; j++) {
      for (let i = 0; i <= seg; i++) {
        const x = cx - half + i * step;
        const z = cz - half + j * step;
        // Drop vertices that only serve the hole to keep the buffer tight.
        if (hole > 0 && Math.abs(x - cx) < hole - step && Math.abs(z - cz) < hole - step) continue;
        const h = heights[j * (seg + 1) + i];

        const hl = heights[j * (seg + 1) + Math.max(0, i - 1)];
        const hr = heights[j * (seg + 1) + Math.min(seg, i + 1)];
        const hd = heights[Math.max(0, j - 1) * (seg + 1) + i];
        const hu = heights[Math.min(seg, j + 1) * (seg + 1) + i];
        const nx = hl - hr, ny = 2 * step, nz = hd - hu;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const slope = 1 - ny / nl;

        const w = this.splatAt(x, z, h, slope);
        pos.push(x, h, z);
        nrm.push(nx / nl, ny / nl, nz / nl);
        uv.push(x * 0.02, z * 0.02);
        splat.push(w[0], w[1], w[2]);
        indexMap[j * (seg + 1) + i] = vi++;
      }
    }

    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = indexMap[j * (seg + 1) + i];
        const b = indexMap[j * (seg + 1) + i + 1];
        const c2 = indexMap[(j + 1) * (seg + 1) + i];
        const d = indexMap[(j + 1) * (seg + 1) + i + 1];
        if (a < 0 || b < 0 || c2 < 0 || d < 0) continue;
        const mx = cx - half + (i + 0.5) * step;
        const mz = cz - half + (j + 0.5) * step;
        if (inHole(mx, mz)) continue;
        idx.push(a, c2, b, b, c2, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('splat', new THREE.Float32BufferAttribute(splat, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Terrain material: three tiling PBR sets blended by the per-vertex splat
 * weights, with a large-scale colour variation pass so the ground never
 * reads as a repeating tile from the air.
 */
export function makeTerrainMaterial(base, rock, snow, theme) {
  const mat = new THREE.MeshStandardMaterial({
    map: base.map,
    normalMap: base.normalMap,
    roughnessMap: base.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
    envMapIntensity: theme.terrainEnvIntensity ?? 1.0,
  });
  mat.defines = { USE_UV: '' };
  const u = {
    tRock: { value: rock.map },
    tRockN: { value: rock.normalMap },
    tSnow: { value: snow.map },
    tSnowN: { value: snow.normalMap },
    uTileBase: { value: theme.tileBase ?? 26.0 },
    uTileRock: { value: theme.tileRock ?? 14.0 },
    uTileSnow: { value: theme.tileSnow ?? 18.0 },
    uMacro: { value: theme.macroTint ?? new THREE.Color(0x8fa46a) },
    uFarColor: { value: theme.farColor ?? new THREE.Color(0x6f8497) },
  };
  mat.userData.uniforms = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 splat;
        varying vec3 vSplat;
        varying vec3 vWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSplat = splat;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSplat;
        varying vec3 vWorld;
        uniform sampler2D tRock, tRockN, tSnow, tSnowN;
        uniform float uTileBase, uTileRock, uTileSnow;
        uniform vec3 uMacro, uFarColor;

        float hash21(vec2 p) {
          p = fract(p * vec2(233.34, 851.73));
          p += dot(p, p + 23.45);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x),
                     mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
        }`)
      .replace('#include <map_fragment>', `
        vec3 w = normalize(max(vSplat, vec3(0.0001)));
        w /= (w.x + w.y + w.z);
        vec2 uvBase = vWorld.xz / uTileBase;
        vec2 uvRock = vWorld.xz / uTileRock;
        vec2 uvSnow = vWorld.xz / uTileSnow;

        // Cliff faces get a triplanar projection so rock strata stay vertical.
        vec3 gn = normalize(vNormal);
        float vertical = 1.0 - abs(gn.y);
        vec2 uvRockSide = vec2(dot(vWorld.xz, normalize(vec2(-gn.z, gn.x))), vWorld.y) / uTileRock;

        vec4 cBase = texture2D(map, uvBase);
        vec4 cRock = mix(texture2D(tRock, uvRock), texture2D(tRock, uvRockSide), smoothstep(0.35, 0.8, vertical));
        vec4 cSnow = texture2D(tSnow, uvSnow);
        vec4 sampledDiffuseColor = cBase * w.x + cRock * w.y + cSnow * w.z;

        // Break up tiling with two octaves of large-scale tint drift.
        float macro = vnoise(vWorld.xz * 0.0032) * 0.65 + vnoise(vWorld.xz * 0.0009) * 0.35;
        sampledDiffuseColor.rgb *= mix(0.80, 1.20, macro);
        sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb,
                                      sampledDiffuseColor.rgb * uMacro * 1.6, w.x * 0.35);
        diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 nBase = texture2D(normalMap, vWorld.xz / uTileBase).xyz * 2.0 - 1.0;
        vec3 nRock = texture2D(tRockN, vWorld.xz / uTileRock).xyz * 2.0 - 1.0;
        vec3 nSnow = texture2D(tSnowN, vWorld.xz / uTileSnow).xyz * 2.0 - 1.0;
        vec3 mapN = normalize(nBase * w.x + nRock * w.y + nSnow * w.z);
        mapN.xy *= normalScale;
        normal = normalize(normal + mapN.x * normalize(cross(normal, vec3(0.0, 1.0, 0.0)) + vec3(1e-5)) * 0.6
                                  + mapN.y * normalize(cross(normal, vec3(1.0, 0.0, 0.0)) + vec3(1e-5)) * 0.6);`);
    mat.userData.shader = shader;
  };
  return mat;
}
