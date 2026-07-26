// Track definitions.
//
// Each entry describes the racing line (as a polar layout, which guarantees a
// clean closed loop) plus a complete environment theme: sky, sun, fog, colour
// grade, terrain profile, water, vegetation mix, architecture recipe and
// track furniture styling.

import * as THREE from 'three';
import { circuit, ring } from './layout.js';

// ---------------------------------------------------------------------------
// 1. 樱花神社 — Sakura Shrine
// ---------------------------------------------------------------------------

// Corner radii, not loop radius, define the lap: a flat-out start sweeper,
// a 52 m hairpin at the shrine gate, a technical esses complex, a narrow lake
// crossing, and a switchback out of the hillside tunnel.
const sakuraLayout = circuit(ring([
  { a: 0,   d: 620, r: 230, y: 6,  w: 26 },                    // start / finish
  { a: 30,  d: 640, r: 220, y: 12, w: 24 },
  { a: 52,  d: 520, r: 62,  y: 22, w: 19, bank: 16 },          // T3 shrine hairpin
  { a: 68,  d: 600, r: 130, y: 32, w: 20 },
  { a: 92,  d: 640, r: 250, y: 42, w: 22 },                    // crest sweeper
  { a: 112, d: 500, r: 48,  y: 46, w: 18, bank: 20 },          // T6 tight left
  { a: 126, d: 560, r: 90,  y: 44, w: 20 },                    // esses
  { a: 142, d: 470, r: 70,  y: 38, w: 20 },                    // esses
  { a: 160, d: 560, r: 160, y: 28, w: 22 },
  { a: 188, d: 620, r: 340, y: 16, w: 24 },                    // fast downhill
  { a: 214, d: 500, r: 75,  y: 6,  w: 18 },                    // brake for the lake
  { a: 236, d: 430, r: 200, y: 2,  w: 15, kind: 'bridge' },    // narrow crossing
  { a: 258, d: 470, r: 58,  y: 4,  w: 16, kind: 'bridge', bank: 14 },
  { a: 276, d: 580, r: 150, y: 12, w: 20 },
  { a: 288, d: 660, r: 220, y: 26, w: 22 },                    // climb to the ridge
  { a: 306, d: 520, r: 50,  y: 40, w: 18, bank: 22 },          // ridge hairpin
  { a: 322, d: 640, r: 190, y: 46, w: 20, kind: 'tunnel' },    // into the hillside
  { a: 336, d: 690, r: 240, y: 44, w: 20, kind: 'tunnel' },
  { a: 348, d: 600, r: 60,  y: 26, w: 19, bank: -20 },         // switchback out
], { stretchX: 1.14, stretchZ: 0.94 }), { step: 8 });
const sakuraClamp = [...circuit.lastReport];

export const SAKURA = {
  id: 'sakura',
  name: '樱花神社',
  subtitle: 'SAKURA SHRINE · 黄昏',
  difficulty: 1,
  laps: 3,
  points: sakuraLayout,
  _clampReport: sakuraClamp,
  width: 22,
  maxBank: 26,
  bankGain: 1000,
  boosts: 6,
  checkpoints: [0.25, 0.5, 0.75],

  theme: {
    title: '樱花神社',
    bannerHue: 0.94,
    barrier: 'wood',
    barrierColor: 0xff5a4a,
    boostColor: 0xffb347,
    markingColor: 0xf1ece0,
    markingGlow: 0.0,
    wetness: 0.0,
    tunnelMaterial: 'stone',
    tunnelLight: 0xffc98a,
    pylon: 'stone',
    skirtDepth: 4.0,
    roadEnvIntensity: 1.0,

    sky: {
      sunDir: new THREE.Vector3(-0.44, 0.42, -0.79),
      turbidity: 4.6,
      rayleigh: 2.8,
      mie: 0.021,
      mieG: 0.86,
      luminance: 1.45,
      night: 0.0,
      cloudCover: 0.52,
      cloudHeight: 1250,
      cloudSpeed: 1.0,
      cloudTint: 0xffc9a8,
      sunColor: 0xffb066,
      groundColor: 0x6d5c46,
      horizonHaze: 0.85,
      stars: 0.0,
    },
    sun: { color: 0xffd2a0, intensity: 5.6, shadowRadius: 3.2 },
    ambient: { sky: 0xffe6cc, ground: 0x8a7c62, intensity: 1.7, floor: 0.95, floorColor: 0xffd9b4 },
    fog: { color: 0xe4b48c, near: 220, far: 3400, density: 0.00022 },
    grade: {
      exposure: 1.30, bloom: 0.62, bloomRadius: 0.78, bloomThreshold: 0.85,
      saturation: 1.14, contrast: 1.06, vignette: 0.95, grain: 0.03,
      lift: [0.006, 0.002, -0.002], gain: [1.04, 1.0, 0.96],
    },

    terrain: {
      scale: 0.0013, amplitude: 260, ridged: 0.5, seaLevel: -14,
      basin: 44, blend: 30, roughness: 1.0, snowLine: 330, warp: 1.1,
    },
    macroTint: new THREE.Color(0xbcd68c),
    tileBase: 24, tileRock: 15, tileSnow: 20,

    water: {
      // Deep enough that the lake fills the valleys rather than flooding the
      // whole basin — the circuit should read as a ridge above water, not an
      // island in a void.
      level: -34, size: 16000, shallow: 0x7fd0c4, deep: 0x2f7fa0,
      foam: 0xfff0e2, waveScale: 1.0, choppy: 0.85, windDir: [0.9, 0.36],
      envIntensity: 1.6, skyTint: 0xd8b98c,
    },

    flora: {
      forest: {
        seed: 1337, radius: 2400,
        species: [
          { key: 'sakura', count: 620, band: 70, roadside: 0.82, clumpScale: 0.005, clumpThreshold: 0.30, maxSlope: 0.34, maxH: 240 },
          { key: 'broadleaf', count: 520, band: 130, roadside: 0.45, clumpScale: 0.0035, clumpThreshold: 0.38, maxSlope: 0.4 },
          { key: 'pine', count: 700, band: 190, roadside: 0.2, clumpScale: 0.0026, clumpThreshold: 0.42, minH: 60 },
          { key: 'bamboo', count: 460, band: 44, roadside: 0.9, clumpScale: 0.009, clumpThreshold: 0.44, maxSlope: 0.3 },
        ],
      },
      grass: { count: 30000, band: 52, height: 1.6, minGrass: 0.3, colors: ['#4b8b2e', '#68a83c', '#37701f', '#88bf52'] },
      rocks: { count: 420, radius: 1900, scale: 2.4, minSlope: 0.05 },
      particles: [
        { type: 'petal', count: 2600, color: 0xffc9dd, size: 3.4, fall: 2.2, swirl: 6.0, wind: [2.2, 0, 0.9], height: 90, opacity: 0.92 },
        { type: 'firefly', count: 260, color: 0xfff0a0, size: 2.0, fall: -0.15, swirl: 3.5, wind: [0.3, 0, 0.2], height: 22, additive: true, opacity: 0.7 },
      ],
      birds: { count: 46, altitude: 190 },
    },

    architecture: {
      pack: 'dynasty',
      villages: 5,
      pagodas: 3,
      gates: 2,
      lanterns: true,
      grandstands: 2,
      bridges: 2,
    },
  },
};

// ---------------------------------------------------------------------------
// 2. 霓虹都市 — Neon Metropolis
// ---------------------------------------------------------------------------

// The hardest lap: an elevated expressway with a heavily banked flyover, a
// downtown underpass, and street corners tight enough that the walls matter —
// on wet tarmac, with less grip than either of the other circuits.
const metroLayout = circuit(ring([
  { a: 0,   d: 560, r: 260, y: 4,  w: 28 },                    // pit straight
  { a: 26,  d: 600, r: 200, y: 6,  w: 26 },
  { a: 44,  d: 470, r: 44,  y: 14, w: 19, bank: 14 },          // T2 street corner
  { a: 58,  d: 520, r: 120, y: 30, w: 21, kind: 'bridge' },    // onto the expressway
  { a: 78,  d: 600, r: 260, y: 48, w: 20, kind: 'bridge', bank: 24 },
  { a: 98,  d: 520, r: 58,  y: 60, w: 18, kind: 'bridge', bank: 28 }, // banked flyover
  { a: 116, d: 580, r: 150, y: 56, w: 19, kind: 'bridge' },
  { a: 146, d: 620, r: 320, y: 34, w: 22, kind: 'bridge' },    // long descent
  { a: 168, d: 480, r: 70,  y: 12, w: 22 },
  { a: 184, d: 420, r: 40,  y: 6,  w: 20, bank: 12 },          // street-level hairpin
  { a: 202, d: 540, r: 170, y: 4,  w: 24 },
  { a: 224, d: 600, r: 300, y: 2,  w: 26 },                    // flat-out to the tunnel
  { a: 246, d: 540, r: 210, y: 2,  w: 22, kind: 'tunnel' },    // downtown underpass
  { a: 262, d: 440, r: 56,  y: 6,  w: 20, kind: 'tunnel', bank: 14 }, // blind kink
  { a: 278, d: 520, r: 140, y: 12, w: 22 },
  { a: 298, d: 620, r: 260, y: 26, w: 22, bank: -20 },         // sweeping flyover
  { a: 314, d: 560, r: 50,  y: 44, w: 18, bank: -26, kind: 'bridge' },
  { a: 318, d: 600, r: 130, y: 46, w: 20, kind: 'bridge' },
  { a: 330, d: 660, r: 240, y: 26, w: 24 },                    // plunge back down
  { a: 340, d: 460, r: 46,  y: 10, w: 21 },                    // final chicane in
  { a: 350, d: 570, r: 56,  y: 5,  w: 24 },                    // chicane out
], { stretchX: 1.04, stretchZ: 1.12 }), { step: 8 });
const metroClamp = [...circuit.lastReport];

export const METRO = {
  id: 'metro',
  name: '霓虹都市',
  subtitle: 'NEON METROPOLIS · 雨夜',
  difficulty: 3,
  laps: 3,
  points: metroLayout,
  _clampReport: metroClamp,
  width: 24,
  maxBank: 30,
  bankGain: 1200,
  boosts: 7,
  checkpoints: [0.25, 0.5, 0.75],

  theme: {
    title: '霓虹都市',
    bannerHue: 0.55,
    barrier: 'energy',
    barrierColor: 0x35e0ff,
    boostColor: 0xff3ea5,
    markingColor: 0xc8f4ff,
    markingGlow: 1.6,
    wetness: 0.78,
    tunnelMaterial: 'concrete',
    tunnelLight: 0x8fe6ff,
    pylon: 'concrete',
    skirtDepth: 5.0,
    roadEnvIntensity: 1.6,
    roadMetalness: 0.15,

    sky: {
      sunDir: new THREE.Vector3(0.25, -0.06, -0.96),
      turbidity: 9.0,
      rayleigh: 1.1,
      mie: 0.035,
      mieG: 0.9,
      luminance: 0.6,
      night: 0.94,
      nightTint: 0x0a1024,
      stars: 0.55,
      cloudCover: 0.72,
      cloudHeight: 900,
      cloudSpeed: 2.4,
      cloudTint: 0x39527a,
      sunColor: 0x4a6cff,
      groundColor: 0x1a2230,
      horizonHaze: 1.25,
    },
    sun: { color: 0x7f9bff, intensity: 0.9, shadowRadius: 4.5 },
    ambient: { sky: 0x3d5e94, ground: 0x2a3242, intensity: 1.05, floor: 0.6, floorColor: 0x4a6ea8 },
    fog: { color: 0x121a2e, near: 90, far: 2000, density: 0.00068 },
    grade: {
      exposure: 1.32, bloom: 1.05, bloomRadius: 0.9, bloomThreshold: 0.5,
      saturation: 1.24, contrast: 1.12, vignette: 1.15, grain: 0.045,
      lift: [-0.004, 0.0, 0.014], gain: [0.96, 1.0, 1.10],
    },

    terrain: {
      scale: 0.0022, amplitude: 90, ridged: 0.25, seaLevel: -40,
      basin: 62, blend: 26, roughness: 0.7, snowLine: 900, warp: 0.7,
    },
    macroTint: new THREE.Color(0x54607a),
    tileBase: 20, tileRock: 12, tileSnow: 18,
    terrainEnvIntensity: 0.9,

    water: {
      level: -50, size: 16000, shallow: 0x2f7f96, deep: 0x123a56,
      foam: 0x9fd6ff, waveScale: 0.8, choppy: 0.6, windDir: [0.5, 0.86],
      envIntensity: 2.0, skyTint: 0x2a3f6a,
    },

    flora: {
      forest: {
        seed: 909, radius: 2100,
        species: [
          { key: 'broadleaf', count: 380, band: 60, roadside: 0.85, clumpScale: 0.006, clumpThreshold: 0.34, maxSlope: 0.36 },
          { key: 'pine', count: 320, band: 160, roadside: 0.25, clumpScale: 0.003, clumpThreshold: 0.46 },
        ],
      },
      grass: { count: 12000, band: 34, height: 1.1, minGrass: 0.4, tint: 0x8fa3b8, colors: ['#2f4a38', '#3d5a44', '#24382c'] },
      rocks: { count: 200, radius: 1500, scale: 2.0, tint: 0x8894a8 },
      particles: [
        { type: 'rain', count: 5200, color: 0xbfe4ff, size: 5.5, fall: 42, swirl: 0.6, wind: [4.0, 0, 1.5], height: 110, opacity: 0.42 },
        { type: 'spark', count: 420, color: 0x7fe8ff, size: 1.8, fall: -0.4, swirl: 5.0, wind: [1.0, 0, 0.6], height: 60, additive: true, opacity: 0.55 },
      ],
      birds: null,
    },

    architecture: {
      pack: 'metro',
      towers: 78,
      signs: 34,
      lamps: 60,
      grandstands: 2,
    },
  },
};

// ---------------------------------------------------------------------------
// 3. 云顶雪山 — Cloudtop Alpine
// ---------------------------------------------------------------------------

// High, exposed and unforgiving: two knife-edge spans over the chasm, an ice
// cave, and hairpins where a mistake puts you over the edge rather than into
// a gravel trap. The loop swings hard in and out from the summit so the
// corners are long as well as tight.
const alpineLayout = circuit(ring([
  { a: 0,   d: 619, r: 300, y: 212, w: 24 },                   // summit straight
  { a: 24,  d: 654, r: 170, y: 218, w: 22 },
  { a: 44,  d: 370, r: 56,  y: 234, w: 18, bank: 18 },         // dive into T3 hairpin
  { a: 60,  d: 550, r: 110, y: 248, w: 20 },
  { a: 80,  d: 671, r: 230, y: 262, w: 20 },                   // out to the ridge
  { a: 100, d: 447, r: 190, y: 266, w: 14, kind: 'bridge' },   // knife-edge span
  { a: 116, d: 593, r: 58,  y: 260, w: 14, kind: 'bridge', bank: 16 },
  { a: 140, d: 654, r: 180, y: 248, w: 18 },
  { a: 170, d: 602, r: 330, y: 222, w: 22 },                   // fast descent
  { a: 192, d: 361, r: 62,  y: 200, w: 19 },                   // switchback
  { a: 210, d: 568, r: 130, y: 188, w: 20, kind: 'tunnel' },   // into the ice cave
  { a: 234, d: 654, r: 220, y: 178, w: 20, kind: 'tunnel' },
  { a: 250, d: 387, r: 50,  y: 178, w: 19, kind: 'tunnel', bank: 16 }, // cave hairpin
  { a: 268, d: 602, r: 140, y: 192, w: 20 },
  { a: 290, d: 679, r: 260, y: 210, w: 22, bank: -16 },        // sweeping climb
  { a: 306, d: 404, r: 54,  y: 228, w: 19, bank: -22 },        // plunge inside
  { a: 322, d: 602, r: 160, y: 244, w: 20 },
  { a: 336, d: 430, r: 190, y: 256, w: 14, kind: 'bridge' },   // chasm span
  { a: 346, d: 602, r: 52,  y: 250, w: 15, kind: 'bridge', bank: 14 },
  { a: 354, d: 636, r: 150, y: 230, w: 20 },
], { stretchX: 1.0, stretchZ: 1.06 }), { step: 8 });
const alpineClamp = [...circuit.lastReport];

export const ALPINE = {
  id: 'alpine',
  name: '云顶雪山',
  subtitle: 'CLOUDTOP ALPINE · 极光黎明',
  difficulty: 2,
  laps: 3,
  points: alpineLayout,
  _clampReport: alpineClamp,
  width: 20,
  maxBank: 28,
  bankGain: 950,
  boosts: 6,
  checkpoints: [0.25, 0.5, 0.75],

  theme: {
    title: '云顶雪山',
    bannerHue: 0.52,
    barrier: 'snow',
    barrierColor: 0xbfe6ff,
    boostColor: 0x66fff0,
    markingColor: 0xf4f8ff,
    markingGlow: 0.35,
    wetness: 0.16,
    tunnelMaterial: 'stone',
    tunnelLight: 0xa8e4ff,
    pylon: 'concrete',
    skirtDepth: 6.0,
    roadEnvIntensity: 1.1,

    sky: {
      sunDir: new THREE.Vector3(0.66, 0.34, 0.67),
      turbidity: 2.2,
      rayleigh: 3.4,
      mie: 0.010,
      mieG: 0.80,
      luminance: 1.25,
      night: 0.22,
      nightTint: 0x0b1730,
      stars: 0.7,
      aurora: 0.9,
      cloudCover: 0.46,
      cloudHeight: 1500,
      cloudSpeed: 1.6,
      cloudTint: 0xa8c4e8,
      sunColor: 0xffd0a8,
      groundColor: 0x53637c,
      horizonHaze: 0.7,
    },
    sun: { color: 0xffd8b8, intensity: 3.4, shadowRadius: 3.6 },
    // Snow is the brightest ground in the game, so this theme needs less
    // ambient and less exposure than the others or the highlights clip.
    ambient: { sky: 0xc4dcff, ground: 0x8496b4, intensity: 1.35, floor: 0.7, floorColor: 0xc8dcff },
    fog: { color: 0xa8bdd6, near: 260, far: 4200, density: 0.00019 },
    grade: {
      exposure: 0.98, bloom: 0.8, bloomRadius: 0.85, bloomThreshold: 0.82,
      saturation: 1.06, contrast: 1.08, vignette: 1.0, grain: 0.028,
      lift: [0.0, 0.004, 0.012], gain: [0.99, 1.0, 1.06],
    },

    terrain: {
      scale: 0.0011, amplitude: 420, ridged: 0.82, seaLevel: -200,
      basin: 150, blend: 32, roughness: 1.3, snowLine: 150, warp: 1.4,
    },
    macroTint: new THREE.Color(0x7f9a86),
    tileBase: 22, tileRock: 13, tileSnow: 24,

    water: null,

    flora: {
      forest: {
        seed: 4242, radius: 2600,
        species: [
          { key: 'pine', count: 1500, band: 130, roadside: 0.6, clumpScale: 0.0032, clumpThreshold: 0.34, maxSlope: 0.45, maxH: 330 },
          { key: 'autumn', count: 240, band: 70, roadside: 0.7, clumpScale: 0.007, clumpThreshold: 0.48, maxH: 250 },
        ],
      },
      grass: { count: 9000, band: 30, height: 1.0, minGrass: 0.45, tint: 0xcfe0d0, colors: ['#5e7a52', '#7c9668', '#48603f'] },
      rocks: { count: 620, radius: 2200, scale: 3.2, minSlope: 0.04, tint: 0xd8e4f0 },
      particles: [
        { type: 'snow', count: 4200, color: 0xffffff, size: 3.0, fall: 3.4, swirl: 7.5, wind: [3.0, 0, 1.2], height: 130, opacity: 0.85 },
        { type: 'spark', count: 200, color: 0xa8fff0, size: 1.6, fall: -0.2, swirl: 4.0, wind: [0.6, 0, 0.4], height: 40, additive: true, opacity: 0.5 },
      ],
      birds: { count: 26, altitude: 420, color: 0x2a3038 },
    },

    architecture: {
      pack: 'alpine',
      villages: 6,
      chapels: 2,
      cableCars: 3,
      grandstands: 1,
    },
  },
};

export const TRACKS = [SAKURA, METRO, ALPINE];
export const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));
