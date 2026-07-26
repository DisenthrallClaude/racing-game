// Chase camera.
//
// Spring-follows the car with a velocity-aware look-ahead, leans into drifts,
// widens its field of view with speed and adds impact shake — the three tricks
// that make an arcade racer feel fast without actually being faster.

import * as THREE from 'three';
import { clamp, smoothstep } from '../util/noise.js';

const _heading = new THREE.Vector3();
const _right = new THREE.Vector3();
const _target = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

export const CAMERA_MODES = ['chase', 'close', 'hood', 'cinematic'];

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.shake = 0;
    this.shakeSeed = Math.random() * 100;
    this.baseFov = 62;
    this.fov = 62;
    this.lateralLean = 0;
    this.initialised = false;
    this.orbitAngle = 0;
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.initialised = false;
    return this.mode;
  }

  addShake(v) { this.shake = clamp(this.shake + v, 0, 1.4); }

  /** Slow orbit used on the menu and the pre-race flyby. */
  orbit(dt, target, radius = 16, height = 5) {
    this.orbitAngle += dt * 0.16;
    this.camera.position.set(
      target.x + Math.cos(this.orbitAngle) * radius,
      target.y + height,
      target.z + Math.sin(this.orbitAngle) * radius,
    );
    this.camera.lookAt(target.x, target.y + 0.9, target.z);
    this.camera.fov += (58 - this.camera.fov) * Math.min(1, dt * 2);
    this.camera.updateProjectionMatrix();
  }

  update(dt, vehicle, opts = {}) {
    const speed = vehicle.speed;
    const speed01 = clamp(speed / 78, 0, 1.25);
    const boosting = vehicle.boostTimer > 0;

    const heading = _heading.set(Math.sin(vehicle.yaw), 0, Math.cos(vehicle.yaw));
    const right = _right.set(Math.cos(vehicle.yaw), 0, -Math.sin(vehicle.yaw));

    let dist, height, lookAhead, lookHeight;
    switch (this.mode) {
      case 'close': dist = 5.4; height = 2.0; lookAhead = 9; lookHeight = 1.1; break;
      case 'hood': dist = -0.4; height = 1.25; lookAhead = 14; lookHeight = 1.2; break;
      case 'cinematic': dist = 11.5; height = 1.6; lookAhead = 16; lookHeight = 1.4; break;
      default: dist = 8.2; height = 3.15; lookAhead = 11; lookHeight = 1.35;
    }
    // Pull back and drop as speed builds — reads as the world rushing at you.
    dist += speed01 * 2.6 + (boosting ? 1.6 : 0);
    height += speed01 * 0.35;

    // Drift lean: swing the camera toward the outside of the slide.
    const slideDir = vehicle.drifting ? -vehicle.driftDir : 0;
    const targetLean = slideDir * 0.55 * clamp(vehicle.driftTime * 1.6, 0, 1);
    this.lateralLean += (targetLean - this.lateralLean) * Math.min(1, dt * 4.0);

    const target = _target.copy(vehicle.position)
      .addScaledVector(heading, -dist)
      .addScaledVector(right, this.lateralLean * 2.4);
    target.y += height;

    // Keep the camera above the ground so it never clips through a hill.
    if (opts.groundAt) {
      const g = opts.groundAt(target.x, target.z);
      target.y = Math.max(target.y, g + 1.6);
    }

    if (!this.initialised) {
      this.pos.copy(target);
      this.initialised = true;
    }
    // Stiffer spring at speed keeps the car centred through fast corners.
    const follow = this.mode === 'hood' ? 30 : (7.5 + speed01 * 7.0);
    this.pos.lerp(target, Math.min(1, dt * follow));

    const lookTarget = _lookTarget.copy(vehicle.position)
      .addScaledVector(heading, lookAhead + speed01 * 6)
      .addScaledVector(right, this.lateralLean * -3.2);
    lookTarget.y += lookHeight;
    this.look.lerp(lookTarget, Math.min(1, dt * 9));

    this.camera.position.copy(this.pos);

    // Shake: decays fast, driven by impacts, landings and offroad rumble.
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const rumble = vehicle.offroad && vehicle.grounded ? clamp(speed / 60, 0, 1) * 0.22 : 0;
    const amp = (this.shake + rumble) * 0.32;
    if (amp > 0.001) {
      const t = performance.now() * 0.001;
      this.camera.position.x += Math.sin(t * 47 + this.shakeSeed) * amp;
      this.camera.position.y += Math.sin(t * 61 + this.shakeSeed * 2) * amp * 0.8;
      this.camera.position.z += Math.sin(t * 53 + this.shakeSeed * 3) * amp;
    }

    this.camera.lookAt(this.look);
    // Roll the camera slightly with the road bank and the drift.
    const bankRoll = (vehicle.surf?.bank ?? 0) * 0.35;
    this.camera.rotateZ(this.lateralLean * 0.08 + bankRoll);

    const targetFov = this.baseFov + speed01 * 13 + (boosting ? 9 : 0) + (vehicle.drifting ? 3 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3.4);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
