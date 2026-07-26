// Ocean / lake surface.
//
// Gerstner wave displacement with analytically derived normals, depth-graded
// colour sampled from a baked terrain height texture, animated shore foam and
// a Fresnel-weighted mix between refracted water colour and the prefiltered
// environment reflection.

import * as THREE from 'three';

export function bakeDepthTexture(terrain, size = 256) {
  const b = terrain.bounds;
  const pad = 3000;
  const minX = b.min.x - pad, maxX = b.max.x + pad;
  const minZ = b.min.z - pad, maxZ = b.max.z + pad;
  const data = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = minX + ((i + 0.5) / size) * (maxX - minX);
      const z = minZ + ((j + 0.5) / size) * (maxZ - minZ);
      data[j * size + i] = terrain.baseHeight(x, z);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, minX, maxX, minZ, maxZ };
}

export function createWater(terrain, theme) {
  const cfg = Object.assign({
    level: -34,
    size: 14000,
    segments: 220,
    shallow: 0x2f7f86,
    deep: 0x04141f,
    foam: 0xdff2f5,
    waveScale: 1.0,
    windDir: [0.86, 0.5],
    choppy: 1.0,
    envIntensity: 1.4,
  }, theme.water || {});

  const depth = bakeDepthTexture(terrain);

  const geo = new THREE.PlaneGeometry(cfg.size, cfg.size, cfg.segments, cfg.segments);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg.shallow),
    roughness: 0.11,
    metalness: 0.02,
    transparent: true,
    opacity: 1.0,
    envMapIntensity: cfg.envIntensity,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWaveScale: { value: cfg.waveScale },
    uChoppy: { value: cfg.choppy },
    uWind: { value: new THREE.Vector2(cfg.windDir[0], cfg.windDir[1]).normalize() },
    uShallow: { value: new THREE.Color(cfg.shallow) },
    uDeep: { value: new THREE.Color(cfg.deep) },
    uFoam: { value: new THREE.Color(cfg.foam) },
    uSkyTint: { value: new THREE.Color(cfg.skyTint ?? 0x9fc4dd) },
    uLevel: { value: cfg.level },
    tDepth: { value: depth.tex },
    uDepthRect: { value: new THREE.Vector4(depth.minX, depth.minZ, depth.maxX - depth.minX, depth.maxZ - depth.minZ) },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform float uTime, uWaveScale, uChoppy;
        uniform vec2 uWind;
        varying vec3 vWorldPos;
        varying vec3 vWaveNormal;
        varying float vCrest;

        // One Gerstner contribution: horizontal pinch + vertical lift.
        void gerstner(vec2 dir, float steepness, float wavelength, float speed,
                      vec3 p, inout vec3 disp, inout vec3 tangent, inout vec3 binormal) {
          float k = 6.28318 / wavelength;
          float c = sqrt(9.81 / k) * speed;
          vec2 d = normalize(dir);
          float f = k * (dot(d, p.xz) - c * uTime);
          float a = steepness / k;
          disp += vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
          tangent += vec3(-d.x * d.x * steepness * sin(f),
                           d.x * steepness * cos(f),
                          -d.x * d.y * steepness * sin(f));
          binormal += vec3(-d.x * d.y * steepness * sin(f),
                            d.y * steepness * cos(f),
                           -d.y * d.y * steepness * sin(f));
        }`)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        vec3 worldSeed = (modelMatrix * vec4(position, 1.0)).xyz;

        vec3 disp = vec3(0.0);
        vec3 tang = vec3(1.0, 0.0, 0.0);
        vec3 binm = vec3(0.0, 0.0, 1.0);
        vec2 w = uWind;
        vec2 wp = vec2(-w.y, w.x);
        // Layered swell: long primary rollers down to short chop.
        gerstner(w,                       0.16 * uChoppy, 78.0 * uWaveScale, 1.0, worldSeed, disp, tang, binm);
        gerstner(mix(w, wp, 0.22),        0.13 * uChoppy, 41.0 * uWaveScale, 1.1, worldSeed, disp, tang, binm);
        gerstner(mix(w, -wp, 0.42),       0.10 * uChoppy, 23.0 * uWaveScale, 1.3, worldSeed, disp, tang, binm);
        gerstner(mix(w, wp, -0.65),       0.07 * uChoppy, 11.0 * uWaveScale, 1.5, worldSeed, disp, tang, binm);
        gerstner(mix(w, wp, 0.9),         0.05 * uChoppy,  5.5 * uWaveScale, 1.8, worldSeed, disp, tang, binm);

        transformed += disp;
        vCrest = smoothstep(0.35, 1.1, disp.y);
        // Guard the frame: if the two derivative vectors ever collapse, the
        // normalize returns NaN, every lighting term downstream becomes NaN,
        // and the whole ocean renders black.
        vec3 waveN = cross(binm, tang);
        vWaveNormal = dot(waveN, waveN) > 1e-8 ? normalize(waveN) : vec3(0.0, 1.0, 0.0);
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
        transformedNormal = normalize(normalMatrix * vWaveNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform float uTime, uLevel;
        uniform vec3 uShallow, uDeep, uFoam, uSkyTint;
        uniform sampler2D tDepth;
        uniform vec4 uDepthRect;
        varying vec3 vWorldPos;
        varying vec3 vWaveNormal;
        varying float vCrest;

        float h21(vec2 p) {
          p = fract(p * vec2(443.897, 441.423));
          p += dot(p, p.yx + 19.19);
          return fract((p.x + p.y) * p.x);
        }
        float vn(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1,0)), f.x),
                     mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float a = 0.5, s = 0.0;
          for (int i = 0; i < 4; i++) { s += a * vn(p); p *= 2.07; a *= 0.5; }
          return s;
        }`)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 duv = (vWorldPos.xz - uDepthRect.xy) / uDepthRect.zw;
        float bed = texture2D(tDepth, clamp(duv, 0.001, 0.999)).r;
        float waterDepth = max(uLevel - bed, 0.0);

        // Beer-Lambert style extinction from shallow turquoise to deep navy.
        // The falloff is deliberately gentle: true deep water is almost black,
        // which reads as a hole in the world rather than a lake.
        float dNorm = 1.0 - exp(-waterDepth * 0.016);
        vec3 waterCol = mix(uShallow, uDeep, dNorm);

        // Sky bounce. Open water is lit far more by the whole dome than by the
        // sun, and without this term a low sun leaves the lake unreadably dark.
        waterCol += uSkyTint * 0.16;

        // Shore foam: a band that follows the waterline, eroded by noise and
        // scrolling with the swell so it never looks like a static decal.
        float shoreBand = 1.0 - smoothstep(0.0, 9.0, waterDepth);
        float foamNoise = fbm(vWorldPos.xz * 0.09 + vec2(uTime * 0.22, -uTime * 0.16));
        float shoreFoam = smoothstep(0.42, 0.85, shoreBand * (0.55 + foamNoise));
        float crestFoam = smoothstep(0.55, 1.0, vCrest * (0.6 + foamNoise * 0.8)) * 0.55;
        float foam = clamp(shoreFoam + crestFoam, 0.0, 1.0);

        diffuseColor.rgb *= mix(waterCol / max(uShallow, vec3(0.001)), vec3(1.0), 0.0);
        diffuseColor.rgb = mix(waterCol, uFoam, foam);
        diffuseColor.a = mix(0.90, 1.0, foam) * smoothstep(0.0, 1.2, waterDepth + 1.2);`)
      // Belt and braces: whatever the lighting produces, the ocean must never
      // resolve to a non-finite colour — a single NaN texel here spreads
      // through the bloom pyramid and takes the whole frame with it.
      .replace('#include <opaque_fragment>', `
        {
          vec3 ol = outgoingLight;
          ol = vec3(ol.r == ol.r ? ol.r : 0.0,
                    ol.g == ol.g ? ol.g : 0.0,
                    ol.b == ol.b ? ol.b : 0.0);
          gl_FragColor = vec4(clamp(ol, 0.0, 40.0), diffuseColor.a);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          vec2 duv2 = (vWorldPos.xz - uDepthRect.xy) / uDepthRect.zw;
          float bed2 = texture2D(tDepth, clamp(duv2, 0.001, 0.999)).r;
          float wd = max(uLevel - bed2, 0.0);
          float shore = 1.0 - smoothstep(0.0, 9.0, wd);
          float fn = fbm(vWorldPos.xz * 0.09 + vec2(uTime * 0.22, -uTime * 0.16));
          float fm = clamp(smoothstep(0.42, 0.85, shore * (0.55 + fn))
                         + smoothstep(0.55, 1.0, vCrest * (0.6 + fn * 0.8)) * 0.55, 0.0, 1.0);
          // Micro-ripples roughen the surface away from the mirror sheen.
          float ripple = fbm(vWorldPos.xz * 1.6 + uTime * 0.6) * 0.09;
          roughnessFactor = clamp(roughnessFactor + ripple + fm * 0.7, 0.02, 1.0);
        }`);
    mat.userData.shader = shader;
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(terrain._center.x, cfg.level, terrain._center.z);
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;
  mesh.name = 'water';
  mesh.userData.update = (dt) => { uniforms.uTime.value += dt; };
  return mesh;
}
