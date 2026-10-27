import * as THREE from 'three';
import { heightAt, createTerrain, PIPE } from './terrain.js';
import { createProps } from './props.js';
import { optics, setSun, patchMaterial } from './optics.js';
import { createSky } from './sky.js';
import { createWaterSurface, createParticles } from './water.js';
import { Pipeline } from './pipeline.js';
import { FlyControls } from './controls.js';

const canvas = document.getElementById('view');
const hud = {
  depth: document.getElementById('depth'),
  fps: document.getElementById('fps'),
  help: document.getElementById('help'),
  loading: document.getElementById('loading'),
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
const world = new THREE.Scene();

// Late-morning sun over the lake, slightly to the right of the view across the water.
const SUN_DIR = new THREE.Vector3(0.42, 0.52, -0.74).normalize();
const SUN_COLOR = new THREE.Color(1.0, 0.95, 0.88);
const SUN_INTENSITY = 4.2;
setSun(SUN_DIR, new THREE.Vector3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(SUN_INTENSITY));

const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 900 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
world.add(sun, sun.target);

function build() {
  const sky = createSky(renderer, world, SUN_DIR);
  world.environment = sky.envTexture;
  world.environmentIntensity = 0.9;
  world.add(createTerrain(patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), 'terrain')));
  world.add(createProps());

  const water = createWaterSurface(sky.cubeTexture);
  const particles = createParticles();
  const overlay = new THREE.Scene();
  overlay.add(water, particles);
  return { sky, pipeline: new Pipeline(renderer, world, overlay, water, particles) };
}

const { sky, pipeline } = build();
optics.uPipeMouth.value.copy(PIPE.mouth);
optics.uPipeDir.value.copy(PIPE.dir);
optics.uPipeR.value = PIPE.radius - PIPE.wall;

const controls = new FlyControls(camera, canvas, heightAt);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Oblique view of the mouth from the front-right, slightly above.
const pipeSide = new THREE.Vector3(-PIPE.dir.z, 0, PIPE.dir.x).normalize();
const pipeView = PIPE.mouth.clone().addScaledVector(PIPE.dir, -4.5).addScaledVector(pipeSide, -4.0).add(new THREE.Vector3(0, 1.6, 0));
const VIEWS = [
  { name: 'Riva', pos: V(3, heightAt(3, 46) + 1.7, 46), target: V(14, 0, -80) },
  { name: 'Bassofondo', pos: V(-3, -2.2, -12), target: V(2, -7, -60) },
  { name: 'Scarpata', pos: V(3, heightAt(3, -86) + 1.6, -86), target: V(6, heightAt(6, -104) + 0.5, -104) },
  { name: 'Condotta', pos: pipeView, target: PIPE.mouth.clone().addScaledVector(PIPE.dir, 2.5) },
  { name: 'Panoramica', pos: V(160, 70, 120), target: V(0, -5, -160) },
];
function goto(i) { controls.setPose(VIEWS[i].pos, VIEWS[i].target); }
goto(0);

window.addEventListener('keydown', (e) => {
  const n = Number(e.key);
  if (n >= 1 && n <= VIEWS.length) goto(n - 1);
  if (e.code === 'KeyH') hud.help.classList.toggle('hidden');
});

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  pipeline.setSize(Math.floor(w * pr), Math.floor(h * pr));
}
window.addEventListener('resize', resize);
resize();

// Shadow frustum follows the area in front of the observer.
const _fwd = new THREE.Vector3();
function updateSunShadow() {
  camera.getWorldDirection(_fwd);
  const c = camera.position.clone().addScaledVector(_fwd.setY(0).normalize(), 25);
  c.y = heightAt(c.x, c.z);
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(SUN_DIR, 400);
  sun.target.updateMatrixWorld();
}

let exposure = 0.55;
let last = performance.now();
let fpsAcc = 0, fpsN = 0;
const clock0 = performance.now();

function frame(now) {
  step(Math.min(0.05, (now - last) / 1000), (now - clock0) / 1000);
  last = now;
  requestAnimationFrame(frame);
}

function step(dt, time) {
  controls.update(dt);
  camera.updateMatrixWorld();
  updateSunShadow();
  sky.update(time);

  // Eye adaptation: brighter exposure as ambient light fades with depth.
  const depth = Math.max(0, -camera.position.y);
  const target = 0.55 * (camera.position.y < 0 ? 2.2 + 3.2 * THREE.MathUtils.smoothstep(depth, 0, 20) : 1);
  exposure += (target - exposure) * (1 - Math.exp(-dt * 2.5));

  pipeline.render(camera, time, exposure);

  hud.depth.textContent = camera.position.y < 0
    ? `Profondità ${depth.toFixed(1)} m`
    : `Quota sul lago ${camera.position.y.toFixed(1)} m`;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { hud.fps.textContent = `${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }
}

hud.loading.classList.add('hidden');
// ?manual: no animation loop; frames are rendered on request (automated screenshots).
const manual = new URLSearchParams(location.search).has('manual');
if (!manual) requestAnimationFrame(frame);
window.__lake = { goto, controls, camera, optics, step, pipeline, world };
