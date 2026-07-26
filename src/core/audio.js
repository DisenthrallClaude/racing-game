// Procedural audio. No sample files — the engine, tyres, wind, nitro and UI
// tones are all synthesised with the Web Audio API, which keeps the build
// self-contained and lets the engine note track the physics continuously.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.masterVolume = 0.7;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    this.master.connect(comp).connect(ctx.destination);

    // --- shared noise buffer -------------------------------------------------
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    // --- engine: three detuned saws through a resonant low-pass --------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3.5;
    this.engineGain.connect(this.engineFilter).connect(this.master);

    this.oscs = [];
    for (const [type, mult, gain, detune] of [
      ['sawtooth', 1.0, 0.5, 0], ['sawtooth', 0.5, 0.36, -7],
      ['square', 2.0, 0.14, 9], ['sawtooth', 1.5, 0.18, 4],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(this.engineGain);
      o.start();
      this.oscs.push({ osc: o, mult });
    }

    // Intake/exhaust roar layer.
    this.engineNoise = ctx.createBufferSource();
    this.engineNoise.buffer = buf;
    this.engineNoise.loop = true;
    this.engineNoiseFilter = ctx.createBiquadFilter();
    this.engineNoiseFilter.type = 'bandpass';
    this.engineNoiseFilter.frequency.value = 260;
    this.engineNoiseFilter.Q.value = 1.1;
    this.engineNoiseGain = ctx.createGain();
    this.engineNoiseGain.gain.value = 0;
    this.engineNoise.connect(this.engineNoiseFilter).connect(this.engineNoiseGain).connect(this.master);
    this.engineNoise.start();

    // --- tyre scrub ----------------------------------------------------------
    this.skid = ctx.createBufferSource();
    this.skid.buffer = buf;
    this.skid.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1750;
    this.skidFilter.Q.value = 7;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skid.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    this.skid.start();

    // --- wind ---------------------------------------------------------------
    this.wind = ctx.createBufferSource();
    this.wind.buffer = buf;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.wind.start();

    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.masterVolume : 0;
  }

  /** Continuous update driven by the player's car state. */
  updateEngine(state) {
    if (!this.ready || !this.enabled) return;
    const now = this.ctx.currentTime;
    const { speed = 0, throttle = 0, boosting = false, drift = 0, offroad = false, airborne = false } = state;

    // Fake a gearbox: the note climbs, snaps back at each shift point.
    const norm = Math.min(speed / 80, 1.4);
    const gear = Math.min(5, Math.floor(norm * 5.2));
    const gearFrac = norm * 5.2 - gear;
    const rpm = 0.28 + gearFrac * 0.72;
    const base = 52 + rpm * 150 + (boosting ? 40 : 0);

    for (const { osc, mult } of this.oscs) {
      osc.frequency.setTargetAtTime(base * mult, now, 0.05);
    }
    const load = 0.16 + throttle * 0.30 + norm * 0.16 + (boosting ? 0.18 : 0);
    this.engineGain.gain.setTargetAtTime(airborne ? load * 0.7 : load, now, 0.07);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 2600 + (boosting ? 1800 : 0), now, 0.08);
    this.engineNoiseFilter.frequency.setTargetAtTime(180 + norm * 900, now, 0.1);
    this.engineNoiseGain.gain.setTargetAtTime(0.035 + norm * 0.07 + (offroad ? 0.11 : 0), now, 0.09);

    this.skidGain.gain.setTargetAtTime(Math.min(0.20, drift * 0.055), now, 0.06);
    this.skidFilter.frequency.setTargetAtTime(1400 + drift * 120, now, 0.08);

    this.windGain.gain.setTargetAtTime(Math.min(0.13, norm * 0.12), now, 0.15);
    this.windFilter.frequency.setTargetAtTime(320 + norm * 1400, now, 0.2);
  }

  _blip(freq, dur, type = 'sine', vol = 0.28, sweep = 0) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + sweep), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  _noiseBurst(dur, freq, q, vol, sweepTo) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, ctx.currentTime);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
  }

  countdownTick(n) {
    if (n > 0) this._blip(560, 0.22, 'square', 0.22);
    else this._blip(920, 0.6, 'square', 0.3, 240);
  }

  boost() {
    this._noiseBurst(0.85, 400, 1.2, 0.28, 4200);
    this._blip(180, 0.7, 'sawtooth', 0.18, 620);
  }

  driftBank(level) {
    this._blip(620 + level * 220, 0.24, 'triangle', 0.2, 260);
  }

  impact(force = 1) {
    this._noiseBurst(0.34, 220, 0.9, Math.min(0.45, 0.18 + force * 0.3), 70);
    this._blip(90, 0.28, 'square', 0.16 * force, -50);
  }

  land(force = 1) {
    this._noiseBurst(0.22, 160, 1.4, Math.min(0.3, 0.1 + force * 0.22), 60);
  }

  lap() {
    this._blip(760, 0.16, 'sine', 0.22);
    setTimeout(() => this._blip(1040, 0.24, 'sine', 0.22), 110);
  }

  finish() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => this._blip(f, 0.42, 'triangle', 0.26), i * 130));
  }

  uiClick() { this._blip(880, 0.07, 'square', 0.12); }
  uiHover() { this._blip(1320, 0.04, 'sine', 0.05); }
}
