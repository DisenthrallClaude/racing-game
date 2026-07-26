// Physically-motivated sky dome.
//
// Rayleigh + Mie single-scattering for the atmosphere, a raymarched cloud
// deck with Beer-Powder lighting, a procedural star field with a Milky Way
// band, and optional aurora curtains. One shader drives every time of day
// used by the game, so the sun's colour, the horizon gradient and the
// environment lighting all stay physically consistent with each other.

import * as THREE from 'three';

const skyVert = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const skyFrag = /* glsl */`
  precision highp float;

  varying vec3 vWorldPos;

  uniform vec3  uSunDir;
  uniform float uTurbidity;
  uniform float uRayleigh;
  uniform float uMieCoefficient;
  uniform float uMieG;
  uniform float uLuminance;
  uniform float uNight;          // 0 = day, 1 = night
  uniform float uTime;
  uniform vec3  uGroundColor;
  uniform vec3  uNightTint;
  uniform float uStarIntensity;
  uniform float uAurora;
  uniform float uCloudCover;     // 0 = clear, 1 = overcast
  uniform float uCloudHeight;
  uniform float uCloudSpeed;
  uniform vec3  uCloudTint;
  uniform vec3  uSunColor;
  uniform float uHorizonHaze;

  const float PI = 3.141592653589793;
  const vec3  UP = vec3(0.0, 1.0, 0.0);

  // --- Preetham-style constants ---------------------------------------------
  const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
  const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const float v = 4.0;
  const vec3 K = vec3(0.686, 0.678, 0.666);
  const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const float sunAngularDiameterCos = 0.999956676946448;
  const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
  const float ONE_OVER_FOURPI = 0.07957747154594767;

  float rayleighPhase(float cosTheta) {
    return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
  }
  float hgPhase(float cosTheta, float g) {
    float g2 = pow(g, 2.0);
    float inv = 1.0 / max(pow(1.0 - 2.0 * g * cosTheta + g2, 1.5), 1e-4);
    return ONE_OVER_FOURPI * ((1.0 - g2) * inv);
  }
  vec3 totalMie(float T) {
    float c = (0.2 * T) * 10E-18;
    return 0.434 * c * MieConst;
  }

  // --- hash / noise ----------------------------------------------------------
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0,0,0));
    float n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0));
    float n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1));
    float n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1));
    float n111 = hash13(i + vec3(1,1,1));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  float fbm3(vec3 p, const int octaves) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      s += a * noise3(p);
      n += a;
      a *= 0.5;
      p = p * 2.03 + vec3(11.3, 7.7, 3.1);
    }
    return s / n;
  }

  // Cloud density at a world position inside the deck. The shape-only variant
  // skips the erosion octaves and is what the light march uses: self
  // shadowing only needs the bulk form, and it keeps the raymarch affordable.
  float cloudShape(vec3 p, float thickness) {
    vec3 q = p * 0.00042;
    q.xz += uTime * uCloudSpeed * 0.0016;
    float d = fbm3(q, 3) - (1.0 - uCloudCover) * 0.62;
    float h = clamp(thickness, 0.0, 1.0);
    d *= smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.62, 1.0, h));
    return clamp(d * 3.2, 0.0, 1.0);
  }

  float cloudDensity(vec3 p, float thickness) {
    vec3 q = p * 0.00042;
    q.xz += uTime * uCloudSpeed * 0.0016;
    float base = fbm3(q, 3);
    // Erode with a higher-frequency layer to get billowed cauliflower edges.
    float detail = fbm3(q * 4.1 + vec3(0.0, uTime * 0.004, 0.0), 2);
    float d = base - (1.0 - uCloudCover) * 0.62 - detail * 0.22;
    float h = clamp(thickness, 0.0, 1.0);
    d *= smoothstep(0.0, 0.22, h) * (1.0 - smoothstep(0.62, 1.0, h));
    return clamp(d * 3.2, 0.0, 1.0);
  }

  vec4 renderClouds(vec3 dir, vec3 sunDir) {
    if (dir.y < 0.02 || uCloudCover <= 0.001) return vec4(0.0);
    float bottom = uCloudHeight;
    float top = uCloudHeight * 1.9;
    float tB = bottom / dir.y;
    float tT = top / dir.y;

    const int STEPS = 14;
    float dt = (tT - tB) / float(STEPS);
    vec3 pos = dir * tB;
    float transmittance = 1.0;
    vec3 scattered = vec3(0.0);

    float sunPow = max(dot(dir, sunDir), 0.0);
    float phase = mix(hgPhase(sunPow, 0.72), hgPhase(sunPow, -0.28), 0.42) * 12.0 + 0.35;
    float lightStep = (top - bottom) * 0.24;

    for (int i = 0; i < STEPS; i++) {
      float hNorm = float(i) / float(STEPS - 1);
      float dens = cloudDensity(pos, hNorm);
      if (dens > 0.004) {
        // 2-tap light march toward the sun for self shadowing.
        float shadow = cloudShape(pos + sunDir * lightStep, hNorm + 0.2)
                     + cloudShape(pos + sunDir * lightStep * 2.0, hNorm + 0.4);
        float lightT = exp(-shadow * 1.6);
        // Powder term: dense cores stay dark, edges glow.
        float powder = 1.0 - exp(-dens * 6.0);
        vec3 sunLight = uSunColor * (lightT * phase * powder);
        vec3 ambient = mix(uCloudTint * 0.42, uCloudTint * 0.9, hNorm);
        vec3 lum = (sunLight + ambient) * dens;
        float aT = exp(-dens * dt * 0.0045);
        scattered += lum * transmittance * (1.0 - aT);
        transmittance *= aT;
        if (transmittance < 0.03) break;
      }
      pos += dir * dt;
    }
    // Dissolve the deck into the haze near the horizon.
    float horizonFade = smoothstep(0.02, 0.18, dir.y);
    float alpha = (1.0 - transmittance) * horizonFade;
    return vec4(scattered * horizonFade, alpha);
  }

  vec3 renderStars(vec3 dir) {
    if (uStarIntensity <= 0.001) return vec3(0.0);
    vec3 col = vec3(0.0);
    // Three density octaves so bright stars sit among faint dust.
    for (int i = 0; i < 3; i++) {
      float scale = 260.0 * pow(2.3, float(i));
      vec3 g = floor(dir * scale);
      float h = hash13(g);
      float thresh = 0.9965 - float(i) * 0.0022;
      if (h > thresh) {
        vec3 c = fract(dir * scale) - 0.5;
        float d = length(c);
        float star = smoothstep(0.42, 0.0, d);
        float tw = 0.65 + 0.35 * sin(uTime * (1.6 + h * 7.0) + h * 40.0);
        float temp = hash13(g + 3.1);
        vec3 tint = mix(vec3(0.72, 0.82, 1.15), vec3(1.2, 0.92, 0.72), temp);
        col += star * tw * tint * (1.0 - float(i) * 0.25);
      }
    }
    // Milky Way: a soft, noisy band tilted across the dome.
    float band = dot(normalize(dir), normalize(vec3(0.42, 0.36, -0.83)));
    float mw = exp(-band * band * 22.0);
    float dust = fbm3(dir * 9.0, 4);
    col += mw * dust * dust * vec3(0.36, 0.40, 0.62) * 0.55;
    return col * uStarIntensity;
  }

  vec3 renderAurora(vec3 dir) {
    if (uAurora <= 0.001 || dir.y < 0.02) return vec3(0.0);
    vec3 col = vec3(0.0);
    // Project onto a high plane and draw vertical curtains from warped noise.
    float t = 1400.0 / max(dir.y, 0.05);
    vec3 p = dir * t;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 q = p.xz * 0.00055 + vec2(fi * 4.1, -fi * 2.7);
      float warp = fbm3(vec3(q * 1.7, uTime * 0.045 + fi), 3);
      float curtain = fbm3(vec3(q * vec2(3.4, 0.55) + warp * 1.3, uTime * 0.03), 4);
      float band = smoothstep(0.52, 0.78, curtain);
      // Vertical falloff makes each curtain fade upward like real aurora.
      float vert = smoothstep(0.03, 0.28, dir.y) * (1.0 - smoothstep(0.34, 0.9, dir.y));
      vec3 tint = mix(vec3(0.16, 1.0, 0.52), vec3(0.42, 0.35, 1.0), fi * 0.4);
      col += band * vert * tint * (0.5 - fi * 0.12);
    }
    return col * uAurora;
  }

  void main() {
    vec3 dir = normalize(vWorldPos - cameraPosition);
    vec3 sunDir = normalize(uSunDir);

    // --- atmospheric scattering ---
    float sunfade = 1.0 - clamp(1.0 - exp(sunDir.y), 0.0, 1.0);
    float rayleighCoefficient = uRayleigh - (1.0 * (1.0 - sunfade));
    vec3 betaR = totalRayleigh * rayleighCoefficient;
    vec3 betaM = totalMie(uTurbidity) * uMieCoefficient;

    // Clamp away from the exact horizon: at 90° the optical-depth term blows
    // up and the scattering integral degenerates, which is where this model
    // produces non-finite values.
    float cosZenith = max(dot(UP, dir), 0.045);
    float zenithAngle = acos(clamp(cosZenith, 0.0, 1.0));
    float inv = 1.0 / (cosZenith + 0.15 * pow(max(93.885 - ((zenithAngle * 180.0) / PI), 0.1), -1.253));
    float sR = rayleighZenithLength * inv;
    float sM = mieZenithLength * inv;
    vec3 Fex = exp(-(betaR * sR + betaM * sM));

    float cosTheta = dot(dir, sunDir);
    float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaRTheta = betaR * rPhase;
    float mPhase = hgPhase(cosTheta, uMieG);
    vec3 betaMTheta = betaM * mPhase;

    vec3 Lin = pow(uLuminance * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0),
               pow(uLuminance * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(0.5)),
               clamp(pow(1.0 - dot(UP, sunDir), 5.0), 0.0, 1.0));

    // --- sun disc with a soft limb and forward-scattered glow ---
    float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00004, cosTheta);
    vec3 L0 = vec3(0.1) * Fex;
    L0 += (uLuminance * 19000.0 * Fex) * sundisk;
    L0 += pow(max(cosTheta, 0.0), 180.0) * uSunColor * 4.0 * Fex;

    vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    // Scrub before anything mixes with it: a NaN here would survive every
    // subsequent mix() (NaN * 0 is still NaN), blacken the horizon, and then
    // spread through the bloom pyramid into the whole frame.
    vec3 sky = vec3(texColor.r == texColor.r ? texColor.r : 0.0,
                    texColor.g == texColor.g ? texColor.g : 0.0,
                    texColor.b == texColor.b ? texColor.b : 0.0);
    sky = clamp(sky, vec3(0.0), vec3(60.0));

    // --- night: dim the scattering and blend in stars + aurora ---
    vec3 night = uNightTint * (0.9 + 0.35 * smoothstep(0.6, -0.1, dir.y));
    night += renderStars(dir);
    night += renderAurora(dir);
    sky = mix(sky, night + sky * 0.16, uNight);

    // --- horizon haze band ---
    float hz = 1.0 - smoothstep(-0.02, 0.30, dir.y);
    vec3 hazeCol = mix(uCloudTint, uSunColor, 0.35) * uHorizonHaze;
    sky = mix(sky, hazeCol, hz * 0.55 * uHorizonHaze);

    // --- ground hemisphere ---
    float below = smoothstep(0.02, -0.06, dir.y);
    sky = mix(sky, uGroundColor, below);

    // --- clouds composited on top ---
    vec4 clouds = renderClouds(dir, sunDir);
    sky = mix(sky, clouds.rgb, clouds.a);

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export class Sky {
  constructor(scene) {
    this.geometry = new THREE.SphereGeometry(9500, 64, 40);
    this.material = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.3, 0.28, -0.9).normalize() },
        uTurbidity: { value: 3.2 },
        uRayleigh: { value: 2.2 },
        uMieCoefficient: { value: 0.006 },
        uMieG: { value: 0.82 },
        uLuminance: { value: 1.0 },
        uNight: { value: 0.0 },
        uTime: { value: 0.0 },
        uGroundColor: { value: new THREE.Color(0x2a2d31) },
        uNightTint: { value: new THREE.Color(0x05070f) },
        uStarIntensity: { value: 0.0 },
        uAurora: { value: 0.0 },
        uCloudCover: { value: 0.5 },
        uCloudHeight: { value: 900 },
        uCloudSpeed: { value: 1.0 },
        uCloudTint: { value: new THREE.Color(0xbfd0e8) },
        uSunColor: { value: new THREE.Color(0xfff0d8) },
        uHorizonHaze: { value: 0.5 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Drawn last in the opaque queue and depth-tested, so the expensive
    // atmosphere and cloud raymarch only shade pixels the terrain and
    // buildings did not already cover.
    this.mesh.renderOrder = 900;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    this.scene = scene;
  }

  configure(cfg) {
    const u = this.material.uniforms;
    if (cfg.sunDir) u.uSunDir.value.copy(cfg.sunDir).normalize();
    if (cfg.turbidity !== undefined) u.uTurbidity.value = cfg.turbidity;
    if (cfg.rayleigh !== undefined) u.uRayleigh.value = cfg.rayleigh;
    if (cfg.mie !== undefined) u.uMieCoefficient.value = cfg.mie;
    if (cfg.mieG !== undefined) u.uMieG.value = cfg.mieG;
    if (cfg.luminance !== undefined) u.uLuminance.value = cfg.luminance;
    if (cfg.night !== undefined) u.uNight.value = cfg.night;
    if (cfg.groundColor !== undefined) u.uGroundColor.value.set(cfg.groundColor);
    if (cfg.nightTint !== undefined) u.uNightTint.value.set(cfg.nightTint);
    if (cfg.stars !== undefined) u.uStarIntensity.value = cfg.stars;
    if (cfg.aurora !== undefined) u.uAurora.value = cfg.aurora;
    if (cfg.cloudCover !== undefined) u.uCloudCover.value = cfg.cloudCover;
    if (cfg.cloudHeight !== undefined) u.uCloudHeight.value = cfg.cloudHeight;
    if (cfg.cloudSpeed !== undefined) u.uCloudSpeed.value = cfg.cloudSpeed;
    if (cfg.cloudTint !== undefined) u.uCloudTint.value.set(cfg.cloudTint);
    if (cfg.sunColor !== undefined) u.uSunColor.value.set(cfg.sunColor);
    if (cfg.horizonHaze !== undefined) u.uHorizonHaze.value = cfg.horizonHaze;
  }

  get sunDirection() { return this.material.uniforms.uSunDir.value; }

  update(dt) {
    this.material.uniforms.uTime.value += dt;
  }

  /**
   * Bake the current sky into a prefiltered environment map so every PBR
   * material in the scene receives correct image-based lighting.
   */
  generateEnvironment(pmrem) {
    const tmp = new THREE.Scene();
    const clone = new THREE.Mesh(this.geometry, this.material);
    clone.frustumCulled = false;
    tmp.add(clone);
    const rt = pmrem.fromScene(tmp, 0, 1, 20000);
    tmp.remove(clone);
    return rt.texture;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
