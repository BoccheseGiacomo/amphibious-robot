// Offline render of the presentation video.
// Scripted shots are rendered frame by frame in headless Chromium, supersampled and encoded with ffmpeg.
//
//   node tools/render-video.cjs [--out video.mp4] [--scale 1.5] [--fps 30] [--shots aerial,entry] [--test]
//
// Requires Node with Playwright (Chromium) and ffmpeg on PATH. --test renders one frame per shot.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(args.out || 'video.mp4');
const SCALE = Number(args.scale || 1.5);
const FPS = Number(args.fps || 30);
const W = 1920, H = 1080;
const FRAMES = path.join(path.dirname(OUT), 'frames');

// Page-side shot script. Each shot: duration (s), setup(), frame(t) placing rover and camera.
const SHOTS = /* js */ `
(() => {
  const L = window.__lake, T = L.THREE, R = L.rover, cam = L.camera, P = L.PIPE;
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const UP = V(0, 1, 0);
  const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  const startYaw = Math.atan2(-(P.mouth.x - L.START.x), -(P.mouth.z - L.START.z));
  const DT = 1 / ${FPS};
  // Rover state after driving straight from the beach for a given time (physics only).
  const drive = (seconds) => { R.reset(L.START.x, L.START.z, startYaw); for (let i = 0; i < seconds * 120; i++) R.update(1 / 120, 1, 0); };
  // Time at which the rover, driving straight, comes to rest in front of the pipe mouth.
  const stopTime = (() => {
    R.reset(L.START.x, L.START.z, startYaw);
    for (let i = 0; i < 120 * 120; i++) { R.update(1 / 120, 1, 0); if (i > 1200 && Math.abs(R.speed) < 0.05) return i / 120; }
    return 120;
  })();
  const axes = () => {
    const s = Math.sin(R.yaw), c = Math.cos(R.yaw);
    return { f: V(-s, 0, -c), r: V(c, 0, -s) };
  };
  const keepAbove = (p, m = 0.25) => { p.y = Math.max(p.y, L.heightAt(p.x, p.z) + m); return p; };
  const setFov = (f) => { if (cam.fov !== f) { cam.fov = f; cam.updateProjectionMatrix(); } };
  const pipeSide = V(-P.dir.z, 0, P.dir.x).normalize();

  window.__shots = {
    aerial: {
      dur: 8,
      setup() { drive(0); R.lightsOn = false; setFov(50); },
      frame(t) {
        const u = ease(t / 8);
        cam.position.copy(V(110, 55, 95).lerp(V(30, 9, 36), u));
        cam.lookAt(V(-20, -20, -160).lerp(V(2, 0, -5), u));
      },
    },
    entry: {
      dur: 12,
      setup() { drive(0.5); R.lightsOn = false; setFov(55); },
      frame(t) {
        R.update(DT, 1, 0);
        const { f, r } = axes();
        const p = R.position;
        const dip = ease((t - 8) / 3);
        const y = (1 - dip) * Math.max(p.y + 0.9, 0.3) + dip * (p.y + 0.55);
        cam.position.copy(p).addScaledVector(r, 3.0).addScaledVector(f, -0.8);
        cam.position.y = y;
        keepAbove(cam.position);
        cam.lookAt(p.clone().addScaledVector(f, 1.2).addScaledVector(UP, 0.3));
      },
    },
    descent: {
      dur: 10,
      setup() { drive(17); R.lightsOn = true; setFov(55); },
      frame(t) {
        R.update(DT, 1, 0);
        const { f, r } = axes();
        const a = 0.6 + 0.7 * ease(t / 10);
        const off = f.clone().multiplyScalar(-Math.cos(a)).addScaledVector(r, Math.sin(a)).multiplyScalar(4.5);
        cam.position.copy(R.position).add(off).addScaledVector(UP, 2.0);
        keepAbove(cam.position, 1.6);
        cam.lookAt(R.position.clone().addScaledVector(f, 1.5).addScaledVector(UP, 0.2));
      },
    },
    arrival: {
      dur: 12,
      setup() { drive(stopTime - 11.5); R.lightsOn = true; setFov(55); },
      frame(t) {
        R.update(DT, 1, 0);
        const base = P.mouth.clone().addScaledVector(P.dir, -9.5).addScaledVector(pipeSide, 3.6).addScaledVector(UP, 1.6);
        cam.position.copy(base).addScaledVector(P.dir, 2.0 * ease(t / 12));
        keepAbove(cam.position, 1.2);
        cam.lookAt(P.mouth.clone().addScaledVector(P.dir, -3.0).addScaledVector(UP, 0.1));
      },
    },
    onboard: {
      dur: 7,
      setup() { drive(stopTime + 1); R.lightsOn = true; setFov(70); },
      frame(t) {
        const u = ease(t / 7);
        R.panAngle = 0.28 - 0.4 * u;
        R.tiltAngle = -0.02 - 0.06 * u;
        R.update(DT, 0, 0);
        R.camAnchor.getWorldPosition(cam.position);
        R.camAnchor.getWorldQuaternion(cam.quaternion);
      },
    },
  };
})();
`;
const ORDER = ['aerial', 'entry', 'descent', 'arrival', 'onboard'];
const FADE = { in: 0.5, out: 0.5, first: 1.2, last: 1.5 };

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, () => ok(server)));
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/index.html?manual&pr=${SCALE}`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__lake, null, { timeout: 120000 });
  await page.addStyleTag({ content: '#status, #help, #reticle { display: none !important; }' });
  await page.addScriptTag({ content: SHOTS });

  const shots = args.shots ? String(args.shots).split(',') : ORDER;
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  let index = 0, time = 0;
  for (const [si, name] of shots.entries()) {
    const dur = await page.evaluate((n) => { window.__shots[n].setup(); return window.__shots[n].dur; }, name);
    const n = Math.round(dur * FPS);
    const fin = si === 0 ? FADE.first : FADE.in, fout = si === shots.length - 1 ? FADE.last : FADE.out;
    const t0 = Date.now();
    for (let k = 0; k < n; k++) {
      if (args.test && k !== Math.floor(n / 2)) { if (k < Math.floor(n / 2)) await page.evaluate(([nm, t]) => window.__shots[nm].frame(t), [name, k / FPS]); continue; }
      const t = k / FPS;
      const fade = Math.min(1, t / fin, (dur - t) / fout);
      await page.evaluate(([nm, t, time, first, fade, fps]) => {
        window.__shots[nm].frame(t);
        window.__lake.renderView(1 / fps, time, first, fade);
      }, [name, t, time + t, k === 0 || !!args.test, Math.max(0, fade), FPS]);
      await page.screenshot({ path: path.join(FRAMES, `${String(index++).padStart(5, '0')}.png`), timeout: 600000 });
      if (args.test || index % 30 === 0) process.stdout.write(`\r${name}: ${k + 1}/${n} frames, ${((Date.now() - t0) / (k + 1) / 1000).toFixed(1)} s/frame   `);
    }
    time += dur;
    console.log(`\n${name} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await browser.close();
  server.close();

  if (args.test) { console.log(`test frames in ${FRAMES}`); return; }
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png'),
    '-vf', `scale=${W}:${H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  console.log(`video: ${OUT}`);
})();
