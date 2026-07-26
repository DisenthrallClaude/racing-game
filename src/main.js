// Entry point: menu, world loading, the race loop and everything that binds
// physics, effects, audio and HUD together.

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { World } from './world/world.js';
import { TRACKS } from './track/tracks.js';
import { Vehicle, CAR_PRESETS } from './game/vehicle.js';
import { AIDriver, AI_NAMES } from './game/ai.js';
import { Race, RACE_STATE, formatTime } from './game/race.js';
import { ChaseCamera } from './game/camera.js';
import { SkidMarks, ParticlePool, createNitroPlume, createSpeedLines, smokeSprite } from './game/effects.js';
import { HUD } from './ui/hud.js';
import {
  radialSprite, asphaltMaps, grassGroundMaps, rockMaps, snowMaps, roofTileMaps, woodMaps,
} from './util/tex.js';
import { clamp, makeRng } from './util/noise.js';

const AI_COLORS = [0xff8a2b, 0x2ec4ff, 0x9dff5a, 0xb64bff, 0xffe066, 0xff4f7a, 0x5affd0];
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

class Game {
  constructor() {
    this.dom = document;
    this.engine = new Engine(document.getElementById('gl'));
    this.audio = new AudioEngine();
    this.input = new Input(document);
    this.hud = new HUD(document);
    this.chase = new ChaseCamera(this.engine.camera);

    this.selected = { track: TRACKS[0], car: CAR_PRESETS[0], quality: 'high', rivals: 5, audio: true };
    this.state = 'loading';
    this.paused = false;

    this.el = {
      loading: document.getElementById('loading'),
      loadbar: document.querySelector('#loadbar i'),
      loadtext: document.getElementById('loadtext'),
      menu: document.getElementById('menu'),
      pause: document.getElementById('pause'),
      results: document.getElementById('results'),
      touch: document.getElementById('touch'),
    };

    this.input.onPause = () => this.togglePause();
    this.input.onRestart = () => { if (this.state === 'racing') this.race.player.vehicle.respawn(); };
    this.input.onCamera = () => {
      if (this.state !== 'racing') return;
      const m = this.chase.cycle();
      this.hud.toast(({ chase: '追尾视角', close: '贴身视角', hood: '车头视角', cinematic: '电影视角' })[m], '#8ef0ff');
      this.audio.uiClick();
    };

    this._buildMenu();
    this._bindButtons();

    this.clock = new THREE.Clock();
    this.lastTime = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // -------------------------------------------------------------------------
  // Menu
  // -------------------------------------------------------------------------
  _buildMenu() {
    const tc = document.getElementById('track-cards');
    tc.innerHTML = TRACKS.map((t, i) => `
      <div class="card ${i === 0 ? 'sel' : ''}" data-track="${t.id}">
        <div class="name">${t.name}</div>
        <div class="sub">${t.subtitle}</div>
        <div class="desc">${trackBlurb(t.id)}</div>
        <div class="stars">${[0, 1, 2].map((k) => `<i class="${k < t.difficulty ? 'on' : ''}"></i>`).join('')}</div>
        <div class="sub" style="margin-top:8px">${t.laps} 圈 · ${(t.laps * 4.0).toFixed(0)}–${(t.laps * 5.5).toFixed(0)} 分钟</div>
      </div>`).join('');

    const cc = document.getElementById('car-cards');
    cc.innerHTML = CAR_PRESETS.map((c, i) => `
      <div class="card ${i === 0 ? 'sel' : ''}" data-car="${c.id}">
        <div class="swatch" style="background:#${c.color.toString(16).padStart(6, '0')};color:#${c.color.toString(16).padStart(6, '0')}"></div>
        <div class="name">${c.name}</div>
        <div class="desc">${c.blurb}</div>
        <div class="stat"><span>极速</span><div class="bar"><i style="width:${(c.topSpeed - 70) / 25 * 100}%"></i></div><span>${Math.round(c.topSpeed * 3.6)}</span></div>
        <div class="stat"><span>加速</span><div class="bar"><i style="width:${(c.accel - 20) / 18 * 100}%"></i></div><span>${c.accel}</span></div>
        <div class="stat"><span>操控</span><div class="bar"><i style="width:${(c.handling - 0.8) / 0.45 * 100}%"></i></div><span>${c.handling.toFixed(2)}</span></div>
      </div>`).join('');

    const pick = (container, attr, cb) => {
      container.addEventListener('click', (e) => {
        const card = e.target.closest(`[data-${attr}]`);
        if (!card) return;
        [...container.querySelectorAll(`[data-${attr}]`)].forEach((c) => c.classList.remove('sel'));
        card.classList.add('sel');
        this.audio.uiClick();
        cb(card.dataset[attr]);
      });
    };
    pick(tc, 'track', (id) => { this.selected.track = TRACKS.find((t) => t.id === id); });
    pick(cc, 'car', (id) => { this.selected.car = CAR_PRESETS.find((c) => c.id === id); });
    pick(document.getElementById('quality-opts'), 'q', (q) => {
      this.selected.quality = q;
      this.engine.setQuality(q);
    });
    pick(document.getElementById('rival-opts'), 'r', (r) => { this.selected.rivals = parseInt(r, 10); });
    pick(document.getElementById('audio-opts'), 'a', (a) => {
      this.selected.audio = a === 'on';
      this.audio.setEnabled(this.selected.audio);
    });
  }

  _bindButtons() {
    document.getElementById('btn-start').onclick = () => {
      this.audio.init();
      this.audio.resume();
      this.audio.setEnabled(this.selected.audio);
      this.audio.uiClick();
      this.startRace();
    };
    document.getElementById('btn-resume').onclick = () => this.togglePause();
    document.getElementById('btn-restart').onclick = () => { this.togglePause(); this.startRace(); };
    document.getElementById('btn-quit').onclick = () => { this.togglePause(); this.toMenu(); };
    document.getElementById('btn-again').onclick = () => { this.el.results.classList.add('hidden'); this.startRace(); };
    document.getElementById('btn-menu').onclick = () => { this.el.results.classList.add('hidden'); this.toMenu(); };
  }

  toMenu() {
    this.state = 'menu';
    this.hud.show(false);
    this.el.menu.classList.remove('hidden');
    this.el.touch.classList.add('hidden');
    this.input.enabled = false;
  }

  togglePause() {
    if (this.state !== 'racing') return;
    this.paused = !this.paused;
    this.el.pause.classList.toggle('hidden', !this.paused);
    this.input.enabled = !this.paused;
  }

  // -------------------------------------------------------------------------
  // Race setup
  // -------------------------------------------------------------------------
  async startRace() {
    this.state = 'loading';
    this.el.menu.classList.add('hidden');
    this.el.loading.classList.remove('hidden');
    this.hud.show(false);
    this._setProgress(0, '准备场景…');
    await frame();

    this._teardown();

    const def = this.selected.track;
    const world = new World(this.engine, def);
    this.world = world;

    const gen = world.build();
    let step = 0;
    const total = 10;
    for (;;) {
      const { value, done } = gen.next();
      if (done) break;
      step++;
      this._setProgress(step / total, value);
      await frame();
      await frame();
    }

    this._setProgress(0.94, '召集车手 · Assembling the grid');
    await frame();
    this._buildEntries(def);
    this._buildEffects();

    this._setProgress(1.0, '出发 · GO');
    await frame();

    this.el.loading.classList.add('hidden');
    this.hud.show(true);
    this.el.touch.classList.remove('hidden');
    this.hud.prepareMinimap(world.track);
    this.input.enabled = true;
    this.state = 'racing';
    this.chase.initialised = false;
    this.race.startCountdown();
  }

  _buildEntries(def) {
    const world = this.world;
    const rng = makeRng(def.id.length * 991 + 17);
    const entries = [];

    const playerVehicle = new Vehicle(world.track, world.terrain, this.selected.car, { isPlayer: true });
    world.root.add(playerVehicle.mesh);
    entries.push({
      vehicle: playerVehicle, isPlayer: true, name: '你 YOU',
      color: this.selected.car.color, ai: null,
    });

    for (let i = 0; i < this.selected.rivals; i++) {
      const preset = {
        ...CAR_PRESETS[i % CAR_PRESETS.length],
        color: AI_COLORS[i % AI_COLORS.length],
        accent: 0xffffff,
      };
      const v = new Vehicle(world.track, world.terrain, preset, {
        speedScale: 0.955 + rng() * 0.07,
        accelScale: 0.93 + rng() * 0.12,
        gripScale: 0.94 + rng() * 0.1,
      });
      world.root.add(v.mesh);
      entries.push({
        vehicle: v, isPlayer: false, name: AI_NAMES[i % AI_NAMES.length],
        color: preset.color,
        ai: new AIDriver(v, world.track, {
          skill: 0.62 + rng() * 0.36,
          aggression: 0.75 + rng() * 0.3,
          seed: 100 + i * 37,
        }),
      });
    }

    this.entries = entries;
    this.race = new Race(world, entries, def);
    this._bindRaceEvents();

    // Headlights for the night circuits.
    if ((def.theme.sky.night ?? 0) > 0.35) {
      for (const e of entries) {
        for (const sx of [-0.62, 0.62]) {
          const spot = new THREE.SpotLight(0xdfefff, e.isPlayer ? 26 : 12, 105, 0.42, 0.55, 1.4);
          spot.position.set(sx, 0.62, 2.2);
          spot.target.position.set(sx * 0.6, -0.4, 26);
          e.vehicle.mesh.add(spot);
          e.vehicle.mesh.add(spot.target);
        }
      }
    }
  }

  _bindRaceEvents() {
    const race = this.race;
    race.onCountdownTick = (n) => {
      this.hud.countdown(n > 0 ? String(n) : 'GO!');
      this.audio.countdownTick(n);
    };
    race.onLap = (lap, time, best) => {
      this.audio.lap();
      const isBest = Math.abs(time - best) < 1e-6;
      this.hud.toast(`第 ${lap} 圈 · ${formatTime(time)}${isBest ? ' 最快!' : ''}`, isBest ? '#ffcb6b' : '#ffffff');
    };
    race.onPadBoost = () => {
      this.audio.boost();
      this.hud.toast('加速带!', '#8ef0ff');
    };
    race.onFinish = (entry) => this._showResults(entry);
    race.onStart = () => {
      // One-line reminder of the core loop, shown once as the lights go out.
      setTimeout(() => this.hud.toast('转向中长按 SHIFT 漂移集气', '#8ef0ff'), 1600);
    };

    const player = race.player.vehicle;
    this._hintedBoost = false;
    player.onDriftBanked = (n) => {
      this.audio.driftBank(n);
      this.hud.toast(n >= 3 ? '完美漂移 +3' : `漂移 +${n}`, n >= 3 ? '#ff3ea5' : '#ffcb6b');
      if (!this._hintedBoost) {
        this._hintedBoost = true;
        setTimeout(() => this.hud.toast('按 SPACE 释放氮气', '#ffcb6b'), 900);
      }
    };
    player.onBoost = () => {
      this.audio.boost();
      this.chase.addShake(0.35);
    };
  }

  _buildEffects() {
    const scene = this.world.root;
    this.skid = new SkidMarks(scene, 1400);
    this.smoke = new ParticlePool(scene, {
      max: 500, sprite: smokeSprite(), grow: 3.2, opacity: 0.26, gravity: 1.0, drag: 1.8,
    });
    this.sparks = new ParticlePool(scene, {
      max: 420, sprite: radialSprite(64, 'rgba(255,255,255,1)', 'rgba(255,180,80,0)', 2.5),
      grow: -0.6, opacity: 0.95, gravity: -16, drag: 0.6, additive: true,
    });

    this.speedLines = createSpeedLines(300);
    this.engine.camera.add(this.speedLines);
    this.speedLines.position.set(0, 0, -1);
    this.engine.scene.add(this.engine.camera);

    // A nitro plume per exhaust nozzle on every car.
    for (const e of this.entries) {
      e.plumes = [];
      for (const nozzle of e.vehicle.parts.nozzles) {
        const plume = createNitroPlume(e.isPlayer ? 0x6fe0ff : 0xffa14a);
        plume.position.copy(nozzle.position).add(new THREE.Vector3(0, 0, -0.2));
        e.vehicle.mesh.add(plume);
        e.plumes.push(plume);
      }
      e.wheelTrack = new Map();
    }
  }

  _teardown() {
    if (this.world) {
      this.world.dispose();
      this.world = null;
    }
    if (this.speedLines) {
      this.engine.camera.remove(this.speedLines);
      this.speedLines.geometry.dispose();
      this.speedLines.material.dispose();
      this.speedLines = null;
    }
    this.race = null;
    this.entries = null;
  }

  _setProgress(p, text) {
    this.el.loadbar.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
    if (text) this.el.loadtext.textContent = text;
  }

  _showResults(entry) {
    const race = this.race;
    setTimeout(() => {
      const standings = [...race.entries].sort((a, b) => a.position - b.position);
      const pos = entry.position;
      document.getElementById('result-title').textContent =
        pos === 1 ? '冠军！' : pos <= 3 ? '登上领奖台' : '完赛';
      document.getElementById('result-sub').textContent =
        pos === 1 ? 'VICTORY' : `FINISHED P${pos}`;

      const total = entry.finishTime - (race.startedAt ?? 0);
      document.getElementById('result-summary').innerHTML = `
        <div><div class="k">Position</div><div class="v">P${pos}</div></div>
        <div><div class="k">Total</div><div class="v">${formatTime(total)}</div></div>
        <div><div class="k">Best Lap</div><div class="v">${formatTime(entry.bestLap)}</div></div>
        <div><div class="k">Top Speed</div><div class="v">${Math.round(this.topSpeedSeen || 0)}</div></div>`;

      document.getElementById('result-rows').innerHTML = standings.map((e) => {
        const t = e.finished ? formatTime(e.finishTime - (race.startedAt ?? 0)) : 'DNF';
        return `<div class="row ${e.isPlayer ? 'me' : ''}">
          <span class="p">${e.position}</span><span>${e.name}</span><span class="t">${t}</span></div>`;
      }).join('');

      this.el.results.classList.remove('hidden');
      this.audio.finish();
      this.input.enabled = false;
    }, 1400);
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------
  _loop(now) {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, (now - this.lastTime) / 1000) || 0.016;
    this.lastTime = now;

    if (this.state === 'racing' && !this.paused) {
      this._update(dt);
    } else if (this.state === 'racing' && this.paused) {
      this.engine.render(dt, { speed01: 0, boost01: 0 });
      return;
    } else if (this.world && this.world.sky && this.race) {
      // Menu / results: keep the world alive with a slow orbit of the car.
      this.world.update(dt, this.engine.camera, this.race.player.vehicle.position);
      this.chase.orbit(dt, this.race.player.vehicle.position, 15, 4.5);
      this.engine.render(dt, { speed01: 0, boost01: 0 });
      return;
    }
    if (this.state !== 'racing') {
      this.engine.render(dt, { speed01: 0, boost01: 0 });
    }
  }

  _update(dt) {
    const race = this.race;
    const input = this.input.sample();
    race.update(dt, input);

    const player = race.player;
    const pv = player.vehicle;
    this.topSpeedSeen = Math.max(this.topSpeedSeen || 0, pv.speedKmh);

    // World animation + shadow frustum follow.
    this.world.update(dt, this.engine.camera, pv.position);

    // Effects for every car.
    for (const e of this.entries) e.vehicle.mesh.updateMatrixWorld(true);
    for (const e of this.entries) this._vehicleEffects(dt, e, e === player);

    this.skid.update(dt);
    this.smoke.update(dt);
    this.sparks.update(dt);

    // Camera
    this.chase.update(dt, pv, {
      groundAt: (x, z) => this.world.terrain.heightAt(x, z),
    });
    if (pv.wallHit > 0.15 && !this._wallShook) {
      this.chase.addShake(pv.wallHit * 0.9);
      this.engine.flashDamage(pv.wallHit * 0.8);
      this.audio.impact(pv.wallHit);
      this._wallShook = true;
    }
    if (pv.wallHit <= 0.05) this._wallShook = false;
    if (pv.lastImpact > 0.08) {
      this.chase.addShake(pv.lastImpact * 0.6);
      this.audio.land(pv.lastImpact);
      pv.lastImpact = 0;
    }

    // Speed lines + post FX drive
    const speed01 = clamp(pv.speed / pv.stats.topSpeed, 0, 1.2);
    const boost01 = pv.boostTimer > 0 ? clamp(pv.boostTimer / 0.6, 0, 1) : 0;
    if (this.speedLines) {
      const u = this.speedLines.userData.uniforms;
      u.uTime.value += dt;
      const target = Math.max(0, speed01 - 0.42) * 1.7 + boost01 * 0.7;
      u.uIntensity.value += (target - u.uIntensity.value) * Math.min(1, dt * 6);
    }

    // Audio
    this.audio.updateEngine({
      speed: pv.speed,
      throttle: input.throttle,
      boosting: pv.boostTimer > 0,
      drift: pv.drifting ? 6 : 0,
      offroad: pv.offroad,
      airborne: !pv.grounded,
    });

    this.hud.update(race, player, dt);
    this.engine.render(dt, { speed01: Math.max(0, speed01 - 0.35) * 1.3, boost01 });
  }

  _vehicleEffects(dt, entry, isPlayer) {
    const v = entry.vehicle;
    const drifting = v.drifting;
    const boosting = v.boostTimer > 0;

    // Nitro plumes
    const power = boosting ? 1.0 : (drifting ? 0.12 + v.driftLevel * 0.14 : 0);
    for (const p of entry.plumes) {
      const u = p.userData.uniforms;
      u.uTime.value += dt;
      u.uPower.value += (power - u.uPower.value) * Math.min(1, dt * 9);
      if (drifting && !boosting) {
        u.uColorA.value.setHex(v.driftLevel === 0 ? 0x3fd0ff : v.driftLevel === 1 ? 0xff8a2b : 0xff3ea5);
      } else if (boosting) {
        u.uColorA.value.setHex(isPlayer ? 0x6fe0ff : 0xffa14a);
      }
    }

    // Tyre marks + smoke from the driven wheels.
    const slide = Math.abs(v.velocity.x * Math.cos(v.yaw) - v.velocity.z * Math.sin(v.yaw));
    const marking = v.grounded && !v.offroad && (drifting || slide > 5.5 || (v._braking && v.speed > 22));
    const dusting = v.grounded && v.offroad && v.speed > 6;

    for (const wheel of v.parts.wheels) {
      const key = `${entry.name}-${wheel.tag}`;
      if (!marking && !dusting) { this.skid.break(key); continue; }
      if (wheel.front && !dusting) { this.skid.break(key); continue; }

      wheel.hub.getWorldPosition(_v);
      _v.y -= 0.42;
      v.mesh.getWorldDirection(_w);
      // Right vector of the car in world space.
      const right = _w.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw));

      if (marking) {
        const intensity = clamp((drifting ? 0.8 : 0.3) + slide / 26, 0.15, 1);
        this.skid.stamp(key, _v, right, 0.38, intensity);
      } else {
        this.skid.break(key);
      }

      // Smoke / dust puffs. Spawn sparingly: four wheels at 60 fps adds up
      // fast, and a wall of smoke hides the car it is supposed to dramatise.
      if (Math.random() < (drifting ? 0.30 : dusting ? 0.16 : 0.08)) {
        const vel = new THREE.Vector3(
          (Math.random() - 0.5) * 2.2 - v.velocity.x * 0.05,
          0.9 + Math.random() * 1.2,
          (Math.random() - 0.5) * 2.2 - v.velocity.z * 0.05,
        );
        const color = dusting
          ? new THREE.Color(0.55, 0.46, 0.34)
          : new THREE.Color(0.82, 0.85, 0.9);
        this.smoke.spawn(_v, vel, 0.55 + Math.random() * 0.45, 0.7 + Math.random() * 0.7, color);
      }
    }

    // Wall sparks
    if (v.wallHit > 0.2 && Math.random() < 0.85) {
      v.mesh.getWorldPosition(_v);
      _v.y += 0.4;
      const side = Math.sign(v.lateral);
      _v.x += Math.cos(v.yaw) * side * 1.0;
      _v.z += -Math.sin(v.yaw) * side * 1.0;
      for (let i = 0; i < 5; i++) {
        const vel = new THREE.Vector3(
          (Math.random() - 0.5) * 9 - v.velocity.x * 0.25,
          Math.random() * 5,
          (Math.random() - 0.5) * 9 - v.velocity.z * 0.25,
        );
        this.sparks.spawn(_v, vel, 0.3 + Math.random() * 0.35, 1.0, new THREE.Color(1.0, 0.72, 0.3));
      }
    }

    // Boost heat shimmer particles behind the car.
    if (boosting && Math.random() < 0.8) {
      v.mesh.getWorldPosition(_v);
      _v.y += 0.45;
      _v.x -= Math.sin(v.yaw) * 2.4;
      _v.z -= Math.cos(v.yaw) * 2.4;
      const vel = new THREE.Vector3(
        -v.velocity.x * 0.15 + (Math.random() - 0.5) * 2,
        0.6 + Math.random(),
        -v.velocity.z * 0.15 + (Math.random() - 0.5) * 2,
      );
      this.sparks.spawn(_v, vel, 0.35, 1.6, new THREE.Color(0.45, 0.85, 1.0));
    }
  }
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function trackBlurb(id) {
  return {
    sakura: '黄昏中的古镇与湖泊，樱花漫天，飞檐斗拱与红灯笼夹道，穿山隧道与窄桥考验胆量。',
    metro: '雨夜的霓虹都市，湿滑路面倒映摩天楼，高架桥、隧道与大倾角弯道连成一体。',
    alpine: '极光下的雪山之巅，冰洞、悬崖窄桥与缆车，风景绝美但每一次失误都代价高昂。',
  }[id] || '';
}

// ---------------------------------------------------------------------------

async function boot() {
  const game = new Game();
  window.__game = game;

  // Warm up: bake the heavy procedural textures before showing the menu so the
  // first race doesn't stutter.
  game._setProgress(0.35, '烘焙材质 · Baking materials');
  await frame();
  asphaltMaps(); grassGroundMaps(); rockMaps(); snowMaps(); roofTileMaps(); woodMaps();
  game._setProgress(0.9, '准备就绪 · Ready');
  await frame();
  game.el.loading.classList.add('hidden');
  game.toMenu();
}

// Works whether the script is deferred, inlined at the end of the document, or
// evaluated after the document has already finished parsing.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
