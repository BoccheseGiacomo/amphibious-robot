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

// Tileable ripple slope map: random sum of plane waves with integer wave numbers, so the
// tile repeats seamlessly. Stored as slopes (RG) with mipmaps and anisotropic filtering:
// the GPU averages ripples smaller than a pixel, which keeps distant water stable.
function createRippleTexture(renderer, size = 256) {
  const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const waves = [];
  for (let i = 0; i < 160; i++) {
    const k = 2 + Math.floor(Math.pow(rand(), 1.6) * 46);
    const ang = 0.6 + (rand() - 0.5) * 2.6;                 // around the wind direction
    const kx = Math.round(k * Math.cos(ang)), ky = Math.round(k * Math.sin(ang));
    if (!kx && !ky) continue;
    const kk = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: 1 / Math.pow(kk, 1.9), ph: rand() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  const sx = new Float32Array(size * size), sy = new Float32Array(size * size);
  let maxS = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let gx = 0, gy = 0;
      for (const w of waves) {
        const c = Math.cos(2 * Math.PI * (w.kx * x + w.ky * y) / size + w.ph) * w.a * 2 * Math.PI;
        gx += c * w.kx; gy += c * w.ky;
      }
      const i = y * size + x;
      sx[i] = gx; sy[i] = gy;
      maxS = Math.max(maxS, Math.abs(gx), Math.abs(gy));
    }
  }
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round((sx[i] / maxS * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((sy[i] / maxS * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

export function createWaterSurface(renderer, skyCube) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...optics,
      tScene: { value: null },
      tDepth: { value: null },
      tReflect: { value: null },
      tSky: { value: skyCube },
      tRipple: { value: createRippleTexture(renderer) },
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

      uniform sampler2D tRipple;

      vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

      // Wind ripples: three scrolling layers of the filtered slope map at unrelated scales and
      // angles, modulated by slow large-scale gusts (calmer and rougher patches on the lake).
      vec3 waveNormal(vec2 p) {
        vec2 g = rot((texture2D(tRipple, rot(p, 0.37) / 23.0 + uTime * vec2(0.011, 0.004)).rg - 0.5), -0.37) * 0.36;
        g += rot((texture2D(tRipple, rot(p, 1.91) / 7.3 + uTime * vec2(-0.017, 0.021)).rg - 0.5), -1.91) * 0.40;
        g += rot((texture2D(tRipple, rot(p, -0.83) / 2.9 + uTime * vec2(0.043, -0.031)).rg - 0.5), 0.83) * 0.30;
        float gust = n_vnoise(p * 0.012 + uTime * vec2(0.010, 0.004)) * 0.6 + n_vnoise(p * 0.031 - uTime * 0.006) * 0.4;
        g *= 0.35 + 1.1 * smoothstep(0.2, 0.8, gust);
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
        vec3 N = waveNormal(vWPos.xz);
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
            // Ripple displacement of the mirror image shrinks with distance and vanishes at the shoreline.
            vec2 roff = N.xz * min(0.025, 0.5 / waterZ) * clamp(thick * 0.5, 0.0, 1.0);
            refl = texture2D(tReflect, rc.xy / rc.w + roff).rgb;
          } else {
            refl = textureCube(tSky, R).rgb;
          }
          float edge = smoothstep(0.0, 0.35, thick);
          col = mix(refr, refl, F * edge);
          // Sun glint: sharp up close, broader and dimmer where ripples are averaged.
          float sp = max(dot(R, uSunDir), 0.0);
          float sharp = mix(900.0, 160.0, smoothstep(0.02, 1.5, footprint));
          col += uSunColor * (pow(sp, sharp) * sharp / 150.0 + pow(sp, 90.0) * 0.08) * edge;
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), material);
  mesh.position.set(0, 0, -40);
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
        vec3 l;
        vec3 lamps = lampRadiance(0, vWPos, l) + lampRadiance(1, vWPos, l);
        vec3 light = uSunColor * exp(-uWaterKd * depth) * 0.05 + uWaterScatter * 1.5 + lamps * 0.12;
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
