import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, smooth, std, shadows } from './kit.js';

// Winter cabin on a frozen lake, at night.
// Moon, stars, aurora, mirror lake with ice floes, snowy pines that sway in the wind,
// cabin with warm windows and chimney smoke, dock lantern, campfire with sparks.
// Clicks: cabin = lights on/off, fire = stoke, anywhere else = gust of wind.

const C = (h) => new THREE.Color(h);
const UP = new THREE.Vector3(0, 1, 0);

// Layout. The lake is a long rotated ellipse that runs from the near-right foreground back towards the
// mountains on the right. The camera stands on the near-left bank looking across to the cabin on the far shore.
const LAKE = { cx: 16, cz: -3, rx: 21, rz: 14.5, a: -0.3 };
const CAM = { target: [2, 2.4, -7], dist: 26, az: -14, el: 4, sway: 16, fov: 38 };
const camBase = (deg = 0) => {
  const a = THREE.MathUtils.degToRad(CAM.az + deg);
  return [CAM.target[0] + Math.sin(a) * CAM.dist, CAM.target[2] + Math.cos(a) * CAM.dist];
};
function lakeDist(N, x, z) {
  const dx = x - LAKE.cx, dz = z - LAKE.cz, c = Math.cos(LAKE.a), sn = Math.sin(LAKE.a);
  const u = dx * c + dz * sn, v = -dx * sn + dz * c;
  return Math.hypot(u / LAKE.rx, v / LAKE.rz) + N.fbm(x * 0.08 + 3.3, z * 0.08 - 1.7, 3) * 0.12;
}

export default {
  name: 'Winter',
  frame: {
    target: CAM.target, radius: CAM.dist * Math.tan(THREE.MathUtils.degToRad(CAM.fov / 2)),
    elevation: CAM.el, azimuth: CAM.az, fov: CAM.fov, sway: CAM.sway, fit: 'height',
    // Tall frame: aim closer to the cabin and open the lens so sky and lake both fit.
    portrait: { target: [-1.5, 3.6, -8.5], azimuth: -10, fov: 54, radius: CAM.dist * Math.tan(THREE.MathUtils.degToRad(27)), sway: 10 },
  },
  look: {
    // Snow here is real 3D snowfall (see buildSnow), so the flat weather overlay is off.
    weather: 'none', wDensity: 0.05, wSpeed: 4, wWind: 0.35,
    exposure: 1.8, saturation: 1.1, bloom: 0.9, bloomThreshold: 0.42,
    tilt: 0.45, tiltCenter: 0.5, tiltWidth: 0.6, tiltFeather: 0.35, vignette: 0.45, cellFill: 0.14,
  },

  create(ctx) {
    const { params, engine } = ctx;
    const scene = new THREE.Scene();
    scene.background = C('#081026');
    scene.fog = new THREE.Fog('#14213d', 30, 115);
    const N = makeNoise(23);
    const rnd = mulberry32(5);
    const state = { aurora: 1, moonGlow: 1, fire: 1, lights: true, smoke: true, gust: 0, stoke: 0, lightsK: 1, snowfall: 0.9, snowSpeed: 1, snowBright: 0.95, flakeSize: 0.1 };

    // ---------- terrain ----------
    const land = (x, z) => smooth(1.0, 1.1, lakeDist(N, x, z));
    const height = (x, z) => {
      const l = land(x, z);
      let h = -0.6 + l * (0.95 + N.fbm(x * 0.22, z * 0.22, 4) * 0.45);
      h += l * Math.max(0, N.fbm(x * 0.5 + 9, z * 0.5, 2)) * 0.35;
      h += l * smooth(20, 40, Math.hypot(x, z)) * (1.2 + N.fbm(x * 0.1, z * 0.1, 3) * 1.2);
      return h;
    };
    scene.add(buildGround(height, N));
    scene.add(buildMountains(N));

    // ---------- lake ----------
    const mirror = new Reflector(new THREE.PlaneGeometry(170, 170), {
      textureWidth: 1024, textureHeight: 1024, clipBias: 0.003, color: 0x6a7a96,
    });
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.set(LAKE.cx, 0, LAKE.cz);
    mirror.userData.glyph = 'ice';
    scene.add(mirror);
    scene.add(buildIce(land, rnd));

    // ---------- sky ----------
    const sky = buildSky();
    const stars = buildStars(rnd);
    const moon = buildMoon(N);
    const aurora = buildAurora();
    scene.add(sky, stars.points, moon.group, aurora.group);

    // ---------- lights ----------
    const hemi = new THREE.HemisphereLight('#5b78b8', '#1a2236', 1.0);
    const moonLight = new THREE.DirectionalLight('#b4c8ff', 2.2);
    moonLight.position.set(moon.dir.x, 0.75, moon.dir.z).normalize().multiplyScalar(30).add(new THREE.Vector3(-3, 0, -6));
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.set(2048, 2048);
    const sc = moonLight.shadow.camera;
    sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 80;
    moonLight.target.position.set(-3, 0, -6);
    moonLight.shadow.bias = -0.0004;
    moonLight.shadow.normalBias = 0.03;
    scene.add(hemi, moonLight, moonLight.target);

    // ---------- cabin (far shore) ----------
    // Cabin on the far-left shore, set back from the water and turned a little so its right side shows.
    // Walk out from the middle of the lake towards the far-left until we reach the shore.
    const away = new THREE.Vector3(-5 - LAKE.cx, 0, -11 - LAKE.cz).normalize();
    const cab = new THREE.Vector3(LAKE.cx, 0, LAKE.cz);
    while (land(cab.x, cab.z) < 0.99) cab.addScaledVector(away, 0.2);
    cab.addScaledVector(away, 1.4);
    const [camX, camZ] = camBase();
    const cabin = buildCabin();
    cabin.group.position.set(cab.x, height(cab.x, cab.z) - 0.08, cab.z);
    cabin.group.rotation.y = Math.atan2(camX - cab.x, camZ - cab.z) - 0.35;
    cabin.group.scale.setScalar(1.35);
    scene.add(cabin.group);
    cabin.group.updateMatrixWorld(true);
    const onCabin = (lx, lz) => cabin.group.localToWorld(new THREE.Vector3(lx, 0, lz));

    // Fire pit on the cabin's right side, right next to it.
    let fz = 0.55;
    while (fz > -2 && land(onCabin(2.15, fz).x, onCabin(2.15, fz).z) < 0.98) fz -= 0.2;
    const fp = onCabin(2.15, fz);
    const fire = buildFire();
    fire.group.position.set(fp.x, height(fp.x, fp.z) - 0.04, fp.z);
    scene.add(fire.group);

    // Dock with a lantern off the cabin's left front, out into the lake.
    const dp = onCabin(-1.7, 1.4);
    const dock = buildDock();
    dock.group.position.set(dp.x, 0, dp.z);
    dock.group.rotation.y = cabin.group.rotation.y;
    scene.add(dock.group);
    const dockEnd = onCabin(-1.7, 1.4 + 3.0 / 1.35);

    // ---------- trees ----------
    const avoid = [[cab.x, cab.z, 3.4], [fp.x, fp.z, 2.0], [dp.x, dp.z, 1.4], [dockEnd.x, dockEnd.z, 1.4]];
    const pines = buildPines(land, height, rnd, avoid);
    scene.add(pines.group);
    const bare = buildBareTree(rnd);
    const b1 = onCabin(-3.3, -0.4);
    const b2 = new THREE.Vector3(camX + 5, 0, camZ - 9);
    while (land(b2.x, b2.z) < 0.97) b2.x -= 0.3;
    for (const [x, z, s, ry] of [[b1.x, b1.z, 1.25, 0.6], [b2.x - 1, b2.z, 1.1, 2.2]]) {
      const t = new THREE.Mesh(bare, std('#2c2624', 'wood'));
      t.position.set(x, height(x, z) - 0.1, z);
      t.scale.setScalar(s);
      t.rotation.y = ry;
      scene.add(shadows(t));
    }
    scene.add(buildRocks(land, height, rnd, avoid));
    // Tree line climbing the lower mountain slopes.
    const surface = (x, z) => Math.max(mountainHeight(N, x, z), Math.abs(x) < 55 && Math.abs(z) < 55 ? height(x, z) : -99);
    scene.add(buildFarPines(N, surface, rnd));

    // ---------- 3D snowfall ----------
    const snowfall = buildSnow(rnd);
    scene.add(snowfall.points);
    scene.userData.cellParticles = [snowfall.points];

    // ---------- chimney smoke ----------
    const smoke = buildSmoke();
    scene.add(smoke.group);
    cabin.group.updateMatrixWorld(true);
    const chimneyTop = cabin.chimneyTop.clone().applyMatrix4(cabin.group.matrixWorld);

    // ---------- interaction ----------
    const clickable = [cabin.group, fire.group];
    const raycastHit = (rc) => rc.intersectObjects(clickable, true)[0]?.object;
    const isIn = (o, root) => { while (o) { if (o === root) return true; o = o.parent; } return false; };

    return {
      scene,
      update(t, dt) {
        state.gust = Math.max(0, state.gust - dt * 0.45);
        state.stoke = Math.max(0, state.stoke - dt * 0.35);
        const gust = state.gust * state.gust;
        engine.windBoost = gust * 2.4;
        const wind = params.wWind + gust * 2.4;

        sky.position.copy(ctx.camera.position);
        stars.points.position.copy(ctx.camera.position);
        stars.material.uniforms.uTime.value = t;
        stars.material.uniforms.uPx.value = engine.size.cellCss * params.detail * 1.05;
        moon.halo.lookAt(ctx.camera.position);
        moon.halo.material.uniforms.uStrength.value = state.moonGlow;
        aurora.material.uniforms.uTime.value = t;
        aurora.material.uniforms.uIntensity.value = state.aurora;

        pines.update(t, wind);
        snowfall.update(dt, wind, state, engine.size, ctx.camera);
        fire.update(t, dt, state.fire, state.stoke, wind);
        smoke.update(dt, chimneyTop, wind, state.smoke);

        // Cabin lights ease on and off.
        state.lightsK += ((state.lights ? 1 : 0) - state.lightsK) * Math.min(1, dt * 4);
        cabin.windowMat.emissiveIntensity = 2.6 * state.lightsK;
        cabin.light.intensity = 3.2 * state.lightsK;
        dock.lantern.intensity = 2.2 * (0.92 + 0.08 * Math.sin(t * 3.1));
      },
      onClick(rc) {
        const hit = raycastHit(rc);
        if (hit && isIn(hit, cabin.group)) state.lights = !state.lights;
        else if (hit && isIn(hit, fire.group)) state.stoke = 1;
        else state.gust = 1;
      },
      gui(folder) {
        folder.add(state, 'aurora', 0, 2, 0.01);
        folder.add(state, 'moonGlow', 0, 2, 0.01).name('moon glow');
        folder.add(state, 'fire', 0, 2, 0.01);
        folder.add(state, 'lights').name('cabin lights').listen();
        folder.add(state, 'smoke').name('chimney smoke');
        folder.add(state, 'snowfall', 0, 1.5, 0.01);
        folder.add(state, 'snowSpeed', 0, 3, 0.01).name('snow speed');
        folder.add(state, 'snowBright', 0, 1, 0.01).name('snow brightness');
        folder.add(state, 'flakeSize', 0.02, 0.3, 0.005).name('flake size');
        folder.add({ gust: () => { state.gust = 1; } }, 'gust').name('gust of wind  [click sky]');
        folder.add({ stoke: () => { state.stoke = 1; } }, 'stoke').name('stoke fire  [click fire]');
      },
      dispose() { engine.windBoost = 0; mirror.dispose(); },
    };
  },
};

// ---------------------------------------------------------------------------

function buildGround(height, N) {
  const SIZE = 110, SEG = 220;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, height(pa.getX(i), pa.getZ(i)));
  const P = g.toNonIndexed().attributes.position.array;
  const out = [[], []], cols = [[], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), col = new THREE.Color();
  const snowA = C('#edf2fb'), snowB = C('#c9d6ea'), rock = C('#3d4555'), bed = C('#1a2436');
  for (let i = 0; i < P.length; i += 9) {
    a.fromArray(P, i); b.fromArray(P, i + 3); c.fromArray(P, i + 6);
    if (Math.max(a.y, b.y, c.y) < -0.3) continue;
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    const cy = (a.y + b.y + c.y) / 3;
    const v = N.noise((a.x + b.x + c.x) * 0.5, (a.z + b.z + c.z) * 0.5) * 0.5 + 0.5;
    let k = 0;
    if (cy < -0.05) col.copy(bed);
    else if (Math.abs(n.y) < 0.62) { k = 1; col.copy(rock).offsetHSL(0, 0, (v - 0.5) * 0.06); }
    else col.lerpColors(snowA, snowB, v * 0.7);
    for (let j = 0; j < 9; j++) out[k].push(P[i + j]);
    for (let j = 0; j < 3; j++) cols[k].push(col.r, col.g, col.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...out), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([].concat(...cols), 3));
  geo.addGroup(0, out[0].length / 3, 0);
  geo.addGroup(out[0].length / 3, out[1].length / 3, 1);
  geo.computeVertexNormals();
  const mat = (glyph) => std('#ffffff', glyph, { vertexColors: true, roughness: 0.9 });
  return shadows(new THREE.Mesh(geo, [mat('snow'), mat('stone')]));
}

const MR0 = 34, MR1 = 80;
function mountainHeight(N, x, z) {
  const r = Math.hypot(x, z);
  const ridge = 1 - Math.abs(N.fbm(x * 0.045 + 20, z * 0.045 - 11, 4) * 1.6);
  const env = smooth(MR0, MR0 + 9, r) * (1 - 0.3 * smooth(MR1 - 14, MR1, r));
  return env * (1.0 + Math.pow(Math.max(0, ridge), 2.2) * 9) - 0.5 + smooth(MR0 - 2, MR0 + 2, r) * 2;
}

function buildMountains(N) {
  const RAD = 18, ANG = 220, R0 = MR0, R1 = MR1;
  const pos = [];
  const pt = (i, j) => {
    const r = R0 + ((R1 - R0) * i) / RAD, a = (j / ANG) * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    return [x, mountainHeight(N, x, z), z];
  };
  for (let i = 0; i < RAD; i++) for (let j = 0; j < ANG; j++) {
    const p00 = pt(i, j), p10 = pt(i + 1, j), p01 = pt(i, j + 1), p11 = pt(i + 1, j + 1);
    pos.push(...p00, ...p01, ...p10, ...p10, ...p01, ...p11);
  }
  const out = [[], []], cols = [[], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), col = new THREE.Color();
  const snow = C('#d5e0f0'), rock = C('#2b3445');
  for (let i = 0; i < pos.length; i += 9) {
    a.fromArray(pos, i); b.fromArray(pos, i + 3); c.fromArray(pos, i + 6);
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    if (n.y < 0) { n.negate(); }
    const cy = (a.y + b.y + c.y) / 3;
    const k = (n.y > 0.55 && cy > 2.0) || cy > 6.5 ? 0 : 1;
    col.copy(k ? rock : snow);
    for (let j = 0; j < 9; j++) out[k].push(pos[i + j]);
    for (let j = 0; j < 3; j++) cols[k].push(col.r, col.g, col.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...out), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([].concat(...cols), 3));
  geo.addGroup(0, out[0].length / 3, 0);
  geo.addGroup(out[0].length / 3, out[1].length / 3, 1);
  geo.computeVertexNormals();
  const mat = (glyph) => std('#ffffff', glyph, { vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, [mat('snow'), mat('stone')]);
  m.receiveShadow = true;
  return m;
}

function buildIce(land, rnd) {
  const g = new THREE.Group();
  g.userData.glyph = 'ice';
  const floeM = std('#d7ecf5', 'ice', { roughness: 0.5 });
  for (let i = 0, tries = 0; i < 9 && tries < 3000; tries++) {
    const x = -16 + rnd() * 50, z = -24 + rnd() * 40;
    const l = land(x, z);
    if (l > 0.05 || l < 0.0 || (l === 0 && rnd() < 0.75)) continue;
    const shape = new THREE.Shape();
    const pts = 5 + Math.floor(rnd() * 3), R = 0.35 + rnd() * 0.6;
    for (let k = 0; k < pts; k++) {
      const a = (k / pts) * Math.PI * 2, r = R * (0.7 + rnd() * 0.5);
      k ? shape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, floeM);
    m.position.set(x, -0.05, z);
    m.rotation.set((rnd() - 0.5) * 0.08, rnd() * 6, (rnd() - 0.5) * 0.08);
    g.add(m);
    i++;
  }
  const bubbleM = std('#86aecb', 'ice', { roughness: 0.4, flatShading: false });
  // A few frozen bubbles near the shore; the open lake stays a clean dark mirror.
  for (let i = 0, tries = 0; i < 22 && tries < 4000; tries++) {
    const x = -14 + rnd() * 44, z = -16 + rnd() * 30;
    const l = land(x, z);
    if (l > 0.02 || (l === 0 && rnd() < 0.9)) continue;
    const r = 0.1 + rnd() * rnd() * 0.45;
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 14).rotateX(-Math.PI / 2), bubbleM);
    m.position.set(x, 0.006, z);
    m.scale.z = 0.7 + rnd() * 0.5;
    g.add(m);
    i++;
  }
  return shadows(g, false, true);
}

function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uZenith: { value: C('#040918') }, uHorizon: { value: C('#1d3463') } },
    vertexShader: /* glsl */`varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform vec3 uZenith; uniform vec3 uHorizon; varying vec3 vDir;
      void main() { gl_FragColor = vec4(mix(uHorizon, uZenith, smoothstep(-0.02, 0.45, vDir.y)), 1.0); }`,
  });
  mat.userData.glyph = 'sky';
  const m = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), mat);
  m.renderOrder = -2;
  m.frustumCulled = false;
  return m;
}

function buildStars(rnd) {
  const n = 900, pos = [], size = [], phase = [];
  while (pos.length / 3 < n) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd(), rnd() * 2 - 1);
    if (v.lengthSq() > 1 || v.y < 0.04) continue;
    v.normalize().multiplyScalar(120);
    pos.push(v.x, v.y, v.z);
    size.push(Math.pow(rnd(), 2.5));
    phase.push(rnd());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 }, uPx: { value: 8 } },
    vertexShader: /* glsl */`attribute float aSize; attribute float aPhase; uniform float uTime; uniform float uPx; varying float vB;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vB = (0.55 + 0.45 * sin(uTime * (0.8 + aPhase * 2.5) + aPhase * 40.0)) * (0.35 + aSize);
        gl_PointSize = uPx * mix(0.55, 1.15, aSize);
      }`,
    fragmentShader: /* glsl */`varying float vB;
      void main() { float a = smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5)); gl_FragColor = vec4(vec3(1.0, 0.96, 0.88) * vB * 2.4 * a, 1.0); }`,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return { points, material };
}

function buildMoon(N) {
  const group = new THREE.Group();
  const dir = new THREE.Vector3(0.36, 0.17, -0.92).normalize();
  const geo = new THREE.IcosahedronGeometry(4.6, 3);
  const cols = [], p = geo.attributes.position, col = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const m = N.fbm(p.getX(i) * 0.35 + 50, p.getY(i) * 0.35 + p.getZ(i) * 0.2, 3);
    col.set('#fff4dc').multiplyScalar(m > 0.12 ? 0.72 : 1);
    cols.push(col.r, col.g, col.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const moonMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  moonMat.userData.glyph = 'glow';
  const moon = new THREE.Mesh(geo, moonMat);
  moon.position.copy(dir).multiplyScalar(96);
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uStrength: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform float uStrength; varying vec2 vUv;
      void main() { float d = length(vUv - 0.5) * 2.0; float a = (exp(-d * d * 9.0) * 0.5 + exp(-d * 3.5) * 0.25) * smoothstep(1.0, 0.6, d) * uStrength;
        gl_FragColor = vec4(vec3(0.62, 0.72, 1.0) * a, 1.0); }`,
  }));
  halo.position.copy(moon.position).multiplyScalar(1.02);
  group.add(moon, halo);
  return { group, halo, dir };
}

function buildAurora() {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; attribute float aSeed; varying float vSeed;
      void main() { vUv = uv; vSeed = aSeed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform float uTime; uniform float uIntensity; varying vec2 vUv; varying float vSeed;
      void main() {
        float u = vUv.x, v = vUv.y, t = uTime;
        float rays = 0.5 + 0.5 * sin(u * 90.0 + sin(u * 7.0 + t * 0.3 + vSeed) * 6.0 + t * 0.9);
        float curtain = 0.5 + 0.5 * sin(u * 9.0 - t * 0.22 + sin(u * 3.0 + t * 0.15 + vSeed) * 2.2);
        float band = smoothstep(0.0, 0.07, v) * (1.0 - smoothstep(0.18, 1.0, v));
        float ends = smoothstep(0.0, 0.15, u) * smoothstep(1.0, 0.85, u);
        vec3 col = mix(vec3(0.12, 1.0, 0.62), vec3(0.62, 0.32, 1.0), smoothstep(0.25, 0.85, v));
        float a = band * ends * pow(rays, 1.6) * smoothstep(0.25, 0.95, curtain) * uIntensity * 1.3;
        gl_FragColor = vec4(col * a, 1.0);
      }`,
  });
  material.userData.glyph = 'aurora';
  for (const [R, y0, H, a0, a1, seed] of [[88, 9, 26, -1.2, 0.7, 0.0], [100, 13, 22, -0.4, 1.2, 3.7]]) {
    const geo = new THREE.PlaneGeometry(1, 1, 180, 1);
    const p = geo.attributes.position, uv = geo.attributes.uv, seeds = [];
    for (let i = 0; i < p.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const a = a0 + (a1 - a0) * u;
      const r = R + Math.sin(u * Math.PI * 3 + seed) * 7;
      p.setXYZ(i, Math.sin(a) * r, y0 + v * H + Math.sin(u * 8 + seed) * 2.2, -Math.cos(a) * r);
      seeds.push(seed);
    }
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const m = new THREE.Mesh(geo, material);
    m.frustumCulled = false;
    group.add(m);
  }
  return { group, material };
}

function buildCabin() {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const W = 2.0, D = 1.7, Hw = 1.1, r = W / Math.sqrt(3);
  const logs = std('#5c3a27'), logsDark = std('#3a2418'), snowM = std('#eef3fb', 'snow'), stone = std('#6f6a66', 'stone');
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };

  add(new THREE.BoxGeometry(W, Hw, D), logs, 0, Hw / 2, 0);
  for (let y = 0.16; y < Hw; y += 0.19) add(new THREE.BoxGeometry(W + 0.06, 0.045, D + 0.06), logsDark, 0, y, 0);
  const gable = add(new THREE.CylinderGeometry(r, r, D, 3, 1, false, Math.PI).rotateX(Math.PI / 2), logs, 0, Hw + r / 2, 0);
  gable.scale.set(0.999, 1, 0.999);
  for (const side of [-1, 1]) {
    // Snow-covered roof slab on each 60deg side, pushed out along its normal.
    const slab = add(new THREE.BoxGeometry(W + 0.5, 0.14, D + 0.4), snowM, side * (W / 4 + 0.866 * 0.07), Hw + 0.75 * r + 0.035, 0);
    slab.rotation.z = -side * Math.PI / 3;
  }
  const windowMat = std('#ffd59a', 'glow', { emissive: '#ffa040', emissiveIntensity: 2.6 });
  const mull = std('#2a1a12');
  for (const x of [-0.58, 0.58]) {
    add(new THREE.BoxGeometry(0.34, 0.38, 0.04), windowMat, x, 0.62, D / 2 + 0.02);
    add(new THREE.BoxGeometry(0.03, 0.38, 0.05), mull, x, 0.62, D / 2 + 0.03);
    add(new THREE.BoxGeometry(0.34, 0.03, 0.05), mull, x, 0.62, D / 2 + 0.03);
  }
  add(new THREE.BoxGeometry(0.44, 0.52, 0.04), windowMat, 0, Hw + 0.55, D / 2 + 0.02);
  add(new THREE.BoxGeometry(0.03, 0.52, 0.05), mull, 0, Hw + 0.55, D / 2 + 0.03);
  add(new THREE.BoxGeometry(0.04, 0.34, 0.32), windowMat, W / 2 + 0.02, 0.62, 0);
  add(new THREE.BoxGeometry(0.34, 0.7, 0.04), logsDark, 0, 0.35, D / 2 + 0.02);
  add(new THREE.BoxGeometry(W + 0.5, 0.08, 0.65), std('#6b4a33'), 0, 0.04, D / 2 + 0.32);
  add(new THREE.BoxGeometry(W + 0.5, 0.05, 0.62), snowM, 0, 0.1, D / 2 + 0.34).scale.set(1, 1, 0.9);
  add(new THREE.BoxGeometry(0.34, 2.6, 0.34), stone, W * 0.3, 1.3, -D * 0.15);
  add(new THREE.BoxGeometry(0.42, 0.08, 0.42), snowM, W * 0.3, 2.64, -D * 0.15);

  const light = new THREE.PointLight('#ffae5c', 3.2, 9, 1.6);
  light.position.set(0, 0.9, D / 2 + 0.9);
  g.add(light);
  shadows(g);
  return { group: g, windowMat, light, chimneyTop: new THREE.Vector3(W * 0.3, 2.75, -D * 0.15) };
}

function buildDock() {
  const group = new THREE.Group();
  group.userData.glyph = 'wood';
  const plank = new THREE.BoxGeometry(0.42, 0.05, 0.2);
  const pm = std('#6e5038'), snowM = std('#e9eff9', 'snow');
  for (let i = 0; i < 11; i++) {
    const p = new THREE.Mesh(plank, i % 4 === 1 ? snowM : pm);
    p.position.set(0, 0.2, i * 0.22);
    p.rotation.y = ((i % 3) - 1) * 0.02;
    group.add(p);
  }
  for (const z of [0, 1.1, 2.2]) for (const x of [-0.19, 0.19]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), std('#3d2b1e'));
    p.position.set(x, -0.15, z);
    group.add(p);
  }
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), std('#3d2b1e'));
  post.position.set(0.16, 0.45, 2.2);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12), std('#ffe3a6', 'glow', { emissive: '#ffb347', emissiveIntensity: 4 }));
  lamp.position.set(0.16, 0.78, 2.2);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.08, 4), std('#2a2a2a'));
  cap.position.set(0.16, 0.9, 2.2);
  cap.rotation.y = Math.PI / 4;
  const lantern = new THREE.PointLight('#ffc46b', 2.2, 5, 2);
  lantern.position.set(0.16, 0.8, 2.3);
  group.add(post, lamp, cap, lantern);
  shadows(group);
  return { group, lantern };
}

function buildFire() {
  const group = new THREE.Group();
  const stone = std('#56565c', 'stone');
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.11, 0), stone);
    s.position.set(Math.cos(a) * 0.42, 0.05, Math.sin(a) * 0.42);
    s.scale.y = 0.7;
    group.add(s);
  }
  const logM = std('#4a2f1f', 'wood');
  for (let i = 0; i < 3; i++) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.62, 6), logM);
    l.rotation.set(Math.PI / 2 - 0.35, (i / 3) * Math.PI * 2, 0);
    l.position.y = 0.12;
    group.add(l);
  }
  for (const [x, z, ry] of [[1.1, 0.2, 0.3], [-0.3, 1.05, 1.7]]) {
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.95, 8).rotateZ(Math.PI / 2), logM);
    seat.position.set(x, 0.13, z);
    seat.rotation.y = ry;
    const snowTop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.16), std('#eef3fb', 'snow'));
    snowTop.position.set(x, 0.27, z);
    snowTop.rotation.y = ry;
    group.add(seat, snowTop);
  }
  const flameM = [
    std('#ff8a2a', 'fire', { emissive: '#ff6a10', emissiveIntensity: 3.2 }),
    std('#ffd36b', 'fire', { emissive: '#ffc04a', emissiveIntensity: 4.2 }),
  ];
  const flames = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(i ? 0.13 : 0.2, 1, 6).translate(0, 0.5, 0), flameM[i ? 1 : 0]);
    f.position.set(i ? Math.cos(i * 2.1) * 0.1 : 0, 0.12, i ? Math.sin(i * 2.1) * 0.1 : 0);
    f.castShadow = false;
    group.add(f);
    flames.push(f);
  }
  const light = new THREE.PointLight('#ff8a3d', 5, 9, 1.7);
  light.position.y = 0.6;
  group.add(light);
  const SP = 22;
  const sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.07, 0),
    std('#ffcf7a', 'fire', { emissive: '#ffa53a', emissiveIntensity: 5 }), SP);
  sparks.frustumCulled = false;
  const life = Array.from({ length: SP }, (_, i) => ({ age: i / SP, seed: Math.random() * 6.28, speed: 0.5 + Math.random() * 0.5 }));
  group.add(sparks);
  shadows(group);
  flames.forEach((f) => { f.castShadow = false; });
  sparks.castShadow = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  return {
    group,
    update(t, dt, strength, stoke, wind) {
      const k = strength * (1 + stoke * 1.6);
      flames.forEach((f, i) => {
        const fl = 0.75 + 0.25 * Math.sin(t * (9 + i * 2.3) + i) * Math.sin(t * 5.1 + i * 1.7);
        const h = (i ? 0.5 : 0.75) * fl * k;
        f.scale.set(0.9 + 0.12 * Math.sin(t * 11 + i), Math.max(0.001, h), 0.9 + 0.12 * Math.cos(t * 13 + i));
        f.rotation.set(wind * 0.12, t * (0.6 + i * 0.3), 0);
        f.visible = strength > 0.01;
      });
      light.intensity = (4 + 2 * Math.sin(t * 13) * Math.sin(t * 7.3) + stoke * 9) * strength;
      life.forEach((p, i) => {
        p.age += dt * p.speed * (0.6 + stoke * 1.2);
        if (p.age > 1) { p.age -= 1; p.seed = Math.random() * 6.28; }
        const a = p.age;
        v.set(Math.cos(p.seed) * 0.15 + wind * a * 0.9 + Math.sin(t * 3 + p.seed) * 0.08, 0.25 + a * (1.8 + stoke * 1.5), Math.sin(p.seed) * 0.15);
        s.setScalar(strength > 0.01 ? (1 - a) * (0.6 + stoke * 0.6) : 0.0001);
        sparks.setMatrixAt(i, m.compose(v, q, s));
      });
      sparks.instanceMatrix.needsUpdate = true;
    },
  };
}

function pineGeometries() {
  const green = [new THREE.CylinderGeometry(0.07, 0.11, 0.7, 6).translate(0, 0.35, 0)], snow = [];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 0.95 - t * 0.62, h = 1.0 - t * 0.35, y = 0.45 + i * 0.55;
    green.push(new THREE.ConeGeometry(r, h, 7).translate(0, y + h / 2, 0));
    const sh = h * 0.8 + 0.05, sr = r * 0.8 + 0.03, sy = y + h * 0.2 - 0.02;
    snow.push(new THREE.ConeGeometry(sr, sh, 7).translate(0, sy + sh / 2, 0));
  }
  return [mergeGeometries(green), mergeGeometries(snow)];
}

// The camera drifts on an arc ~26 units out from the target; keep that corridor open.
function nearCameraPath(x, z) {
  for (let a = -CAM.sway - 6; a <= CAM.sway + 6; a += 4) {
    const [cx, cz] = camBase(a);
    if (Math.hypot(x - cx, z - cz) < 10) return true;
  }
  return false;
}

function buildPines(land, height, rnd, avoid) {
  const pts = [];
  for (let tries = 0; tries < 40000 && pts.length < 460; tries++) {
    const x = -40 + rnd() * 80, z = -40 + rnd() * 70;
    if (land(x, z) < 0.985 || Math.hypot(x, z) > 34) continue;
    // Denser forest behind the cabin and along the far shore, lighter on the near bank.
    if (z > 4 && rnd() > 0.35) continue;
    if (nearCameraPath(x, z)) continue;
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2])) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.z - z) < 0.95)) continue;
    pts.push({ x, z, y: height(x, z) - 0.1, s: 0.7 + rnd() * 0.85, yaw: rnd() * 6.28, ph: rnd() * 6.28 });
  }
  const [gG, sG] = pineGeometries();
  const green = new THREE.InstancedMesh(gG, std('#1d3a3f', 'foliage'), pts.length);
  const snow = new THREE.InstancedMesh(sG, std('#e6eef9', 'snow'), pts.length);
  const group = new THREE.Group();
  group.add(green, snow);
  shadows(group);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qt = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const update = (t, wind) => {
    pts.forEach((p, i) => {
      const sway = wind * (0.018 + 0.012 * Math.sin(t * 1.3 + p.ph)) + 0.006 * Math.sin(t * 2.1 + p.ph * 2) * (0.4 + wind);
      qt.setFromEuler(e.set(0.004 * Math.sin(t * 1.7 + p.ph), 0, -sway / p.s));
      q.setFromAxisAngle(UP, p.yaw).premultiply(qt);
      m.compose(v.set(p.x, p.y, p.z), q, s.setScalar(p.s));
      green.setMatrixAt(i, m);
      snow.setMatrixAt(i, m);
    });
    green.instanceMatrix.needsUpdate = true;
    snow.instanceMatrix.needsUpdate = true;
  };
  update(0, 0);
  return { group, update };
}

function buildBareTree(rnd) {
  const parts = [];
  const grow = (start, dir, len, rad, depth) => {
    const end = start.clone().addScaledVector(dir, len);
    const g = new THREE.CylinderGeometry(rad * 0.68, rad, len, 5);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
    const mid = start.clone().addScaledVector(dir, len / 2);
    g.translate(mid.x, mid.y, mid.z);
    parts.push(g);
    if (depth <= 0) return;
    const n = depth > 2 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const nd = dir.clone().add(new THREE.Vector3((rnd() - 0.5) * 1.5, rnd() * 0.45, (rnd() - 0.5) * 1.5)).normalize();
      grow(end, nd, len * (0.62 + rnd() * 0.16), rad * 0.62, depth - 1);
    }
  };
  grow(new THREE.Vector3(), UP.clone(), 1.1, 0.1, 4);
  return mergeGeometries(parts);
}

function buildRocks(land, height, rnd, avoid) {
  const pts = [];
  for (let tries = 0; tries < 6000 && pts.length < 44; tries++) {
    const x = -20 + rnd() * 58, z = -26 + rnd() * 46, l = land(x, z);
    if (l < 0.3 || l > 0.9) continue;
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2] * 0.7)) continue;
    pts.push({ x, z, y: Math.max(height(x, z), -0.1) });
  }
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.3, 0), std('#ffffff', 'stone'), pts.length);
  const caps = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.26, 0), std('#e8eef8', 'snow'), pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color();
  pts.forEach((p, i) => {
    q.setFromEuler(e.set(rnd() * 0.5, rnd() * 6, rnd() * 0.5));
    s.set(0.7 + rnd() * 1.1, 0.5 + rnd() * 0.5, 0.7 + rnd() * 0.9);
    rocks.setMatrixAt(i, m.compose(v.set(p.x, p.y, p.z), q, s));
    rocks.setColorAt(i, col.setHSL(0.6, 0.08, 0.2 + rnd() * 0.1));
    caps.setMatrixAt(i, m.compose(v.set(p.x, p.y + s.y * 0.2, p.z), q, s.multiply(new THREE.Vector3(0.95, 0.45, 0.95))));
  });
  const g = new THREE.Group();
  g.add(rocks, caps);
  return shadows(g);
}

function buildSmoke() {
  const group = new THREE.Group();
  group.userData.glyph = 'smoke';
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const mat = std('#8e9ab0', 'smoke', { roughness: 1 });
  const puffs = Array.from({ length: 16 }, (_, i) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;
    group.add(m);
    return { m, age: i / 16, seed: i * 1.7 };
  });
  return {
    group,
    update(dt, top, wind, on) {
      for (const p of puffs) {
        p.age += dt / 7;
        if (p.age > 1) p.age -= 1;
        const k = p.age;
        p.m.position.set(top.x + wind * k * 3.2 + Math.sin(k * 6 + p.seed) * 0.15, top.y + k * 3.4, top.z + Math.cos(k * 5 + p.seed) * 0.12);
        const sc = on ? (0.12 + k * 0.55) * (1 - smooth(0.7, 1.0, k)) * smooth(0.0, 0.06, k) : 0.0001;
        p.m.scale.setScalar(Math.max(sc, 0.0001));
      }
    },
  };
}

// Static pines up the lower mountain slopes, below the snowline.
function buildFarPines(N, surface, rnd) {
  const pts = [];
  for (let tries = 0; tries < 9000 && pts.length < 420; tries++) {
    const a = rnd() * Math.PI * 2, r = 31 + rnd() * 17;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = surface(x, z);
    if (y > 5.2 || y < 0.25) continue; // below the snowline, above the water
    const slope = Math.abs(surface(x + 0.6, z) - surface(x - 0.6, z)) + Math.abs(surface(x, z + 0.6) - surface(x, z - 0.6));
    if (slope > 2.2) continue;
    if (nearCameraPath(x, z)) continue;
    pts.push([x, y - 0.25, z, 0.75 + rnd() * 0.6, rnd() * 6.28]);
  }
  const [gG, sG] = pineGeometries();
  const green = new THREE.InstancedMesh(gG, std('#1d3a3f', 'foliage'), pts.length);
  const snow = new THREE.InstancedMesh(sG, std('#e6eef9', 'snow'), pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  pts.forEach(([x, y, z, k, yaw], i) => {
    m.compose(v.set(x, y, z), q.setFromAxisAngle(UP, yaw), sc.setScalar(k));
    green.setMatrixAt(i, m);
    snow.setMatrixAt(i, m);
  });
  const g = new THREE.Group();
  g.add(green, snow);
  return shadows(g, true, true);
}

// 3D snowfall. Flakes live in world space (so they have perspective, parallax and depth) and the engine
// drops each one into the character cell it projects to: near flakes become *, far ones become .
function buildSnow(rnd) {
  const MAX = 40000;
  const base = new Float32Array(MAX * 3), rand = new Float32Array(MAX * 3);
  for (let i = 0; i < MAX * 3; i++) { base[i] = rnd(); rand[i] = rnd(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 3));
  const U = {
    uFall: { value: 0 }, uDrift: { value: 0 }, uTime: { value: 0 }, uBright: { value: 0.9 },
    uCenter: { value: new THREE.Vector3(4, 8, -4) }, uSize: { value: new THREE.Vector3(90, 18, 72) },
    uRayO: { value: new THREE.Vector3() }, uRayD: { value: new THREE.Vector3(0, 1, 0) }, uPush: { value: 0 },
    uPxPerUnit: { value: 100 }, uFlake: { value: 0.08 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: U, depthTest: true, depthWrite: true, fog: false,
    vertexShader: /* glsl */`
      attribute vec3 aRand;
      uniform float uFall; uniform float uDrift; uniform float uTime; uniform float uBright;
      uniform vec3 uCenter; uniform vec3 uSize; uniform vec3 uRayO; uniform vec3 uRayD; uniform float uPush;
      uniform float uPxPerUnit; uniform float uFlake;
      varying vec3 vData;
      void main() {
        float sp = mix(0.55, 1.25, aRand.x);
        vec3 p;
        p.y = mod(position.y * uSize.y - uFall * sp, uSize.y);
        p.x = mod(position.x * uSize.x + uDrift * sp + sin(uTime * 0.7 + aRand.y * 6.28) * 0.5, uSize.x);
        p.z = mod(position.z * uSize.z + cos(uTime * 0.55 + aRand.z * 6.28) * 0.4, uSize.z);
        vec3 w = uCenter - uSize * 0.5 + p;
        vec3 rel = w - uRayO;
        float along = dot(rel, uRayD);
        vec3 perp = rel - uRayD * along;
        float d = length(perp);
        w += perp / max(d, 1e-3) * uPush * exp(-d * d / 1.5) * step(0.0, along);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        // Size in cells from the flake's real size, so near flakes span several cells and far ones one.
        gl_PointSize = clamp(uFlake * mix(0.7, 1.3, aRand.y) * uPxPerUnit / max(dist, 0.1), 1.0, 9.0);
        if (dist < 1.6) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vData = vec3(dist, clamp(1.0 - (dist - 4.0) / 30.0, 0.0, 1.0), mix(1.0, 0.55, smoothstep(10.0, 60.0, dist)) * uBright);
      }`,
    fragmentShader: /* glsl */`varying vec3 vData;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        // Bright * in the middle of a big flake, softer glyphs towards its edge.
        gl_FragColor = vec4(vData.x, vData.y * (1.0 - r * 0.55), vData.z * (1.0 - r * 0.4), 1.0);
      }`,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  const ray = { o: new THREE.Vector3(), d: new THREE.Vector3(), on: false };
  return {
    points,
    setRay(r) {
      ray.on = !!r;
      if (r) { ray.o.copy(r.origin); ray.d.copy(r.direction); }
    },
    update(dt, wind, state, size, camera) {
      U.uPxPerUnit.value = size.rows / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      U.uFlake.value = state.flakeSize;
      U.uTime.value += dt;
      U.uFall.value += dt * 1.6 * state.snowSpeed;
      U.uDrift.value += dt * wind * 1.4 * state.snowSpeed;
      U.uBright.value = state.snowBright;
      U.uRayO.value.copy(ray.o);
      U.uRayD.value.copy(ray.d);
      U.uPush.value += ((ray.on ? 1.6 : 0) - U.uPush.value) * Math.min(1, dt * 6);
      geo.setDrawRange(0, Math.min(MAX, Math.round(state.snowfall * 30000)));
    },
  };
}
