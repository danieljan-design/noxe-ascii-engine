import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, smooth, std, shadows } from './kit.js';

// Wheat farm at golden hour.
// Thousands of wheat stalks bend in rolling gusts; the aux pass gets the same bend and uses each stalk's
// direction as its "normal", so the orientation glyphs (| / \ -) follow the stalks as the wind moves them.
// Farmhouse, red barn, silo, windpump that spins with the wind, dirt road with power poles, hedgerows,
// a tractor kicking up dust, birds, streaky sunset clouds, low sun.
// Cursor: brushes through the wheat. Click the field: a ripple runs out through the stalks. Click the sky: birds scatter.

const C = (h) => new THREE.Color(h);
const UP = new THREE.Vector3(0, 1, 0);
const STALK_H = 1.1;
const HILLS_Z = -112;

// Fields are rotated parcels; each gets a crop tone. id > 0.78 is harvested stubble.
const FIELD_PAL = ['#e2b04c', '#ecd28e', '#d18e34', '#b8a646', '#e9bf63'].map((h) => new THREE.Color(h));
const hash2 = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const parcel = (x, z) => {
  const ang = 0.35, u = x * Math.cos(ang) + z * Math.sin(ang), v = -x * Math.sin(ang) + z * Math.cos(ang);
  return { id: hash2(Math.floor(u / 26), Math.floor(v / 18)), v };
};
const fieldColor = (x, z, out) => {
  const { id } = parcel(x, z);
  return out.copy(z > -32 ? FIELD_PAL[id < 0.5 ? 0 : 2] : FIELD_PAL[Math.floor(id * 4.99)]);
};

const WIND_GLSL = /* glsl */`
uniform float uTime;
uniform float uWind;
uniform float uGust;
uniform vec2 uWindDir;
uniform vec3 uCursor;
uniform float uBrush;
uniform vec4 uRipple;
float gustWave(vec2 p) {
  float a = dot(p, uWindDir) * 0.2 - uTime * 1.5;
  float n = 0.5 + 0.5 * sin(a + sin(dot(p, vec2(-uWindDir.y, uWindDir.x)) * 0.07) * 2.0);
  float n2 = 0.5 + 0.5 * sin(dot(p, uWindDir) * 0.53 - uTime * 2.3 + p.y * 0.2);
  return mix(0.5, pow(n, 2.0) * 0.8 + n2 * 0.2, uGust);
}
vec2 windPush(vec2 p) {
  vec2 push = uWindDir * uWind * (0.12 + 0.88 * gustWave(p)) * 0.55;
  push += vec2(sin(uTime * 3.3 + p.x * 1.9 + p.y), cos(uTime * 2.9 + p.y * 1.7)) * 0.03 * (0.3 + uWind);
  vec2 dc = p - uCursor.xz;
  float dl = length(dc);
  push += dc / max(dl, 1e-3) * uBrush * smoothstep(2.4, 0.0, dl);
  vec2 dr = p - uRipple.xy;
  float rr = length(dr);
  push += dr / max(rr, 1e-3) * uRipple.w * exp(-pow(rr - uRipple.z * 8.0, 2.0) * 0.25) * exp(-uRipple.z * 0.5);
  return push;
}
`;

// Shared vertex patch for the stalks, used by both the colour pass and the aux pass.
const windPatch = (U, aux) => (sh) => {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
    .replace('#include <beginnormal_vertex>', `
      vec3 wbase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float wscale = length(instanceMatrix[0].xyz);
      float wh = clamp(position.y / ${STALK_H.toFixed(2)}, 0.0, 1.3);
      vec2 wpush = windPush(wbase.xz);
      vec3 objectNormal = ${aux
        ? 'normalize(vec3(wpush.x * 2.0 * wh / wscale, 1.0, wpush.y * 2.0 * wh / wscale))'
        : 'normalize(vec3(0.0, 1.0, 0.0) + normal * 0.35)'};
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
      #endif`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.xz += wpush * wh * wh / wscale;
      transformed.y -= dot(wpush, wpush) * wh * wh * 0.3 / wscale;`);
};

export default {
  name: 'Farm',
  frame: {
    target: [0, 2.2, -24], radius: 13.8, elevation: -0.5, azimuth: 0, fov: 40, sway: 16, fit: 'height', maxPolar: 96, far: 330,
    // Tall frame: turn towards the sun so it stays in shot, wider lens for more sky and wheat.
    portrait: { azimuth: -20, fov: 56, radius: 37.9 * Math.tan((28 * Math.PI) / 180), target: [0, 3.0, -24], sway: 4 },
  },
  look: {
    weather: 'motes', wDensity: 0.014, wSpeed: 0.25, wWind: 1.2, wSway: 1.4, wBright: 0.9, wColor: '#ffe3a0',
    exposure: 1.4, saturation: 1.5, lift: 0.3, glyphGain: 1.3, bloom: 0.9, bloomThreshold: 0.6,
    tilt: 0.5, tiltCenter: 0.55, tiltWidth: 0.45, tiltFeather: 0.3, vignette: 0.4, cellFill: 0.42, bg: '#120802',
    setFill: { sky: 0.48, cloud: 0.7, dust: 0.75 },
  },

  create(ctx) {
    const scene = new THREE.Scene();
    const N = makeNoise(77);
    const rnd = mulberry32(13);
    const state = { sunHeight: 0.45, wind: 1.2, gusts: 1, brush: 0.9, birds: true, tractor: true, ripple: 0, scatter: 0 };
    const U = {
      uTime: { value: 0 }, uWind: { value: 1 }, uGust: { value: 1 }, uWindDir: { value: new THREE.Vector2(0.95, 0.3).normalize() },
      uCursor: { value: new THREE.Vector3(1e4, 0, 1e4) }, uBrush: { value: 0.9 }, uRipple: { value: new THREE.Vector4(0, 0, 99, 0) },
    };

    // ---------- landscape ----------
    const roadX = (z) => 7 - 16 * smooth(14, -44, z) + 1.5 * Math.sin(z * 0.09);
    const height = (x, z) => {
      const far = smooth(0, -60, z);
      let h = Math.max(0, -z) * 0.035;
      h += (N.fbm(x * 0.018 + 5, z * 0.018, 4) * 4.0 + N.fbm(x * 0.05, z * 0.05, 3) * 0.8) * (0.15 + 0.85 * far);
      h += smooth(-90, -170, z) * 7 * (0.6 + 0.4 * N.noise(x * 0.02, 3));
      return h;
    };
    const onRoad = (x, z) => z > -46 && Math.abs(x - roadX(z)) < 1.5;

    const sky = buildSky();
    const sun = buildSun();
    scene.add(sky.mesh, sun.group);
    scene.fog = new THREE.Fog('#f0b47a', 45, 260);
    scene.background = C('#f0b47a');

    const hemi = new THREE.HemisphereLight('#ffd7a6', '#6b3a1e', 0.85);
    const light = new THREE.DirectionalLight('#ffb36b', 3);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    const sc = light.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 160;
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.05;
    light.target.position.set(0, 0, -22);
    scene.add(hemi, light, light.target);

    const terrain = buildTerrain(height, roadX, onRoad, N, U);
    scene.add(terrain);
    const wheat = buildWheat(height, onRoad, rnd, U);
    scene.add(wheat);

    // ---------- farm ----------
    const farm = new THREE.Group();
    const place = (o, x, z, ry = 0, dy = 0) => { o.position.set(x, height(x, z) + dy, z); o.rotation.y = ry; farm.add(o); return o; };
    place(buildHouse(), -9, -45, 0.35, -0.1);
    place(buildBarn(), -1.5, -49, -0.25, -0.1);
    place(buildSilo(), 3.2, -51, 0, -0.1);
    place(buildShed(2.2, 1.4, 2.6, '#8a5a3c'), -14.5, -49, 0.5, -0.05);
    place(buildShed(1.6, 1.1, 1.8, '#6f5a48'), 5.5, -47, -0.4, -0.05);
    const pump = buildWindpump();
    place(pump.group, -15.5, -40, 0, -0.1);
    scene.add(farm);

    const poles = buildPoles(height, roadX);
    scene.add(poles);
    scene.add(buildTrees(height, rnd));
    const tractor = buildTractor();
    scene.add(tractor.group);
    const birds = buildBirds(rnd);
    scene.add(birds.mesh);
    const clouds = buildClouds(rnd);
    scene.add(clouds.group);

    // ---------- sun / time of day ----------
    const lerpC = (a, b, k) => C(a).lerp(C(b), k);
    const applySun = () => {
      const k = state.sunHeight;
      const el = THREE.MathUtils.degToRad(1.5 + k * 16), az = THREE.MathUtils.degToRad(28);
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      sun.setDir(dir);
      sky.set(dir, lerpC('#ff9a7a', '#ffd2a2', k), lerpC('#3a2a72', '#7279c4', k), lerpC('#ff7a1a', '#ffb347', k));
      light.position.copy(light.target.position).addScaledVector(dir, 80);
      light.color.copy(lerpC('#ff7a35', '#ffd09a', k));
      light.intensity = 2.2 + k * 1.4;
      hemi.color.copy(lerpC('#ff9d6c', '#ffe2b6', k));
      hemi.intensity = 0.65 + k * 0.35;
      const fog = lerpC('#e7966a', '#f0c48c', k);
      scene.fog.color.copy(fog);
      scene.background.copy(fog);
      clouds.tint(lerpC('#ff7a5a', '#ffd09a', k));
    };
    applySun();

    const ground = (ray, out) => {
      if (!ray || ray.direction.y > -0.002) return null;
      let y = 0;
      for (let i = 0; i < 3; i++) {
        const t = (y - ray.origin.y) / ray.direction.y;
        if (t < 0) return null;
        out.copy(ray.origin).addScaledVector(ray.direction, t);
        y = height(out.x, out.z);
      }
      out.y = y;
      return out.distanceTo(ray.origin) < 220 ? out : null;
    };
    const tmp = new THREE.Vector3();

    return {
      scene,
      update(t, dt) {
        U.uTime.value = t;
        U.uWind.value = state.wind;
        U.uGust.value = state.gusts;
        U.uBrush.value = state.brush;
        U.uRipple.value.z += dt;
        state.scatter = Math.max(0, state.scatter - dt * 0.25);
        sky.mesh.position.copy(ctx.camera.position);
        sun.halo.lookAt(ctx.camera.position);
        pump.update(t, dt, state.wind);
        tractor.group.visible = state.tractor;
        tractor.update(t, dt, height);
        birds.mesh.visible = state.birds;
        birds.update(t, dt, state.scatter);
        clouds.update(dt, state.wind);
        poles.userData.update?.(t, state.wind);
      },
      onMove(ray) {
        const p = ground(ray, tmp);
        U.uCursor.value.set(p ? p.x : 1e4, 0, p ? p.z : 1e4);
      },
      onClick(rc) {
        const p = ground(rc.ray, tmp);
        if (p) U.uRipple.value.set(p.x, p.z, 0, 1.6);
        else state.scatter = 1;
      },
      gui(folder) {
        folder.add(state, 'sunHeight', 0, 1, 0.01).name('sun height').onChange(applySun);
        folder.add(state, 'wind', 0, 2.5, 0.01);
        folder.add(state, 'gusts', 0, 1, 0.01).name('gust waves');
        folder.add(state, 'brush', 0, 2, 0.01).name('cursor brush');
        folder.add(state, 'birds');
        folder.add(state, 'tractor');
        folder.add({ go: () => { state.scatter = 1; } }, 'go').name('scatter birds  [click sky]');
      },
    };
  },
};

// ---------------------------------------------------------------------------

function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: new THREE.Vector3() }, uHorizon: { value: new THREE.Color() }, uZenith: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() } },
    vertexShader: /* glsl */`varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform vec3 uSun; uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uSunCol; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, d.y));
        float s = max(dot(d, uSun), 0.0);
        c += uSunCol * (pow(s, 5.0) * 0.55 + pow(s, 60.0) * 1.2);
        c = mix(c, uHorizon * 0.85, smoothstep(0.0, -0.2, d.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  mat.userData.glyph = 'sky';
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), mat);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  return {
    mesh,
    set(dir, horizon, zenith, sunCol) {
      mat.uniforms.uSun.value.copy(dir);
      mat.uniforms.uHorizon.value.copy(horizon);
      mat.uniforms.uZenith.value.copy(zenith);
      mat.uniforms.uSunCol.value.copy(sunCol);
    },
  };
}

function buildSun() {
  const group = new THREE.Group();
  const discMat = new THREE.MeshBasicMaterial({ color: '#fff3c8', fog: false });
  discMat.userData.glyph = 'glow';
  const disc = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 12), discMat);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`varying vec2 vUv; void main() { float d = length(vUv - 0.5) * 2.0;
      float a = (exp(-d * d * 14.0) * 0.6 + exp(-d * 4.0) * 0.3) * smoothstep(1.0, 0.5, d); gl_FragColor = vec4(vec3(1.0, 0.78, 0.45) * a, 1.0); }`,
  }));
  group.add(disc, halo);
  return {
    group, halo,
    setDir(dir) { disc.position.copy(dir).multiplyScalar(128); halo.position.copy(dir).multiplyScalar(126); },
  };
}

function buildTerrain(height, roadX, onRoad, N, U) {
  const W = 300, D = 240, SX = 150, SZ = 120;
  const g = new THREE.PlaneGeometry(W, D, SX, SZ);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -D / 2 + 34);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, height(pa.getX(i), pa.getZ(i)));
  const P = g.toNonIndexed().attributes.position.array;
  const groups = [[], [], [], []], cols = [[], [], [], []];
  const col = new THREE.Color();
  const stubA = C('#c7a066'), stubB = C('#a98450'), road = C('#a58055'), hillNear = C('#b9737a'), hillFar = C('#8d6a96');
  for (let i = 0; i < P.length; i += 9) {
    const cx = (P[i] + P[i + 3] + P[i + 6]) / 3, cz = (P[i + 2] + P[i + 5] + P[i + 8]) / 3;
    const { id, v } = parcel(cx, cz);
    let k = 0;
    if (cz < HILLS_Z + N.noise(cx * 0.03, 7) * 12) { k = 3; col.lerpColors(hillNear, hillFar, smooth(HILLS_Z, -200, cz)).offsetHSL(0, 0, N.noise(cx * 0.1, cz * 0.1) * 0.03); }
    else if (onRoad(cx, cz)) { k = 2; col.copy(road); }
    else if (cz < -32 && id > 0.78) { k = 1; col.copy(Math.floor(v * 1.1) % 2 ? stubA : stubB); }
    else fieldColor(cx, cz, col).offsetHSL(0, 0, N.noise(cx * 0.3, cz * 0.3) * 0.045);
    for (let j = 0; j < 9; j++) groups[k].push(P[i + j]);
    for (let j = 0; j < 3; j++) cols[k].push(col.r, col.g, col.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...groups), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([].concat(...cols), 3));
  let start = 0;
  groups.forEach((arr, k) => { geo.addGroup(start, arr.length / 3, k); start += arr.length / 3; });
  geo.computeVertexNormals();

  // Wheat fields shimmer as gusts pass: brightness follows the same wave that bends the stalks.
  const wheatM = std('#ffffff', 'wheat', { vertexColors: true, roughness: 0.9 });
  wheatM.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${WIND_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 0.8 + 0.45 * gustWave(vWPos.xz) * min(uWind, 1.5);`);
  };
  wheatM.customProgramCacheKey = () => 'farm-field';
  const hillsM = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  hillsM.userData.glyph = 'dust';
  const mesh = new THREE.Mesh(geo, [wheatM, std('#ffffff', 'sand', { vertexColors: true, roughness: 1 }), std('#ffffff', 'dust', { vertexColors: true, roughness: 1 }), hillsM]);
  mesh.receiveShadow = true;
  return mesh;
}

function clumpGeometry(rnd, n) {
  const pos = [], col = [];
  const stem = C('#9c7230'), stemTop = C('#cf9d48'), head = C('#f0c45e'), tip = C('#ffe394');
  const quad = (a, b, c, d, ca, cb, cc, cd) => {
    for (const [p, q, r, cp, cq, cr] of [[a, b, c, ca, cb, cc], [a, c, d, ca, cc, cd], [a, c, b, ca, cc, cb], [a, d, c, ca, cd, cc]]) {
      pos.push(...p, ...q, ...r);
      col.push(cp.r, cp.g, cp.b, cq.r, cq.g, cq.b, cr.r, cr.g, cr.b);
    }
  };
  for (let i = 0; i < n; i++) {
    const ox = (rnd() - 0.5) * 0.4, oz = (rnd() - 0.5) * 0.4, yaw = rnd() * Math.PI, h = STALK_H * (0.8 + rnd() * 0.35);
    const lx = (rnd() - 0.5) * 0.14, lz = (rnd() - 0.5) * 0.14, ux = Math.cos(yaw), uz = Math.sin(yaw);
    const P = (t, w) => [ox + lx * t * t + ux * w, h * t, oz + lz * t * t + uz * w];
    const ws = 0.015, wh = 0.045;
    const segs = [0, 0.33, 0.62, 0.8];
    for (let k = 0; k < 3; k++) {
      const c0 = stem.clone().lerp(stemTop, segs[k]), c1 = stem.clone().lerp(stemTop, segs[k + 1]);
      quad(P(segs[k], -ws), P(segs[k], ws), P(segs[k + 1], ws), P(segs[k + 1], -ws), c0, c0, c1, c1);
    }
    quad(P(0.8, -ws), P(0.8, ws), P(0.88, wh), P(0.88, -wh), stemTop, stemTop, head, head);
    quad(P(0.88, -wh), P(0.88, wh), P(1.0, 0.005), P(1.0, -0.005), head, head, tip, tip);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildWheat(height, onRoad, rnd, U) {
  const near = [], far = [];
  const farmYard = (x, z) => x > -24 && x < 12 && z < -36 && z > -62;
  const region = (list, x0, x1, z0, z1, density, s0, s1) => {
    const n = Math.round((x1 - x0) * (z1 - z0) * density);
    for (let i = 0; i < n; i++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (onRoad(x, z) || farmYard(x, z) || (z > 9.5 && Math.abs(x) < 16)) continue;
      if (z < -32 && parcel(x, z).id > 0.78) continue;
      // Spread out with distance so the far field covers the view width.
      list.push([x, height(x, z) - 0.05, z, s0 + rnd() * (s1 - s0)]);
    }
  };
  region(near, -26, 26, 2, 15, 5.0, 1.0, 1.45);
  region(near, -36, 36, -12, 2, 2.6, 0.95, 1.25);
  region(near, -50, 50, -31, -12, 1.0, 0.9, 1.15);
  region(far, -85, 85, -68, -31, 0.42, 1.25, 1.75);
  region(far, -140, 140, HILLS_Z + 4, -68, 0.14, 1.7, 2.5);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, emissive: '#6a3a08', emissiveIntensity: 0.6 });
  mat.userData.glyph = 'wheat';
  mat.onBeforeCompile = windPatch(U, false);
  mat.customProgramCacheKey = () => 'farm-wheat';
  mat.userData.auxPatch = windPatch(U, true);
  mat.userData.auxPatchKey = 'farm-wheat';
  const m = new THREE.Matrix4(), tint = new THREE.Color(), base = C('#e2b04c');
  const group = new THREE.Group();
  for (const [list, stalks] of [[near, 4], [far, 2]]) {
    const mesh = new THREE.InstancedMesh(clumpGeometry(rnd, stalks), mat, list.length);
    list.forEach(([x, y, z, s], i) => {
      mesh.setMatrixAt(i, m.makeScale(s, s, s).setPosition(x, y, z));
      // Tint each clump towards its field's crop tone.
      fieldColor(x, z, tint);
      mesh.setColorAt(i, tint.set(tint.r / base.r, tint.g / base.g, tint.b / base.b));
    });
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function buildHouse() {
  const g = new THREE.Group();
  g.userData.glyph = 'default';
  const wall = std('#e6d6bd'), roof = std('#5a4640', 'wood'), trim = std('#7a5a44', 'wood');
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(new THREE.BoxGeometry(3.2, 2.6, 2.4), wall, 0, 1.3, 0);
  const r = 1.85;
  const roofG = new THREE.CylinderGeometry(r, r, 3.6, 3, 1, false, Math.PI / 2).rotateZ(Math.PI / 2);
  add(roofG, roof, 0, 2.6 + r / 2, 0).scale.set(1, 0.75, 0.8);
  add(new THREE.BoxGeometry(0.35, 1.4, 0.35), std('#7a5040', 'brick'), 0.9, 3.6, -0.2);
  const win = std('#ffd28a', 'glow', { emissive: '#ffa850', emissiveIntensity: 0.9 });
  for (const x of [-0.9, 0, 0.9]) add(new THREE.BoxGeometry(0.42, 0.55, 0.05), win, x, 1.9, 1.22);
  for (const x of [-0.9, 0.9]) add(new THREE.BoxGeometry(0.42, 0.55, 0.05), win, x, 0.9, 1.22);
  add(new THREE.BoxGeometry(0.5, 1.0, 0.05), trim, 0, 0.5, 1.22);
  add(new THREE.BoxGeometry(3.5, 0.08, 1.0), trim, 0, 1.25, 1.7);
  for (const x of [-1.6, 1.6]) add(new THREE.BoxGeometry(0.08, 1.25, 0.08), trim, x, 0.62, 2.15);
  return shadows(g);
}

function buildBarn() {
  const g = new THREE.Group();
  g.userData.glyph = 'brick';
  const red = std('#9b3b2a'), roof = std('#4a3a36', 'wood'), white = std('#efe6d6', 'default');
  const W = 3.8, H = 2.6, L = 5.0;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, L), red);
  body.position.y = H / 2;
  const s = new THREE.Shape();
  s.moveTo(-W / 2 - 0.15, 0); s.lineTo(-W / 2 + 0.25, 1.0); s.lineTo(0, 1.75); s.lineTo(W / 2 - 0.25, 1.0); s.lineTo(W / 2 + 0.15, 0); s.lineTo(-W / 2 - 0.15, 0);
  const roofG = new THREE.ExtrudeGeometry(s, { depth: L + 0.3, bevelEnabled: false }).translate(0, 0, -(L + 0.3) / 2);
  const roofM = new THREE.Mesh(roofG, roof);
  roofM.position.y = H;
  g.add(body, roofM);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 0.05), red);
  door.position.set(0, 0.9, L / 2 + 0.03);
  g.add(door);
  for (const [w, h, x, y, rz] of [[1.7, 0.08, 0, 1.8, 0], [1.7, 0.08, 0, 0.02, 0], [0.08, 1.8, -0.8, 0.9, 0], [0.08, 1.8, 0.8, 0.9, 0], [2.3, 0.07, 0, 0.9, 0.84], [2.3, 0.07, 0, 0.9, -0.84]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), white);
    b.position.set(x, y, L / 2 + 0.07);
    b.rotation.z = rz;
    g.add(b);
  }
  const loft = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.05), std('#2a1a14', 'default'));
  loft.position.set(0, H + 0.7, L / 2 + 0.16);
  g.add(loft);
  return shadows(g);
}

function buildSilo() {
  const g = new THREE.Group();
  g.userData.glyph = 'metal';
  const m = std('#bdb6aa', 'metal', { flatShading: true, metalness: 0.2, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 5.6, 14), m);
  body.position.y = 2.8;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.97, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), std('#9a948c', 'metal'));
  dome.position.y = 5.6;
  g.add(body, dome);
  for (let y = 0.8; y < 5.5; y += 1.1) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 0.98, 0.06, 14, 1, true), std('#7e786f', 'metal'));
    band.position.y = y;
    g.add(band);
  }
  return shadows(g);
}

function buildShed(w, h, d, color) {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color));
  body.position.y = h / 2;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.1, d + 0.3), std('#4d3f3a'));
  roof.position.y = h + 0.1;
  roof.rotation.x = 0.15;
  g.add(body, roof);
  return shadows(g);
}

function buildWindpump() {
  const group = new THREE.Group();
  group.userData.glyph = 'metal';
  const steel = std('#8f9296', 'metal', { metalness: 0.3, roughness: 0.5 });
  const H = 6.5;
  const leg = (bx, bz) => {
    const a = new THREE.Vector3(bx, 0, bz), b = new THREE.Vector3(bx * 0.18, H, bz * 0.18);
    const d = b.clone().sub(a), len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, len, 5), steel);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize());
    group.add(m);
  };
  for (const [x, z] of [[0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]]) leg(x, z);
  for (const y of [1.6, 3.2, 4.8]) {
    const s = 0.9 * (1 - (y / H) * 0.82);
    for (const [ax, az, rot] of [[0, s, 0], [0, -s, 0], [s, 0, Math.PI / 2], [-s, 0, Math.PI / 2]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(2 * s, 0.04, 0.04), steel);
      b.position.set(ax, y, az);
      b.rotation.y = rot;
      group.add(b);
    }
  }
  const head = new THREE.Group();
  head.position.y = H + 0.2;
  group.add(head);
  const rotor = new THREE.Group();
  rotor.position.x = 0.3;
  head.add(rotor);
  const blade = new THREE.BoxGeometry(0.03, 1.25, 0.24).translate(0, 0.85, 0);
  for (let i = 0; i < 16; i++) {
    const b = new THREE.Mesh(blade, std('#b9b2a6', 'metal'));
    b.rotation.x = (i / 16) * Math.PI * 2;
    b.rotation.y = 0.35;
    rotor.add(b);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.2, 10).rotateZ(Math.PI / 2), steel);
  rotor.add(hub);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.04), std('#a0392c', 'brick'));
  tail.position.x = -1.1;
  head.add(tail);
  head.rotation.y = Math.PI * 0.85;
  shadows(group);
  return { group, update(t, dt, wind) { rotor.rotation.x += dt * (0.6 + wind * 3.2); } };
}

function buildPoles(height, roadX) {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const wood = std('#4d3a2c'), wire = std('#2a2422', 'metal');
  const tops = [];
  for (let z = 6; z > -46; z -= 10.5) {
    const x = roadX(z) + 2.4, y = height(x, z);
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 6, 6), wood);
    p.position.set(x, y + 3, z);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.08), wood);
    bar.position.set(x, y + 5.6, z);
    g.add(p, bar);
    tops.push([new THREE.Vector3(x - 0.6, y + 5.65, z), new THREE.Vector3(x + 0.6, y + 5.65, z)]);
  }
  for (let i = 0; i < tops.length - 1; i++) for (let k = 0; k < 2; k++) {
    const a = tops[i][k], b = tops[i + 1][k];
    let prev = a.clone();
    for (let s = 1; s <= 6; s++) {
      const t = s / 6, p = a.clone().lerp(b, t);
      p.y -= Math.sin(t * Math.PI) * 0.6;
      const d = p.clone().sub(prev), len = d.length();
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, len, 3), wire);
      w.position.copy(prev).addScaledVector(d, 0.5);
      w.quaternion.setFromUnitVectors(UP, d.normalize());
      g.add(w);
      prev = p;
    }
  }
  return shadows(g);
}

function buildTrees(height, rnd) {
  const pts = [];
  const add = (x, z, s) => pts.push([x, height(x, z) - 0.2, z, s, rnd()]);
  for (let i = 0; i < 12; i++) add(-20 + rnd() * 30, -54 - rnd() * 6, 1.2 + rnd() * 0.8);
  for (let i = 0; i < 5; i++) add(-17 + rnd() * 4, -46 + rnd() * 6, 1.0 + rnd() * 0.6);
  for (const [z0, x0, x1, gap0, gap1] of [[-33, -70, 70, -8, 14], [-62, -110, 110, 0, 0], [-85, -120, 120, 0, 0]]) {
    for (let x = x0; x < x1; x += 2.2 + rnd() * 2.5) {
      if (x > gap0 && x < gap1) continue;
      if (rnd() < 0.25) continue;
      add(x, z0 + (rnd() - 0.5) * 3, 0.9 + rnd() * 0.9);
    }
  }
  add(-19, 5, 1.4); add(-20.5, 6.5, 1.1); add(12, 6.5, 1.5); add(13.5, 8, 1.0);
  const blobs = mergeGeometries([
    new THREE.CylinderGeometry(0.12, 0.18, 1.4, 6).translate(0, 0.7, 0),
    new THREE.IcosahedronGeometry(1.0, 1).translate(0, 2.0, 0),
    new THREE.IcosahedronGeometry(0.75, 1).translate(0.7, 1.7, 0.2),
    new THREE.IcosahedronGeometry(0.7, 1).translate(-0.6, 1.8, -0.3),
  ].map((x) => x.toNonIndexed()));
  const mesh = new THREE.InstancedMesh(blobs, std('#ffffff', 'foliage', { roughness: 1 }), pts.length);
  const pal = ['#5d6a2a', '#6f7230', '#46511f', '#7a6a2c'].map(C);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  pts.forEach(([x, y, z, k, r], i) => {
    q.setFromAxisAngle(UP, r * 6.28);
    mesh.setMatrixAt(i, m.compose(v.set(x, y, z), q, s.set(k, k * (0.85 + r * 0.3), k)));
    mesh.setColorAt(i, pal[Math.floor(r * pal.length)]);
  });
  return shadows(mesh);
}

function buildTractor() {
  const group = new THREE.Group();
  group.userData.glyph = 'metal';
  const body = std('#3f6e3a'), dark = std('#1f1f1f', 'stone'), cab = std('#d9d2c2', 'default');
  const add = (geo, mat, x, y, z, parent = group) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  add(new THREE.BoxGeometry(1.4, 0.6, 0.8), body, 0.3, 0.75, 0);
  add(new THREE.BoxGeometry(0.8, 0.8, 0.85), cab, -0.35, 1.35, 0);
  add(new THREE.BoxGeometry(0.9, 0.06, 0.95), body, -0.35, 1.78, 0);
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 5), dark, 0.75, 1.25, 0.2);
  const wheels = [];
  for (const [x, r, z] of [[-0.45, 0.48, 0.5], [-0.45, 0.48, -0.5], [0.75, 0.28, 0.45], [0.75, 0.28, -0.45]]) {
    wheels.push(add(new THREE.CylinderGeometry(r, r, 0.26, 12).rotateX(Math.PI / 2), dark, x, r, z));
  }
  shadows(group);
  const dust = [];
  const dustM = std('#d9b88a', 'dust', { roughness: 1 });
  for (let i = 0; i < 12; i++) {
    const d = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), dustM);
    d.castShadow = false;
    dust.push({ m: d, age: i / 12, p: new THREE.Vector3() });
  }
  const dustGroup = new THREE.Group();
  dust.forEach((d) => dustGroup.add(d.m));
  const root = new THREE.Group();
  root.add(group, dustGroup);
  let x = -40, dir = 1;
  return {
    group: root,
    update(t, dt, height) {
      x += dir * dt * 2.2;
      if (x > 42) dir = -1; else if (x < -42) dir = 1;
      const z = -23;
      group.position.set(x, height(x, z), z);
      group.rotation.y = dir > 0 ? 0 : Math.PI;
      group.rotation.z = Math.sin(t * 9) * 0.015;
      wheels.forEach((w) => { w.rotation.z -= dt * 2.2 * dir * 3; });
      for (const d of dust) {
        d.age += dt / 2.2;
        if (d.age > 1) { d.age -= 1; d.p.set(x - dir * 0.9, height(x, z) + 0.3, z + (Math.random() - 0.5) * 0.6); }
        const k = d.age;
        d.m.position.set(d.p.x - dir * k * 0.8, d.p.y + k * 0.9, d.p.z);
        d.m.scale.setScalar(Math.max(0.0001, (0.15 + k * 0.6) * (1 - k)));
      }
    },
  };
}

function buildBirds(rnd) {
  const N = 38;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, -0.35, 0.18, -0.85, 0.15, 0, 0,
    0, 0, 0, 0.15, 0, 0, -0.35, 0.18, 0.85,
  ], 3));
  geo.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(geo, std('#5a3a30', 'birds', { side: THREE.DoubleSide, fog: false }), N);
  mesh.frustumCulled = false;
  const birds = Array.from({ length: N }, (_, i) => {
    const row = Math.floor((i + 1) / 2), side = i % 2 ? 1 : -1;
    return { o: new THREE.Vector3(-row * 1.3, (rnd() - 0.5) * 0.6, side * row * 1.1).add(new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).multiplyScalar(0.8)), ph: rnd() * 6.28, sc: new THREE.Vector3((rnd() - 0.5) * 30, rnd() * 10, (rnd() - 0.5) * 30) };
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Vector3();
  return {
    mesh,
    update(t, dt, scatter) {
      const T = (t * 3.2) % 190;
      c.set(-95 + T, 22 + Math.sin(t * 0.2) * 3, -70 + Math.sin(t * 0.07) * 8);
      birds.forEach((b, i) => {
        v.copy(c).add(b.o).addScaledVector(b.sc, scatter * scatter);
        v.y += Math.sin(t * 0.8 + b.ph) * 0.4;
        q.setFromEuler(e.set(0, 0, Math.sin(t * 0.5 + b.ph) * 0.1));
        const flap = Math.sin(t * (7 + scatter * 6) + b.ph);
        mesh.setMatrixAt(i, m.compose(v, q, s.set(1.1, 1 + flap * 1.6, 1.1)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildClouds(rnd) {
  const group = new THREE.Group();
  group.userData.glyph = 'cloud';
  const mat = std('#ffd2a6', 'cloud', { roughness: 1, fog: false, emissive: '#ffb27a', emissiveIntensity: 0.7 });
  const list = [];
  for (let i = 0; i < 11; i++) {
    const c = new THREE.Group();
    const n = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), mat);
      p.scale.set(5 + rnd() * 6, 0.7 + rnd() * 0.8, 1.6 + rnd() * 1.8);
      p.position.set((rnd() - 0.5) * 12, (rnd() - 0.5) * 1.6, (rnd() - 0.5) * 4);
      p.castShadow = false;
      c.add(p);
    }
    c.position.set(-80 + rnd() * 160, 22 + rnd() * 24, -72 - rnd() * 40);
    c.rotation.set(0, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.12);
    group.add(c);
    list.push(c);
  }
  return {
    group,
    tint(col) { mat.color.copy(col); mat.emissive.copy(col).multiplyScalar(0.8); },
    update(dt, wind) {
      for (const c of list) {
        c.position.x += dt * (0.4 + wind * 0.6);
        if (c.position.x > 90) c.position.x = -90;
      }
    },
  };
}
