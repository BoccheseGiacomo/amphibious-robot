// Deterministic height field of the lake basin and surrounding mountains.
// heightAt() is the single source of truth for rendering, prop placement and
// (later) rover contact. World units: metres, y up, water surface at y = 0.
import * as THREE from 'three';

export function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 2D simplex noise -------------------------------------------------------
const perm = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1, -1];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export function noise2(x, y) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = perm[ii + perm[jj]] & 7; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
  return 70 * n;
}

export function fbm(x, y, oct) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

// Value noise with analytic derivatives (quintic interpolation): [value, d/dx, d/dy], value in [-1, 1].
function hash2(i, j) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const _nd = [0, 0, 0];
function noised(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  _nd[0] = 2 * (a + k1 * ux + k2 * uy + k3 * ux * uy) - 1;
  _nd[1] = 2 * dux * (k1 + k3 * uy);
  _nd[2] = 2 * duy * (k2 + k3 * ux);
  return _nd;
}

// Erosion-like fBm: detail is damped where the accumulated slope is high, giving rounded
// summits, smooth valleys and branching gullies instead of noisy spikes.
function erodedFbm(x, y, oct) {
  let sum = 0, amp = 0.5, dx = 0, dy = 0;
  for (let i = 0; i < oct; i++) {
    const n = noised(x, y);
    dx += n[1]; dy += n[2];
    sum += amp * n[0] / (1 + dx * dx + dy * dy);
    amp *= 0.5;
    const nx = 1.6 * x - 1.2 * y, ny = 1.2 * x + 1.6 * y;   // rotate and double the frequency
    x = nx + 17.3; y = ny - 9.1;
  }
  return sum;
}

export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Lake basin ---------------------------------------------------------------
// Small elliptic mountain lake (~300 x 220 m); the playable shore is its southern edge (z ≈ 15).
const LAKE = { cx: 0, cz: -95, rx: 150, rz: 110 };

// Signed horizontal distance to the shoreline in metres (negative inside the lake).
export function shoreDistance(x, z) {
  const play = Math.exp(-(x * x + (z - 15) * (z - 15)) / (2 * 70 * 70));
  const k = 1 - 0.8 * play;
  const wx = x + k * fbm(x * 0.015, z * 0.015, 3) * 25;
  const wz = z + k * fbm(x * 0.015 + 31.7, z * 0.015 - 11.3, 3) * 25;
  const qx = (wx - LAKE.cx) / LAKE.rx, qz = (wz - LAKE.cz) / LAKE.rz;
  return (Math.hypot(qx, qz) - 1) * LAKE.rz;
}

function baseHeight(x, z) {
  const s = shoreDistance(x, z);
  if (s < 0) {
    const d = -s;
    // Beach shelf, littoral slope, drop-off to a ~10 m plateau, then the ~20 m basin.
    let h = -(2 * (1 - Math.exp(-d / 8)) + 3.5 * smooth(8, 24, d) + 4.5 * smooth(22, 42, d) + 9 * smooth(60, 115, d));
    h += fbm(x * 0.05, z * 0.05, 4) * 0.7 * smooth(4, 20, d);
    h += fbm(x * 0.2, z * 0.2, 2) * 0.12 * smooth(1, 6, d);
    return h;
  }
  // Meadow foothills, then eroded mountains rising to ~350 m above the lake.
  const hills = (fbm(x * 0.02, z * 0.02, 4) * 0.5 + 0.5) * 14 * smooth(10, 70, s);
  const mountains = (erodedFbm(x * 0.0022 + 3.1, z * 0.0022 - 7.7, 9) * 0.5 + 0.55) * 330 * smooth(60, 600, s);
  const detail = fbm(x * 0.2, z * 0.2, 2) * 0.12 * smooth(0, 6, s);
  return s * 0.09 + hills + mountains + smooth(0, 500, s) * 30 + detail;
}

// --- Submerged pipe -----------------------------------------------------------
// Intake pipe, straight in plan, laid in 12 m sections that follow a smoothed bed
// profile and are joined by flanges. Its open mouth faces the shore.
const PM = { x: 5, z: -28 };        // mouth (plan position)
const PE = { x: -20, z: -150 };     // far end, near the deepest part of the lake
const P_AX = PE.x - PM.x, P_AZ = PE.z - PM.z;
const P_LEN = Math.hypot(P_AX, P_AZ);
const NSEC = Math.round(P_LEN / 12);
const APRON = 10;                    // levelled area in front of the mouth (m)

const BED = (() => {
  let b = [];
  for (let i = 0; i <= NSEC; i++) b.push(baseHeight(PM.x + P_AX * i / NSEC, PM.z + P_AZ * i / NSEC));
  for (let pass = 0; pass < 6; pass++) {
    b = b.map((v, i) => (i === 0 || i === NSEC ? v : 0.25 * b[i - 1] + 0.5 * v + 0.25 * b[i + 1]));
  }
  return b;
})();

function bedAt(t) {
  const u = Math.min(1, Math.max(0, t)) * NSEC;
  const i = Math.min(NSEC - 1, Math.floor(u));
  return BED[i] + (BED[i + 1] - BED[i]) * (u - i);
}

const RADIUS = 0.9, EMBED = 0.25;
const JOINTS = BED.map((b, i) => new THREE.Vector3(PM.x + P_AX * i / NSEC, b + RADIUS - EMBED, PM.z + P_AZ * i / NSEC));

export const PIPE = {
  radius: RADIUS,
  wall: 0.07,
  embed: EMBED,
  joints: JOINTS,                                   // section ends, from the mouth outwards
  mouth: JOINTS[0],
  end: JOINTS[NSEC],
  dir: new THREE.Vector3().subVectors(JOINTS[1], JOINTS[0]).normalize(),   // into the pipe at the mouth
};

// Rover start on the beach. The straight route from here to the mouth is kept free
// of blocking rocks so a first drive is accessible.
export const START = { x: 2, z: 24 };

// Near the pipe the bed is filled up to its invert where the lake floor is lower,
// and sediment may bury it up to ~60 % of its diameter where the floor is higher.
// In front of the mouth the floor is levelled (approach apron).
export function heightAt(x, z) {
  const h = baseHeight(x, z);
  const t = ((x - PM.x) * P_AX + (z - PM.z) * P_AZ) / (P_LEN * P_LEN);
  if (t < -APRON / P_LEN - 0.08 || t > 1.05) return h;
  const tc = Math.min(1, Math.max(-APRON / P_LEN, t));
  const dist = Math.hypot(x - (PM.x + P_AX * tc), z - (PM.z + P_AZ * tc));
  const bed = bedAt(tc);
  const apron = smooth(-APRON / P_LEN, -2 / P_LEN, tc);   // 0 on the apron, 1 along the pipe
  const target = bed + apron * Math.min(Math.max(h - bed, 0), 1.1);
  const half = 3 + 2 * (1 - apron);
  const m = 1 - smooth(half, half * 2.8, dist);
  return h + (target - h) * m;
}

export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.25;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// --- Mesh ---------------------------------------------------------------------
// Separable grid: uniform 0.5 m cells over the play area, geometric growth outwards.
function axisCoords(center, halfInner, step, extent, outerCells) {
  const target = extent - halfInner;
  let lo = 1.0001, hi = 1.2;
  for (let k = 0; k < 60; k++) {
    const r = 0.5 * (lo + hi);
    const sum = step * r * (Math.pow(r, outerCells) - 1) / (r - 1);
    if (sum > target) hi = r; else lo = r;
  }
  const r = 0.5 * (lo + hi);
  const inner = [];
  const n = Math.round((2 * halfInner) / step);
  for (let i = 0; i <= n; i++) inner.push(-halfInner + i * step);
  const outer = [];
  let d = halfInner, s = step;
  for (let i = 0; i < outerCells; i++) { s *= r; d += s; outer.push(d); }
  return [...outer.map((v) => -v).reverse(), ...inner, ...outer].map((v) => v + center);
}

export function createTerrain(material) {
  const xs = axisCoords(0, 110, 0.5, 1100, 230);
  const zs = axisCoords(-40, 110, 0.5, 1100, 230);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      pos[k++] = x; pos[k++] = heightAt(x, z); pos[k++] = z;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(gridIndex(nx, 0, nx - 1, 0, nz - 1));
  geo.computeVertexNormals();

  // Tiles share the vertex buffers; each has its own index range and bounds, so the
  // renderer can skip tiles outside the view (most of the terrain under water or far away).
  const group = new THREE.Group();
  const T = 64;
  for (let j0 = 0; j0 < nz - 1; j0 += T) {
    for (let i0 = 0; i0 < nx - 1; i0 += T) {
      const i1 = Math.min(i0 + T, nx - 1), j1 = Math.min(j0 + T, nz - 1);
      const tile = new THREE.BufferGeometry();
      tile.setAttribute('position', geo.attributes.position);
      tile.setAttribute('normal', geo.attributes.normal);
      tile.setIndex(gridIndex(nx, i0, i1, j0, j1));
      const box = new THREE.Box3();
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i += Math.max(1, i1 - i0)) box.expandByPoint(new THREE.Vector3().fromArray(pos, (j * nx + i) * 3));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const y = pos[(j * nx + i) * 3 + 1];
        box.min.y = Math.min(box.min.y, y); box.max.y = Math.max(box.max.y, y);
      }
      tile.boundingBox = box;
      tile.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(tile, material);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

// Two triangles per grid cell for cells [i0, i1) x [j0, j1) of a grid nx wide.
function gridIndex(nx, i0, i1, j0, j1) {
  const idx = new Uint32Array((i1 - i0) * (j1 - j0) * 6);
  let k = 0;
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  return new THREE.BufferAttribute(idx, 1);
}
