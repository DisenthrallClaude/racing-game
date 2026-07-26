// Vehicle effects: tyre marks burned into the tarmac, drift smoke, nitro
// exhaust plumes, impact sparks and a speed-line tunnel that snaps on when
// the car is really moving.

import * as THREE from 'three';
import { radialSprite } from '../util/tex.js';
import { clamp, TAU } from '../util/noise.js';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Skid marks
// ---------------------------------------------------------------------------

export class SkidMarks {
  constructor(scene, maxSegments = 900) {
    this.max = maxSegments;
    this.head = 0;
    this.time = 0;

    const verts = maxSegments * 4;
    this.positions = new Float32Array(verts * 3);
    this.ages = new Float32Array(verts);
    this.opacities = new Float32Array(verts);
    this.ages.fill(-1e6);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAge', new THREE.BufferAttribute(this.ages, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacities, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(maxSegments * 6);
    for (let i = 0; i < maxSegments; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.uniforms = { uTime: { value: 0 }, uLife: { value: 14.0 }, uColor: { value: new THREE.Color(0x0a0a0c) } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: /* glsl */`
        attribute float aAge;
        attribute float aOpacity;
        uniform float uTime, uLife;
        varying float vFade;
        void main() {
          float age = uTime - aAge;
          vFade = clamp(1.0 - age / uLife, 0.0, 1.0) * aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          if (vFade <= 0.004) discard;
          gl_FragColor = vec4(uColor, vFade * 0.62);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.prev = new Map();
  }

  /** Add one quad between the previous and current contact patch. */
  stamp(key, point, right, width, opacity) {
    const prev = this.prev.get(key);
    const a = _a.copy(point).addScaledVector(right, -width * 0.5);
    const b = _b.copy(point).addScaledVector(right, width * 0.5);
    if (prev) {
      const i = this.head % this.max;
      const o = i * 4;
      this.positions.set([
        prev.a.x, prev.a.y, prev.a.z,
        prev.b.x, prev.b.y, prev.b.z,
        a.x, a.y, a.z,
        b.x, b.y, b.z,
      ], o * 3);
      for (let k = 0; k < 4; k++) {
        this.ages[o + k] = this.time;
        this.opacities[o + k] = opacity;
      }
      this.head++;
      this._dirty = true;
    }
    this.prev.set(key, { a: a.clone(), b: b.clone() });
  }

  break(key) { this.prev.delete(key); }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this._dirty) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aAge.needsUpdate = true;
      this.geometry.attributes.aOpacity.needsUpdate = true;
      this._dirty = false;
    }
  }
}

// ---------------------------------------------------------------------------
// CPU particle pool (smoke, sparks, dust)
// ---------------------------------------------------------------------------

export class ParticlePool {
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 700;
    this.positions = new Float32Array(this.max * 3);
    this.velocities = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.seed = new Float32Array(this.max);
    this.colors = new Float32Array(this.max * 3);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aMaxLife', new THREE.BufferAttribute(this.maxLife, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.uniforms = {
      tSprite: { value: opts.sprite ?? radialSprite(64, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)', 2.0) },
      uGrow: { value: opts.grow ?? 5.0 },
      uOpacity: { value: opts.opacity ?? 0.6 },
      uFadeIn: { value: opts.fadeIn ?? 0.12 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */`
        attribute float aLife, aMaxLife, aSize, aSeed;
        attribute vec3 aColor;
        uniform float uGrow;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;
        void main() {
          float t = 1.0 - clamp(aLife / max(aMaxLife, 0.001), 0.0, 1.0); // 0 new -> 1 dead
          vAlpha = aLife > 0.0 ? 1.0 : 0.0;
          vColor = aColor;
          vRot = aSeed * 6.283 + t * (aSeed - 0.5) * 4.0;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (aSize + t * uGrow) * (330.0 / dist);
          vAlpha *= (1.0 - t) * (1.0 - t);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tSprite;
        uniform float uOpacity;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vRot;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          uv = mat2(c, -s, s, c) * uv + 0.5;
          vec4 tex = texture2D(tSprite, uv);
          float a = tex.a * vAlpha * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * tex.rgb, a);
        }`,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    this.gravity = opts.gravity ?? 0;
    this.drag = opts.drag ?? 1.2;
  }

  spawn(pos, vel, life, size, color) {
    const i = this.cursor % this.max;
    this.cursor++;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.velocities[i * 3] = vel.x;
    this.velocities[i * 3 + 1] = vel.y;
    this.velocities[i * 3 + 2] = vel.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.seed[i] = Math.random();
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
  }

  update(dt) {
    const d = Math.max(0, 1 - this.drag * dt);
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      alive = true;
      this.life[i] -= dt;
      this.velocities[i * 3 + 1] += this.gravity * dt;
      this.velocities[i * 3] *= d;
      this.velocities[i * 3 + 1] *= d;
      this.velocities[i * 3 + 2] *= d;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }
    if (alive || this._wasAlive) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aLife.needsUpdate = true;
      this.geometry.attributes.aMaxLife.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aSeed.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
    }
    this._wasAlive = alive;
  }
}

// ---------------------------------------------------------------------------
// Nitro exhaust plume
// ---------------------------------------------------------------------------

export function createNitroPlume(color = 0x5fd8ff) {
  const geo = new THREE.ConeGeometry(0.28, 2.6, 12, 1, true);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -1.3);
  const uniforms = {
    uTime: { value: 0 },
    uPower: { value: 0 },
    uColorA: { value: new THREE.Color(color) },
    uColorB: { value: new THREE.Color(0xffffff) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uTime, uPower;
      varying vec2 vUv;
      varying float vLen;
      void main() {
        vUv = uv;
        vec3 p = position;
        float t = clamp(-p.z / 2.6, 0.0, 1.0);
        // The flame stretches with power and flickers along its length.
        p.z *= 0.35 + uPower * 1.5;
        float flick = sin(uTime * 42.0 + t * 12.0) * 0.06 + sin(uTime * 71.0) * 0.03;
        p.xy *= (1.0 - t * 0.55) * (0.5 + uPower * 0.9 + flick);
        vLen = t;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColorA, uColorB;
      uniform float uPower, uTime;
      varying vec2 vUv;
      varying float vLen;
      void main() {
        float core = smoothstep(1.0, 0.0, vLen);
        vec3 col = mix(uColorA, uColorB, pow(core, 2.5));
        float a = core * uPower * (0.75 + 0.25 * sin(uTime * 55.0 + vLen * 20.0));
        if (a < 0.01) discard;
        gl_FragColor = vec4(col * (1.0 + uPower), a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  return mesh;
}

// ---------------------------------------------------------------------------
// Speed lines
// ---------------------------------------------------------------------------

/** Camera-locked streak tunnel that fades in with velocity. */
export function createSpeedLines(count = 260) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const r = 3 + Math.random() * 12;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = -Math.random() * 60;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0xdff4ff) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime, uIntensity;
      varying float vA;
      void main() {
        vec3 p = position;
        p.z = mod(p.z + uTime * (40.0 + aSeed * 60.0) * (0.3 + uIntensity), 60.0) - 60.0;
        float radial = length(p.xy);
        vA = uIntensity * smoothstep(3.0, 9.0, radial) * (0.4 + aSeed * 0.6);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.2 + uIntensity * 3.0) * (60.0 / max(-mv.z, 1.0)) * 8.0;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vA;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        // Vertical streak rather than a dot.
        float d = smoothstep(0.5, 0.0, abs(uv.x) * 6.0) * smoothstep(0.5, 0.0, abs(uv.y));
        float a = d * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a * 0.5);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 20;
  points.userData.uniforms = uniforms;
  return points;
}

/** Smoke sprite: soft, slightly noisy puff. */
export function smokeSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // Break the perfect circle so puffs read as volume, not as discs.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * TAU;
    const r = 30 + Math.random() * 34;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const rad = 6 + Math.random() * 16;
    const gg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    gg.addColorStop(0, 'rgba(0,0,0,0.55)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
