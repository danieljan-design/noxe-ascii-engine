import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, smooth, std as baseStd, shadows } from './kit.js';

// Smooth-shaded materials for this scene (rounder, less low-poly).
const std = (color, glyph, extra = {}) => baseStd(color, glyph, { flatShading: false, ...extra });

// Sunken shipwreck reef.
// Tilted wooden wreck with broken masts and torn sails, sunken ruins in the haze, coral gardens,
// swaying kelp, a silver fish school that dodges the cursor, reef fish, a manta ray, glowing jellyfish,
// light shafts and moving caustics, bubble streams, and a treasure chest.
// Clicks: chest = open/close, anywhere else = bubble burst + the school scatters.

const C = (h) => new THREE.Color(h);
const UP = new THREE.Vector3(0, 1, 0);
const SURFACE_Y = 12.5;

const CAUSTIC_GLSL = /* glsl */`
float caustic(vec2 uv, float time) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 2.0);
}
`;

export default {
  name: 'Reef',
  frame: {
    target: [0.4, 2.8, -2], radius: 6.6, elevation: -3, azimuth: 0, fov: 46, sway: 26, fit: 'height', maxPolar: 100,
    portrait: { fov: 58, radius: 8.6, target: [0.4, 3.6, -2], sway: 18 },
  },
  look: {
    weather: 'snow', wDensity: 0.03, wSpeed: 0.7, wWind: 0.15, wSway: 1.1, wBright: 0.35, wColor: '#bdf3ff', wRepel: 6, wRepelR: 8,
    exposure: 1.3, saturation: 1.3, bloom: 0.8, bloomThreshold: 0.45,
    tilt: 0.4, tiltCenter: 0.45, tiltWidth: 0.55, tiltFeather: 0.35, vignette: 0.5, cellFill: 0.16, bg: '#03080c',
  },

  create(ctx) {
    const scene = new THREE.Scene();
    const fogCol = C('#0a4258');
    scene.background = fogCol.clone();
    scene.fog = new THREE.Fog(fogCol, 9, 46);
    const N = makeNoise(41);
    const rnd = mulberry32(9);
    const U = { uTime: { value: 0 }, uCaustic: { value: 1 } };
    const state = { rays: 1, caustics: 1, current: 1, jellyfish: true, manta: true, chestOpen: false, scatter: 0, open: 0 };
    const caustic = (color, glyph, extra) => causticMat(U, color, glyph, extra);

    // ---------- light ----------
    const hemi = new THREE.HemisphereLight('#7fdcec', '#1d4a55', 1.35);
    const sun = new THREE.DirectionalLight('#c9f7ff', 2.4);
    sun.position.set(3, 18, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 60;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(hemi, sun, sun.target);

    // ---------- water volume + surface ----------
    const sky = buildWaterSky();
    const surface = buildSurface();
    scene.add(sky, surface.mesh);

    // ---------- seafloor ----------
    const height = (x, z) => {
      let h = N.fbm(x * 0.06, z * 0.06, 4) * 1.6;
      h += Math.sin(x * 2.2 + N.noise(x * 0.3, z * 0.3) * 4) * 0.04;
      const R = Math.hypot(x, z);
      h += smooth(14, 34, R) * 3;
      h += smooth(22, 70, R) * (2 + N.fbm(x * 0.04 + 11, z * 0.04 - 3, 4) * 6);
      return h;
    };
    const floor = buildFloor(height, N, caustic);
    scene.add(floor);

    // ---------- wreck ----------
    const ship = buildShip(N, rnd, caustic);
    ship.group.position.set(0.4, height(0.4, -3) + 1.75, -3);
    ship.group.scale.setScalar(1.25);
    ship.group.rotation.set(-0.24, -0.5, 0.12, 'YZX');
    scene.add(ship.group);
    ship.group.updateMatrixWorld(true);
    const vents = ship.vents.map((v) => v.clone().applyMatrix4(ship.group.matrixWorld));

    const ruins = buildRuins(height, caustic);
    scene.add(ruins);
    scene.add(buildDebris(height, rnd, caustic));
    const chest = buildChest();
    chest.group.position.set(2.9, height(2.9, 2.0) - 0.08, 2.0);
    chest.group.rotation.set(0.06, -0.5, 0.05);
    scene.add(chest.group);

    // ---------- life ----------
    const avoid = [[0.4, -3, 5.6], [2.9, 2.0, 1.0]];
    const coral = buildCoral(height, rnd, N, caustic, avoid);
    scene.add(coral.group);
    const kelp = buildKelp(height, rnd, avoid);
    scene.add(kelp.mesh);
    const schools = [
      buildSchool(rnd),
      buildSchool(rnd, { count: 90, path: (t, o) => o.set(-14 + Math.cos(t * 0.09) * 11, 6 + Math.sin(t * 0.2) * 1.5, -30 + Math.sin(t * 0.09) * 6) }),
      buildSchool(rnd, { count: 90, path: (t, o) => o.set(18 + Math.sin(t * 0.07) * 12, 9 + Math.sin(t * 0.17 + 1) * 2, -26 + Math.cos(t * 0.07) * 7) }),
    ];
    schools.forEach((sc) => scene.add(sc.mesh));
    scene.add(buildOutcrops(height, rnd, N, caustic));
    const reefFish = buildReefFish(height, rnd, coral.spots);
    scene.add(reefFish.mesh);
    const manta = buildManta();
    scene.add(manta.group);
    const jellies = buildJellies(rnd);
    scene.add(jellies.group);
    const bubbles = buildBubbles(vents);
    scene.add(bubbles.mesh);
    const rays = buildRays(rnd);
    scene.add(rays.group);

    let cursorRay = null;
    const hitTargets = [floor, ship.group, ruins, chest.group];
    const isIn = (o, root) => { while (o) { if (o === root) return true; o = o.parent; } return false; };

    return {
      scene,
      update(t, dt) {
        U.uTime.value = t;
        U.uCaustic.value = state.caustics;
        state.scatter = Math.max(0, state.scatter - dt * 0.5);
        state.open += ((state.chestOpen ? 1 : 0) - state.open) * Math.min(1, dt * 3);
        const cur = state.current;
        sky.position.copy(ctx.camera.position);
        surface.update(t);
        ship.update(t, cur);
        kelp.update(t, cur);
        coral.update(t, cur);
        schools.forEach((sc) => sc.update(t, dt, cursorRay, state.scatter, cur));
        reefFish.update(t);
        manta.group.visible = state.manta;
        manta.update(t);
        jellies.group.visible = state.jellyfish;
        jellies.update(t, dt);
        bubbles.update(t, dt, cur);
        rays.update(t, state.rays);
        chest.update(t, state.open);
      },
      onMove(ray) { cursorRay = ray ? ray.clone() : null; },
      onClick(rc) {
        const hit = rc.intersectObjects(hitTargets, true)[0];
        if (hit && isIn(hit.object, chest.group)) { state.chestOpen = !state.chestOpen; return; }
        const p = hit ? hit.point : rc.ray.at(10, new THREE.Vector3());
        bubbles.burst(p, 40);
        state.scatter = 1;
      },
      gui(folder) {
        folder.add(state, 'rays', 0, 2, 0.01).name('sun rays');
        folder.add(state, 'caustics', 0, 3, 0.01);
        folder.add(state, 'current', 0, 3, 0.01);
        folder.add(state, 'jellyfish');
        folder.add(state, 'manta').name('manta ray');
        folder.add(state, 'chestOpen').name('chest open  [click it]').listen();
        folder.add({ burst: () => { bubbles.burst(new THREE.Vector3(0, 2, 0), 60); state.scatter = 1; } }, 'burst').name('bubble burst  [click]');
      },
    };
  },
};

// ---------------------------------------------------------------------------

// Standard material plus animated caustics on upward-facing surfaces.
function causticMat(U, color, glyph, extra = {}) {
  const m = std(color, glyph, extra);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uCaustic = U.uCaustic;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 cwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cwp = instanceMatrix * cwp;
        #endif
        vWPos = (modelMatrix * cwp).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uCaustic;\n${CAUSTIC_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 cwn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float ck = caustic(vWPos.xz * 0.16, uTime * 0.55) * smoothstep(0.1, 0.8, cwn.y) * smoothstep(-2.0, 6.0, vWPos.y + 2.0);
          totalEmissiveRadiance += diffuseColor.rgb * ck * uCaustic * 1.3;
        }`);
  };
  return m;
}

function buildWaterSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uDown: { value: C('#021821') }, uMid: { value: C('#0a4258') }, uUp: { value: C('#2a8fa3') } },
    vertexShader: /* glsl */`varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform vec3 uDown; uniform vec3 uMid; uniform vec3 uUp; varying vec3 vDir;
      void main() { float y = vDir.y; vec3 c = y < 0.0 ? mix(uMid, uDown, smoothstep(0.0, -0.4, y)) : mix(uMid, uUp, smoothstep(0.0, 0.8, y)); gl_FragColor = vec4(c, 1.0); }`,
  });
  mat.userData.glyph = 'sky';
  const m = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), mat);
  m.renderOrder = -2;
  m.frustumCulled = false;
  return m;
}

function buildSurface() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uDeep: { value: C('#0a4258') }, uBright: { value: C('#d6fbff') } },
    vertexShader: /* glsl */`varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`uniform float uTime; uniform vec3 uDeep; uniform vec3 uBright; varying vec3 vW;
      ${CAUSTIC_GLSL}
      void main() {
        float d = length(vW.xz - cameraPosition.xz);
        float r = caustic(vW.xz * 0.045, uTime * 0.35);
        float sun = exp(-length(vW.xz - vec2(-3.0, -6.0)) * 0.06);
        vec3 col = mix(uDeep * 1.7, uBright, clamp(r * 0.55 + sun * 0.7, 0.0, 1.0)) * (1.0 + sun * 1.4);
        gl_FragColor = vec4(mix(uDeep, col, exp(-d * 0.028)), 1.0);
      }`,
  });
  mat.userData.glyph = 'water';
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(Math.PI / 2), mat);
  mesh.position.y = SURFACE_Y;
  return { mesh, update(t) { mat.uniforms.uTime.value = t; } };
}

function buildFloor(height, N, caustic) {
  const SIZE = 170, SEG = 300;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  const colors = new Float32Array(pa.count * 3), rockW = new Float32Array(pa.count);
  const col = new THREE.Color(), rc = new THREE.Color();
  const sandA = C('#d9cfa8'), sandB = C('#b7ad86'), rockA = C('#4f5b55'), rockB = C('#36423f');
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), z = pa.getZ(i);
    pa.setY(i, height(x, z));
    const v = N.noise(x * 0.9, z * 0.9) * 0.5 + 0.5;
    const r = smooth(0.16, 0.3, N.fbm(x * 0.12 + 30, z * 0.12, 3));
    rockW[i] = r;
    col.lerpColors(sandA, sandB, v * 0.8).lerp(rc.lerpColors(rockA, rockB, v), r);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  // Smooth (indexed) surface; triangles split into sand and rock groups for their glyph sets.
  const idx = g.index.array, sand = [], rock = [];
  for (let t = 0; t < idx.length; t += 3) {
    const w = (rockW[idx[t]] + rockW[idx[t + 1]] + rockW[idx[t + 2]]) / 3;
    (w > 0.5 ? rock : sand).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  g.setIndex(sand.concat(rock));
  g.clearGroups();
  g.addGroup(0, sand.length, 0);
  g.addGroup(sand.length, rock.length, 1);
  const mesh = new THREE.Mesh(g, [
    caustic('#ffffff', 'sand', { vertexColors: true, roughness: 1 }),
    caustic('#ffffff', 'stone', { vertexColors: true, roughness: 1 }),
  ]);
  mesh.receiveShadow = true;
  return mesh;
}

function buildShip(N, rnd, caustic) {
  const group = new THREE.Group();
  group.userData.glyph = 'wood';
  const L = 9, B = 2.6, D = 2.0, S = 46, K = 10;
  const half = (s) => (B / 2) * Math.max(0.03, 1 - Math.pow(Math.max(0, (s - 0.55) / 0.45), 1.7)) * (0.8 + 0.2 * smooth(0, 0.3, s));
  const top = (s) => 0.45 * Math.pow(2 * s - 1, 2) + 0.3 * Math.max(0, s - 0.6);
  const bot = (s) => -D + 0.5 * Math.pow(Math.max(0, (s - 0.72) / 0.28), 2);
  const P = (s, f) => {
    const a = Math.abs(f);
    return new THREE.Vector3((s - 0.5) * L, bot(s) + (top(s) - bot(s)) * Math.pow(a, 1.4),
      Math.sign(f) * half(s) * Math.pow(Math.sin((a * Math.PI) / 2), 0.5));
  };
  const wood = [], moss = [], woodC = [], mossC = [];
  const plank = [C('#8a7a62'), C('#74664f'), C('#968468')], rot = C('#45392c'), mossA = C('#5d8a45'), mossB = C('#8fae4a');
  const tri = (a, b, c, col, m) => {
    const arr = m ? moss : wood, cc = m ? mossC : woodC;
    arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) cc.push(col.r, col.g, col.b);
  };
  const quad = (a, b, c, d, col, m) => { tri(a, b, c, col, m); tri(a, c, d, col, m); };
  const tmp = new THREE.Color();

  // Hull planking, with holes punched through.
  for (let i = 0; i < S; i++) {
    const s0 = i / S, s1 = (i + 1) / S;
    for (let j = 0; j < 2 * K; j++) {
      const f0 = -1 + j / K, f1 = -1 + (j + 1) / K;
      const a = Math.abs((f0 + f1) / 2);
      if (a > 0.3 && a < 0.88 && N.noise(s0 * 9 + (f0 > 0 ? 0 : 40), a * 3.2) > 0.4) continue;
      const mossy = a > 0.8 && N.noise(s0 * 14, f0 * 5 + 7) > -0.1;
      if (mossy) tmp.lerpColors(mossA, mossB, N.noise(s0 * 20, f0 * 9) * 0.5 + 0.5);
      else tmp.copy(plank[Math.floor(a * K) % 3]).lerp(rot, Math.max(0, N.noise(s0 * 11 + 3, a * 6)) * 0.8);
      quad(P(s0, f0), P(s1, f0), P(s1, f1), P(s0, f1), tmp, mossy);
    }
  }
  // Deck, mostly overgrown, with gaps.
  for (let i = 0; i < S; i++) {
    const s0 = i / S, s1 = (i + 1) / S;
    for (let j = 0; j < 8; j++) {
      const u0 = -1 + j / 4, u1 = -1 + (j + 1) / 4;
      if (N.noise(s0 * 7 + 90, u0 * 2) > 0.38) continue;
      const Dp = (s, u) => new THREE.Vector3((s - 0.5) * L, top(s) - 0.06, u * half(s) * 0.97);
      const mossy = N.noise(s0 * 6 + 5, u0 * 3) > -0.25;
      if (mossy) tmp.lerpColors(mossA, mossB, rnd()); else tmp.copy(plank[j % 3]);
      quad(Dp(s0, u0), Dp(s0, u1), Dp(s1, u1), Dp(s1, u0), tmp, mossy);
    }
  }
  // Transom at the stern.
  const mid = new THREE.Vector3(-L / 2, (top(0) + bot(0)) / 2, 0);
  for (let j = 0; j < 2 * K; j++) tri(mid, P(0, -1 + (j + 1) / K), P(0, -1 + j / K), plank[j % 3], false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...wood, ...moss], 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([...woodC, ...mossC], 3));
  geo.addGroup(0, wood.length / 3, 0);
  geo.addGroup(wood.length / 3, moss.length / 3, 1);
  geo.computeVertexNormals();
  const woodM = caustic('#ffffff', 'wood', { vertexColors: true, side: THREE.DoubleSide, roughness: 0.95 });
  const mossM = caustic('#ffffff', 'foliage', { vertexColors: true, side: THREE.DoubleSide, roughness: 1 });
  group.add(new THREE.Mesh(toCreasedNormals(geo, Math.PI / 3), [woodM, mossM]));

  // Stern castle.
  const castleM = caustic('#7a6650', 'wood');
  const castle = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, B * 0.82), castleM);
  castle.position.set(-L / 2 + 1.15, top(0.12) + 0.45, 0);
  group.add(castle);
  const castleTop = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, B * 0.86), caustic('#5f8a3a', 'foliage'));
  castleTop.position.set(-L / 2 + 1.15, top(0.12) + 1.02, 0);
  group.add(castleTop);
  const dark = std('#0e1a1c', 'default');
  for (const z of [-0.6, 0, 0.6]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.28), dark);
    w.position.set(-L / 2 + 0.13, top(0.12) + 0.5, z);
    group.add(w);
  }

  // Masts, yard, crow's nest, bowsprit.
  const spar = caustic('#5e4c3a', 'wood');
  const mast = (x, h, lean, side, r = 0.12) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, top((x / L) + 0.5) - 0.05, 0);
    pivot.rotation.set(side, 0, lean);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r, h, 12).translate(0, h / 2, 0), spar);
    pivot.add(m);
    group.add(pivot);
    return pivot;
  };
  const main = mast(0.2, 7.2, -0.12, 0.25);
  const nest = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.3, 0.28, 10, 1, true), spar);
  nest.position.y = 5.8;
  main.add(nest);
  const yard = new THREE.Group();
  yard.position.y = 5.1;
  yard.rotation.set(0.55, 0.3, 0);
  yard.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.2, 10).rotateX(Math.PI / 2), spar));
  main.add(yard);
  const fore = mast(2.7, 2.2, 0.05, -0.1, 0.11);
  const jag = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.35, 5), spar);
  jag.position.y = 2.35;
  fore.add(jag);
  const mizzen = mast(-2.9, 4.8, 0.18, -0.32, 0.1);
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.4, 10).translate(0, 1.2, 0), spar);
  bow.position.set(L / 2 - 0.3, top(0.97) - 0.05, 0);
  bow.rotation.z = -Math.PI / 2 + 0.38;
  group.add(bow);

  // Torn sails.
  const sails = [];
  const sail = (parent, w, h, y, seed) => {
    const g = new THREE.PlaneGeometry(w, h, 12, 9).rotateY(Math.PI / 2).translate(0, -h / 2, 0);
    const keep = [];
    const idx = g.index.array, pos = g.attributes.position;
    for (let i = 0; i < idx.length; i += 3) {
      const yy = (pos.getY(idx[i]) + pos.getY(idx[i + 1]) + pos.getY(idx[i + 2])) / 3;
      const zz = (pos.getZ(idx[i]) + pos.getZ(idx[i + 1]) + pos.getZ(idx[i + 2])) / 3;
      const rag = N.noise(zz * 2.2 + seed, yy * 2.6) + (-yy / h) * 0.55;
      if (rag < 0.42) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    g.setIndex(keep);
    const m = new THREE.Mesh(g, std('#c9bfa3', 'soft', { side: THREE.DoubleSide }));
    m.position.y = y;
    parent.add(m);
    sails.push({ m, base: Float32Array.from(g.attributes.position.array), h, seed });
  };
  sail(yard, 3.8, 2.6, -0.05, 0);
  sail(mizzen, 2.0, 1.6, 3.9, 11);

  // Rigging.
  group.updateMatrixWorld(true);
  const tip = (o, y) => o.localToWorld(new THREE.Vector3(0, y, 0));
  const rope = (a, b) => {
    const d = b.clone().sub(a), len = d.length();
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6), spar);
    r.position.copy(a).addScaledVector(d, 0.5);
    r.quaternion.setFromUnitVectors(UP, d.normalize());
    group.add(r);
  };
  const mainTop = tip(main, 7.0), mizTop = tip(mizzen, 4.6);
  rope(mainTop, new THREE.Vector3(L / 2 - 0.4, top(0.95), 0));
  rope(mainTop, new THREE.Vector3(-0.6, top(0.45), half(0.45)));
  rope(mainTop, new THREE.Vector3(0.9, top(0.6), -half(0.6)));
  rope(mizTop, new THREE.Vector3(-L / 2 + 0.3, top(0.03) + 1.0, 0.4));
  rope(mizTop, mainTop.clone().lerp(new THREE.Vector3(0.2, 3, 0), 0.4));
  shadows(group);

  const vents = [new THREE.Vector3(-0.8, top(0.4), 0.3), new THREE.Vector3(1.6, top(0.68), -0.2), new THREE.Vector3(-3.0, top(0.12) + 1.0, 0)];
  return {
    group, vents,
    update(t, cur) {
      for (const s of sails) {
        const p = s.m.geometry.attributes.position, a = p.array, b = s.base;
        for (let i = 0; i < p.count; i++) {
          const y = b[i * 3 + 1], z = b[i * 3 + 2];
          const k = -y / s.h;
          a[i * 3] = b[i * 3] + Math.sin(z * 1.4 + t * 0.9 + s.seed) * 0.22 * k * cur + Math.sin(t * 0.5 + s.seed) * 0.1 * k * cur;
        }
        p.needsUpdate = true;
      }
    },
  };
}

function buildRuins(height, caustic) {
  const g = new THREE.Group();
  g.userData.glyph = 'stone';
  const M = caustic('#62777b', 'stone');
  const column = (x, z, h, broken) => {
    const y = height(x, z) - 0.2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 1.3), M);
    base.position.set(x, y + 0.17, z);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, h, 28), M);
    shaft.position.set(x, y + 0.35 + h / 2, z);
    g.add(base, shaft);
    if (broken) {
      const jag = new THREE.Mesh(new THREE.ConeGeometry(0.44, 0.7, 7), M);
      jag.position.set(x, y + 0.35 + h + 0.2, z);
      jag.rotation.z = 0.5;
      g.add(jag);
    } else {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 1.2), M);
      cap.position.set(x, y + 0.35 + h + 0.17, z);
      g.add(cap);
    }
    return y + 0.35 + h + 0.35;
  };
  const archTop = Math.max(column(-11.4, -17, 6, false), column(-7.4, -17, 6, false));
  const arch = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.42, 14, 36, Math.PI), M);
  arch.position.set(-9.4, archTop - 0.1, -17);
  g.add(arch);
  column(6.5, -20, 7, false);
  column(10, -18.5, 3.2, true);
  column(13.5, -14, 5.5, false);
  column(-15.5, -11, 2.4, true);
  column(-4, -22, 4.2, true);
  const archAt = (x, z, span, h) => {
    const top = Math.max(column(x - span / 2, z, h, false), column(x + span / 2, z, h, false));
    const a = new THREE.Mesh(new THREE.TorusGeometry(span / 2, 0.42, 14, 36, Math.PI), M);
    a.position.set(x, top - 0.1, z);
    g.add(a);
  };
  archAt(20, -34, 4.4, 6.5);
  archAt(-27, -30, 4.0, 5.5);
  for (const [x, z, h, broken] of [[-22, -24, 4.5, true], [26, -20, 5, false], [-2, -40, 7, false], [-14, -42, 3, true],
    [9, -45, 6, false], [33, -36, 2.6, true], [-35, -38, 6, false], [-40, -16, 3.5, true], [40, -12, 5.5, false]]) column(x, z, h, broken);
  const fallen2 = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 5.5, 28), M);
  fallen2.position.set(-18, height(-18, -33) + 0.3, -33);
  fallen2.rotation.set(0.05, -0.5, Math.PI / 2);
  g.add(fallen2);
  const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 5.5, 28), M);
  fallen.position.set(3.5, height(3.5, -14) + 0.3, -14);
  fallen.rotation.set(0.1, 0.7, Math.PI / 2);
  g.add(fallen);
  for (let i = 0; i < 9; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.7), M);
    const x = -2 + (i % 4) * 1.25, row = Math.floor(i / 4);
    b.position.set(x, height(x, -24) + 0.3 + row * 0.6, -24);
    b.rotation.y = (i * 0.37) % 0.2;
    g.add(b);
  }
  return shadows(g);
}

function buildDebris(height, rnd, caustic) {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const plankM = caustic('#5a4532', 'wood');
  for (let i = 0; i < 12; i++) {
    const x = -4 + rnd() * 9, z = -0.5 + rnd() * 3;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.9 + rnd(), 0.06, 0.18), plankM);
    p.position.set(x, height(x, z) + 0.03, z);
    p.rotation.set(rnd() * 0.2, rnd() * 3, rnd() * 0.2);
    g.add(p);
  }
  const barrelM = caustic('#6a4b2e', 'wood'), band = std('#2d2a26', 'stone');
  for (const [x, z, lying] of [[-3.2, 1.0, true], [-2.5, 1.6, false], [4.6, -0.6, true]]) {
    const b = new THREE.Group();
    b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.25, 0.72, 22), barrelM));
    for (const y of [-0.22, 0.22]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.05, 22, 1, true), band);
      r.position.y = y;
      b.add(r);
    }
    b.position.set(x, height(x, z) + (lying ? 0.24 : 0.34), z);
    if (lying) b.rotation.set(Math.PI / 2, rnd() * 3, 0);
    g.add(b);
  }
  const metal = std('#2f3438', 'stone');
  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 1.3, 18), metal);
  cannon.position.set(-1.4, height(-1.4, 2.2) + 0.12, 2.2);
  cannon.rotation.set(Math.PI / 2, 0, 0.9);
  g.add(cannon);
  // Anchor by the bow.
  const anchor = new THREE.Group();
  anchor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.7, 6), metal));
  const arms = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 10, 24, Math.PI), metal);
  arms.rotation.z = Math.PI;
  arms.position.y = -0.3;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 6, 12), metal);
  ring.position.y = 0.95;
  anchor.add(arms, ring);
  anchor.position.set(5.8, height(5.8, 0.8) + 0.25, 0.8);
  anchor.rotation.set(1.2, 0.4, 0.3);
  g.add(anchor);
  return shadows(g);
}

function buildChest() {
  const group = new THREE.Group();
  group.userData.glyph = 'wood';
  const woodM = std('#6b4423'), trim = std('#c9a23c', 'stone', { metalness: 0.4, roughness: 0.45 });
  const add = (geo, mat, x, y, z, parent = group) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  add(new THREE.BoxGeometry(0.8, 0.45, 0.5), woodM, 0, 0.225, 0);
  for (const y of [0.05, 0.42]) add(new THREE.BoxGeometry(0.82, 0.06, 0.52), trim, 0, y, 0);
  for (const x of [-0.3, 0.3]) add(new THREE.BoxGeometry(0.06, 0.47, 0.52), trim, x, 0.23, 0);
  const goldM = std('#ffe08a', 'glow', { emissive: '#ffbf3a', emissiveIntensity: 0.3 });
  for (let i = 0; i < 7; i++) add(new THREE.IcosahedronGeometry(0.07 + (i % 3) * 0.02, 0), goldM, -0.28 + i * 0.09, 0.44, (i % 2) * 0.1 - 0.05);
  const pivot = new THREE.Group();
  pivot.position.set(0, 0.45, -0.25);
  group.add(pivot);
  const lid = add(new THREE.CylinderGeometry(0.25, 0.25, 0.8, 20, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), woodM, 0, 0, 0.25, pivot);
  lid.scale.set(1, 0.7, 1);
  add(new THREE.BoxGeometry(0.06, 0.2, 0.52), trim, 0, 0.08, 0.25, pivot);
  const light = new THREE.PointLight('#ffcf6b', 0, 4, 2);
  light.position.set(0, 0.8, 0.2);
  group.add(light);
  const SP = 10;
  const sparkle = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.035, 0), std('#fff2b0', 'particles', { emissive: '#ffd36b', emissiveIntensity: 4 }), SP);
  sparkle.frustumCulled = false;
  group.add(sparkle);
  shadows(group);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  return {
    group,
    update(t, open) {
      pivot.rotation.x = -open * 1.7;
      goldM.emissiveIntensity = 0.3 + open * 3.2;
      light.intensity = open * 3;
      for (let i = 0; i < SP; i++) {
        const k = (t * 0.35 + i / SP) % 1;
        v.set(Math.sin(i * 2.4 + t) * 0.25, 0.5 + k * 1.4, Math.cos(i * 1.7 + t) * 0.15);
        s.setScalar(open > 0.05 ? (1 - k) * open * 1.4 : 0.0001);
        sparkle.setMatrixAt(i, m.compose(v, q, s));
      }
      sparkle.instanceMatrix.needsUpdate = true;
    },
  };
}

function branchGeometry(rnd) {
  const parts = [];
  const grow = (start, dir, len, rad, depth) => {
    const end = start.clone().addScaledVector(dir, len);
    const g = new THREE.CylinderGeometry(rad * 0.8, rad, len, 9);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
    const mid = start.clone().addScaledVector(dir, len / 2);
    g.translate(mid.x, mid.y, mid.z);
    parts.push(g);
    if (depth <= 0) {
      parts.push(new THREE.SphereGeometry(rad * 1.3, 9, 7).translate(end.x, end.y, end.z));
      return;
    }
    for (let i = 0; i < 2 + (rnd() < 0.4 ? 1 : 0); i++) {
      const nd = dir.clone().add(new THREE.Vector3((rnd() - 0.5) * 1.6, 0.35 + rnd() * 0.4, (rnd() - 0.5) * 1.6)).normalize();
      grow(end, nd, len * (0.7 + rnd() * 0.15), rad * 0.72, depth - 1);
    }
  };
  grow(new THREE.Vector3(), UP.clone(), 0.5, 0.11, 3);
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
}

// A lumpy, smooth blob (indexed so normals average across faces).
function blobGeometry(N, detail, amount, freq, seed = 0) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + N.fbm(v.x * freq + seed, v.y * freq + v.z * freq * 0.7 + seed, 3) * amount;
    p.setXYZ(i, v.x * d, v.y * d, v.z * d);
  }
  g.computeVertexNormals();
  return g;
}

function buildCoral(height, rnd, N, caustic, avoid) {
  const group = new THREE.Group();
  const spots = [];
  const corridor = (x, z) => z > 4 && Math.abs(x) < 10;
  const take = (count, regions, minD, far = false) => {
    const out = [];
    for (let tries = 0; tries < count * 60 && out.length < count; tries++) {
      const [x0, x1, z0, z1] = regions[Math.floor(rnd() * regions.length)];
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2])) continue;
      if (far && corridor(x, z)) continue;
      if (spots.some((p) => Math.hypot(p.x - x, p.z - z) < minD) || out.some((p) => Math.hypot(p.x - x, p.z - z) < minD)) continue;
      out.push({ x, z, y: height(x, z), r: rnd(), r2: rnd(), r3: rnd() });
    }
    spots.push(...out);
    return out;
  };
  const near = [[-9, -3, 0, 6], [3.5, 10, -0.5, 5.5], [-12, 12, -12, 2]];
  const far = [[-50, -12, -50, 10], [12, 50, -50, 10], [-14, 14, -52, -14]];
  const palette = ['#ff6f61', '#ff9a3c', '#e84a8a', '#c05bd6', '#ffd166', '#ff4f5e', '#f28cb1'].map(C);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const add = (geo, mat, pts, scale, sy = 1, tilt = 0.25) => {
    const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
    pts.forEach((p, i) => {
      q.setFromEuler(e.set((p.r2 - 0.5) * tilt, p.r * 6.28, (p.r3 - 0.5) * tilt));
      const k = scale[0] + p.r2 * (scale[1] - scale[0]);
      mesh.setMatrixAt(i, m.compose(v.set(p.x, p.y - 0.05, p.z), q, s.set(k, k * sy, k)));
      mesh.setColorAt(i, palette[Math.floor(p.r3 * palette.length)]);
    });
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const branchGs = [branchGeometry(rnd), branchGeometry(rnd)];
  const coralM = caustic('#ffffff', 'foliage');
  for (const [pts, sc] of [[take(60, near, 0.65), [0.9, 1.9]], [take(130, far, 1.2, true), [1.4, 3.2]]]) {
    const half = Math.ceil(pts.length / 2);
    add(branchGs[0], coralM, pts.slice(0, half), sc).castShadow = true;
    add(branchGs[1], coralM, pts.slice(half), sc).castShadow = true;
  }

  const brainG = blobGeometry(N, 4, 0.16, 2.4, 3);
  add(brainG, coralM, take(38, near, 0.8), [0.45, 1.0], 0.6, 0.1);
  add(brainG, coralM, take(90, far, 1.3, true), [0.8, 2.2], 0.6, 0.1);

  const spongeG = mergeGeometries([0, 1, 2, 3].map((i) => {
    const h = 0.6 + i * 0.22;
    return new THREE.CylinderGeometry(0.1, 0.08, h, 16, 1, true).translate(Math.cos(i * 1.9) * 0.14, h / 2, Math.sin(i * 1.9) * 0.14);
  }));
  const spongeM = caustic('#ffffff', 'default', { side: THREE.DoubleSide });
  add(spongeG, spongeM, take(14, near, 0.8), [0.9, 1.6]);
  add(spongeG, spongeM, take(40, far, 1.3, true), [1.4, 2.6]);

  const fanG = new THREE.CircleGeometry(1, 36, 0, Math.PI);
  const fp = fanG.attributes.position;
  for (let i = 0; i < fp.count; i++) fp.setZ(i, N.noise(fp.getX(i) * 3, fp.getY(i) * 3) * 0.12);
  fanG.computeVertexNormals();
  const fanM = std('#ffffff', 'soft', { side: THREE.DoubleSide });
  const fanSets = [[take(12, near, 1.0), [0.6, 1.1]], [take(30, far, 1.6, true), [1.0, 2.0]]].map(([pts, sc]) => ({ pts, sc, mesh: add(fanG, fanM, pts, sc, 1, 0) }));

  return {
    group, spots,
    update(t, cur) {
      for (const f of fanSets) {
        f.pts.forEach((p, i) => {
          q.setFromEuler(e.set(Math.sin(t * 0.8 + p.r * 9) * 0.12 * cur, p.r * 6.28, 0));
          const k = f.sc[0] + p.r2 * (f.sc[1] - f.sc[0]);
          f.mesh.setMatrixAt(i, m.compose(v.set(p.x, p.y - 0.05, p.z), q, s.setScalar(k)));
        });
        f.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

// Big smooth rock outcrops scattered out into the haze, so the reef never visibly ends.
function buildOutcrops(height, rnd, N, caustic) {
  const geo = blobGeometry(N, 3, 0.4, 1.3, 5);
  const pts = [];
  for (let tries = 0; tries < 2000 && pts.length < 46; tries++) {
    const a = rnd() * Math.PI * 2, r = 14 + rnd() * 46;
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 4;
    if (z > 2 && Math.abs(x) < 14) continue;
    if (Math.hypot(x - 0.4, z + 3) < 8) continue;
    if (pts.some((p) => Math.hypot(p[0] - x, p[2] - z) < 4)) continue;
    const sx = 2 + rnd() * 4.5, sy = 1 + rnd() * 2.6, sz = 2 + rnd() * 4.5;
    pts.push([x, height(x, z) - sy * 0.35, z, sx, sy, sz, rnd() * 6.28, rnd()]);
  }
  const mesh = new THREE.InstancedMesh(geo, caustic('#ffffff', 'stone', { roughness: 1 }), pts.length);
  const pal = ['#55635c', '#4a5550', '#56704a', '#5e665e'].map(C);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
  pts.forEach(([x, y, z, sx, sy, sz, ry, c], i) => {
    q.setFromEuler(e.set((c - 0.5) * 0.3, ry, (c - 0.5) * 0.2));
    mesh.setMatrixAt(i, m.compose(v.set(x, y, z), q, s.set(sx, sy, sz)));
    mesh.setColorAt(i, pal[Math.floor(c * pal.length)]);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildKelp(height, rnd, avoid) {
  const strands = [];
  const add = (count, x0, x1, z0, z1, segs, segLen, width) => {
    for (let tries = 0; tries < count * 40 && count > 0; tries++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2])) continue;
      strands.push({ x, z, y: height(x, z) - 0.05, segs, segLen: segLen * (0.7 + rnd() * 0.6), width, ph: rnd() * 6.28, yaw: rnd() * 6.28, lean: (rnd() - 0.5) * 0.2 });
      count--;
    }
  };
  add(14, -14, -7, -6, 5, 9, 0.5, 0.24);
  add(12, 7, 14, -8, 3, 9, 0.5, 0.24);
  add(10, -10, 10, 1, 7, 4, 0.22, 0.1);
  add(16, -12, 12, -12, -5, 5, 0.3, 0.12);
  add(45, -50, -14, -50, 8, 10, 0.55, 0.3);
  add(45, 14, 50, -50, 8, 10, 0.55, 0.3);
  add(35, -16, 16, -52, -16, 10, 0.55, 0.3);
  const total = strands.reduce((n, s) => n + s.segs, 0);
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.08).translate(0, 0.5, 0), std('#ffffff', 'grass', { side: THREE.DoubleSide }), total);
  const col = new THREE.Color();
  let k = 0;
  for (const s of strands) for (let j = 0; j < s.segs; j++) mesh.setColorAt(k++, col.set(j / s.segs > 0.6 ? '#7d9a35' : '#4f7d3a'));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), step = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3(), d = new THREE.Vector3();
  const update = (t, cur) => {
    let i = 0;
    for (const s of strands) {
      p.set(s.x, s.y, s.z);
      q.setFromAxisAngle(UP, s.yaw);
      for (let j = 0; j < s.segs; j++) {
        const f = j / s.segs;
        step.setFromEuler(e.set(Math.sin(t * 0.7 + s.ph * 1.3 + j * 0.3) * 0.06 * cur, 0,
          s.lean / s.segs + Math.sin(t * 0.9 + s.ph + j * 0.45) * (0.1 + 0.08 * f) * cur));
        q.multiply(step);
        mesh.setMatrixAt(i++, m.compose(p, q, sc.set(s.width * (1 - f * 0.4), s.segLen, 1)));
        p.add(d.set(0, s.segLen, 0).applyQuaternion(q));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0, 1);
  return { mesh, update };
}

function fishGeometry() {
  const body = new THREE.SphereGeometry(1, 14, 10).toNonIndexed();
  body.scale(1, 0.42, 0.2);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([-0.85, 0, 0, -1.55, 0.45, 0, -1.55, -0.45, 0], 3));
  tail.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  tail.computeVertexNormals();
  return mergeGeometries([body, tail]);
}

function buildSchool(rnd, opts = {}) {
  const N = opts.count ?? 160;
  const mesh = new THREE.InstancedMesh(fishGeometry(), std('#ffffff', 'particles', { side: THREE.DoubleSide, roughness: 0.35, emissive: '#1b3f4a' }), N);
  mesh.frustumCulled = false;
  const col = new THREE.Color();
  const fish = Array.from({ length: N }, (_, i) => {
    mesh.setColorAt(i, col.set('#dff2f5').lerp(C('#8fb7c4'), rnd()));
    const o = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (o.length() > 1) o.normalize();
    return { lag: rnd() * 2.4, o: o.multiply(new THREE.Vector3(1.5, 0.7, 1.5)), ph: rnd() * 6.28, s: 0.15 + rnd() * 0.07, av: new THREE.Vector3() };
  });
  const path = opts.path || ((t, out) => out.set(Math.cos(t * 0.11) * 8.5, 4.4 + Math.sin(t * 0.23) * 1.5, Math.sin(t * 0.11) * 4.8 - 2.2));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), pos = new THREE.Vector3(), vel = new THREE.Vector3(), cp = new THREE.Vector3(), push = new THREE.Vector3();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), sc = new THREE.Vector3();
  return {
    mesh,
    update(t, dt, ray, scatter, cur) {
      fish.forEach((f, i) => {
        const tt = t * (0.8 + 0.2 * cur) - f.lag;
        path(tt, a); path(tt + 0.05, b);
        vel.subVectors(b, a);
        pos.copy(a).addScaledVector(f.o, 1 + scatter * 2.6);
        pos.y += Math.sin(t * 1.3 + f.ph) * 0.12;
        push.set(0, 0, 0);
        if (ray) {
          ray.closestPointToPoint(pos, cp);
          const d = pos.distanceTo(cp);
          if (d < 2.4) push.subVectors(pos, cp).normalize().multiplyScalar((2.4 - d) * 1.3);
        }
        f.av.lerp(push, Math.min(1, dt * 4));
        pos.add(f.av);
        const yaw = Math.atan2(-vel.z, vel.x) + Math.sin(t * 9 + f.ph) * 0.12;
        const pitch = Math.asin(THREE.MathUtils.clamp(vel.y / (vel.length() || 1), -0.6, 0.6));
        q.setFromEuler(e.set(0, yaw, pitch, 'YZX'));
        mesh.setMatrixAt(i, m.compose(pos, q, sc.setScalar(f.s)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildReefFish(height, rnd, spots) {
  const N = 18;
  const mesh = new THREE.InstancedMesh(fishGeometry(), std('#ffffff', 'default', { side: THREE.DoubleSide, roughness: 0.5 }), N);
  mesh.frustumCulled = false;
  const pal = ['#ff8c3a', '#ffd23f', '#3fa7ff', '#ff5d8f', '#ffb347'].map(C);
  const fish = Array.from({ length: N }, (_, i) => {
    const sp = spots[Math.floor(rnd() * spots.length)] || { x: 0, z: 2, y: 0 };
    mesh.setColorAt(i, pal[i % pal.length]);
    return { hx: sp.x, hz: sp.z, hy: sp.y + 0.6 + rnd() * 1.4, r: 0.7 + rnd() * 1.2, w: (0.35 + rnd() * 0.4) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * 6.28, s: 0.2 + rnd() * 0.1 };
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), v = new THREE.Vector3(), sc = new THREE.Vector3();
  return {
    mesh,
    update(t) {
      fish.forEach((f, i) => {
        const a = t * f.w + f.ph;
        v.set(f.hx + Math.cos(a) * f.r, f.hy + Math.sin(a * 2) * 0.25, f.hz + Math.sin(a) * f.r * 0.6);
        const vx = -Math.sin(a) * f.w, vz = Math.cos(a) * f.w * 0.6;
        q.setFromEuler(e.set(0, Math.atan2(-vz, vx) + Math.sin(t * 8 + f.ph) * 0.15, 0, 'YZX'));
        mesh.setMatrixAt(i, m.compose(v, q, sc.setScalar(f.s)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildManta() {
  const group = new THREE.Group();
  group.userData.glyph = 'default';
  const top = std('#26363f', undefined, { side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14).scale(0.95, 0.2, 0.55), top);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.7, 0);
  wingShape.quadraticCurveTo(0.6, 1.4, -0.2, 2.4);
  wingShape.quadraticCurveTo(-0.2, 1.0, -0.8, 0);
  wingShape.lineTo(0.7, 0);
  const wingG = new THREE.ExtrudeGeometry(wingShape, { depth: 0.06, bevelEnabled: false, curveSegments: 16 }).rotateX(Math.PI / 2);
  const wingR = new THREE.Mesh(wingG, top);
  wingR.position.z = 0.35;
  const wingL = new THREE.Mesh(wingG, top);
  wingL.position.z = -0.35;
  wingL.scale.z = -1;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.05, 1.8, 8).rotateZ(Math.PI / 2), top);
  tail.position.x = -1.7;
  const fins = [0.25, -0.25].map((z) => {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 0.08), top);
    f.position.set(1.0, 0, z);
    return f;
  });
  group.add(body, wingR, wingL, tail, ...fins);
  group.scale.setScalar(0.85);
  shadows(group);
  return {
    group,
    update(t) {
      const a = t * 0.08 + 2.0, R = 10.5;
      group.position.set(Math.cos(a) * R, 7.8 + Math.sin(t * 0.3) * 0.6, Math.sin(a) * R * 0.75 - 4);
      group.rotation.set(Math.sin(t * 0.4) * 0.08, -(a + Math.PI / 2), -0.18, 'YZX');
      const flap = Math.sin(t * 1.5) * 0.42;
      wingR.rotation.x = flap;
      wingL.rotation.x = -flap;
    },
  };
}

function buildJellies(rnd) {
  const group = new THREE.Group();
  group.userData.glyph = 'glow';
  const list = [];
  const cols = [['#f3c6ff', '#c05bff'], ['#c6f4ff', '#45c8ff'], ['#ffd0e6', '#ff5fa8']];
  for (let i = 0; i < 11; i++) {
    const [c, em] = cols[i % cols.length];
    const g = new THREE.Group();
    const mat = std(c, 'glow', { emissive: em, emissiveIntensity: 1.6, side: THREE.DoubleSide, flatShading: false, roughness: 0.3 });
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat);
    g.add(bell);
    const tents = [];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const piv = new THREE.Group();
      piv.position.set(Math.cos(a) * 0.24, 0.02, Math.sin(a) * 0.24);
      piv.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.004, 1.5, 3).translate(0, -0.75, 0), mat));
      g.add(piv);
      tents.push(piv);
    }
    g.position.set(-24 + rnd() * 48, 2 + rnd() * 9, -34 + rnd() * 30);
    group.add(g);
    list.push({ g, bell, tents, ph: rnd() * 6.28, sp: 0.12 + rnd() * 0.1, dx: (rnd() - 0.5) * 0.1 });
  }
  return {
    group,
    update(t, dt) {
      for (const j of list) {
        const p = Math.sin(t * 1.8 + j.ph);
        j.bell.scale.set(1 + 0.12 * p, 1 - 0.16 * p, 1 + 0.12 * p);
        j.g.position.y += dt * j.sp * (0.4 + 0.6 * Math.max(0, -p));
        j.g.position.x += dt * j.dx;
        if (j.g.position.y > SURFACE_Y - 1.5) j.g.position.y = 1.5;
        j.tents.forEach((tp, k) => { tp.rotation.set(Math.sin(t * 1.3 + k + j.ph) * 0.18, 0, Math.cos(t * 1.1 + k * 1.7) * 0.18); });
      }
    },
  };
}

function buildBubbles(vents) {
  const N = 220;
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8),
    std('#e6fdff', 'soft', { emissive: '#7fe3ff', emissiveIntensity: 1.6, roughness: 0.2, flatShading: false }), N);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const b = Array.from({ length: N }, () => ({ alive: false, p: new THREE.Vector3(), r: 0.1, vy: 1, ph: 0 }));
  const spawn = (p, spread, rMin, rMax) => {
    const s = b.find((x) => !x.alive);
    if (!s) return;
    s.alive = true;
    s.p.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 0.5, (Math.random() - 0.5) * spread));
    s.r = rMin + Math.random() * (rMax - rMin);
    s.vy = 0.9 + Math.random() * 0.8;
    s.ph = Math.random() * 6.28;
  };
  const acc = vents.map(() => 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  return {
    mesh,
    burst(p, n) { for (let i = 0; i < n; i++) spawn(p, 0.9, 0.06, 0.2); },
    update(t, dt, cur) {
      vents.forEach((v, i) => { acc[i] += dt * 4; while (acc[i] > 1) { acc[i] -= 1; spawn(v, 0.15, 0.05, 0.12); } });
      b.forEach((x, i) => {
        if (x.alive) {
          x.p.y += x.vy * dt;
          x.p.x += (Math.sin(t * 3 + x.ph) * 0.25 + cur * 0.15) * dt;
          x.p.z += Math.cos(t * 2.6 + x.ph) * 0.2 * dt;
          if (x.p.y > SURFACE_Y - 0.2) x.alive = false;
        }
        const r = x.alive ? x.r * (1 + Math.max(0, x.p.y) * 0.03) : 0.0001;
        mesh.setMatrixAt(i, m.compose(x.p, q, sc.setScalar(r)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function buildRays(rnd) {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uStrength: { value: 1 } },
    vertexShader: /* glsl */`varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vSeed; attribute float aSeed;
      void main() { vUv = uv; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform float uTime; uniform float uStrength; varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vSeed;
      void main() {
        float edge = pow(abs(dot(vN, vV)), 1.6);
        float fade = smoothstep(0.0, 0.85, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
        float flick = 0.6 + 0.4 * sin(uTime * 0.7 + vSeed * 7.0) * sin(uTime * 0.43 + vSeed * 3.0);
        float a = edge * fade * flick * uStrength * 0.13;
        gl_FragColor = vec4(vec3(0.75, 0.97, 1.0) * a, 1.0);
      }`,
  });
  const shafts = [];
  for (let i = 0; i < 13; i++) {
    const h = 15;
    const g = new THREE.CylinderGeometry(0.3 + rnd() * 0.4, 0.9 + rnd() * 0.9, h, 18, 1, true).translate(0, -h / 2, 0);
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(rnd()), 1));
    const m = new THREE.Mesh(g, mat);
    m.position.set(-26 + i * 4.3 + (rnd() - 0.5) * 3, SURFACE_Y + 0.5, -30 + rnd() * 34);
    m.rotation.set(0.22 + rnd() * 0.12, 0, -0.18 + (rnd() - 0.5) * 0.15);
    m.frustumCulled = false;
    group.add(m);
    shafts.push({ m, base: m.rotation.z, ph: rnd() * 6.28 });
  }
  return {
    group,
    update(t, strength) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uStrength.value = strength;
      for (const s of shafts) s.m.rotation.z = s.base + Math.sin(t * 0.15 + s.ph) * 0.05;
    },
  };
}
