import * as THREE from 'three';
import { std, addLights, shadows, disposeScene } from './kit.js';

// Empty stage for dropped .glb / .gltf models. Glyph sets are guessed from material and mesh names.

const RULES = [
  [/water|sea|ocean|river|lake|liquid/i, 'water'],
  [/leaf|leaves|foliage|tree|bush|plant|hedge|canopy/i, 'foliage'],
  [/grass|lawn|moss|turf/i, 'grass'],
  [/rock|stone|cliff|concrete|brick|marble|metal|steel/i, 'stone'],
  [/wood|bark|trunk|plank|timber/i, 'wood'],
  [/sand|dirt|soil|ground|terrain|earth/i, 'sand'],
  [/glass|light|lamp|emiss|neon|glow|fire/i, 'glow'],
  [/cloud|smoke|fog|fabric|cloth/i, 'soft'],
];

export function tagGlyphs(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.userData.glyph) continue;
      const rule = RULES.find(([re]) => re.test(`${m.name} ${o.name}`));
      if (rule) m.userData.glyph = rule[1];
      else if (m.emissive && m.emissiveIntensity > 0.5 && m.emissive.getHex() !== 0) m.userData.glyph = 'glow';
    }
  });
}

export default {
  name: 'Stage',
  frame: { target: [0, 1.2, 0], radius: 2.6, elevation: 16, azimuth: 30, fov: 30 },

  create() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0d1019');
    addLights(scene, { pos: [5, 8, 4], extent: 6 });

    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64).rotateX(-Math.PI / 2), std('#2a303d', 'default', { flatShading: false }));
    floor.receiveShadow = true;
    scene.add(floor);

    let model = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.22, 200, 28), std('#b08cff', 'default', { flatShading: false, roughness: 0.35 }));
    model.position.y = 1.2;
    scene.add(shadows(model));
    let placeholder = true;
    let mixer = null;

    return {
      scene,
      update(t, dt) {
        mixer?.update(dt);
        if (placeholder) model.rotation.set(t * 0.3, t * 0.45, 0);
      },
      setModel(gltf) {
        scene.remove(model);
        disposeScene(model);
        placeholder = false;
        mixer = null;
        model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.scale.setScalar(2.6 / Math.max(size.x, size.y, size.z, 1e-6));
        box.setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.x -= c.x;
        model.position.z -= c.z;
        model.position.y -= box.min.y;
        tagGlyphs(model);
        scene.add(model);
        if (gltf.animations?.length) {
          mixer = new THREE.AnimationMixer(model);
          gltf.animations.forEach((a) => mixer.clipAction(a).play());
        }
      },
    };
  },
};
