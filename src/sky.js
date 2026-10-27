// Physically based daylight sky (Preetham) with a drifting cumulus layer,
// plus the cube map and pre-filtered environment used for lighting and the water.
import * as THREE from 'three';
import { Sky } from '../vendor/Sky.js';
import { NOISE_GLSL } from './optics.js';

export const SKY_LAYER = 1;

function createClouds(sunDir) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      ${NOISE_GLSL}
      float clouds(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { s += a * n_vnoise(p); p = p * 2.02 + vec2(5.3, 1.7); a *= 0.5; }
        return s;
      }
      void main() {
        vec3 d = normalize(vDir);
        if (d.y <= 0.0) discard;
        float t = (2600.0 - cameraPosition.y) / max(d.y, 0.02);
        vec2 wind = vec2(uTime * 0.0016, uTime * 0.0005);
        vec2 p = (cameraPosition.xz + d.xz * t) * 0.00026 + wind;
        float n = clouds(p);
        float dens = smoothstep(0.5, 0.78, n);
        if (dens <= 0.001) discard;
        float n2 = clouds(p + normalize(uSunDir.xz + 1e-4) * 0.05);
        float lit = clamp(0.6 + (n - n2) * 4.0, 0.0, 1.0);
        float sunFacing = pow(max(dot(d, uSunDir), 0.0), 6.0);
        vec3 shade = vec3(0.42, 0.47, 0.56);
        vec3 bright = vec3(1.0, 0.97, 0.92) * (1.25 + 1.8 * sunFacing);
        vec3 col = mix(shade, bright, lit) * (0.85 + 0.3 * (1.0 - dens));
        float a = dens * smoothstep(0.0, 0.14, d.y) * 0.95;
        gl_FragColor = vec4(col, a);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(15000, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export function createSky(renderer, scene, sunDir) {
  const sky = new Sky();
  sky.scale.setScalar(18000);
  const u = sky.material.uniforms;
  u.turbidity.value = 2.4;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
  sky.renderOrder = -2;

  const clouds = createClouds(sunDir);
  sky.layers.set(SKY_LAYER);
  clouds.layers.set(SKY_LAYER);
  scene.add(sky, clouds);

  // Cube capture of sky + clouds: sampled by the water through Snell's window,
  // and pre-filtered for image-based lighting.
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(1, 30000, cubeRT);
  for (const c of cubeCam.children) c.layers.set(SKY_LAYER);
  cubeCam.position.set(0, 2, 0);
  scene.add(cubeCam);
  // The analytic sky is bright below the horizon too; for lighting, the lower hemisphere
  // must be the landscape (radiance of sunlit forest and meadow, albedo ~0.1).
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(9000, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.07, 0.09, 0.055, THREE.LinearSRGBColorSpace), side: THREE.BackSide, toneMapped: false }),
  );
  ground.layers.set(SKY_LAYER);
  scene.add(ground);
  cubeCam.update(renderer, scene);
  scene.remove(ground);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromCubemap(cubeRT.texture);
  pmrem.dispose();

  return {
    clouds,
    cubeTexture: cubeRT.texture,
    envTexture: env.texture,
    update(time) { clouds.material.uniforms.uTime.value = time; },
  };
}
