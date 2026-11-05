import * as THREE from 'three';

// Small helpers shared by scenes.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function makeNoise(seed = 1) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rnd() * 2 - 1;
  const h = (x, y) => vals[p[(p[x & 255] + y) & 255]];
  function noise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct = 4) {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  return { noise, fbm };
}

// Standard low-poly material with an optional glyph set tag.
export function std(color, glyph, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...extra });
  if (glyph) m.userData.glyph = glyph;
  return m;
}

export function addLights(scene, { sun = '#ffe1b8', sunI = 2.6, sky = '#a9c8ff', ground = '#4b3d2c', hemiI = 0.9, pos = [8, 11, 5], extent = 11 } = {}) {
  const hemi = new THREE.HemisphereLight(sky, ground, hemiI);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(sun, sunI);
  dir.position.set(...pos);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  const c = dir.shadow.camera;
  c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent; c.near = 1; c.far = 50;
  dir.shadow.bias = -0.0004;
  dir.shadow.normalBias = 0.03;
  scene.add(dir, dir.target);
  return { hemi, dir };
}

export function shadows(obj, cast = true, receive = true) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}

export function disposeScene(scene) {
  scene.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}
