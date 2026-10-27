import * as THREE from 'three';
import { heightAt, createTerrain, PIPE, START } from './terrain.js';
import { createProps } from './props.js';
import { optics, setSun, patchMaterial } from './optics.js';
import { createSky } from './sky.js';
import { createWaterSurface, createParticles } from './water.js';
import { Pipeline } from './pipeline.js';
import { FlyControls, ChaseCamera, onPointer, pressed } from './controls.js';
import { Rover } from './rover.js';

const canvas = document.getElementById('view');
const $ = (id) => document.getElementById(id);
const hud = {
  view: $('h-view'), depth: $('h-depth'), speed: $('h-speed'), heading: $('h-heading'),
  pitch: $('h-pitch'), roll: $('h-roll'), pipe: $('h-pipe'), lights: $('h-lights'),
  fps: $('fps'), help: $('help'), loading: $('loading'),
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
  const props = createProps();
  world.add(props.group);
  const rover = new Rover(props.obstacles);
  world.add(rover.group);

  const water = createWaterSurface(sky.cubeTexture);
  const particles = createParticles();
  const overlay = new THREE.Scene();
  overlay.add(water, particles);
  return { sky, rover, pipeline: new Pipeline(renderer, world, overlay, water, particles) };
}

const { sky, rover, pipeline } = build();
optics.uPipeMouth.value.copy(PIPE.mouth);
optics.uPipeDir.value.copy(PIPE.dir);
optics.uPipeR.value = PIPE.radius - PIPE.wall;

// Start on the beach, facing the pipe across the water.
const startYaw = Math.atan2(-(PIPE.mouth.x - START.x), -(PIPE.mouth.z - START.z));
rover.reset(START.x, START.z, startYaw);

const fly = new FlyControls(camera, heightAt);
const chase = new ChaseCamera(camera, heightAt);
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

// Views: 'esterna' (chase), 'bordo' (rover camera), 'libera' (free observer).
const VIEW_NAMES = { esterna: 'Vista esterna', bordo: 'Telecamera di bordo', libera: 'Camera libera' };
let mode = 'esterna';
function setMode(m) {
  mode = m;
  camera.fov = m === 'bordo' ? 70 : 60;
  camera.updateProjectionMatrix();
  document.body.classList.toggle('onboard', m === 'bordo');
  if (m === 'esterna') chase.update(0, rover, true);
  hud.view.textContent = VIEW_NAMES[m];
}
function goto(i) {
  setMode('libera');
  fly.setPose(VIEWS[i].pos, VIEWS[i].target);
}
setMode('esterna');

onPointer(canvas, {
  drag(dx, dy) {
    if (mode === 'libera') fly.look(dx, dy);
    else if (mode === 'esterna') chase.orbit(dx, dy);
    else rover.aim(-dx * 0.004, -dy * 0.004);
  },
  wheel(s) { if (mode === 'esterna') chase.zoom(s); },
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const n = Number(e.key);
  if (n >= 1 && n <= VIEWS.length) goto(n - 1);
  if (e.code === 'KeyV') setMode(mode === 'esterna' ? 'bordo' : 'esterna');
  if (e.code === 'KeyF') {
    const t = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()));
    setMode('libera');
    fly.setPose(camera.position.clone(), t);
  }
  if (e.code === 'KeyL') rover.lightsOn = !rover.lightsOn;
  if (e.code === 'KeyR') rover.reset(START.x, START.z, startYaw);
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

// Shadow frustum follows the rover, or the area in front of the free observer.
const _fwd = new THREE.Vector3();
function updateSunShadow() {
  let c;
  if (mode === 'libera') {
    camera.getWorldDirection(_fwd);
    c = camera.position.clone().addScaledVector(_fwd.setY(0).normalize(), 25);
    c.y = heightAt(c.x, c.z);
  } else {
    c = rover.position.clone();
  }
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

const _q = new THREE.Quaternion();
function step(dt, time) {
  const drive = mode !== 'libera';
  const throttle = drive ? pressed('KeyW', 'ArrowUp') - pressed('KeyS', 'ArrowDown') : 0;
  const steer = drive ? pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft') : 0;
  rover.update(dt, throttle, steer);

  if (mode === 'libera') fly.update(dt);
  else if (mode === 'esterna') chase.update(dt, rover);
  else {
    rover.camAnchor.getWorldPosition(camera.position);
    camera.quaternion.copy(rover.camAnchor.getWorldQuaternion(_q));
  }
  camera.updateMatrixWorld();
  updateSunShadow();
  sky.update(time);

  // Eye adaptation: brighter exposure as ambient light fades with depth.
  const depth = Math.max(0, -camera.position.y);
  const target = 0.55 * (camera.position.y < 0 ? 2.2 + 3.2 * THREE.MathUtils.smoothstep(depth, 0, 20) : 1);
  exposure += (target - exposure) * (1 - Math.exp(-dt * 2.5));

  pipeline.render(camera, time, exposure);

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.25) {
    hud.fps.textContent = `${Math.round(fpsN / fpsAcc)} fps`;
    fpsAcc = 0; fpsN = 0;
    updateHud();
  }
}

const fmtSigned = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}°`;
function updateHud() {
  const d = rover.depth;
  hud.depth.textContent = d > 0 ? `${d.toFixed(1)} m` : 'fuori acqua';
  hud.speed.textContent = `${rover.speed.toFixed(2)} m/s`;
  hud.heading.textContent = `${rover.heading.toFixed(0).padStart(3, '0')}°`;
  hud.pitch.textContent = fmtSigned(rover.pitch);
  hud.roll.textContent = fmtSigned(rover.roll);
  hud.pipe.textContent = `${Math.max(0, rover.position.distanceTo(PIPE.mouth) - 0.5).toFixed(1)} m`;
  hud.lights.textContent = rover.lightsOn ? 'accese' : 'spente';
}

hud.loading.classList.add('hidden');
// ?manual: no animation loop; frames are rendered on request (automated screenshots).
const manual = new URLSearchParams(location.search).has('manual');
if (!manual) requestAnimationFrame(frame);
window.__lake = { goto, setMode, fly, chase, rover, camera, optics, step, pipeline, world };
