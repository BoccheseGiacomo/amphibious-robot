// Input state and camera rigs: free observer and rover chase camera.
import * as THREE from 'three';

// Keyboard state shared by all controllers.
export const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
export const pressed = (...codes) => (codes.some((c) => keys.has(c)) ? 1 : 0);

// Mouse drag (any button) and wheel on an element.
export function onPointer(dom, { drag, wheel }) {
  let last = null;
  dom.addEventListener('mousedown', (e) => { last = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', () => { last = null; });
  window.addEventListener('mousemove', (e) => {
    if (!last) return;
    drag(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
  });
  dom.addEventListener('wheel', (e) => { e.preventDefault(); wheel(Math.sign(e.deltaY)); }, { passive: false });
}

// Free-flight observer with inertia.
export class FlyControls {
  constructor(camera, groundAt) {
    this.camera = camera;
    this.groundAt = groundAt;
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0035;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0035, -1.5, 1.5);
  }

  setPose(position, target) {
    this.camera.position.copy(position);
    const d = new THREE.Vector3().subVectors(target, position).normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.asin(d.y);
    this.vel.set(0, 0, 0);
    this.apply();
  }

  apply() {
    this.camera.quaternion.setFromEuler(this._euler.set(this.pitch, this.yaw, 0));
  }

  update(dt) {
    const turn = 1.6 * dt / 0.0035;
    this.look((pressed('ArrowRight') - pressed('ArrowLeft')) * turn, (pressed('ArrowDown') - pressed('ArrowUp')) * turn * 0.6);

    const f = pressed('KeyW') - pressed('KeyS');
    const s = pressed('KeyD') - pressed('KeyA');
    const u = pressed('KeyE', 'Space') - pressed('KeyQ', 'KeyC');
    const cp = Math.cos(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const dir = fwd.multiplyScalar(f).addScaledVector(right, s).add(new THREE.Vector3(0, u, 0));
    if (dir.lengthSq() > 1) dir.normalize();
    const under = this.camera.position.y < 0;
    const speed = (pressed('ShiftLeft', 'ShiftRight') ? 22 : 4) * (under ? 0.55 : 1);
    this.vel.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-dt * (under ? 2.0 : 3.5)));

    const p = this.camera.position.addScaledVector(this.vel, dt);
    const g = this.groundAt(p.x, p.z) + 0.35;
    if (p.y < g) { p.y = g; this.vel.y = Math.max(this.vel.y, 0); }
    this.apply();
  }
}

// Orbiting chase camera behind the rover. The orbit drifts back behind the rover while driving.
export class ChaseCamera {
  constructor(camera, groundAt) {
    this.camera = camera;
    this.groundAt = groundAt;
    this.yawOff = 0;
    this.pitch = 0.32;
    this.dist = 4.5;
    this.idle = 0;
    this.target = new THREE.Vector3();
  }

  orbit(dx, dy) {
    this.yawOff -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -0.15, 1.3);
    this.idle = 0;
  }

  zoom(s) { this.dist = THREE.MathUtils.clamp(this.dist * (s > 0 ? 1.12 : 1 / 1.12), 2.2, 14); }

  update(dt, rover, snap = false) {
    this.idle += dt;
    if (this.idle > 2 && Math.abs(rover.speed) > 0.1) this.yawOff *= Math.exp(-dt * 0.8);
    const yaw = rover.yaw + this.yawOff;
    const t = this.target.copy(rover.position).add(new THREE.Vector3(0, 0.45, 0));
    const want = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.dist).add(t);
    if (this.confine) this.confine(want, t);
    want.y = Math.max(want.y, this.groundAt(want.x, want.z) + 0.3);
    if (snap) this.camera.position.copy(want);
    else this.camera.position.lerp(want, 1 - Math.exp(-dt * 6));
    this.camera.lookAt(t);
  }
}
