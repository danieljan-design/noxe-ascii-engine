import * as THREE from 'three';
import { std, addLights, shadows } from './kit.js';

// Test scene: one object per glyph set so each ramp can be tuned in isolation.

export default {
  name: 'Primitives',
  frame: { target: [0, 0.9, 0], radius: 3.6, elevation: 22, azimuth: 30, fov: 30 },

  create() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0e1220');
    addLights(scene, { pos: [6, 9, 4], extent: 7 });

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), std('#3a4254', 'grass', { flatShading: false }));
    ground.receiveShadow = true;
    scene.add(ground);

    const items = [
      [new THREE.TorusKnotGeometry(0.42, 0.15, 180, 24), std('#b08cff', 'default', { flatShading: false, roughness: 0.4 })],
      [new THREE.SphereGeometry(0.6, 48, 32), std('#d9d9d9', 'stone', { flatShading: false })],
      [new THREE.BoxGeometry(0.9, 0.9, 0.9), std('#e2733b', 'wood')],
      [new THREE.IcosahedronGeometry(0.65, 0), std('#6ab04c', 'foliage')],
      [new THREE.CylinderGeometry(0.4, 0.4, 1.1, 32), std('#4fb3c9', 'water', { flatShading: false, roughness: 0.3 })],
      [new THREE.TorusGeometry(0.45, 0.16, 20, 48), std('#fff1c9', 'glow', { emissive: '#ffbf5a', emissiveIntensity: 2.5 })],
    ];
    const meshes = items.map(([g, m], i) => {
      const mesh = new THREE.Mesh(g, m);
      const a = (i / items.length) * Math.PI * 2;
      mesh.position.set(Math.cos(a) * 1.9, 0.75, Math.sin(a) * 1.9);
      scene.add(shadows(mesh));
      return mesh;
    });

    return {
      scene,
      update(t) {
        meshes.forEach((m, i) => {
          m.rotation.set(t * 0.3 + i, t * 0.5 + i * 2, 0);
          m.position.y = 0.8 + Math.sin(t * 1.2 + i) * 0.12;
        });
      },
    };
  },
};
