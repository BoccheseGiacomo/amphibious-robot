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

function ridged(x, y, oct) {
  let a = 0.5, f = 1, s = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise2(x * f + i * 7.3, y * f - i * 3.1));
    n *= n * w;
    w = Math.min(1, n * 2);
    s += n * a;
    f *= 2.1; a *= 0.5;
  }
  return s;
}

export const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Lake basin ---------------------------------------------------------------
// Elliptic lake; the playable shore is the southern edge near the origin (z ≈ 30).
const LAKE = { cx: 0, cz: -650, rx: 1100, rz: 680 };

// Signed horizontal distance to the shoreline in metres (negative inside the lake).
export function shoreDistance(x, z) {
  const play = Math.exp(-(x * x + (z - 30) * (z - 30)) / (2 * 200 * 200));
  const k = 1 - 0.85 * play;
  const wx = x + k * fbm(x * 0.0021, z * 0.0021, 3) * 170;
  const wz = z + k * fbm(x * 0.0021 + 31.7, z * 0.0021 - 11.3, 3) * 170;
  const qx = (wx - LAKE.cx) / LAKE.rx, qz = (wz - LAKE.cz) / LAKE.rz;
  return (Math.hypot(qx, qz) - 1) * LAKE.rz;
}

function baseHeight(x, z) {
  const s = shoreDistance(x, z);
  if (s < 0) {
    const d = -s;
    // Beach shelf, littoral slope, drop-off to a ~19 m plateau, then the deep basin.
    let h = -(8 * (1 - Math.exp(-d / 45)) + 11 * smooth(60, 135, d) + 25 * smooth(230, 650, d));
    h += fbm(x * 0.012, z * 0.012, 4) * 2.2 * smooth(8, 60, d);
    h += fbm(x * 0.07, z * 0.07, 2) * 0.25 * smooth(2, 12, d);
    return h;
  }
  // Forested foothills, then rounded prealpine massifs with occasional rocky crests.
  const hills = (fbm(x * 0.0035, z * 0.0035, 5) * 0.5 + 0.5) * 120 * smooth(25, 500, s);
  const massif = (fbm(x * 0.0006 + 5.2, z * 0.0006 - 1.7, 5) * 0.5 + 0.5) * 850 * smooth(350, 2800, s);
  const crest = Math.pow(ridged(x * 0.00038, z * 0.00038, 5), 2.0) * 750 * smooth(1000, 3800, s);
  const detail = fbm(x * 0.07, z * 0.07, 2) * 0.25 * smooth(0, 10, s);
  return s * 0.07 + hills + massif + crest + smooth(0, 2500, s) * 220 + detail;
}

// --- Submerged pipe -----------------------------------------------------------
// Intake pipe, straight in plan, laid in 12 m sections that follow a smoothed bed
// profile and are joined by flanges. Its open mouth faces the shore.
const PM = { x: 8, z: -118 };       // mouth (plan position)
const PE = { x: -60, z: -430 };     // far end
const P_AX = PE.x - PM.x, P_AZ = PE.z - PM.z;
const P_LEN = Math.hypot(P_AX, P_AZ);
const NSEC = Math.round(P_LEN / 12);
const APRON = 14;                    // levelled area in front of the mouth (m)

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
// Separable grid: uniform 0.6 m cells over the play area, geometric growth outwards.
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
  const xs = axisCoords(0, 150, 0.6, 6500, 140);
  const zs = axisCoords(-60, 150, 0.6, 6500, 140);
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
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}
