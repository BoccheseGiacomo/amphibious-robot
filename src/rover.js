// Generic tracked inspection rover: geometry and ground/water dynamics.
// Parameters are plausible for a ~1 m class crawler; they are not data of a real machine.
import * as THREE from 'three';
import { heightAt } from './terrain.js';
import { optics, patchMaterial } from './optics.js';

export const ROVER = {
  mass: 120,          // kg
  volume: 0.08,       // m³ displaced when fully submerged -> 80 kg buoyancy, 40 kg apparent weight
  height: 0.55,       // m, track bottom to top of housing (immersion)
  refHeight: 0.3,     // m, depth/indicator reference: chassis centre above track bottom
  gauge: 0.64,        // m, distance between track centre lines
  contact: 0.8,       // m, track ground-contact length
  vmax: 1.4,          // m/s, track speed at full command
  motorForce: 350,    // N per track at stall
  motorGain: 1500,    // N per m/s of track speed error (proportional)
  motorInt: 6000,     // N per m of accumulated track speed error (integral: holds on slopes)
  mu: 0.6,            // track–bed friction coefficient
  muTurn: 0.45,       // skid-steer turning resistance coefficient
  rolling: 0.06,      // rolling resistance coefficient
  cdA: 0.32,          // m², frontal drag coefficient × area
  cdASide: 0.55,      // m², lateral
  addedMass: 0.5,     // fraction of displaced water mass added to inertia
  steer: 0.22,        // differential track command at full steering
  radius: 0.58,       // m, plan-view collision radius
  lamp: 2.5,          // lamp radiant intensity (scene units)
};
const RHO = 1000, G = 9.81, HZ = 120;

// --- geometry ----------------------------------------------------------------------
const TRACK_R = 0.13, TRACK_A = 0.39, TRACK_W = 0.17;
const TRACK_P = 4 * TRACK_A + 2 * Math.PI * TRACK_R;
const CLEATS = 30;

// Point on the track belt (rover frame, forward = -z) at arc length u from the rear of the bottom run.
function beltPoint(u) {
  u = ((u % TRACK_P) + TRACK_P) % TRACK_P;
  const A = TRACK_A, R = TRACK_R;
  let y, z, ny, nz;
  if (u < 2 * A) { z = -A + u; y = 0; ny = -1; nz = 0; }
  else if ((u -= 2 * A) < Math.PI * R) { const t = -Math.PI / 2 + u / R; z = A + R * Math.cos(t); y = R + R * Math.sin(t); ny = Math.sin(t); nz = Math.cos(t); }
  else if ((u -= Math.PI * R) < 2 * A) { z = A - u; y = 2 * R; ny = 1; nz = 0; }
  else { u -= 2 * A; const t = Math.PI / 2 + u / R; z = -A + R * Math.cos(t); y = R + R * Math.sin(t); ny = Math.sin(t); nz = Math.cos(t); }
  return { y: y + ny * 0.012, z: z + nz * 0.012, angle: Math.atan2(-nz, -ny) };
}

function buildModel() {
  const mat = (o, kind = 'plain') => patchMaterial(new THREE.MeshStandardMaterial(o), kind);
  const yellow = mat({ color: 0xd98a1e, roughness: 0.45, metalness: 0.1 });
  const rubber = mat({ color: 0x141414, roughness: 0.92 });
  const metal = mat({ color: 0x8a8d90, roughness: 0.4, metalness: 0.8 });
  const glass = mat({ color: 0x0b1015, roughness: 0.06 });
  const lens = mat({ color: 0x202020, emissive: 0xfff1dc, emissiveIntensity: 0 });

  const group = new THREE.Group();
  const add = (parent, geo, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Chassis and cylindrical electronics housing.
  add(group, new THREE.BoxGeometry(0.44, 0.2, 0.9), yellow, 0, 0.24, 0);
  add(group, new THREE.CylinderGeometry(0.13, 0.13, 0.72, 28).rotateX(Math.PI / 2), yellow, 0, 0.40, 0.03);
  for (const z of [-0.335, 0.395]) add(group, new THREE.CylinderGeometry(0.137, 0.137, 0.03, 28).rotateX(Math.PI / 2), metal, 0, 0.40, z);

  // Tracks: rubber belt body, moving cleats, sprocket hubs.
  const shape = new THREE.Shape();
  shape.moveTo(-TRACK_A, -TRACK_R);
  shape.lineTo(TRACK_A, -TRACK_R);
  shape.absarc(TRACK_A, 0, TRACK_R, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(-TRACK_A, TRACK_R);
  shape.absarc(-TRACK_A, 0, TRACK_R, Math.PI / 2, Math.PI * 1.5, false);
  const beltGeo = new THREE.ExtrudeGeometry(shape, { depth: TRACK_W, bevelEnabled: false, curveSegments: 16 })
    .translate(0, TRACK_R, -TRACK_W / 2).rotateY(Math.PI / 2);
  const cleatGeo = new THREE.BoxGeometry(TRACK_W + 0.01, 0.024, 0.035);
  const hubGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.02, 20).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.024, 0.17, 0.028);
  const cleats = [], hubs = [];
  for (const side of [-1, 1]) {
    const x = side * ROVER.gauge / 2;
    add(group, beltGeo, rubber, x, 0, 0);
    const c = new THREE.InstancedMesh(cleatGeo, rubber, CLEATS);
    c.castShadow = true;
    c.position.x = x;
    group.add(c);
    cleats.push(c);
    const sideHubs = [];
    for (const z of [-TRACK_A, TRACK_A]) {
      const hub = new THREE.Group();
      hub.position.set(x + side * (TRACK_W / 2 + 0.01), TRACK_R, z);
      add(hub, hubGeo, metal);
      add(hub, spokeGeo, metal, side * 0.012, 0, 0);
      group.add(hub);
      sideHubs.push(hub);
    }
    hubs.push(sideHubs);
  }

  // Pan-tilt camera head at the front.
  const pan = new THREE.Group();
  pan.position.set(0, 0.47, -0.36);
  group.add(pan);
  add(pan, new THREE.CylinderGeometry(0.03, 0.04, 0.1, 12), metal, 0, 0.03, 0);
  const tilt = new THREE.Group();
  tilt.position.y = 0.1;
  pan.add(tilt);
  add(tilt, new THREE.CylinderGeometry(0.06, 0.06, 0.15, 20).rotateX(Math.PI / 2), yellow);
  add(tilt, new THREE.SphereGeometry(0.058, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), glass, 0, 0, -0.075);
  const camAnchor = new THREE.Object3D();
  camAnchor.position.z = -0.14;
  tilt.add(camAnchor);

  // Two floodlights at the front corners, slightly toed out and tilted down.
  const lamps = [];
  for (const side of [-1, 1]) {
    const lamp = new THREE.Group();
    lamp.position.set(side * 0.17, 0.29, -0.45);
    lamp.rotation.set(-0.06, -side * 0.1, 0, 'YXZ');
    add(lamp, new THREE.CylinderGeometry(0.045, 0.05, 0.07, 16).rotateX(Math.PI / 2), metal);
    add(lamp, new THREE.CylinderGeometry(0.04, 0.04, 0.005, 16).rotateX(Math.PI / 2), lens, 0, 0, -0.036);
    group.add(lamp);
    lamps.push(lamp);
  }

  return { group, cleats, hubs, pan, tilt, camAnchor, lamps, lens };
}

// --- dynamics -------------------------------------------------------------------------
const clamp = THREE.MathUtils.clamp;

export class Rover {
  constructor(obstacles) {
    Object.assign(this, buildModel());
    this.obstacles = obstacles;
    this.position = new THREE.Vector3();   // track-bottom centre
    this.vel = new THREE.Vector2();        // plan velocity (x, z), m/s
    this.yaw = 0;                          // rad, 0 = facing -z, positive = turning left
    this.omega = 0;                        // rad/s
    this.belt = [0, 0];                    // belt travel (left, right), m
    this.integ = [0, 0];                   // speed controller integral state
    this.normal = new THREE.Vector3(0, 1, 0);
    this.quat = new THREE.Quaternion();
    this.speed = 0;                        // m/s along heading
    this.immersion = 0;
    this.lightsOn = false;
    this.panAngle = 0;
    this.tiltAngle = -0.12;
    this.acc = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  reset(x, z, yaw) {
    this.position.set(x, 0, z);
    this.vel.set(0, 0);
    this.yaw = yaw;
    this.omega = 0;
    this.integ = [0, 0];
    this.sampleGround();
    this.quat.copy(this.targetQuat());
    this.sync(0);
  }

  aim(dPan, dTilt) {
    this.panAngle = clamp(this.panAngle + dPan, -1.6, 1.6);
    this.tiltAngle = clamp(this.tiltAngle + dTilt, -1.0, 0.5);
  }

  // Ground contact: four corners of the track contact patches plus the centre.
  sampleGround() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const fx = -s, fz = -c, rx = c, rz = -s;
    const hl = ROVER.contact / 2, hg = ROVER.gauge / 2;
    const p = this.position;
    const h = (a, b) => heightAt(p.x + fx * a + rx * b, p.z + fz * a + rz * b);
    const fl = h(hl, -hg), fr = h(hl, hg), rl = h(-hl, -hg), rr = h(-hl, hg);
    const front = (fl + fr) / 2, rear = (rl + rr) / 2, left = (fl + rl) / 2, right = (fr + rr) / 2;
    p.y = Math.max((front + rear) / 2, heightAt(p.x, p.z));
    const tf = new THREE.Vector3(fx * ROVER.contact, front - rear, fz * ROVER.contact);
    const tr = new THREE.Vector3(rx * ROVER.gauge, right - left, rz * ROVER.gauge);
    this.normal.crossVectors(tr, tf).normalize();
    this._tr = tr.normalize();
  }

  targetQuat() {
    const Y = this.normal;
    const Z = new THREE.Vector3().crossVectors(this._tr, Y).normalize();
    const X = new THREE.Vector3().crossVectors(Y, Z);
    return this._q.setFromRotationMatrix(this._m.makeBasis(X, Y, Z));
  }

  update(dt, throttle, steer) {
    this.acc += dt;
    const h = 1 / HZ;
    let n = 0;
    while (this.acc >= h && n < 12) { this.step(h, throttle, steer); this.acc -= h; n++; }
    if (n === 12) this.acc = 0;
    this.sync(dt);
  }

  step(h, T, S) {
    const P = ROVER;
    this.sampleGround();
    const nrm = this.normal, p = this.position;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const fx = -s, fz = -c, rx = c, rz = -s;

    // Buoyancy reduces the load on the tracks; water adds drag and inertia.
    const imm = clamp(-p.y / P.height, 0, 1);
    const buoy = RHO * P.volume * imm;
    const mApp = P.mass - buoy;
    const mEff = P.mass + P.addedMass * buoy;
    const N = Math.max(0, mApp * G * nrm.y);
    const gx = mApp * G * nrm.y * nrm.x, gz = mApp * G * nrm.y * nrm.z;   // slope force (plan)

    let vL = this.vel.x * fx + this.vel.y * fz;
    let vT = this.vel.x * rx + this.vel.y * rz;
    const half = P.gauge / 2;

    // Track speed controllers, limited by motor force and by friction on the bed.
    const uL = clamp(T + S * P.steer, -1, 1) * P.vmax;
    const uR = clamp(T - S * P.steer, -1, 1) * P.vmax;
    const vl = vL - this.omega * half, vr = vL + this.omega * half;
    const lim = Math.min(P.motorForce, P.mu * N / 2);
    const track = (i, u, v) => {
      const e = u - v;
      const f = P.motorGain * e + P.motorInt * this.integ[i];
      if (Math.abs(f) < lim) this.integ[i] += e * h;        // anti-windup
      return clamp(f, -lim, lim);
    };
    const Fl = track(0, uL, vl);
    const Fr = track(1, uR, vr);

    // Longitudinal.
    const drag = 0.5 * RHO * P.cdA * imm * vL * Math.abs(vL);
    const roll = P.rolling * N * Math.tanh(vL / 0.05);
    vL += (Fl + Fr + gx * fx + gz * fz - drag - roll) / mEff * h;

    // Lateral: slope and water drag, cancelled by track friction up to mu·N.
    vT += (gx * rx + gz * rz - 0.5 * RHO * P.cdASide * imm * vT * Math.abs(vT)) / mEff * h;
    const jT = P.mu * N * h / mEff;
    vT += clamp(-vT, -jT, jT);

    // Yaw: differential thrust against skid-steer resistance.
    const I = mEff * (1.04 * 1.04 + 0.81 * 0.81) / 12;
    this.omega += ((Fr - Fl) * half - 40 * imm * this.omega * Math.abs(this.omega)) / I * h;
    const jW = P.muTurn * N * (P.contact / 4) * h / I;
    this.omega += clamp(-this.omega, -jW, jW);

    this.vel.set(vL * fx + vT * rx, vL * fz + vT * rz);
    p.x += this.vel.x * h;
    p.z += this.vel.y * h;
    this.yaw += this.omega * h;
    this.collide();

    // Belt travel: follows the ground when gripping, the command when slipping.
    this.belt[0] += (Math.abs(Fl) >= lim * 0.999 ? uL : vl) * h;
    this.belt[1] += (Math.abs(Fr) >= lim * 0.999 ? uR : vr) * h;
    this.speed = vL;
    this.immersion = imm;
  }

  collide() {
    const p = this.position, r0 = ROVER.radius;
    for (const o of this.obstacles) {
      let qx, qz;
      if (o.type === 'capsule') {
        const dx = o.bx - o.ax, dz = o.bz - o.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp(((p.x - o.ax) * dx + (p.z - o.az) * dz) / l2, 0, 1) : 0;
        qx = o.ax + dx * t; qz = o.az + dz * t;
      } else {
        const dx = p.x - o.cx, dz = p.z - o.cz;
        let a = dx * o.ux + dz * o.uz, b = -dx * o.uz + dz * o.ux;
        if (Math.abs(a) < o.hl && Math.abs(b) < o.hw) {     // centre inside: exit through nearest face
          if (o.hl - Math.abs(a) < o.hw - Math.abs(b)) a = Math.sign(a) * o.hl; else b = Math.sign(b) * o.hw;
        } else { a = clamp(a, -o.hl, o.hl); b = clamp(b, -o.hw, o.hw); }
        qx = o.cx + a * o.ux - b * o.uz; qz = o.cz + a * o.uz + b * o.ux;
      }
      const r = r0 + (o.r || 0);
      const ex = p.x - qx, ez = p.z - qz;
      const d = Math.hypot(ex, ez);
      if (d >= r || d < 1e-6) continue;
      const nx = ex / d, nz = ez / d;
      p.x = qx + nx * r; p.z = qz + nz * r;
      const vn = this.vel.x * nx + this.vel.y * nz;
      if (vn < 0) { this.vel.x -= vn * nx; this.vel.y -= vn * nz; }
      this.omega *= 0.9;
    }
  }

  // Pose, belt animation, camera head and lamps.
  sync(dt) {
    this.group.position.copy(this.position);
    this.quat.slerp(this.targetQuat(), dt > 0 ? 1 - Math.exp(-dt * 15) : 1);
    this.group.quaternion.copy(this.quat);

    const m = this._m, q = this._q, e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < CLEATS; i++) {
        const b = beltPoint(i * TRACK_P / CLEATS + this.belt[side]);
        this.cleats[side].setMatrixAt(i, m.compose(v.set(0, b.y, b.z), q.setFromEuler(e.set(b.angle, 0, 0)), one));
      }
      this.cleats[side].instanceMatrix.needsUpdate = true;
      for (const hub of this.hubs[side]) hub.rotation.x = -this.belt[side] / TRACK_R;
    }
    this.pan.rotation.y = this.panAngle;
    this.tilt.rotation.x = this.tiltAngle;
    this.group.updateMatrixWorld(true);

    const on = this.lightsOn;
    this.lens.emissiveIntensity = on ? 12 : 0;
    optics.uLampColor.value.set(1.0, 0.95, 0.86).multiplyScalar(on ? ROVER.lamp : 0);
    this.lamps.forEach((lamp, i) => {
      lamp.getWorldPosition(optics.uLampPos.value[i]);
      optics.uLampDir.value[i].set(0, 0, -1).transformDirection(lamp.matrixWorld);
      optics.uLampPos.value[i].addScaledVector(optics.uLampDir.value[i], 0.05);
    });
  }

  // Indicators, all derived from the simulated state.
  get depth() { return Math.max(0, -(this.position.y + ROVER.refHeight)); }
  get heading() { return ((-THREE.MathUtils.radToDeg(this.yaw) % 360) + 360) % 360; }
  get pitch() { return THREE.MathUtils.radToDeg(Math.asin(clamp(new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat).y, -1, 1))); }
  get roll() { return THREE.MathUtils.radToDeg(Math.asin(clamp(new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat).y, -1, 1))); }
}
