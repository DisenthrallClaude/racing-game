// Renderer + HDR post-processing stack.
//
// Pipeline: scene -> HDR linear buffer -> [bright pass -> 4-level separable
// Gaussian pyramid] -> cinematic composite (bloom, radial speed blur,
// chromatic aberration, boost heat-haze, vignette, filmic grain, grade)
// -> SMAA -> ACES tonemap.
//
// Bloom is generated and composited inside a single pass rather than blended
// back into the scene buffer in place: one less full-screen blend, no
// read-modify-write on the buffer we are about to sample, and the bloom
// texture stays available to the grade so highlights can be tinted.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A single non-finite texel anywhere in the HDR buffer would spread through
// the blur and then poison the whole frame (NaN * 0 is still NaN, and a NaN
// written to the framebuffer reads as black). Scrub it at the point the bloom
// pyramid is seeded, and clamp the range so nothing can overflow half-float
// on the way down the mips.
const SANITIZE = /* glsl */`
  vec3 sanitize(vec3 c) {
    // NaN is the only value that is not equal to itself.
    c = vec3(c.r == c.r ? c.r : 0.0,
             c.g == c.g ? c.g : 0.0,
             c.b == c.b ? c.b : 0.0);
    return clamp(c, vec3(0.0), vec3(64.0));
  }
`;

const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  ${SANITIZE}
  void main() {
    vec3 c = sanitize(texture2D(tDiffuse, vUv).rgb);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee so highlights ramp into the bloom instead of popping.
    float w = smoothstep(uThreshold, uThreshold + uKnee, l);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uDirection;   // texel-sized step, horizontal or vertical
  varying vec2 vUv;
  void main() {
    // 9-tap Gaussian, sigma ~2.4, folded to 5 weighted samples.
    const float w0 = 0.227027;
    const float w1 = 0.194594;
    const float w2 = 0.121621;
    const float w3 = 0.054054;
    const float w4 = 0.016216;
    vec3 c = texture2D(tDiffuse, vUv).rgb * w0;
    c += texture2D(tDiffuse, vUv + uDirection * 1.0).rgb * w1;
    c += texture2D(tDiffuse, vUv - uDirection * 1.0).rgb * w1;
    c += texture2D(tDiffuse, vUv + uDirection * 2.0).rgb * w2;
    c += texture2D(tDiffuse, vUv - uDirection * 2.0).rgb * w2;
    c += texture2D(tDiffuse, vUv + uDirection * 3.0).rgb * w3;
    c += texture2D(tDiffuse, vUv - uDirection * 3.0).rgb * w3;
    c += texture2D(tDiffuse, vUv + uDirection * 4.0).rgb * w4;
    c += texture2D(tDiffuse, vUv - uDirection * 4.0).rgb * w4;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const COPY_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
`;

const CINEMATIC_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom0;
  uniform sampler2D tBloom1;
  uniform sampler2D tBloom2;
  uniform sampler2D tBloom3;
  uniform float uBloom;
  uniform float uTime, uSpeed, uBoost, uAspect, uVignette, uGrain;
  uniform float uSaturation, uContrast, uDamage;
  uniform float uDebug;
  uniform vec3 uLift, uGain;
  varying vec2 vUv;
  ${SANITIZE}

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  vec3 bloomAt(vec2 uv) {
    // Widest mips carry the most weight, which is what gives the glow its
    // soft, wide falloff instead of a hard halo.
    return texture2D(tBloom0, uv).rgb * 0.32
         + texture2D(tBloom1, uv).rgb * 0.27
         + texture2D(tBloom2, uv).rgb * 0.23
         + texture2D(tBloom3, uv).rgb * 0.18;
  }

  void main() {
    // Debug taps, used by the render-pipeline probe in .dev/.
    if (uDebug > 0.5) {
      if (uDebug < 1.5) { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }
      if (uDebug < 2.5) { gl_FragColor = vec4(bloomAt(vUv), 1.0); return; }
      gl_FragColor = vec4(sanitize(texture2D(tDiffuse, vUv).rgb), 1.0); return;
    }
    vec2 uv = vUv;
    vec2 center = vec2(0.5, 0.5);
    vec2 dir = uv - center;
    float dist = length(dir * vec2(uAspect, 1.0));

    // --- boost heat-haze: refract the frame with animated noise near edges
    if (uBoost > 0.001) {
      float w = sin((uv.y * 42.0) + uTime * 18.0) * cos((uv.x * 31.0) - uTime * 13.0);
      uv += dir * w * 0.0016 * uBoost * smoothstep(0.1, 0.7, dist);
    }

    // --- radial speed streaks, strength ramps with velocity and distance
    float streak = uSpeed * smoothstep(0.08, 0.85, dist);
    vec3 col = vec3(0.0);
    float wsum = 0.0;
    const int SAMPLES = 10;
    for (int i = 0; i < SAMPLES; i++) {
      float t = float(i) / float(SAMPLES - 1);
      float scale = 1.0 - t * (0.055 * streak + 0.03 * uBoost * smoothstep(0.0, 0.9, dist));
      vec2 suv = center + dir * scale;
      // Per-channel offset gives the streaks a prismatic edge.
      float ca = (0.0022 * streak + 0.0035 * uBoost) * (1.0 - t);
      float w = 1.0 - t * 0.65;
      col.r += texture2D(tDiffuse, center + (suv - center) * (1.0 + ca)).r * w;
      col.g += texture2D(tDiffuse, suv).g * w;
      col.b += texture2D(tDiffuse, center + (suv - center) * (1.0 - ca)).b * w;
      wsum += w;
    }
    col = sanitize(col / wsum);

    // --- bloom, added in linear light before the grade
    col += sanitize(bloomAt(uv)) * uBloom;

    // --- grade: lift / gain / contrast / saturation
    col = col * uGain + uLift;
    col = (col - 0.18) * uContrast + 0.18;
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, uSaturation);

    // --- boost tints the frame toward electric cyan-violet
    col = mix(col, col * vec3(0.82, 1.05, 1.35) + vec3(0.0, 0.02, 0.06), uBoost * 0.35);
    col = mix(col, col * vec3(1.6, 0.55, 0.45), uDamage * 0.5);

    // --- vignette + subtle corner desaturation, like a fast cine lens.
    // Kept gentle: a deep vignette reads as "under-lit" rather than cinematic
    // once the corners are carrying scenery.
    float vig = 1.0 - smoothstep(0.58, 1.45, dist);
    col *= mix(1.0, mix(0.52, 1.0, vig), uVignette);
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, mix(0.88, 1.0, vig));

    // --- animated film grain, finer in the highlights
    float g = hash(vUv * vec2(1024.0, 640.0) + fract(uTime) * 91.7) - 0.5;
    col += g * uGrain * (1.0 - clamp(luma, 0.0, 1.0) * 0.6);

    gl_FragColor = vec4(sanitize(col), 1.0);
  }
`;

const LEVELS = 4;

/** Bright-pass + Gaussian pyramid + cinematic composite, in one pass. */
export class CinematicPass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;

    const rt = (w, h) => {
      const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      t.texture.generateMipmaps = false;
      return t;
    };

    this.mips = [];
    for (let i = 0; i < LEVELS; i++) {
      const d = Math.pow(2, i + 1);
      this.mips.push({ a: rt(width / d, height / d), b: rt(width / d, height / d), div: d });
    }

    this.brightUniforms = {
      tDiffuse: { value: null },
      uThreshold: { value: 0.82 },
      uKnee: { value: 0.55 },
    };
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: this.brightUniforms, vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.blurUniforms = { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() } };
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: this.blurUniforms, vertexShader: FS_VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.copyUniforms = { tDiffuse: { value: null } };
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: this.copyUniforms, vertexShader: FS_VERT, fragmentShader: COPY_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.uniforms = {
      tDiffuse: { value: null },
      tBloom0: { value: this.mips[0].a.texture },
      tBloom1: { value: this.mips[1].a.texture },
      tBloom2: { value: this.mips[2].a.texture },
      tBloom3: { value: this.mips[3].a.texture },
      uBloom: { value: 0.62 },
      uTime: { value: 0 },
      uSpeed: { value: 0 },        // 0..1 normalised velocity -> radial streak
      uBoost: { value: 0 },        // 0..1 nitro -> haze + heavier aberration
      uAspect: { value: width / height },
      uVignette: { value: 1.0 },
      uGrain: { value: 0.035 },
      uSaturation: { value: 1.08 },
      uContrast: { value: 1.05 },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uDamage: { value: 0 },       // collision flash
      uDebug: { value: 0 },        // 0 normal, 1 raw input, 2 bloom only, 3 sanitised input
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: FS_VERT, fragmentShader: CINEMATIC_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.material);
    this.bloomRadius = 1.0;
  }

  setSize(width, height) {
    this.uniforms.uAspect.value = width / height;
    for (const m of this.mips) {
      m.a.setSize(Math.max(1, Math.floor(width / m.div)), Math.max(1, Math.floor(height / m.div)));
      m.b.setSize(Math.max(1, Math.floor(width / m.div)), Math.max(1, Math.floor(height / m.div)));
    }
  }

  _draw(renderer, material, target) {
    this.fsQuad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    this.fsQuad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1. bright pass into the first (half-res) mip
    this.brightUniforms.tDiffuse.value = readBuffer.texture;
    this._draw(renderer, this.brightMat, this.mips[0].a);

    // 2. successive downsample + separable blur
    for (let i = 0; i < LEVELS; i++) {
      const m = this.mips[i];
      if (i > 0) {
        this.copyUniforms.tDiffuse.value = this.mips[i - 1].a.texture;
        this._draw(renderer, this.copyMat, m.a);
      }
      const w = m.a.width, h = m.a.height;
      this.blurUniforms.tDiffuse.value = m.a.texture;
      this.blurUniforms.uDirection.value.set(this.bloomRadius / w, 0);
      this._draw(renderer, this.blurMat, m.b);

      this.blurUniforms.tDiffuse.value = m.b.texture;
      this.blurUniforms.uDirection.value.set(0, this.bloomRadius / h);
      this._draw(renderer, this.blurMat, m.a);
    }

    // 3. composite
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.fsQuad.material = this.material;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
    }
    this.fsQuad.render(renderer);

    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    for (const m of this.mips) { m.a.dispose(); m.b.dispose(); }
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.copyMat.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.35, 14000);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this._buildComposer();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this.quality = 'high';
  }

  _buildComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, 2);
    const target = new THREE.WebGLRenderTarget(w * pr, h * pr, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.cinematic = new CinematicPass(w * pr, h * pr);
    this.composer.addPass(this.cinematic);

    this.smaa = new SMAAPass(w * pr, h * pr);
    this.composer.addPass(this.smaa);

    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setQuality(q) {
    this.quality = q;
    const dpr = window.devicePixelRatio;
    if (q === 'low') {
      this.renderer.setPixelRatio(Math.min(dpr, 1));
      this.composer.setPixelRatio(Math.min(dpr, 1));
      this.smaa.enabled = false;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    } else if (q === 'medium') {
      this.renderer.setPixelRatio(Math.min(dpr, 1.35));
      this.composer.setPixelRatio(Math.min(dpr, 1.35));
      this.smaa.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    } else {
      this.renderer.setPixelRatio(Math.min(dpr, 2));
      this.composer.setPixelRatio(Math.min(dpr, 2));
      this.smaa.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.resize();
  }

  /** Apply a theme's colour grade / exposure / bloom profile. */
  applyGrade(grade = {}) {
    const u = this.cinematic.uniforms;
    this.renderer.toneMappingExposure = grade.exposure ?? 1.0;
    u.uBloom.value = grade.bloom ?? 0.62;
    this.cinematic.bloomRadius = grade.bloomRadius ? 0.7 + grade.bloomRadius : 1.4;
    this.cinematic.brightUniforms.uThreshold.value = grade.bloomThreshold ?? 0.82;
    u.uSaturation.value = grade.saturation ?? 1.08;
    u.uContrast.value = grade.contrast ?? 1.05;
    u.uVignette.value = grade.vignette ?? 1.0;
    u.uGrain.value = grade.grain ?? 0.035;
    if (grade.lift) u.uLift.value.set(...grade.lift);
    if (grade.gain) u.uGain.value.set(...grade.gain);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this.renderer.getPixelRatio();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.cinematic.setSize(w * pr, h * pr);
  }

  render(dt, state = {}) {
    const u = this.cinematic.uniforms;
    u.uTime.value += dt;
    u.uSpeed.value += ((state.speed01 ?? 0) - u.uSpeed.value) * Math.min(1, dt * 8);
    u.uBoost.value += ((state.boost01 ?? 0) - u.uBoost.value) * Math.min(1, dt * 10);
    u.uDamage.value = Math.max(0, u.uDamage.value - dt * 3.2);
    this.composer.render(dt);
  }

  flashDamage(amount = 1) {
    const u = this.cinematic.uniforms.uDamage;
    u.value = Math.min(1, u.value + amount);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
