// Scene dressing: rocks, aquatic weeds, sunken logs and the intake pipe.
import * as THREE from 'three';
import { heightAt, normalAt, shoreDistance, mulberry32, PIPE, START } from './terrain.js';
import { patchMaterial } from './optics.js';

// --- helpers -------------------------------------------------------------------
function hash3(i, j, k) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

function fbm3(x, y, z, oct) {
  let a = 0.5, s = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise3(x, y, z); x *= 2.1; y *= 2.1; z *= 2.1; a *= 0.5; }
  return s;
}

// Weld duplicated vertices of a non-indexed geometry so normals are smooth.
function weld(geo) {
  const src = geo.attributes.position;
  const map = new Map();
  const verts = [];
  const index = [];
  for (let i = 0; i < src.count; i++) {
    const key = `${src.getX(i).toFixed(5)},${src.getY(i).toFixed(5)},${src.getZ(i).toFixed(5)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(src.getX(i), src.getY(i), src.getZ(i));
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Plan-view collision shapes for the rover, filled while props are built.
// capsule: segment a-b with radius r (a circle when a = b); box: centre, unit axis, half extents.
const obstacles = [];
const capsule = (ax, az, bx, bz, r) => obstacles.push({ type: 'capsule', ax, az, bx, bz, r });

// --- rocks ---------------------------------------------------------------------
function makeRockGeometry(seed) {
  const r = mulberry32(seed);
  const geo = weld(new THREE.IcosahedronGeometry(1, 5));
  const p = geo.attributes.position;
  const o = [r() * 100, r() * 100, r() * 100];
  const sx = 0.8 + r() * 0.6, sy = 0.45 + r() * 0.4, sz = 0.75 + r() * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = fbm3(x * 1.2 + o[0], y * 1.2 + o[1], z * 1.2 + o[2], 4);
    const facet = Math.abs(vnoise3(x * 2.3 + o[1], y * 2.3, z * 2.3 + o[2]) - 0.5);
    const d = 0.72 + n * 0.6 - facet * 0.45;
    let yy = y * d * sy;
    if (yy < -0.22) yy = -0.22 + (yy + 0.22) * 0.25;
    p.setXYZ(i, x * d * sx, yy, z * d * sz);
  }
  geo.computeVertexNormals();
  return geo;
}

function createRocks(rand) {
  const material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), 'rock');
  const variants = 6;
  const geos = Array.from({ length: variants }, (_, i) => makeRockGeometry(101 + i * 17));
  const placements = Array.from({ length: variants }, () => []);

  const place = (x, z, scale) => {
    if (pipeClearance(x, z) < 3.5 + scale) return;
    if (scale > 0.35 && routeClearance(x, z) < 2.5 + scale) return;
    const y = heightAt(x, z);
    normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, _n.lerp(UP, 0.4).normalize());
    _q.multiply(new THREE.Quaternion().setFromEuler(_e.set((rand() - 0.5) * 0.4, rand() * Math.PI * 2, (rand() - 0.5) * 0.4)));
    _s.set(scale * (0.8 + rand() * 0.4), scale * (0.7 + rand() * 0.5), scale * (0.8 + rand() * 0.4));
    _p.set(x, y - 0.12 * scale, z);
    placements[Math.floor(rand() * variants)].push(new THREE.Matrix4().compose(_p.clone(), _q.clone(), _s.clone()));
    // Rocks standing higher than ~25 cm block the tracks; smaller ones are driven over.
    if (_s.y * 0.55 > 0.25) capsule(x, z, x, z, 0.8 * Math.max(_s.x, _s.z));
  };

  // Lake bed around the route, denser on the steep drop-off.
  for (let i = 0; i < 1000; i++) {
    const x = (rand() - 0.5) * 170, z = 20 - rand() * 90;
    const slope = 1 - normalAt(x, z, _n).y;
    if (rand() > 0.12 + slope * 3.0) continue;
    place(x, z, 0.12 + Math.pow(rand(), 3) * 1.3);
  }
  // Shoreline cobbles and boulders.
  for (let i = 0; i < 6000; i++) {
    const x = (rand() - 0.5) * 360, z = 40 - rand() * 280;
    const s = shoreDistance(x, z);
    if (Math.abs(s) > 12 || rand() > 0.35) continue;
    place(x, z, 0.15 + Math.pow(rand(), 4) * 1.6);
  }
  // Large erratic boulders.
  for (let i = 0; i < 40; i++) {
    const x = (rand() - 0.5) * 300, z = 60 - rand() * 200;
    place(x, z, 1.4 + rand() * 2.2);
  }

  const group = new THREE.Group();
  const color = new THREE.Color();
  placements.forEach((list, v) => {
    const mesh = new THREE.InstancedMesh(geos[v], material, list.length);
    list.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      const g = 0.75 + rand() * 0.35;
      mesh.setColorAt(i, color.setRGB(g, g * (0.96 + rand() * 0.04), g * (0.9 + rand() * 0.08)));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  });
  return group;
}

// Horizontal distance from (x, z) to the straight route between the start and the pipe mouth.
function routeClearance(x, z) {
  const ax = PIPE.mouth.x - START.x, az = PIPE.mouth.z - START.z;
  const t = Math.min(1, Math.max(0, ((x - START.x) * ax + (z - START.z) * az) / (ax * ax + az * az)));
  return Math.hypot(x - (START.x + ax * t), z - (START.z + az * t));
}

// Horizontal distance from (x, z) to the pipe axis, including the apron in front of the mouth.
function pipeClearance(x, z) {
  const ax = PIPE.end.x - PIPE.mouth.x, az = PIPE.end.z - PIPE.mouth.z;
  const len2 = ax * ax + az * az;
  const t = Math.min(1, Math.max(-14 / Math.sqrt(len2), ((x - PIPE.mouth.x) * ax + (z - PIPE.mouth.z) * az) / len2));
  return Math.hypot(x - (PIPE.mouth.x + ax * t), z - (PIPE.mouth.z + az * t));
}

// --- aquatic weeds ---------------------------------------------------------------
function makeTuftGeometry(rand) {
  const pos = [], nrm = [], idx = [];
  const blades = 7, seg = 6;
  for (let b = 0; b < blades; b++) {
    const ang = rand() * Math.PI * 2;
    const lean = 0.1 + rand() * 0.3;
    const h = 0.6 + rand() * 0.4;
    const w = 0.025 + rand() * 0.02;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const ox = (rand() - 0.5) * 0.15, oz = (rand() - 0.5) * 0.15;
    const base = pos.length / 3;
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const y = t * h;
      const off = lean * t * t;
      const cx = ox + dx * off, cz = oz + dz * off;
      const ww = w * (1 - t * 0.85);
      pos.push(cx - dz * ww, y, cz + dx * ww, cx + dz * ww, y, cz - dx * ww);
      nrm.push(dx, 0.3, dz, dx, 0.3, dz);
    }
    for (let s = 0; s < seg; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.normalizeNormals();
  return geo;
}

function createWeeds(rand) {
  const material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide }), 'weed');
  const list = [];
  for (let i = 0; i < 40000 && list.length < 2500; i++) {
    const x = (rand() - 0.5) * 180, z = 18 - rand() * 60;
    const y = heightAt(x, z);
    if (y > -0.8 || y < -9) continue;
    const cluster = fbm3(x * 0.08, 3.3, z * 0.08, 3);
    if (cluster < 0.52 + (rand() - 0.5) * 0.1) continue;
    if (pipeClearance(x, z) < 3) continue;
    const h = 0.5 + rand() * 1.1;
    _p.set(x, y - 0.03, z);
    _q.setFromEuler(_e.set(0, rand() * 6.28, 0));
    _s.set(1, h, 1);
    list.push(new THREE.Matrix4().compose(_p.clone(), _q.clone(), _s.clone()));
  }
  const mesh = new THREE.InstancedMesh(makeTuftGeometry(rand), material, list.length);
  const c = new THREE.Color();
  list.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    const g = 0.6 + rand() * 0.6;
    mesh.setColorAt(i, c.setRGB(0.09 * g, 0.15 * g, 0.045 * g));
  });
  mesh.computeBoundingSphere();
  return mesh;
}

// --- sunken logs -----------------------------------------------------------------
function createLogs(rand) {
  const material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), 'wood');
  const group = new THREE.Group();
  const spots = [[-10, -2], [14, -12], [-8, -20], [22, 4]];
  for (const [x, z] of spots) {
    const len = 4 + rand() * 5, r = 0.14 + rand() * 0.12;
    const geo = new THREE.CylinderGeometry(r * 0.8, r, len, 14, 1);
    const mesh = new THREE.Mesh(geo, material);
    const y = heightAt(x, z);
    mesh.position.set(x, y + r * 0.6, z);
    mesh.rotation.set((rand() - 0.5) * 0.1, rand() * Math.PI, Math.PI / 2, 'YXZ');
    mesh.updateMatrixWorld();
    const a = new THREE.Vector3(0, -len / 2, 0).applyMatrix4(mesh.matrixWorld);
    const b = new THREE.Vector3(0, len / 2, 0).applyMatrix4(mesh.matrixWorld);
    capsule(a.x, a.z, b.x, b.z, r);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// --- intake pipe -----------------------------------------------------------------
function createPipe() {
  const group = new THREE.Group();
  const { radius: R, wall, joints } = PIPE;
  const Ri = R - wall;
  const steel = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 }), 'pipe');
  const concrete = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), 'concrete');
  const orientAlong = (axis) => new THREE.Quaternion().setFromUnitVectors(UP, axis);
  const add = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh; };

  // Sections: lathe profiles along local +y, from the far joint towards the mouth.
  // The first section carries a bevelled lip; the others overlap slightly under the flanges.
  const b = 0.015;
  for (let i = 0; i < joints.length - 1; i++) {
    const axis = new THREE.Vector3().subVectors(joints[i], joints[i + 1]);
    const L = axis.length() + (i === 0 ? 0 : 0.05);
    axis.normalize();
    const prof = i === 0
      ? [[R, 0], [R, L - b], [R - b, L], [Ri + b, L], [Ri, L - b], [Ri, 0]]
      : [[R, 0], [R, L], [Ri, L], [Ri, 0]];
    const tube = add(new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 64), steel));
    tube.quaternion.copy(orientAlong(axis));
    tube.position.copy(joints[i + 1]);
  }

  // Flanges at the mouth and at every joint.
  const fr = R + 0.07;
  const flangeGeo = new THREE.LatheGeometry([
    [R - 0.005, -0.13], [fr, -0.11], [fr, 0.11], [R - 0.005, 0.13],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 64);
  const flanges = add(new THREE.InstancedMesh(flangeGeo, steel, joints.length - 1));
  flanges.setMatrixAt(0, _m.compose(_p.copy(joints[0]).addScaledVector(PIPE.dir, 0.3), orientAlong(PIPE.dir), _s.set(1, 1, 1)));
  for (let i = 1; i < joints.length - 1; i++) {
    const axis = new THREE.Vector3().subVectors(joints[i + 1], joints[i - 1]).normalize();
    flanges.setMatrixAt(i, _m.compose(joints[i], orientAlong(axis), _s.set(1, 1, 1)));
  }

  // Concrete saddles at mid-section, partly buried.
  const saddles = add(new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, 0.9, 0.7), concrete, joints.length - 1));
  for (let i = 0; i < joints.length - 1; i++) {
    const axis = new THREE.Vector3().subVectors(joints[i + 1], joints[i]);
    const q = new THREE.Quaternion().setFromEuler(_e.set(0, Math.atan2(axis.x, axis.z), 0));
    _p.copy(joints[i]).lerp(joints[i + 1], i === 0 ? 0.6 : 0.5);
    _p.y -= R * 0.72;
    saddles.setMatrixAt(i, _m.compose(_p, q, _s.set(1, 1, 1)));
  }

  // Headwall around the pipe, 1.6 m behind the mouth.
  const shape = new THREE.Shape();
  const bottom = -(R - PIPE.embed) - 1.0;
  shape.moveTo(-2.6, bottom); shape.lineTo(2.6, bottom); shape.lineTo(2.6, 1.9); shape.lineTo(-2.6, 1.9); shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, R + 0.03, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2, curveSegments: 48 });
  const headwall = add(new THREE.Mesh(wallGeo, concrete));
  headwall.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), PIPE.dir);
  headwall.position.copy(PIPE.mouth).addScaledVector(PIPE.dir, 1.6);

  const fl = R + 0.07;
  for (let i = 0; i < joints.length - 1; i++) capsule(joints[i].x, joints[i].z, joints[i + 1].x, joints[i + 1].z, fl);
  const axis = new THREE.Vector2(PIPE.dir.x, PIPE.dir.z).normalize();
  const c = PIPE.mouth.clone().addScaledVector(PIPE.dir, 1.1);   // headwall spans 0.6–1.6 m behind the mouth
  obstacles.push({ type: 'box', cx: c.x, cz: c.z, ux: axis.x, uz: axis.y, hl: 0.54, hw: 2.64 });

  return group;
}

export function createProps() {
  const rand = mulberry32(2026);
  const group = new THREE.Group();
  obstacles.length = 0;
  group.add(createRocks(rand), createWeeds(rand), createLogs(rand), createPipe());
  return { group, obstacles };
}
