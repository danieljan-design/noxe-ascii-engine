import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, smooth, std, addLights, shadows } from './kit.js';

// Low-poly island diorama: terrain, water, trees, rocks, lighthouse with sweeping beams,
// cottage, dock, a sailboat and drifting clouds.

const C = (hex) => new THREE.Color(hex);
export const wave = (x, z, t) =>
  0.055 * Math.sin(x * 0.85 + t * 1.1) + 0.045 * Math.sin(z * 1.2 - t * 0.9 + x * 0.35) + 0.025 * Math.sin((x + z) * 2.3 + t * 1.9);

export default {
  name: 'Island',
  frame: { target: [0, 0.5, 0], radius: 4.6, elevation: 30, azimuth: 40, fov: 28 },
  look: {},

  create() {
    const scene = new THREE.Scene();
    scene.background = C('#1a2433');
    scene.fog = new THREE.Fog('#1f2c40', 26, 56);
    addLights(scene);

    const N = makeNoise(11);
    const rnd = mulberry32(7);
    const height = (x, z) => {
      const warp = N.fbm(x * 0.22 + 4.1, z * 0.22 - 2.3, 3) * 1.6;
      const r = Math.hypot(x, z * 1.15) + warp;
      const land = smooth(6.0, 2.0, r);
      let h = land * (0.9 + N.fbm(x * 0.32, z * 0.32, 4) * 0.9);
      h += land * land * Math.max(0, N.fbm(x * 0.45 + 7.7, z * 0.45 + 1.3, 3)) * 2.6;
      return h - 0.55 - (1 - land) * 1.2;
    };
    const slope = (x, z) =>
      Math.abs(height(x + 0.25, z) - height(x - 0.25, z)) + Math.abs(height(x, z + 0.25) - height(x, z - 0.25));

    scene.add(buildTerrain(height, N));
    const water = buildWater(height);
    scene.add(water.mesh);

    // Lighthouse on the high ground at the back of the island.
    let best = null;
    for (let a = 0; a < 64; a++) {
      const ang = Math.PI * (0.85 + (a / 64) * 0.8);
      for (let r = 2.2; r < 5; r += 0.2) {
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r, h = height(x, z);
        const score = h * 0.6 + r * 0.4 - slope(x, z) * 4;
        if (h > 0.6 && (!best || score > best.score)) best = { x, z, h, score, ang };
      }
    }
    const lh = buildLighthouse();
    lh.group.position.set(best.x, best.h - 0.08, best.z);
    scene.add(lh.group);

    // Cottage beside it, towards the middle.
    const hx = best.x - Math.cos(best.ang) * 0.85, hz = best.z - Math.sin(best.ang) * 0.85;
    const house = buildHouse();
    house.position.set(hx, height(hx, hz) - 0.06, hz);
    house.rotation.y = -best.ang + 0.4;
    scene.add(house);

    // Dock on the near shore.
    const dAng = -0.3;
    const dir = new THREE.Vector3(Math.cos(dAng), 0, Math.sin(dAng));
    let shore = 1;
    while (shore < 8 && height(dir.x * shore, dir.z * shore) > 0.1) shore += 0.05;
    const dock = buildDock();
    dock.position.set(dir.x * shore, 0, dir.z * shore);
    dock.rotation.y = -dAng;
    scene.add(dock);

    const avoid = [[best.x, best.z, 0.9], [hx, hz, 0.8], [dir.x * shore, dir.z * shore, 0.7]];
    scene.add(buildTrees(height, slope, rnd, avoid));
    scene.add(buildRocks(height, slope, rnd, avoid));

    const boat = buildBoat();
    scene.add(boat);
    const clouds = buildClouds(rnd);
    clouds.forEach((c) => scene.add(c.group));

    return {
      scene,
      update(t, dt) {
        water.update(t);
        lh.spin.rotation.y = t * 0.9;
        const a = t * 0.07 + 1.2, R = 7.2;
        const bx = Math.cos(a) * R, bz = Math.sin(a) * R;
        boat.position.set(bx, wave(bx, bz, t) + 0.02, bz);
        boat.rotation.set(Math.sin(t * 1.3) * 0.05, -(a + Math.PI / 2), Math.sin(t * 1.7 + 1) * 0.04);
        for (const c of clouds) {
          c.ang += c.speed * dt;
          c.group.position.set(Math.cos(c.ang) * c.r, c.y, Math.sin(c.ang) * c.r);
        }
      },
    };
  },
};

function buildTerrain(height, N) {
  const SIZE = 15, SEG = 120;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, height(pa.getX(i), pa.getZ(i)));
  const P = g.toNonIndexed().attributes.position.array;

  const out = [[], [], []], cols = [[], [], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), col = new THREE.Color();
  const sand = C('#d8bd84'), grassA = C('#64a347'), grassB = C('#386a33'), rockA = C('#8b857a'), rockB = C('#5c5852');
  for (let i = 0; i < P.length; i += 9) {
    a.fromArray(P, i); b.fromArray(P, i + 3); c.fromArray(P, i + 6);
    if (Math.max(a.y, b.y, c.y) < -0.5) continue;
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    const cy = (a.y + b.y + c.y) / 3;
    const v = N.noise((a.x + b.x + c.x) * 0.6, (a.z + b.z + c.z) * 0.6) * 0.5 + 0.5;
    let k;
    if (cy < 0.2 + v * 0.12) { k = 0; col.copy(sand).offsetHSL(0, 0, (v - 0.5) * 0.08); }
    else if (Math.abs(n.y) < 0.78 || cy > 2.4) { k = 2; col.lerpColors(rockA, rockB, v); }
    else { k = 1; col.lerpColors(grassA, grassB, v * 0.8 + Math.min(1, cy / 3) * 0.2); }
    for (let j = 0; j < 9; j++) out[k].push(P[i + j]);
    for (let j = 0; j < 3; j++) cols[k].push(col.r, col.g, col.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...out), 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute([].concat(...cols), 3));
  let start = 0;
  out.forEach((arr, k) => { const cnt = arr.length / 3; geo.addGroup(start, cnt, k); start += cnt; });
  geo.computeVertexNormals();
  const mat = (glyph) => std('#ffffff', glyph, { vertexColors: true, roughness: 0.95 });
  return shadows(new THREE.Mesh(geo, [mat('sand'), mat('grass'), mat('stone')]));
}

function buildWater(height) {
  const SIZE = 90, SEG = 150;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  const base = Float32Array.from(pa.array);
  const colors = new Float32Array(pa.count * 3);
  const deep = C('#154a70'), mid = C('#1f7f99'), shallow = C('#53c4c8'), foam = C('#eef6f2'), col = new THREE.Color();
  for (let i = 0; i < pa.count; i++) {
    const h = height(base[i * 3], base[i * 3 + 2]);
    col.lerpColors(deep, mid, smooth(-1.75, -1.0, h));
    col.lerp(shallow, smooth(-0.9, -0.25, h));
    col.lerp(foam, smooth(-0.22, -0.02, h) * 0.85);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(g, std('#ffffff', 'water', { vertexColors: true, roughness: 0.3, metalness: 0.05 }));
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(t) {
      const arr = pa.array;
      for (let i = 0; i < pa.count; i++) arr[i * 3 + 1] = wave(base[i * 3], base[i * 3 + 2], t);
      pa.needsUpdate = true;
    },
  };
}

function buildLighthouse() {
  const group = new THREE.Group();
  const white = std('#ece6d8'), red = std('#c4432f'), dark = std('#2b2e36', 'stone'), roof = std('#8f2f24');
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.3, 8), std('#8a847a', 'stone'));
  plinth.position.y = 0.05;
  group.add(plinth);
  let y = 0.2;
  const bands = 6, H = 1.5;
  for (let i = 0; i < bands; i++) {
    const r0 = 0.3 - i * 0.022, r1 = 0.3 - (i + 1) * 0.022;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, H / bands, 12), i % 2 ? red : white);
    seg.position.y = y + H / bands / 2;
    y += H / bands;
    group.add(seg);
  }
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 14), dark);
  gallery.position.y = y + 0.025; y += 0.05;
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.24, 10),
    std('#fff3c4', 'glow', { emissive: '#ffcf6a', emissiveIntensity: 3 }));
  lantern.position.y = y + 0.12;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.24, 10), roof);
  cap.position.y = y + 0.36;
  group.add(gallery, lantern, cap);

  const spin = new THREE.Group();
  spin.position.y = y + 0.12;
  const beamG = new THREE.ConeGeometry(0.5, 5, 20, 1, true);
  beamG.rotateZ(Math.PI / 2);
  beamG.translate(2.5, 0, 0);
  const beamM = new THREE.MeshBasicMaterial({
    color: '#ffe7ad', transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  for (const r of [0, Math.PI]) {
    const tilt = new THREE.Group();
    tilt.rotation.y = r;
    const beam = new THREE.Mesh(beamG, beamM);
    beam.rotation.z = -0.1;
    beam.userData.aux = false;
    tilt.add(beam);
    spin.add(tilt);
  }
  group.add(spin);
  shadows(group);
  spin.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return { group, spin };
}

function buildHouse() {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const walls = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.44), std('#e7dcc6', 'default'));
  walls.position.y = 0.18;
  const roofG = new THREE.CylinderGeometry(0.34, 0.34, 0.72, 3, 1, false, Math.PI / 2);
  roofG.rotateZ(Math.PI / 2);
  const roof = new THREE.Mesh(roofG, std('#3d4c63'));
  roof.position.y = 0.36 + 0.17;
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), std('#7a4a3a', 'stone'));
  chimney.position.set(0.18, 0.62, 0.08);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.02), std('#5a3b28'));
  door.position.set(0, 0.09, 0.225);
  g.add(walls, roof, chimney, door);
  return shadows(g);
}

function buildDock() {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const plank = new THREE.BoxGeometry(0.18, 0.05, 0.38);
  const pm = std('#8b6a48');
  for (let i = 0; i < 10; i++) {
    const p = new THREE.Mesh(plank, pm);
    p.position.set(-0.3 + i * 0.21, 0.22, 0);
    p.rotation.y = (i % 3 - 1) * 0.02;
    g.add(p);
  }
  const post = new THREE.CylinderGeometry(0.025, 0.025, 0.9, 5);
  const postM = std('#5b4330');
  for (const x of [-0.2, 0.7, 1.6]) for (const z of [-0.17, 0.17]) {
    const p = new THREE.Mesh(post, postM);
    p.position.set(x, -0.2, z);
    g.add(p);
  }
  return shadows(g);
}

function buildTrees(height, slope, rnd, avoid) {
  const pts = [];
  for (let tries = 0; tries < 1200 && pts.length < 48; tries++) {
    const x = (rnd() * 2 - 1) * 5.5, z = (rnd() * 2 - 1) * 5.5, h = height(x, z);
    if (h < 0.4 || h > 2.4 || slope(x, z) > 0.5) continue;
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2])) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.z - z) < 0.42)) continue;
    pts.push({ x, z, y: h - 0.04, s: 0.75 + rnd() * 0.6, pine: rnd() < 0.6, c: rnd(), yaw: rnd() * 6.28 });
  }
  const trunkG = new THREE.CylinderGeometry(0.035, 0.055, 0.34, 5).translate(0, 0.17, 0);
  const pineG = mergeGeometries([
    new THREE.ConeGeometry(0.27, 0.62, 6).translate(0, 0.55, 0),
    new THREE.ConeGeometry(0.2, 0.48, 6).translate(0, 0.86, 0),
  ]);
  const roundG = new THREE.IcosahedronGeometry(0.3, 0).translate(0, 0.56, 0);
  const pines = pts.filter((p) => p.pine), rounds = pts.filter((p) => !p.pine);
  const trunks = new THREE.InstancedMesh(trunkG, std('#6b4a30', 'wood'), pts.length);
  const pineM = new THREE.InstancedMesh(pineG, std('#ffffff', 'foliage'), pines.length);
  const roundM = new THREE.InstancedMesh(roundG, std('#ffffff', 'foliage'), rounds.length);
  const pinePal = ['#2f6a3c', '#3c7a41', '#285738'].map(C);
  const roundPal = ['#5b9a45', '#7aa84a', '#d08a2e', '#e0b23e', '#6f9d3f'].map(C);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const place = (p) => { q.setFromEuler(e.set(0, p.yaw, 0)); s.setScalar(p.s); return m.compose(v.set(p.x, p.y, p.z), q, s); };
  pts.forEach((p, i) => trunks.setMatrixAt(i, place(p)));
  pines.forEach((p, i) => { pineM.setMatrixAt(i, place(p)); pineM.setColorAt(i, pinePal[Math.floor(p.c * pinePal.length)]); });
  rounds.forEach((p, i) => { roundM.setMatrixAt(i, place(p)); roundM.setColorAt(i, roundPal[Math.floor(p.c * roundPal.length)]); });
  const g = new THREE.Group();
  g.add(trunks, pineM, roundM);
  return shadows(g);
}

function buildRocks(height, slope, rnd, avoid) {
  const pts = [];
  for (let tries = 0; tries < 2000 && pts.length < 34; tries++) {
    const x = (rnd() * 2 - 1) * 6.5, z = (rnd() * 2 - 1) * 6.5, h = height(x, z);
    const shore = h > -0.4 && h < 0.25;
    const cliff = h > 0.5 && slope(x, z) > 0.6 && rnd() < 0.3;
    if (!shore && !cliff) continue;
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - z) < a[2])) continue;
    pts.push({ x, y: Math.max(h, -0.15), z });
  }
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.22, 0), std('#ffffff', 'stone'), pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const col = new THREE.Color();
  pts.forEach((p, i) => {
    q.setFromEuler(e.set(rnd() * 3, rnd() * 3, rnd() * 3));
    s.set(0.6 + rnd(), 0.5 + rnd() * 0.5, 0.6 + rnd() * 0.9);
    rocks.setMatrixAt(i, m.compose(v.set(p.x, p.y, p.z), q, s));
    rocks.setColorAt(i, col.setHSL(0.09, 0.06, 0.38 + rnd() * 0.18));
  });
  return shadows(rocks);
}

function buildBoat() {
  const g = new THREE.Group();
  g.userData.glyph = 'wood';
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.13, 0.24), std('#7a3826'));
  hull.position.y = 0.04;
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4).scale(1, 0.55, 1), std('#7a3826'));
  bow.position.set(0.4, 0.04, 0);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.16), std('#e9e2d0', 'default'));
  cabin.position.set(-0.12, 0.16, 0);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 5), std('#3b2a1e'));
  mast.position.set(0.08, 0.45, 0);
  const sailG = new THREE.BufferGeometry();
  sailG.setAttribute('position', new THREE.Float32BufferAttribute([0.09, 0.15, 0, 0.09, 0.78, 0, 0.42, 0.17, 0], 3));
  sailG.computeVertexNormals();
  const sail = new THREE.Mesh(sailG, std('#f2efe6', 'default', { side: THREE.DoubleSide }));
  g.add(hull, bow, cabin, mast, sail);
  return shadows(g);
}

// Shadow-only clouds: invisible to the camera (no colour/depth write, skipped in the aux pass)
// but they still cast soft moving shadows across the island.
function buildClouds(rnd) {
  const mat = std('#f4f1ea', 'soft', { roughness: 1, colorWrite: false, depthWrite: false });
  const list = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    group.userData.aux = false;
    group.scale.setScalar(1.0);
    const puffs = 4 + Math.floor(rnd() * 3);
    for (let j = 0; j < puffs; j++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35 + rnd() * 0.35, 1), mat);
      p.position.set((rnd() * 2 - 1) * 0.8, (rnd() * 2 - 1) * 0.12, (rnd() * 2 - 1) * 0.35);
      p.scale.y = 0.65;
      p.castShadow = true;
      p.userData.aux = false;
      group.add(p);
    }
    list.push({ group, r: 1 + rnd() * 5, ang: (i / 4) * 6.28 + rnd(), y: 6 + rnd(), speed: 0.03 + rnd() * 0.03 });
  }
  return list;
}
