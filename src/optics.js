// Shared light-transport model for air and lake water.
// Every material in the scene uses the same uniforms and GLSL, so attenuation,
// in-scattering, caustics and haze stay consistent across terrain, props and water.
import * as THREE from 'three';

// Optical parameters (per metre). Extinction c must exceed diffuse attenuation Kd
// per channel. Values describe a moderately turbid green-blue prealpine lake.
export const optics = {
  uTime: { value: 0 },
  uEye: { value: new THREE.Vector3() },
  uEyeUnder: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },      // towards the sun, in air
  uSunDirW: { value: new THREE.Vector3(0, 1, 0) },     // towards the sun, refracted into water
  uSunColor: { value: new THREE.Vector3(4, 4, 4) },
  uWaterExt: { value: new THREE.Vector3(0.40, 0.10, 0.13) },
  uWaterKd: { value: new THREE.Vector3(0.27, 0.06, 0.075) },
  uWaterScatter: { value: new THREE.Vector3(0.010, 0.045, 0.050) },
  uHazeColor: { value: new THREE.Vector3(0.50, 0.60, 0.76) },
  uHazeDensity: { value: 0.0001 },
  uHazeFalloff: { value: 0.0011 },
  uCaustics: { value: 1.0 },
  uDetail: { value: 1.0 },                             // 0 in the reflection pass: skip fine surface detail
  // Bore of the submerged pipe: its interior receives no ambient light.
  uPipeMouth: { value: new THREE.Vector3() },
  uPipeDir: { value: new THREE.Vector3(0, 0, -1) },   // from the mouth into the pipe
  uPipeR: { value: 0.83 },
  // Rover floodlights: positions, beam axes, radiant intensity (0 when off), cone cosines (outer, inner).
  uLampPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  uLampDir: { value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)] },
  uLampColor: { value: new THREE.Vector3() },
  uLampCone: { value: new THREE.Vector2(Math.cos(0.55), Math.cos(0.25)) },
};

export function setSun(dirToSun, color) {
  optics.uSunDir.value.copy(dirToSun).normalize();
  const h = new THREE.Vector2(dirToSun.x, dirToSun.z).multiplyScalar(1 / 1.333);
  optics.uSunDirW.value.set(h.x, Math.sqrt(Math.max(0, 1 - h.lengthSq())), h.y);
  optics.uSunColor.value.copy(color);
}

export const NOISE_GLSL = /* glsl */ `
float n_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 n_hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float n_hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float n_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(n_hash12(i), n_hash12(i + vec2(1, 0)), u.x), mix(n_hash12(i + vec2(0, 1)), n_hash12(i + vec2(1, 1)), u.x), u.y);
}
float n_vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(n_hash13(i), n_hash13(i + vec3(1, 0, 0)), u.x);
  float b = mix(n_hash13(i + vec3(0, 1, 0)), n_hash13(i + vec3(1, 1, 0)), u.x);
  float c = mix(n_hash13(i + vec3(0, 0, 1)), n_hash13(i + vec3(1, 0, 1)), u.x);
  float d = mix(n_hash13(i + vec3(0, 1, 1)), n_hash13(i + vec3(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
float n_fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n_vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s / 0.97; }
float n_fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n_vnoise3(p); p = p * 2.07 + vec3(17.1, 9.3, 4.7); a *= 0.5; } return s / 0.94; }
// x: distance to nearest feature, y: feature id, zw: vector to feature (cell units)
vec4 n_voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float md = 8.0; vec2 mr = vec2(0.0), mc = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + 0.15 + 0.7 * n_hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mc = n + g; }
  }
  return vec4(sqrt(md), n_hash12(mc), mr);
}
`;

export const OPTICS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uEye;
uniform float uEyeUnder;
uniform vec3 uSunDir;
uniform vec3 uSunDirW;
uniform vec3 uSunColor;
uniform vec3 uWaterExt;
uniform vec3 uWaterKd;
uniform vec3 uWaterScatter;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uHazeFalloff;
uniform float uCaustics;
uniform float uDetail;
uniform vec3 uPipeMouth;
uniform vec3 uPipeDir;
uniform float uPipeR;

// Distance behind the mouth plane for points inside the pipe bore, else 0.
float pipeInside(vec3 p) {
  vec3 d = p - uPipeMouth;
  float s = dot(d, uPipeDir);
  float r = length(d - uPipeDir * s);
  return (s > 0.0 && r < uPipeR + 0.02) ? s : 0.0;
}

// Ambient light reaching a point inside the pipe decays away from the mouth.
float pipeAmbient(vec3 p) {
  float s = pipeInside(p);
  return s > 0.0 ? 0.06 + 0.94 * exp(-s / 0.9) : 1.0;
}

uniform vec3 uLampPos[2];
uniform vec3 uLampDir[2];
uniform vec3 uLampColor;
uniform vec2 uLampCone;

// Transmittance of the water part of the straight segment a -> b.
vec3 waterTransmit(vec3 a, vec3 b) {
  float L = length(b - a);
  float under;
  if (a.y < 0.0 && b.y < 0.0) under = L;
  else if (a.y >= 0.0 && b.y >= 0.0) under = 0.0;
  else { float t = a.y / (a.y - b.y); under = a.y < 0.0 ? t * L : (1.0 - t) * L; }
  return exp(-uWaterExt * under);
}

// Radiance emitted by lamp i towards point p (inverse square, soft cone, water absorption).
vec3 lampRadiance(int i, vec3 p, out vec3 toLamp) {
  vec3 L = uLampPos[i] - p;
  float d2 = dot(L, L);
  toLamp = L * inversesqrt(d2);
  float cone = smoothstep(uLampCone.x, uLampCone.y, dot(-toLamp, uLampDir[i]));
  return uLampColor * cone * waterTransmit(uLampPos[i], p) / (d2 + 0.02);
}

// Irradiance from both lamps on a surface with normal n.
vec3 lampIrradiance(vec3 p, vec3 n) {
  vec3 e = vec3(0.0), l;
  for (int i = 0; i < 2; i++) {
    vec3 r = lampRadiance(i, p, l);
    e += r * max(dot(n, l), 0.0);
  }
  return e;
}

// Tileable caustic network (period 1 in uv).
float causticPattern(vec2 uv, float t) {
  vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
  vec2 i = p; float c = 1.0; const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

// Surface point that focuses sunlight onto p (projection along the refracted sun ray).
vec2 causticCoord(vec3 p, float z) { return p.xz + uSunDirW.xz / uSunDirW.y * z; }

// Multiplier for direct sunlight at depth z: focused bright lines, contrast fading with depth.
float causticLight(vec3 p, float z) {
  vec2 q = causticCoord(p, z);
  float c = 0.6 * causticPattern(q * 0.23, uTime * 0.55) + 0.4 * causticPattern(q * 0.31 + 0.37, uTime * 0.45 + 3.0);
  float k = uCaustics * smoothstep(0.0, 0.6, z) * exp(-z / 10.0);
  return mix(1.0, 0.35 + 5.0 * c, k);
}

// Attenuation and in-scattering along a straight water segment a -> b (a on the eye side).
// In-scatter source decays with depth as exp(-Kd z); integrated analytically.
vec3 waterPath(vec3 col, vec3 a, vec3 b) {
  vec3 d = b - a;
  float L = length(d);
  if (L < 1e-4) return col;
  vec3 dir = d / L;
  float z0 = max(-a.y, 0.0);
  vec3 c = uWaterExt;
  vec3 k = c - uWaterKd * dir.y;
  vec3 T = exp(-c * L);
  float fwd = 0.75 + 0.7 * pow(max(dot(dir, uSunDirW), 0.0), 4.0);
  vec3 S = fwd * uWaterScatter * exp(-uWaterKd * z0) * c * (1.0 - exp(-k * L)) / k;
  return col * T + S;
}

// Height-dependent atmospheric haze along a -> b.
vec3 airPath(vec3 col, vec3 a, vec3 b) {
  vec3 d = b - a;
  float L = length(d);
  if (L < 1e-3) return col;
  float f = uHazeFalloff;
  float x = f * d.y;
  float k = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0;
  float od = uHazeDensity * exp(-f * max(a.y, 0.0)) * k * L;
  vec3 T = exp(-od * vec3(0.55, 0.78, 1.0));
  float sunAmt = pow(max(dot(d / L, uSunDir), 0.0), 6.0);
  vec3 hc = uHazeColor * (1.0 + 1.5 * sunAmt * vec3(1.0, 0.88, 0.7));
  return col * T + hc * (1.0 - T);
}

// Opaque surfaces. Eye above water: only the part of the ray beyond the surface
// (the surface shader adds the air in front). Eye under water: the whole path, so
// nothing above the surface ever reaches the image unattenuated.
vec3 opticsOpaque(vec3 col, vec3 p) {
  bool eu = uEyeUnder > 0.5;
  bool pu = p.y < 0.0;
  if (eu == pu) {
    if (!pu) return airPath(col, uEye, p);
    // Water enclosed by the pipe is dark: no in-scattering along that part of the ray.
    float s = pipeInside(p);
    if (s > 0.0) {
      vec3 v = normalize(uEye - p);
      float l = min(s / max(dot(v, -uPipeDir), 0.2), length(uEye - p));
      col *= exp(-uWaterExt * l);
      p += v * l;
    }
    return waterPath(col, uEye, p);
  }
  vec3 x = mix(uEye, p, clamp(-uEye.y / (p.y - uEye.y), 0.0, 1.0));
  return pu ? waterPath(col, x, p) : waterPath(airPath(col, x, p), uEye, x);
}

vec3 opticsSurface(vec3 col, vec3 p) {
  return uEyeUnder > 0.5 ? waterPath(col, uEye, p) : airPath(col, uEye, p);
}
`;

// Procedural surface descriptions (albedo, normal perturbation, roughness) in world space.
const SURFACE_GLSL = /* glsl */ `
vec3 pebbleColor(float h) {
  vec3 a = vec3(0.40, 0.38, 0.35), b = vec3(0.29, 0.24, 0.19), c = vec3(0.17, 0.17, 0.16), d = vec3(0.47, 0.45, 0.41);
  return h < 0.4 ? mix(a, d, h / 0.4) : (h < 0.75 ? mix(b, a, (h - 0.4) / 0.35) : mix(c, b, (h - 0.75) / 0.25));
}

// Rounded stone layer from a Voronoi field. Writes colour, slope (bump) and coverage.
void stoneLayer(vec2 xz, float s, float R, float cover, float fw, float shape, inout vec3 col, inout vec2 g, inout float ao) {
  // Beyond the resolvable scale, blend to the layer's mean colour and occlusion.
  const vec3 meanPebble = vec3(0.30, 0.285, 0.255);
  float fade = 1.0 - smoothstep(0.25, 0.7, fw * s);
  vec3 farCol = mix(col, meanPebble, cover * 0.85);
  float farAo = 1.0 - 0.2 * cover;
  if (fade <= 0.0) { col = farCol; ao *= farAo; return; }
  vec4 v = n_voronoi(xz * s);
  float exists = step(v.y, cover);
  float ang = fract(v.y * 31.7) * 6.2831853;
  vec2 ax = vec2(cos(ang), sin(ang));
  vec2 q = vec2(dot(v.zw, ax), dot(v.zw, vec2(-ax.y, ax.x)) * (1.0 + 0.4 * fract(v.y * 5.3)));
  R *= 0.85 + 0.35 * fract(v.y * 17.9);
  float h = max(0.0, 1.0 - dot(q, q) / (R * R)) * exists;
  vec3 pc = pebbleColor(fract(v.y * 13.7)) * (0.72 + 0.3 * fract(v.y * 71.3));
  float inside = smoothstep(0.0, 0.2, h);
  vec3 nearCol = mix(col, pc, inside);
  float nearAo = mix(1.0, 0.55 + 0.45 * sqrt(h), cover);
  col = mix(farCol, nearCol, fade);
  ao *= mix(farAo, nearAo, fade);
  vec2 gs = shape * 2.0 * v.zw / (R * R) * step(1e-4, h) * fade;
  g = mix(g, gs, inside);
}

void underwaterFouling(vec3 p, vec3 n, inout vec3 col, float strength) {
  float z = -p.y;
  if (z <= 0.0) return;
  float up = 0.45 + 0.55 * smoothstep(-0.2, 0.9, n.y);
  float f = smoothstep(0.0, 1.2, z) * strength;
  float b = n_fbm3(p * 1.7);
  float spots = n_fbm3(p * 6.0 + 2.0);
  col = mix(col, vec3(0.10, 0.11, 0.055) * (0.6 + 0.8 * b), f * up * 0.75 * smoothstep(0.3, 0.6, b + 0.15));
  col = mix(col, vec3(0.20, 0.17, 0.10), f * 0.5 * smoothstep(0.6, 0.72, spots));
  col = mix(col, vec3(0.21, 0.19, 0.14), f * smoothstep(0.5, 0.95, n.y) * smoothstep(4.0, 14.0, z) * 0.75);
}

void terrainSurface(vec3 p, vec3 n, inout vec3 col, inout vec3 bump, inout float rough) {
  float fw = max(length(fwidth(p.xz)), 1e-4);
  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  float depth = -p.y;
  float big = n_fbm2(p.xz * 0.021);
  float mid = n_fbm2(p.xz * 0.19 + 3.1);

  // Gravel bed: pebbles over sand, sparse larger stones.
  vec3 gravel = mix(vec3(0.23, 0.215, 0.18), vec3(0.29, 0.27, 0.23), mid);
  vec2 g = vec2(0.0); float ao = 1.0;
  float cover = clamp(0.82 + (mid - 0.5) * 0.4, 0.55, 0.95);
  cover = mix(cover, 0.97, smoothstep(-0.5, 0.2, p.y));
  if (uDetail < 0.5) fw = 1e3;   // reflection pass: mean colours only
  stoneLayer(p.xz, 9.0, 0.62, cover, fw, 0.22, gravel, g, ao);
  float stones = 0.22 * smoothstep(0.3, 0.7, big + 0.2) * mix(1.0, 0.3, smoothstep(-0.5, 0.2, p.y));
  stoneLayer(p.xz + 17.3, 2.7, 0.44, stones, fw, 0.28, gravel, g, ao);
  gravel *= ao;
  float bumpK = 1.0;

  // Fine sediment in deeper water.
  vec3 silt = mix(vec3(0.13, 0.125, 0.095), vec3(0.19, 0.175, 0.135), mid) * (0.85 + 0.3 * n_vnoise(p.xz * 3.1));
  float siltAmt = smoothstep(2.0, 11.0, depth + (big - 0.5) * 9.0) * 0.92;
  col = mix(gravel, silt, siltAmt);
  bumpK *= 1.0 - siltAmt * 0.85;

  // Biofilm in the shallow littoral zone and a dark band at the waterline.
  col = mix(col, col * vec3(0.8, 0.95, 0.55), smoothstep(0.2, 1.5, depth) * (1.0 - smoothstep(5.0, 10.0, depth)) * 0.6 * mid);
  float band = smoothstep(-0.12, -0.02, p.y) * (1.0 - smoothstep(0.0, 0.35, depth));
  col = mix(col, vec3(0.09, 0.085, 0.05), band * 0.55);

  // Wet beach above the waterline.
  float wet = 1.0 - smoothstep(0.0, 0.35 + 0.4 * mid, p.y);
  rough = depth > 0.0 ? 0.8 : mix(0.88, 0.32, wet);
  if (depth <= 0.0) col *= mix(1.0, 0.58, wet);

  // Meadow, forest, rock and snow on land.
  float beachTop = mix(1.7, 0.45, smoothstep(150.0, 450.0, length(p.xz - vec2(0.0, -40.0))));
  float grass = smoothstep(beachTop - 0.7, beachTop + 0.7, p.y + (mid - 0.5) * 1.6) * (1.0 - smoothstep(0.32, 0.5, slope));
  vec3 grassCol = mix(vec3(0.05, 0.085, 0.02), vec3(0.12, 0.15, 0.04), n_fbm2(p.xz * 0.37)) * (0.75 + 0.5 * big);
  col = mix(col, grassCol, grass);
  bumpK *= 1.0 - grass * 0.7;

  float forest = smoothstep(12.0, 30.0, p.y + (big - 0.5) * 30.0) * (1.0 - smoothstep(0.5, 0.72, slope));
  forest *= smoothstep(0.22, 0.4, n_fbm2(p.xz * 0.0045 + 9.0) + 0.2 - smoothstep(1300.0, 1700.0, p.y));
  vec3 forestCol = mix(vec3(0.018, 0.034, 0.014), vec3(0.045, 0.068, 0.024), n_fbm2(p.xz * 0.06));
  col = mix(col, forestCol, forest);

  float rock = smoothstep(0.4, 0.6, slope + (mid - 0.5) * 0.25);
  vec3 rockCol = mix(vec3(0.24, 0.235, 0.22), vec3(0.38, 0.37, 0.35), smoothstep(600.0, 1600.0, p.y));
  rockCol *= 0.75 + 0.4 * n_fbm2(p.xz * 0.05 + p.y * 0.03);
  col = mix(col, depth > 0.0 ? mix(rockCol * 0.75, silt, siltAmt * 0.6) : rockCol, rock);

  float snow = smoothstep(1850.0, 2000.0, p.y + (big - 0.5) * 300.0) * (1.0 - smoothstep(0.5, 0.75, slope));
  col = mix(col, vec3(0.85, 0.87, 0.9), snow);
  rough = mix(rough, 0.6, snow);

  bump = -vec3(g.x, 0.0, g.y) * bumpK;
}

void rockSurface(vec3 p, vec3 n, inout vec3 col, inout vec3 bump, inout float rough) {
  float fw = max(length(fwidth(p)), 1e-4);
  float a = n_fbm3(p * 0.9);
  float b = n_fbm3(p * 4.3 + 3.0);
  vec3 base = mix(vec3(0.20, 0.195, 0.18), vec3(0.42, 0.40, 0.37), a) * (0.75 + 0.45 * b);
  // Lichen-like spots above water, cavities darker.
  base = mix(base, vec3(0.30, 0.31, 0.24), smoothstep(0.62, 0.7, n_fbm3(p * 2.7 + 9.0)) * step(0.0, p.y) * 0.6);
  vec3 q = p * 2.3;
  float h0 = n_fbm3(q);
  float e = 0.03;
  vec3 gr = vec3(n_fbm3(q + vec3(e, 0, 0)) - h0, n_fbm3(q + vec3(0, e, 0)) - h0, n_fbm3(q + vec3(0, 0, e)) - h0) / e;
  gr -= n * dot(gr, n);
  float fade = 1.0 - smoothstep(0.02, 0.1, fw);
  bump = -gr * 0.16 * fade;
  base *= 0.6 + 0.55 * smoothstep(0.25, 0.6, h0);
  col *= base;
  rough = 0.88;
  float wet = (1.0 - smoothstep(0.0, 0.3, p.y)) * step(0.0, p.y);
  col *= mix(1.0, 0.6, wet);
  rough = mix(rough, 0.35, wet);
  underwaterFouling(p, n, col, 1.0);
}

void pipeSurface(vec3 p, vec3 n, inout vec3 col, inout vec3 bump, inout float rough) {
  float a = n_fbm3(p * 0.55);
  float b = n_fbm3(p * 3.7);
  vec3 steel = vec3(0.24, 0.235, 0.22) * (0.85 + 0.3 * b);
  vec3 rust = mix(vec3(0.16, 0.08, 0.04), vec3(0.27, 0.15, 0.07), b);
  float r = smoothstep(0.6, 0.85, a + b * 0.35);
  col = mix(steel, rust, r);
  rough = mix(0.5, 0.92, r);
  underwaterFouling(p, n, col, 1.0);
  rough = mix(rough, 0.9, smoothstep(0.0, 1.0, -p.y));
}

void concreteSurface(vec3 p, vec3 n, inout vec3 col, inout vec3 bump, inout float rough) {
  float a = n_fbm3(p * 1.3);
  float h = p.x * 0.7 + p.z * 0.7;
  float streak = n_vnoise(vec2(h * 5.0, p.y * 0.35)) * n_vnoise(vec2(h * 1.3 + 4.0, p.y * 0.2));
  col = vec3(0.33, 0.325, 0.30) * (0.7 + 0.45 * a) * (0.92 + 0.16 * n_vnoise3(p * 23.0));
  col *= 1.0 - 0.45 * smoothstep(0.15, 0.5, streak);
  // Sediment line and darker base near the lake bed around the pipe.
  float hb = p.y - (uPipeMouth.y - uPipeR - 0.1);
  col = mix(vec3(0.15, 0.14, 0.10), col, smoothstep(0.0, 0.9 + 0.4 * a, hb));
  vec3 q = p * 6.0;
  float e = 0.05;
  float h0 = n_vnoise3(q);
  vec3 gr = vec3(n_vnoise3(q + vec3(e, 0, 0)) - h0, n_vnoise3(q + vec3(0, e, 0)) - h0, n_vnoise3(q + vec3(0, 0, e)) - h0) / e;
  gr -= n * dot(gr, n);
  bump = -gr * 0.05;
  rough = 0.95;
  underwaterFouling(p, n, col, 1.3);
}

void woodSurface(vec3 p, vec3 n, inout vec3 col, inout vec3 bump, inout float rough) {
  col = vec3(0.10, 0.07, 0.045) * (0.7 + 0.6 * n_fbm3(p * 3.0));
  rough = 0.9;
  underwaterFouling(p, n, col, 1.4);
}
`;

const SURFACE_CALL = {
  terrain: 'terrainSurface',
  rock: 'rockSurface',
  pipe: 'pipeSurface',
  concrete: 'concreteSurface',
  wood: 'woodSurface',
};

const SWAY_GLSL = /* glsl */ `
{
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
  ip = instanceMatrix[3].xyz;
  #endif
  float sw = position.y * position.y;
  float ph = uTime * 1.1 + ip.x * 0.37 + ip.z * 0.21;
  transformed.x += sin(ph + position.y * 2.0) * 0.14 * sw;
  transformed.z += cos(ph * 0.8 + position.y * 1.7) * 0.09 * sw;
}
`;

// Injects world-space varyings, procedural surfaces, underwater lighting and media
// transport into a MeshStandardMaterial. kind: terrain|rock|pipe|concrete|wood|plain|weed
export function patchMaterial(material, kind) {
  const surface = SURFACE_CALL[kind];
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, optics);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nuniform float uTime;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (kind === 'weed' ? SWAY_GLSL : ''))
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
          wn = mat3(instanceMatrix) * wn;
        #endif
        wp4 = modelMatrix * wp4;
        vWPos = wp4.xyz;
        vWNrm = normalize(mat3(modelMatrix) * wn);
        #ifdef FLIP_SIDED
          vWNrm = -vWNrm;
        #endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\n' + NOISE_GLSL + OPTICS_GLSL + (surface ? SURFACE_GLSL : ''))
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 sBump = vec3(0.0);
        float sRough = -1.0;
        ${surface ? `${surface}(vWPos, normalize(vWNrm), diffuseColor.rgb, sBump, sRough);` : ''}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (sRough >= 0.0) roughnessFactor = sRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        ${surface ? `{
          vec3 nW = normalize(vWNrm);
          #ifdef DOUBLE_SIDED
            nW *= faceDirection;
          #endif
          nW = normalize(nW + sBump);
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }` : ''}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (vWPos.y < 0.0) {
          float zD = -vWPos.y;
          vec3 att = exp(-uWaterKd * zD);
          float caus = causticLight(vWPos, zD);
          reflectedLight.directDiffuse *= att * caus;
          reflectedLight.directSpecular *= att * caus;
          float amb = pipeAmbient(vWPos);
          reflectedLight.indirectDiffuse *= att * amb;
          reflectedLight.indirectSpecular *= att * amb * mix(1.0, 0.3, smoothstep(0.0, 0.5, zD));
        }
        // Rover lamps travel only through water/air, not from the surface down: added after.
        if (uLampColor.g > 0.0) {
          vec3 nWorld = inverseTransformDirection(normal, viewMatrix);
          reflectedLight.directDiffuse += lampIrradiance(vWPos, nWorld) * BRDF_Lambert(material.diffuseColor);
        }`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = opticsOpaque(gl_FragColor.rgb, vWPos);');
  };
  material.customProgramCacheKey = () => 'lake-' + kind;
  return material;
}
