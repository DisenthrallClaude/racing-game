// World assembly.
//
// Takes a track definition and produces the complete playable scene: sky and
// image-based lighting, sun with a shadow frustum that follows the car,
// terrain, water, the road and all its furniture, vegetation, a themed city
// or village, weather particles and the ambient life that makes it feel like
// a place rather than a level.

import * as THREE from 'three';
import { Track, buildTrackMeshes, makeRoadMaterial } from '../track/track.js';
import {
  buildBarriers, buildBoostPads, buildTunnels, buildPylons,
  buildStartGantry, buildCheckpointArches,
} from '../track/props.js';
import { Sky } from './sky.js';
import { Terrain, makeTerrainMaterial } from './terrain.js';
import { createWater } from './water.js';
import {
  createForest, createGrassField, createRocks, createParticleField,
  createBirds, petalSprite, rainSprite, mergeGeometries,
} from './flora.js';
import {
  architectureMaterials, dynastyHall, pagoda, paifang, lanternString, archBridge,
  skyscraper, hologramSign, streetLamp, chalet, chapel, cableCar, torii, banner, grandstand,
} from './architecture.js';
import {
  asphaltMaps, wetAsphaltMaps, grassGroundMaps, rockMaps, snowMaps,
  concreteMaps, cobbleMaps, radialSprite, sandMaps, iceMaps,
} from '../util/tex.js';
import { makeRng, TAU, clamp } from '../util/noise.js';

const _v = new THREE.Vector3();

export class World {
  constructor(engine, def) {
    this.engine = engine;
    this.def = def;
    this.theme = def.theme;
    this.scene = engine.scene;
    this.updaters = [];
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.scene.add(this.root);
    this.time = 0;

    this.windUniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
      uWindStrength: { value: this.theme.windStrength ?? 0.06 },
    };
  }

  /** Generator so the loading screen can report progress between phases. */
  *build() {
    const T = this.theme;

    yield '构建赛道曲线 · Tracing the circuit';
    this.track = new Track(this.def);

    yield '烘焙天空与全局光照 · Baking sky & IBL';
    this.sky = new Sky(this.root);
    this.sky.configure(T.sky);
    const env = this.sky.generateEnvironment(this.engine.pmrem);
    this.scene.environment = env;
    this.scene.background = null;

    this.scene.fog = new THREE.FogExp2(new THREE.Color(T.fog.color), T.fog.density);
    this.engine.applyGrade(T.grade);

    yield '架设光源 · Setting the lights';
    this._buildLights();

    yield '雕刻地形 · Sculpting terrain';
    this._buildTerrain();

    yield '铺设路面 · Laying the tarmac';
    this._buildRoad();

    yield '搭建护栏与隧道 · Barriers & tunnels';
    this._buildTrackProps();

    yield '种植森林 · Growing the forest';
    this._buildFlora();

    yield '建造城镇 · Raising the architecture';
    this._buildArchitecture();

    yield '布置天气与生灵 · Weather & wildlife';
    this._buildAtmosphere();

    yield '完成 · Ready';
    return this;
  }

  // -------------------------------------------------------------------------
  _buildLights() {
    const T = this.theme;
    const sunDir = T.sky.sunDir.clone().normalize();

    const sun = new THREE.DirectionalLight(T.sun.color, T.sun.intensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 190;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.55;
    sun.shadow.radius = T.sun.shadowRadius ?? 3;
    this.root.add(sun);
    this.root.add(sun.target);
    this.sun = sun;
    this.sunDir = sunDir;

    const hemi = new THREE.HemisphereLight(T.ambient.sky, T.ambient.ground, T.ambient.intensity);
    this.root.add(hemi);

    // A dim fill from the anti-sun side keeps shadowed faces readable without
    // washing out the contrast the tone mapper works with.
    const fill = new THREE.DirectionalLight(T.ambient.sky, T.sun.intensity * 0.12 + 0.12);
    fill.position.set(-sunDir.x * 200, 120, -sunDir.z * 200);
    this.root.add(fill);
  }

  _buildTerrain() {
    const T = this.theme;
    this.terrain = new Terrain(this.track, T);

    const base = T.groundKind === 'sand' ? sandMaps() : grassGroundMaps();
    const rock = rockMaps();
    const snow = T.groundKind === 'ice' ? iceMaps() : snowMaps();
    const mat = makeTerrainMaterial(base, rock, snow, T);
    this.root.add(this.terrain.build(mat));

    if (T.water) {
      this.water = createWater(this.terrain, T);
      this.root.add(this.water);
      this.updaters.push((dt) => this.water.userData.update(dt));
    }
  }

  _buildRoad() {
    const T = this.theme;
    const maps = T.wetness > 0.4 ? wetAsphaltMaps() : asphaltMaps();
    const roadMaps = {
      map: maps.map.clone(), normalMap: maps.normalMap.clone(), roughnessMap: maps.roughnessMap.clone(),
    };
    for (const k of Object.keys(roadMaps)) {
      roadMaps[k].repeat.set(1, 1);
      roadMaps[k].needsUpdate = true;
    }
    this.roadMaterial = makeRoadMaterial(roadMaps, T);

    const mats = architectureMaterials();
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.55, metalness: 0.0,
    });
    curbMat.defines = { USE_UV: '' };
    // Red/white rumble stripes, generated in-shader from the along-road UV.
    curbMat.onBeforeCompile = (shader) => {
      shader.uniforms.uCurbA = { value: new THREE.Color(T.curbA ?? 0xd8342c) };
      shader.uniforms.uCurbB = { value: new THREE.Color(T.curbB ?? 0xf2f0ea) };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n uniform vec3 uCurbA, uCurbB;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          float stripe = step(0.5, fract(vUv.y));
          diffuseColor.rgb *= mix(uCurbA, uCurbB, stripe);`);
    };

    const built = buildTrackMeshes(this.track, T, {
      road: this.roadMaterial,
      curb: curbMat,
      skirt: T.pylon === 'stone' ? mats.stone : mats.concrete,
    });
    this.root.add(built.group);
    this.roadMesh = built.roadMesh;
  }

  _buildTrackProps() {
    const T = this.theme;
    const track = this.track;

    this.root.add(buildBarriers(track, T));

    const tun = buildTunnels(track, T);
    this.root.add(tun.group);
    this.tunnelLights = tun.lights;

    this.root.add(buildPylons(track, this.terrain, T));

    const boostList = this._pickBoostSpots(this.def.boosts ?? 6).map((s) => ({
      s, length: 16, width: Math.min(9, track.widthAtS(s) * 0.5),
    }));
    const pads = buildBoostPads(track, boostList, T);
    this.root.add(pads.group);
    this.boostZones = pads.zones;
    this.updaters.push((dt) => pads.group.userData.update(dt));

    const gantry = buildStartGantry(track, T);
    this.root.add(gantry);
    this.startLights = gantry.userData.startLights;

    this.root.add(buildCheckpointArches(track, (this.def.checkpoints ?? []).map((f) => f * track.length), T));
  }

  /**
   * Boost pads belong on the fast parts of the lap, so find the longest
   * genuinely straight runs and drop a pad a third of the way into each.
   * Doing this from the geometry means the pads follow any layout change.
   */
  _pickBoostSpots(count) {
    const t = this.track;
    const runs = [];
    let start = -1;
    for (let i = 0; i <= t.count; i++) {
      const idx = i % t.count;
      const straight = Math.abs(t.curvature[idx]) < 0.0032 && t.kindFlags[idx] !== 2;
      if (straight && start < 0) start = i;
      if ((!straight || i === t.count) && start >= 0) {
        if ((i - start) * t.sampleStep > 55) runs.push([start, i]);
        start = -1;
      }
    }
    runs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    return runs.slice(0, count)
      .map(([a, b]) => ((a + (b - a) * 0.35) % t.count) * t.sampleStep)
      .sort((a, b) => a - b);
  }

  _buildFlora() {
    const f = this.theme.flora;
    if (!f) return;
    if (f.forest) {
      const forest = createForest(this.terrain, this.track, f.forest, this.windUniforms);
      this.root.add(forest);
    }
    if (f.grass) {
      this.root.add(createGrassField(this.terrain, this.track, f.grass, this.windUniforms));
    }
    if (f.rocks) {
      this.root.add(createRocks(this.terrain, this.track, f.rocks));
    }
  }

  _buildAtmosphere() {
    const f = this.theme.flora;
    if (f?.particles) {
      for (const p of f.particles) {
        const sprite = p.type === 'petal' ? petalSprite('#ffd0e0')
          : p.type === 'rain' ? rainSprite()
          : radialSprite(64, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)', p.type === 'snow' ? 1.4 : 2.4);
        const field = createParticleField({
          ...p, sprite, baseY: this.terrain._center.y ?? 0,
          name: p.type,
        });
        this.root.add(field);
        this.updaters.push((dt, cam) => field.userData.update(dt, cam));
      }
    }
    if (f?.birds) {
      const birds = createBirds(this.terrain, f.birds);
      this.root.add(birds);
      this.updaters.push((dt) => birds.userData.update(dt));
    }
  }

  // -------------------------------------------------------------------------
  // Architecture placement
  // -------------------------------------------------------------------------

  /** Find a buildable spot near the track: off the road, not too steep. */
  _findSpot(rng, opts = {}) {
    const track = this.track;
    for (let attempt = 0; attempt < 60; attempt++) {
      const s = (opts.s ?? rng() * track.length);
      const side = opts.side ?? (rng() < 0.5 ? -1 : 1);
      const w = track.widthAtS(s);
      const dist = (opts.min ?? 22) + rng() * ((opts.max ?? 90) - (opts.min ?? 22));
      track.pointAtS(s, side * (w * 0.5 + dist), _v);
      const x = _v.x + (rng() - 0.5) * (opts.jitter ?? 10);
      const z = _v.z + (rng() - 0.5) * (opts.jitter ?? 10);

      const surf = track.sampleAt(x, z, -1);
      if (surf && Math.abs(surf.lateral) < surf.width * 0.5 + (opts.clearance ?? 14)) continue;
      const slope = this.terrain.fastSlopeAt(x, z);
      if (slope > (opts.maxSlope ?? 0.22)) continue;
      const h = this.terrain.heightAt(x, z, surf ? surf.index : -1);
      if (h < (opts.minH ?? -1e9) || h > (opts.maxH ?? 1e9)) continue;
      // Face the structure toward the track for a good on-camera silhouette.
      track.pointAtS(s, 0, _v);
      const yaw = Math.atan2(_v.x - x, _v.z - z);
      return { x, y: h, z, yaw, s, side };
    }
    return null;
  }

  _place(obj, spot, opts = {}) {
    obj.position.set(spot.x, spot.y + (opts.yOffset ?? 0), spot.z);
    obj.rotation.y = spot.yaw + (opts.yawOffset ?? 0);
    if (opts.scale) obj.scale.setScalar(opts.scale);
    this.root.add(obj);
    if (obj.userData.update) {
      this.updaters.push((dt) => obj.userData.update(this.time, dt));
    }
    if (obj.userData.windowMaterial) {
      this.windowMaterials = this.windowMaterials || [];
      this.windowMaterials.push(obj.userData.windowMaterial);
    }
    return obj;
  }

  _buildArchitecture() {
    const A = this.theme.architecture;
    if (!A) return;
    const rng = makeRng(A.seed ?? 2024);
    if (A.pack === 'dynasty') this._buildDynasty(A, rng);
    else if (A.pack === 'metro') this._buildMetro(A, rng);
    else if (A.pack === 'alpine') this._buildAlpine(A, rng);

    // Grandstands framing the start/finish straight.
    for (let i = 0; i < (A.grandstands ?? 0); i++) {
      const s = (i === 0 ? 0.985 : 0.02 + i * 0.33) * this.track.length;
      const side = i % 2 === 0 ? 1 : -1;
      const spot = this._findSpot(rng, { s, side, min: 16, max: 22, clearance: 12, maxSlope: 0.45 });
      if (!spot) continue;
      // _findSpot's yaw already points local +Z at the track, which is the
      // direction the seating tiers face.
      const stand = grandstand({ w: 40, rows: 9, seed: 30 + i });
      this._place(stand, spot, { yOffset: -0.4 });
    }
  }

  _buildDynasty(A, rng) {
    const mats = architectureMaterials();

    // Villages: clusters of halls along a cobbled street with lantern strings.
    for (let v = 0; v < (A.villages ?? 4); v++) {
      const anchor = this._findSpot(rng, {
        s: (v / A.villages + rng() * 0.06) * this.track.length,
        min: 26, max: 60, maxSlope: 0.16, jitter: 6,
      });
      if (!anchor) continue;
      const count = 4 + Math.floor(rng() * 5);
      const dirX = Math.cos(anchor.yaw), dirZ = -Math.sin(anchor.yaw);
      for (let i = 0; i < count; i++) {
        const row = i % 2 === 0 ? 1 : -1;
        const along = (Math.floor(i / 2) - count / 4) * 16 + (rng() - 0.5) * 4;
        const x = anchor.x + dirX * along + dirZ * row * 13;
        const z = anchor.z + dirZ * along - dirX * row * 13;
        const h = this.terrain.heightAt(x, z);
        if (this.terrain.fastSlopeAt(x, z) > 0.3) continue;
        const hall = dynastyHall({ seed: 100 + v * 17 + i, lit: 0.75, glow: 2.4 });
        this._place(hall, { x, y: h - 0.2, z, yaw: anchor.yaw + (row > 0 ? 0 : Math.PI) });
      }
      // Street surface and lanterns down the middle.
      // Bake the ground rotation into the geometry so the yaw below is a
      // plain spin about world up (chaining Euler X then Z would tilt it).
      const streetLen = Math.max(30, count * 9);
      const streetGeo = new THREE.PlaneGeometry(streetLen, 9);
      streetGeo.rotateX(-Math.PI / 2);
      const street = new THREE.Mesh(streetGeo, mats.cobble);
      street.rotation.y = anchor.yaw;
      street.position.set(anchor.x, this.terrain.heightAt(anchor.x, anchor.z) + 0.06, anchor.z);
      street.receiveShadow = true;
      this.root.add(street);

      const lant = lanternString(Math.max(4, count), 5.2, { glow: 3.0, seed: v * 3 + 1, glyph: v % 2 ? '福' : '春' });
      lant.position.set(anchor.x, this.terrain.heightAt(anchor.x, anchor.z) + 6.4, anchor.z);
      lant.rotation.y = anchor.yaw;
      this._place(lant, { x: anchor.x, y: this.terrain.heightAt(anchor.x, anchor.z) + 6.4, z: anchor.z, yaw: anchor.yaw });

      for (let b = 0; b < 3; b++) {
        const bx = anchor.x + dirX * (b - 1) * 11 + dirZ * 6;
        const bz = anchor.z + dirZ * (b - 1) * 11 - dirX * 6;
        const bn = banner({ glyph: ['速', '飞', '风'][b % 3], glow: 0.6 });
        this._place(bn, { x: bx, y: this.terrain.heightAt(bx, bz), z: bz, yaw: anchor.yaw });
      }
    }

    // Pagodas on prominent high ground.
    for (let i = 0; i < (A.pagodas ?? 2); i++) {
      const spot = this._findSpot(rng, {
        s: ((i + 0.4) / (A.pagodas ?? 2)) * this.track.length,
        min: 60, max: 190, maxSlope: 0.24, jitter: 20,
      });
      if (!spot) continue;
      const pg = pagoda({ seed: 200 + i * 31, levels: 5 + (i % 3) });
      this._place(pg, spot, { yOffset: -0.4 });
    }

    // Ceremonial gates straddling the road.
    for (let i = 0; i < (A.gates ?? 2); i++) {
      const s = (0.12 + i * 0.47) * this.track.length;
      const idx = Math.floor((s / this.track.sampleStep) % this.track.count);
      const p = new THREE.Vector3(this.track.pos[idx * 3], this.track.pos[idx * 3 + 1], this.track.pos[idx * 3 + 2]);
      const t = new THREE.Vector3(this.track.tan[idx * 3], 0, this.track.tan[idx * 3 + 2]).normalize();
      const gate = paifang({ span: this.track.width[idx] + 10, height: 12, glyph: i === 0 ? '飞' : '车' });
      gate.position.copy(p).setY(p.y - 0.2);
      gate.rotation.y = Math.atan2(t.x, t.z);
      this.root.add(gate);

      // Lanterns strung across the road under the gate.
      const lant = lanternString(9, 3.0, { glow: 3.4, droop: 1.4, glyph: '福', seed: i + 9 });
      lant.position.copy(p).setY(p.y + 8.4);
      lant.rotation.y = Math.atan2(t.x, t.z) + Math.PI / 2;
      this._place(lant, { x: p.x, y: p.y + 8.4, z: p.z, yaw: Math.atan2(t.x, t.z) + Math.PI / 2 });

      const tor = torii({ w: this.track.width[idx] + 6, h: 9 });
      const s2 = s + 90;
      const idx2 = Math.floor((s2 / this.track.sampleStep) % this.track.count);
      const p2 = new THREE.Vector3(this.track.pos[idx2 * 3], this.track.pos[idx2 * 3 + 1], this.track.pos[idx2 * 3 + 2]);
      const t2 = new THREE.Vector3(this.track.tan[idx2 * 3], 0, this.track.tan[idx2 * 3 + 2]).normalize();
      tor.position.copy(p2).setY(p2.y - 0.2);
      tor.rotation.y = Math.atan2(t2.x, t2.z);
      this.root.add(tor);
    }

    // Ornamental arch bridges over the lake.
    for (let i = 0; i < (A.bridges ?? 2); i++) {
      const spot = this._findSpot(rng, {
        s: (0.45 + i * 0.2) * this.track.length,
        min: 60, max: 150, maxSlope: 0.5,
        maxH: (this.theme.water?.level ?? 0) + 6,
      });
      if (!spot) continue;
      const br = archBridge({ span: 26, rise: 5.5, width: 5 });
      this._place(br, { ...spot, y: (this.theme.water?.level ?? 0) - 1.2 });
    }
  }

  _buildMetro(A, rng) {
    // Towers: clustered downtown blocks, thinning toward the outskirts.
    let placed = 0;
    const target = A.towers ?? 60;
    for (let attempt = 0; attempt < target * 22 && placed < target; attempt++) {
      const spot = this._findSpot(rng, {
        min: 34, max: 420, clearance: 26, maxSlope: 0.5, jitter: 30,
      });
      if (!spot) continue;
      // Bias height by distance from the track so the skyline layers properly.
      const d = Math.hypot(spot.x - this.terrain._center.x, spot.z - this.terrain._center.z);
      const inner = clamp(1 - Math.abs(d - this.terrain.radius) / 420, 0, 1);
      const h = 34 + Math.pow(rng(), 1.7) * (60 + inner * 190);
      const tower = skyscraper({
        seed: Math.floor(rng() * 1e6),
        w: 12 + rng() * 22, d: 12 + rng() * 22, h,
        lit: 0.34 + rng() * 0.3,
        glow: 2.0 + rng() * 1.8,
      });
      this._place(tower, spot, { yOffset: -1.0 });
      placed++;

      // Rooftop or facade signage on some towers.
      if (rng() < 0.3) {
        const sign = hologramSign({
          text: ['飞', '速', '光', '夜', '霓', '虹'][Math.floor(rng() * 6)],
          hue: rng(), w: 7 + rng() * 6, h: 7 + rng() * 6,
        });
        sign.position.set(spot.x, spot.y + tower.userData.height + 1, spot.z);
        sign.rotation.y = spot.yaw;
        this._place(sign, { x: spot.x, y: spot.y + tower.userData.height + 1, z: spot.z, yaw: spot.yaw });
      }
    }

    // Roadside holograms right where the camera will see them.
    for (let i = 0; i < (A.signs ?? 20); i++) {
      const spot = this._findSpot(rng, { min: 14, max: 32, clearance: 11, maxSlope: 0.6, jitter: 4 });
      if (!spot) continue;
      const sign = hologramSign({
        text: ['飞车', '加速', '漂移', 'NEON', '霓虹', '極速'][i % 6],
        hue: (i * 0.17) % 1, w: 6 + rng() * 4, h: 6 + rng() * 3,
      });
      this._place(sign, spot, { yOffset: 3 });
    }

    // Street lighting. The lamps are identical, so they go down as two
    // instanced meshes (structure + emissive head) rather than 60 groups.
    const lampCount = A.lamps ?? 50;
    const proto = streetLamp({ height: 9, color: 0xd8e8ff, glow: 5.0 });
    const structure = [], heads = [];
    proto.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone();
      geo.applyMatrix4(new THREE.Matrix4().compose(o.position, o.quaternion, o.scale));
      (o.material === proto.userData.emissive ? heads : structure).push(geo);
    });
    const lampMeshes = [
      new THREE.InstancedMesh(mergeGeometries(structure), architectureMaterials().darkMetal, lampCount),
      new THREE.InstancedMesh(mergeGeometries(heads), proto.userData.emissive, lampCount),
    ];
    lampMeshes[0].castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < lampCount; i++) {
      const s = (i / lampCount) * this.track.length;
      const side = i % 2 === 0 ? 1 : -1;
      const w = this.track.widthAtS(s);
      this.track.pointAtS(s, side * (w * 0.5 + 4.5), _v);
      const idx = Math.floor((s / this.track.sampleStep) % this.track.count);
      const t = new THREE.Vector3(this.track.tan[idx * 3], 0, this.track.tan[idx * 3 + 2]).normalize();
      // The lamp's arm runs along local +X, which maps to the track's -right,
      // so a lamp on the right needs no flip and one on the left does.
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(t.x, t.z) + (side > 0 ? 0 : Math.PI));
      m.compose(_v, q, new THREE.Vector3(1, 1, 1));
      for (const mesh of lampMeshes) mesh.setMatrixAt(i, m);
    }
    for (const mesh of lampMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    }
  }

  _buildAlpine(A, rng) {
    for (let v = 0; v < (A.villages ?? 5); v++) {
      const anchor = this._findSpot(rng, {
        s: (v / A.villages + rng() * 0.05) * this.track.length,
        min: 28, max: 90, maxSlope: 0.2, jitter: 10,
      });
      if (!anchor) continue;
      const count = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < count; i++) {
        const a = rng() * TAU;
        const r = 8 + rng() * 26;
        const x = anchor.x + Math.cos(a) * r;
        const z = anchor.z + Math.sin(a) * r;
        if (this.terrain.fastSlopeAt(x, z) > 0.3) continue;
        const h = this.terrain.heightAt(x, z);
        const c = chalet({ seed: 400 + v * 13 + i });
        this._place(c, { x, y: h - 0.3, z, yaw: anchor.yaw + (rng() - 0.5) * 1.2 });
      }
    }

    for (let i = 0; i < (A.chapels ?? 1); i++) {
      const spot = this._findSpot(rng, {
        s: ((i + 0.5) / (A.chapels ?? 1)) * this.track.length,
        min: 50, max: 150, maxSlope: 0.22, jitter: 16,
      });
      if (!spot) continue;
      this._place(chapel({}), spot, { yOffset: -0.4 });
    }

    // Cable cars slung between high points on either side of the circuit.
    for (let i = 0; i < (A.cableCars ?? 2); i++) {
      const s = ((i + 0.3) / (A.cableCars ?? 2)) * this.track.length;
      const w = this.track.widthAtS(s);
      const a = this.track.pointAtS(s, -(w * 0.5 + 160), new THREE.Vector3());
      const b = this.track.pointAtS(s, w * 0.5 + 190, new THREE.Vector3());
      a.y = this.terrain.heightAt(a.x, a.z) + 40;
      b.y = this.terrain.heightAt(b.x, b.z) + 46;
      const cc = cableCar(a, b, { count: 5, speed: 0.014, sag: 22 });
      this.root.add(cc);
      this.updaters.push((dt) => cc.userData.update(dt));
    }
  }

  // -------------------------------------------------------------------------
  update(dt, camera, carPos) {
    this.time += dt;
    this.windUniforms.uTime.value = this.time;
    this.sky.update(dt);
    this.sky.mesh.position.copy(camera.position);
    this.sky.mesh.updateMatrix();
    this.sky.mesh.updateMatrixWorld(true);

    if (this.roadMaterial.userData.uniforms) {
      this.roadMaterial.userData.uniforms.uTime.value = this.time;
    }
    if (this.windowMaterials) {
      for (const m of this.windowMaterials) {
        if (m.userData.uniforms) m.userData.uniforms.uTime.value = this.time;
      }
    }

    // Keep the shadow frustum tight around the car for crisp contact shadows.
    if (carPos) {
      const off = this.sunDir.clone().multiplyScalar(320);
      this.sun.position.copy(carPos).add(off);
      this.sun.target.position.copy(carPos);
      this.sun.target.updateMatrixWorld();
    }

    for (const u of this.updaters) u(dt, camera);
  }

  dispose() {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    if (this.scene.environment) this.scene.environment.dispose?.();
    this.scene.environment = null;
    this.scene.fog = null;
  }
}
