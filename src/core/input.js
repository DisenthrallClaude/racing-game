// Input: keyboard, gamepad and on-screen touch controls, normalised into a
// single command object the vehicle understands.

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, drift: false, boost: false, look: 0 };
    this.touch = { left: false, right: false, gas: false, brake: false, drift: false, boost: false };
    this.enabled = true;
    this.onPause = null;
    this.onRestart = null;
    this.onCamera = null;

    this._keydown = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Escape') this.onPause?.();
      if (e.code === 'KeyR') this.onRestart?.();
      if (e.code === 'KeyC') this.onCamera?.();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._keyup = (e) => this.keys.delete(e.code);
    this._blur = () => this.keys.clear();

    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('blur', this._blur);

    this._bindTouch(dom);
  }

  _bindTouch(dom) {
    if (!dom) return;
    const bind = (id, prop) => {
      const el = dom.querySelector(id);
      if (!el) return;
      const on = (v) => (e) => { e.preventDefault(); this.touch[prop] = v; el.classList.toggle('active', v); };
      el.addEventListener('touchstart', on(true), { passive: false });
      el.addEventListener('touchend', on(false), { passive: false });
      el.addEventListener('touchcancel', on(false), { passive: false });
      el.addEventListener('mousedown', on(true));
      window.addEventListener('mouseup', on(false));
    };
    bind('#tc-left', 'left');
    bind('#tc-right', 'right');
    bind('#tc-gas', 'gas');
    bind('#tc-brake', 'brake');
    bind('#tc-drift', 'drift');
    bind('#tc-boost', 'boost');
  }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }

  sample() {
    const s = this.state;
    if (!this.enabled) {
      s.throttle = 0; s.brake = 0; s.steer = 0; s.drift = false; s.boost = false;
      return s;
    }
    let steer = 0;
    if (this.has('ArrowLeft', 'KeyA') || this.touch.left) steer -= 1;
    if (this.has('ArrowRight', 'KeyD') || this.touch.right) steer += 1;

    let throttle = (this.has('ArrowUp', 'KeyW') || this.touch.gas) ? 1 : 0;
    let brake = (this.has('ArrowDown', 'KeyS') || this.touch.brake) ? 1 : 0;
    let drift = this.has('ShiftLeft', 'ShiftRight') || this.touch.drift;
    let boost = this.has('Space') || this.touch.boost;

    // Gamepad overrides when a stick or trigger is actually being used.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = ax;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05) throttle = rt;
      if (lt > 0.05) brake = lt;
      if (pad.buttons[0]?.pressed) boost = true;
      if (pad.buttons[1]?.pressed || pad.buttons[5]?.pressed) drift = true;
      break;
    }

    s.throttle = throttle;
    s.brake = brake;
    s.steer = Math.max(-1, Math.min(1, steer));
    s.drift = drift;
    s.boost = boost;
    return s;
  }

  dispose() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('blur', this._blur);
  }
}
