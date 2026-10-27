// Free-flight observer camera with inertia (environment preview, no rover yet).
import * as THREE from 'three';

export class FlyControls {
  constructor(camera, dom, groundAt) {
    this.camera = camera;
    this.dom = dom;
    this.groundAt = groundAt;
    this.yaw = 0;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.drag = null;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    dom.addEventListener('mousedown', (e) => { this.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mouseup', () => { this.drag = null; });
    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      this.look(e.clientX - this.drag.x, e.clientY - this.drag.y);
      this.drag.x = e.clientX; this.drag.y = e.clientY;
    });
    window.addEventListener('keydown', (e) => { this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.drag = null; });
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
    const k = this.keys;
    const on = (...codes) => (codes.some((c) => k.has(c)) ? 1 : 0);
    const turn = 1.6 * dt / 0.0035;
    this.look((on('ArrowRight') - on('ArrowLeft')) * turn, (on('ArrowDown') - on('ArrowUp')) * turn * 0.6);

    const f = on('KeyW') - on('KeyS');
    const s = on('KeyD') - on('KeyA');
    const u = on('KeyE', 'Space') - on('KeyQ', 'KeyC');
    const cp = Math.cos(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const dir = fwd.multiplyScalar(f).addScaledVector(right, s).add(new THREE.Vector3(0, u, 0));
    if (dir.lengthSq() > 1) dir.normalize();
    const under = this.camera.position.y < 0;
    const speed = (on('ShiftLeft', 'ShiftRight') ? 22 : 4) * (under ? 0.55 : 1);
    this.vel.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-dt * (under ? 2.0 : 3.5)));

    const p = this.camera.position.addScaledVector(this.vel, dt);
    const g = this.groundAt(p.x, p.z) + 0.35;
    if (p.y < g) { p.y = g; this.vel.y = Math.max(this.vel.y, 0); }
    this.apply();
  }
}
