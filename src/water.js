// Lake surface (reflection, refraction, Snell's window) and suspended particles.
import * as THREE from 'three';
import { optics, OPTICS_GLSL, NOISE_GLSL } from './optics.js';

// Depth texture holds the logarithmic depth written by three.js (logarithmicDepthBuffer).
export const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform vec2 uRes;
float viewDistZ(float d) { return exp2(d * log2(uFar + 1.0)) - 1.0; }
`;

export function createWaterSurface(skyCube) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...optics,
      tScene: { value: null },
      tDepth: { value: null },
      tReflect: { value: null },
      tSky: { value: skyCube },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 1 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 20000 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tReflect;
      uniform samplerCube tSky;
      uniform mat4 uReflMatrix;
      uniform float uReflOn;
      varying vec3 vWPos;
      ${DEPTH_GLSL}
      ${NOISE_GLSL}
      ${OPTICS_GLSL}

      // Wind ripples: sum of directional deep-water waves, band-limited by pixel footprint.
      vec3 waveNormal(vec2 p, float footprint) {
        vec2 g = vec2(0.0);
        float wind = 0.6;
        for (int i = 0; i < 14; i++) {
          float fi = float(i);
          float ang = wind + (n_hash12(vec2(fi, 3.7)) - 0.5) * 2.4;
          vec2 d = vec2(cos(ang), sin(ang));
          float wl = 0.18 * pow(1.3, fi);
          float k = 6.2831853 / wl;
          float w = sqrt(9.81 * k);
          float a = wl * 0.010;
          float aa = 1.0 - smoothstep(wl * 0.08, wl * 0.3, footprint);
          float ph = dot(d, p) * k - w * uTime + fi * 1.7;
          g += d * (a * k * cos(ph)) * aa;
        }
        vec2 q = p * 0.35 + vec2(uTime * 0.05, uTime * 0.03);
        float e = 0.08;
        float n0 = n_vnoise(q * 3.0);
        g += vec2(n_vnoise(q * 3.0 + vec2(e, 0.0)) - n0, n_vnoise(q * 3.0 + vec2(0.0, e)) - n0) / e * 0.06 * (1.0 - smoothstep(0.05, 0.3, footprint));
        return normalize(vec3(-g.x, 1.0, -g.y));
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / uRes;
        float sd = texture2D(tDepth, uv).r;
        vec4 vp = viewMatrix * vec4(vWPos, 1.0);
        float waterZ = -vp.z;
        float sceneZ = sd >= 1.0 ? 1e9 : viewDistZ(sd);
        // Manual depth test against the opaque pass.
        if (sceneZ < waterZ * (1.0 - 1e-4) - 0.01) discard;

        float footprint = length(fwidth(vWPos.xz));
        vec3 N = waveNormal(vWPos.xz, footprint);
        vec3 V = normalize(cameraPosition - vWPos);
        float thick = sceneZ - waterZ;
        vec3 col;

        if (uEyeUnder < 0.5) {
          float cosT = max(dot(N, V), 0.0);
          float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
          vec2 off = N.xz * 0.05 * clamp(thick * 0.4, 0.0, 1.0) / (1.0 + waterZ * 0.02);
          vec2 ruv = uv + off;
          float rd = texture2D(tDepth, ruv).r;
          if (rd < 1.0 && viewDistZ(rd) < waterZ) ruv = uv;
          vec3 refr = texture2D(tScene, ruv).rgb;
          vec3 R = reflect(-V, N);
          vec3 refl;
          if (uReflOn > 0.5) {
            vec4 rc = uReflMatrix * vec4(vWPos, 1.0);
            refl = texture2D(tReflect, rc.xy / rc.w + N.xz * 0.025).rgb;
          } else {
            refl = textureCube(tSky, R).rgb;
          }
          float edge = smoothstep(0.0, 0.35, thick);
          col = mix(refr, refl, F * edge);
          float sp = max(dot(R, uSunDir), 0.0);
          col += uSunColor * (pow(sp, 900.0) * 6.0 + pow(sp, 90.0) * 0.08) * edge;
          col = opticsSurface(col, vWPos);
        } else {
          // Seen from below: refraction into air inside Snell's window, total internal reflection outside.
          vec3 Nd = -N;
          vec3 I = -V;
          vec3 T = refract(I, Nd, 1.333);
          vec3 deep = uWaterScatter * 0.85;
          // tScene above the surface is already attenuated along the whole eye path.
          vec3 deepSeen = opticsSurface(deep, vWPos);
          if (dot(T, T) < 1e-6) {
            col = deepSeen;
          } else {
            float F = 0.02 + 0.98 * pow(1.0 - clamp(T.y, 0.0, 1.0), 5.0);
            vec2 off = N.xz * 0.06;
            float sdd = texture2D(tDepth, uv + off).r;
            vec3 above;
            if (sdd < 1.0) {
              above = texture2D(tScene, uv + off).rgb;
            } else {
              above = textureCube(tSky, T).rgb + uSunColor * pow(max(dot(T, uSunDir), 0.0), 500.0) * 4.0;
              above = opticsSurface(above, vWPos);
            }
            col = mix(above, deepSeen, F);
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000).rotateX(-Math.PI / 2), material);
  mesh.position.set(0, 0, -600);
  mesh.frustumCulled = false;
  return mesh;
}

// Suspended organic particles ("marine snow") in a box that wraps around the eye.
export function createParticles(count = 9000, box = 26) {
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random();
    size[i] = 0.004 + Math.pow(Math.random(), 4) * 0.02;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...optics,
      tDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 20000 },
      uBox: { value: box },
      uProjScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uBox;
      uniform float uProjScale;
      uniform float uTime;
      varying vec3 vWPos;
      varying float vAlpha;
      void main() {
        vec3 p = position * uBox + vec3(sin(uTime * 0.1 + position.y * 40.0) * 0.3, -uTime * 0.02, cos(uTime * 0.08 + position.x * 30.0) * 0.3);
        vec3 rel = mod(p - cameraPosition, uBox) - 0.5 * uBox;
        vec3 wp = cameraPosition + rel;
        vWPos = wp;
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float px = aSize * uProjScale / max(-mv.z, 0.01);
        vAlpha = clamp(px, 0.0, 1.0) * (1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, length(rel)));
        gl_PointSize = max(px, 1.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWPos;
      varying float vAlpha;
      ${DEPTH_GLSL}
      ${OPTICS_GLSL}
      void main() {
        if (vWPos.y > -0.05) discard;
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c);
        if (r > 0.25) discard;
        vec4 vp = viewMatrix * vec4(vWPos, 1.0);
        float z = -vp.z;
        float sd = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
        float sceneZ = sd >= 1.0 ? 1e9 : viewDistZ(sd);
        float soft = clamp((sceneZ - z) * 4.0, 0.0, 1.0);
        float depth = -vWPos.y;
        vec3 light = uSunColor * exp(-uWaterKd * depth) * 0.05 + uWaterScatter * 1.5;
        vec3 col = light * vec3(0.9, 1.0, 0.85);
        vec3 seen = waterPath(col, uEye, vWPos) - waterPath(vec3(0.0), uEye, vWPos);
        float a = vAlpha * soft * (1.0 - r * 4.0);
        gl_FragColor = vec4(seen * a, 1.0);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  return points;
}
