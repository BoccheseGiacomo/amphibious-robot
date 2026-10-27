// Frame pipeline:
//  1. planar reflection of the world above the water (eye above water only)
//  2. opaque world -> HDR target with depth (MSAA)
//  3. composite: opaque copy + water surface + suspended particles
//  4. underwater light shafts (half resolution, ray-marched)
//  5. bloom (quarter resolution)
//  6. final: grading, vignette, tone mapping, sRGB
import * as THREE from 'three';
import { optics, OPTICS_GLSL } from './optics.js';
import { DEPTH_GLSL } from './water.js';
import { SKY_LAYER } from './sky.js';

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function pass(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

export class Pipeline {
  constructor(renderer, world, overlay, water, particles) {
    this.renderer = renderer;
    this.world = world;
    this.overlay = overlay;
    this.water = water;
    this.particles = particles;

    const hdr = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.mainRT = new THREE.WebGLRenderTarget(1, 1, {
      ...hdr, samples: 4,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.reflRT = new THREE.WebGLRenderTarget(1, 1, hdr);
    this.compRT = new THREE.WebGLRenderTarget(1, 1, { ...hdr, depthBuffer: false });
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, { ...hdr, depthBuffer: false });
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { ...hdr, depthBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { ...hdr, depthBuffer: false });

    this.reflCam = new THREE.PerspectiveCamera();
    this.reflCam.layers.enableAll();
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.copyMat = pass(/* glsl */ `
      uniform sampler2D tSrc; varying vec2 vUv;
      void main() { gl_FragColor = texture2D(tSrc, vUv); }`, { tSrc: { value: null } });

    this.raysMat = pass(/* glsl */ `
      uniform mat4 uInvProj, uCamWorld;
      uniform float uFrame;
      varying vec2 vUv;
      ${DEPTH_GLSL}
      ${OPTICS_GLSL}
      void main() {
        vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
        vec3 vdir = normalize(v.xyz / v.w);
        vec3 wdir = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
        float d = texture2D(tDepth, vUv).r;
        float tScene = d >= 1.0 ? 1e9 : viewDistZ(d) / max(-vdir.z, 1e-4);
        float tSurf = wdir.y > 1e-4 ? -uEye.y / wdir.y : 1e9;
        float tMax = min(min(tScene, tSurf), 42.0);
        const int N = 28;
        float dt = tMax / float(N);
        float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588, vec2(0.06711056, 0.00583715))));
        vec3 acc = vec3(0.0);
        for (int i = 0; i < N; i++) {
          float t = (float(i) + jit) * dt;
          vec3 x = uEye + wdir * t;
          float z = max(-x.y, 0.0);
          vec2 q = causticCoord(x, z);
          float shaft = pow(causticPattern(q * 0.045, uTime * 0.18), 0.35) * 0.7
                      + pow(causticPattern(q * 0.11 + 0.3, uTime * 0.25), 0.5) * 0.3;
          vec3 sun = exp(-uWaterKd * z * 1.25);
          acc += sun * shaft * exp(-uWaterExt * t) * dt;
        }
        float mu = dot(wdir, uSunDirW);
        float g = 0.82;
        float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / 12.566;
        gl_FragColor = vec4(acc * uSunColor * uWaterExt * vec3(0.25, 0.9, 0.8) * phase * 0.08, 1.0);
      }`, {
      ...optics,
      tDepth: { value: null },
      uNear: { value: 0.1 }, uFar: { value: 20000 },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uFrame: { value: 0 },
    });

    this.brightMat = pass(/* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
        c *= 0.25;
        c = min(c, vec3(60.0));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(c * max(l - uThreshold, 0.0) / max(l, 1e-4), 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.2 } });

    this.blurMat = pass(/* glsl */ `
      uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
        c += texture2D(tSrc, vUv + uDir * 1.3846).rgb * 0.316216;
        c += texture2D(tSrc, vUv - uDir * 1.3846).rgb * 0.316216;
        c += texture2D(tSrc, vUv + uDir * 3.2308).rgb * 0.070270;
        c += texture2D(tSrc, vUv - uDir * 3.2308).rgb * 0.070270;
        gl_FragColor = vec4(c, 1.0);
      }`, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.finalMat = pass(/* glsl */ `
      uniform sampler2D tColor, tRays, tBloom;
      uniform float uUnder, uTime, uBloom;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        uv += uUnder * vec2(sin(uv.y * 23.0 + uTime * 1.3), cos(uv.x * 19.0 + uTime * 1.1)) * 0.0008;
        vec3 c = texture2D(tColor, uv).rgb;
        c += texture2D(tRays, uv).rgb * uUnder;
        c += texture2D(tBloom, uv).rgb * uBloom;
        vec2 q = vUv - 0.5;
        c *= 1.0 - dot(q, q) * mix(0.45, 1.1, uUnder);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, 1.12), 0.0);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 91.0, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor.rgb += (n - 0.5) / 255.0 * 1.5;
      }`, {
      tColor: { value: null }, tRays: { value: null }, tBloom: { value: null },
      uUnder: { value: 0 }, uTime: { value: 0 }, uBloom: { value: 0.06 },
    });
    this.finalMat.toneMapped = true;

    this.frame = 0;
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._v = new THREE.Vector3();
    this._clear = new THREE.Color();
  }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.mainRT.setSize(w, h);
    this.compRT.setSize(w, h);
    this.reflRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.raysRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.bloomA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.bloomB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  drawQuad(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  // Virtual camera mirrored in the plane y = 0, with an oblique near plane on the water.
  updateReflectionCamera(camera) {
    const rc = this.reflCam;
    rc.near = camera.near; rc.far = camera.far; rc.fov = camera.fov; rc.aspect = camera.aspect;
    rc.position.set(camera.position.x, -camera.position.y, camera.position.z);
    const f = this._v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    f.y = -f.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    up.y = -up.y;
    rc.up.copy(up);
    rc.lookAt(rc.position.x + f.x, rc.position.y + f.y, rc.position.z + f.z);
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);

    this.water.material.uniforms.uReflMatrix.value.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    ).multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    const plane = this._plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
    plane.applyMatrix4(rc.matrixWorldInverse);
    const clip = this._clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = rc.projectionMatrix.elements;
    const q = this._q.set(
      (Math.sign(clip.x) + e[8]) / e[0],
      (Math.sign(clip.y) + e[9]) / e[5],
      -1.0,
      (1.0 + e[10]) / e[14],
    );
    clip.multiplyScalar(2.0 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1.0 - 0.003; e[14] = clip.w;
    rc.projectionMatrixInverse.copy(rc.projectionMatrix).invert();
  }

  render(camera, time, exposure) {
    const r = this.renderer;
    const under = camera.position.y < 0;
    optics.uEye.value.copy(camera.position);
    optics.uEyeUnder.value = under ? 1 : 0;
    optics.uTime.value = time;

    // 1. reflection
    const wu = this.water.material.uniforms;
    wu.uReflOn.value = under ? 0 : 1;
    if (!under) {
      this.updateReflectionCamera(camera);
      r.setRenderTarget(this.reflRT);
      r.render(this.world, this.reflCam);
    }

    // 2. opaque world. Under water the sky is hidden: the surface covers it, and
    // bright HDR sky samples would otherwise bleed into anti-aliased silhouettes.
    if (under) {
      camera.layers.disable(SKY_LAYER);
      const z = -camera.position.y;
      const w = optics.uWaterScatter.value, kd = optics.uWaterKd.value;
      this._clear.setRGB(w.x * Math.exp(-kd.x * z), w.y * Math.exp(-kd.y * z), w.z * Math.exp(-kd.z * z), THREE.LinearSRGBColorSpace);
    } else {
      camera.layers.enable(SKY_LAYER);
      this._clear.setRGB(0, 0, 0);
    }
    r.setClearColor(this._clear);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.mainRT);
    r.render(this.world, camera);

    // 3. composite with water and particles
    const depth = this.mainRT.depthTexture;
    wu.tScene.value = this.mainRT.texture;
    wu.tDepth.value = depth;
    wu.tReflect.value = this.reflRT.texture;
    wu.uRes.value.set(this.width, this.height);
    wu.uNear.value = camera.near; wu.uFar.value = camera.far;
    const pu = this.particles.material.uniforms;
    pu.tDepth.value = depth;
    pu.uRes.value.set(this.width, this.height);
    pu.uNear.value = camera.near; pu.uFar.value = camera.far;
    pu.uProjScale.value = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.particles.visible = under;

    this.copyMat.uniforms.tSrc.value = this.mainRT.texture;
    this.drawQuad(this.copyMat, this.compRT);
    r.autoClear = false;
    r.render(this.overlay, camera);
    r.autoClear = true;

    // 4. light shafts
    if (under) {
      const u = this.raysMat.uniforms;
      u.tDepth.value = depth;
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uFrame.value = this.frame % 64;
      this.drawQuad(this.raysMat, this.raysRT);
    }

    // 5. bloom
    this.brightMat.uniforms.tSrc.value = this.compRT.texture;
    this.brightMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.drawQuad(this.brightMat, this.bloomA);
    const bw = this.bloomA.width, bh = this.bloomA.height;
    for (let i = 0; i < 2; i++) {
      this.blurMat.uniforms.tSrc.value = this.bloomA.texture;
      this.blurMat.uniforms.uDir.value.set((1 + i) / bw, 0);
      this.drawQuad(this.blurMat, this.bloomB);
      this.blurMat.uniforms.tSrc.value = this.bloomB.texture;
      this.blurMat.uniforms.uDir.value.set(0, (1 + i) / bh);
      this.drawQuad(this.blurMat, this.bloomA);
    }

    // 6. final
    const fu = this.finalMat.uniforms;
    fu.tColor.value = this.compRT.texture;
    fu.tRays.value = this.raysRT.texture;
    fu.tBloom.value = this.bloomA.texture;
    fu.uUnder.value = under ? 1 : 0;
    fu.uTime.value = time;
    r.toneMappingExposure = exposure;
    this.drawQuad(this.finalMat, null);
    this.frame++;
  }
}
