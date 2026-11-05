import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import GUI from 'lil-gui';
import { AsciiEngine, defaultParams, VIEWS } from './engine/ascii-engine.js';
import { disposeScene } from './scenes/kit.js';
import Island from './scenes/island.js';
import Winter from './scenes/winter.js';
import Reef from './scenes/reef.js';
import Farm from './scenes/farm.js';
import Primitives from './scenes/primitives.js';
import Stage from './scenes/stage.js';

const SCENES = { Island, Winter, Reef, Farm, Primitives, Stage };
const FONTS = ['IBM Plex Mono', 'JetBrains Mono', 'Space Mono', 'Courier New', 'Menlo'];
const STORE = 'noxe-ascii-engine/v2';
// Params a scene can preset in its `look`. Your own tweaks to these are remembered per scene.
const LOOK_KEYS = ['weather', 'wDensity', 'wSpeed', 'wWind', 'wSway', 'wBright', 'wColor', 'exposure', 'gamma', 'saturation',
  'lift', 'bloom', 'bloomThreshold', 'bloomRadius', 'tilt', 'tiltCenter', 'tiltWidth', 'tiltFeather', 'vignette', 'cellFill', 'glyphGain', 'bg'];

// ---------- settings ----------
// xCell / xFps: character size and frame rate used only for the X recordings and X preview.
const app = { scene: 'Island', autoRotate: true, rotateSpeed: 0.6, timeScale: 1, paused: false, recordSeconds: 10, looks: {}, xCell: 6.5, xFps: 30 };
const params = defaultParams();
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved?.params) {
    const { sets, ...rest } = saved.params;
    Object.assign(params, rest);
    if (Array.isArray(sets)) sets.forEach((s, i) => params.sets[i] && Object.assign(params.sets[i], s));
  }
  if (saved?.app) Object.assign(app, saved.app, { paused: false });
} catch (e) { /* ignore bad storage */ }
const save = () => localStorage.setItem(STORE, JSON.stringify({ params, app }));

// ---------- renderer ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

const camera = new THREE.PerspectiveCamera(28, 1, 0.3, 150);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;

const engine = new AsciiEngine(renderer, params);
const rebuildAtlas = () => engine.rebuildAtlas();

// ---------- scenes ----------
let world = null;
let gui = null;
let sceneFolder = null;
const sway = { phase: 0, angle: 0 };

// X (Twitter) recording sizes: logical size x pixel ratio 1.5 = 1920x1080 / 1080x1920.
const RECORD_SIZES = { landscape: [1280, 720], portrait: [720, 1280] };
const RECORD_DPR = 1.5;
let recordMode = null; // null = record/draw the window as is
let recordingWindow = false; // true while 'record this window' runs (caps the size the encoder gets)
const preview = { frame: 'window' }; // letterboxed preview of an X frame, kept until changed

// Scenes can give their framed shots a different setup for tall frames (frame.portrait).
const effectiveFrame = (frame) => (camera.aspect < 1 && frame.portrait ? { ...frame, ...frame.portrait } : frame);

function frameCamera(frame, resetAngles) {
  const f = effectiveFrame(frame);
  camera.fov = f.fov ?? 28;
  camera.updateProjectionMatrix();
  controls.maxPolarAngle = THREE.MathUtils.degToRad(f.maxPolar ?? 88);
  camera.far = f.far ?? 150;
  camera.updateProjectionMatrix();
  const vf = THREE.MathUtils.degToRad(camera.fov);
  const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const dist = f.radius / Math.tan((f.fit === 'height' ? vf : Math.min(vf, hf)) / 2);
  const dir = resetAngles
    ? new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - f.elevation), THREE.MathUtils.degToRad(f.azimuth))
    : camera.position.clone().sub(controls.target).normalize();
  controls.target.fromArray(f.target);
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  if (resetAngles) { sway.phase = 0; sway.angle = 0; } // drift restarts from the framed angle
  controls.update();
}

function applyLook(def) {
  const d = defaultParams();
  const mine = app.looks[def.name] || {};
  for (const k of LOOK_KEYS) params[k] = mine[k] ?? def.look?.[k] ?? d[k];
  // Per-set background fill can also be preset per scene (look.setFill = { sky: 0.3 }).
  for (const s of params.sets) s.fill = mine.setFill?.[s.name] ?? def.look?.setFill?.[s.name] ?? 1;
}

function loadScene(name) {
  if (world) { world.dispose?.(); disposeScene(world.scene); }
  engine.windBoost = 0;
  const def = SCENES[name] || Island;
  world = def.create({ params, engine, renderer, camera });
  world.def = def;
  sway.phase = 0; sway.angle = 0;
  applyLook(def);
  frameCamera(def.frame, true);
  if (gui) {
    sceneFolder?.destroy();
    sceneFolder = null;
    if (world.gui) {
      sceneFolder = gui.addFolder(`${def.name} controls`);
      world.gui(sceneFolder);
      fScene.domElement.insertAdjacentElement('afterend', sceneFolder.domElement);
    }
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}

// Logical (CSS-pixel) size of the drawing: the window, or the fixed recording size.
const view = { w: 1, h: 1 };
// keepCamera: only change the frame size; leave the camera's position, angle and zoom exactly as they are.
function resize(keepCamera = false) {
  const wasPortrait = camera.aspect < 1;
  if (recordMode) {
    const [w, h] = RECORD_SIZES[recordMode];
    // X re-compresses uploads hard: bigger characters and no frame-to-frame grain survive it much better.
    engine.override = { cellSize: app.xCell, grain: 0 };
    renderer.setPixelRatio(RECORD_DPR);
    renderer.setSize(w, h, false);
    // Letterbox the fixed-size frame in the window so you see exactly what is being recorded.
    const k = Math.min(window.innerWidth / w, window.innerHeight / h);
    Object.assign(canvas.style, { width: `${w * k}px`, height: `${h * k}px`, left: `${(window.innerWidth - w * k) / 2}px`, top: `${(window.innerHeight - h * k) / 2}px` });
    Object.assign(view, { w, h });
  } else {
    const w = window.innerWidth, h = window.innerHeight;
    let pr = Math.min(window.devicePixelRatio || 1, 2);
    if (recordingWindow) {
      // The Mac's H.264 encoder can't take a full Retina window (e.g. 3818×2358 came out unplayable):
      // cap the recording at 4K and use even sizes, which H.264 needs. Same look, slightly fewer pixels.
      pr = Math.min(pr, 3840 / Math.max(w, h), 2160 / Math.min(w, h));
      const W = Math.floor((w * pr) / 2) * 2, H = Math.floor((h * pr) / 2) * 2;
      renderer.setPixelRatio(pr);
      renderer.setSize(W / pr + 1e-4, H / pr + 1e-4, false);
    } else {
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
    }
    Object.assign(canvas.style, { width: '', height: '', left: '', top: '' });
    Object.assign(view, { w: window.innerWidth, h: window.innerHeight });
    engine.override = {};
  }
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  // Re-frame from scratch when switching between wide and tall, otherwise keep the current angle.
  if (world && !keepCamera) frameCamera(world.def.frame, wasPortrait !== camera.aspect < 1);
}
window.addEventListener('resize', () => resize());
resize();

// ---------- pointer: cursor for weather, clicks for scenes ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
const pointerRay = new THREE.Raycaster();
// Pointer position in the drawing's own logical pixels (works when letterboxed for recording).
const toView = (e) => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * view.w, ((e.clientY - r.top) / r.height) * view.h];
};
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = toView(e);
  engine.cursor.set(x, y);
  ndc.set((x / view.w) * 2 - 1, -(y / view.h) * 2 + 1);
  pointerRay.setFromCamera(ndc, camera);
  world?.onMove?.(pointerRay.ray);
});
canvas.addEventListener('pointerleave', () => { engine.cursor.set(-1e4, -1e4); world?.onMove?.(null); });
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const [x, y] = toView(e);
  ndc.set((x / view.w) * 2 - 1, -(y / view.h) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  world.onClick?.(raycaster, ndc);
});

// ---------- export ----------
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
let pendingPNG = false;
let recorder = null;
const exportActions = {
  png: () => { pendingPNG = true; },
  record: () => startRecording(null),
  recordLandscape: () => startRecording('landscape'),
  recordPortrait: () => startRecording('portrait'),
  copy: async () => {
    await navigator.clipboard.writeText(JSON.stringify({ params, app }, null, 2));
    toast('Settings copied');
  },
  resetLook: () => {
    delete app.looks[app.scene];
    applyLook(world.def);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    save();
    toast(`${app.scene} look reset`);
  },
  reset: () => { localStorage.removeItem(STORE); location.reload(); },
  load: () => fileInput.click(),
};

// ---------- recording ----------
// mode: null = the window as it is; 'landscape' / 'portrait' = fixed X (Twitter) sizes.
// MP4 (H.264) when the browser can, which X accepts directly; 60fps, ~20 Mbps (X allows up to 25).
const RECORD_LABELS = { null: 'record this window', landscape: 'record for X: landscape 1920×1080', portrait: 'record for X: portrait 1080×1920' };
let recordTimer = null;
function setRecordLabels(active) {
  for (const [mode, ctrl] of Object.entries(recordCtrls)) ctrl.name(active === undefined ? RECORD_LABELS[mode] : 'stop recording');
}
let recordStarting = false;
function startRecording(mode) {
  if (recordStarting) return;
  if (recorder) { recorder.stop(); return; }
  // 'record this window' records whatever is showing, including a preview frame.
  recordMode = mode ?? (preview.frame === 'window' ? null : preview.frame);
  // H.264 level 5.1 (avc1.640033) allows up to 4K for window recordings; 4.2 is plenty for the 1080p X sizes.
  const avc = recordMode ? ['avc1.64002A', 'avc1.640028'] : ['avc1.640033', 'avc1.640032', 'avc1.64002A'];
  const types = [...avc.map((c) => `video/mp4;codecs=${c}`), 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const type = types.find((t) => MediaRecorder.isTypeSupported(t));
  recordingWindow = !recordMode;
  resize(true); // record from exactly where the camera is now
  recordStarting = true;
  // Only open the capture once frames at the new size are being drawn: an MP4 (H.264) stream
  // must keep one resolution for the whole file, or the video can come out broken.
  setTimeout(() => {
    recordStarting = false;
    const chunks = [];
    const stream = canvas.captureStream(recordMode ? app.xFps : 60);
    // The encoder overshoots on dense ASCII detail (asking 20 gave ~40 Mbps), so aim lower to land near X's ~25 Mbps ceiling.
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 11e6 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      clearTimeout(recordTimer);
      stream.getTracks().forEach((t) => t.stop());
      const tag = mode ? `-x-${mode}` : '';
      download(new Blob(chunks, { type }), `noxe-ascii-${app.scene.toLowerCase()}${tag}-${stamp()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
      recorder = null;
      // Back to the normal view only after the file is closed, camera left where it ended.
      recordMode = preview.frame === 'window' ? null : preview.frame;
      recordingWindow = false;
      resize(true);
      setRecordLabels();
      toast(type.includes('mp4') ? 'Video saved' : 'Saved as WebM (this browser cannot record MP4; convert before posting to X)');
    };
    recorder.start();
    setRecordLabels(mode);
    toast(`Recording ${app.recordSeconds}s${mode ? ` · ${RECORD_LABELS[mode].replace('record for ', '')}` : ''}`);
    recordTimer = setTimeout(() => recorder?.state === 'recording' && recorder.stop(), app.recordSeconds * 1000);
  }, 300);
}

// ---------- model drop ----------
const fileInput = document.getElementById('file');
const dropEl = document.getElementById('drop');
async function loadModel(file) {
  if (!file || !/\.(glb|gltf)$/i.test(file.name)) { toast('Drop a .glb or .gltf file'); return; }
  if (app.scene !== 'Stage') { app.scene = 'Stage'; sceneCtrl.updateDisplay(); loadScene('Stage'); }
  const url = URL.createObjectURL(file);
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    world.setModel(gltf);
    toast(`Loaded ${file.name}`);
  } catch (e) {
    console.error(e);
    toast(`Could not load ${file.name}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
fileInput.addEventListener('change', () => loadModel(fileInput.files[0]));
window.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('on'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dropEl.classList.remove('on'); });
window.addEventListener('drop', (e) => { e.preventDefault(); dropEl.classList.remove('on'); loadModel(e.dataTransfer.files[0]); });

// ---------- panel ----------
gui = new GUI({ title: 'ASCII Engine', width: 300 });
const fScene = gui.addFolder('Scene');
const sceneCtrl = fScene.add(app, 'scene', Object.keys(SCENES)).onChange(loadScene);
fScene.add(app, 'autoRotate').name('auto camera');
fScene.add(app, 'rotateSpeed', -3, 3, 0.05).name('camera speed');
fScene.add(app, 'timeScale', 0, 3, 0.05).name('time');
fScene.add(app, 'paused').name('pause').listen();
fScene.add(exportActions, 'load').name('load .glb model…');

const fWeather = gui.addFolder('Weather').close();
fWeather.add(params, 'weather', ['none', 'snow', 'rain', 'motes']).name('type');
fWeather.add(params, 'wDensity', 0, 0.4, 0.005).name('density');
fWeather.add(params, 'wSpeed', 0, 20, 0.1).name('fall speed');
fWeather.add(params, 'wWind', -3, 3, 0.01).name('wind');
fWeather.add(params, 'wSway', 0, 3, 0.01).name('sway');
fWeather.add(params, 'wBright', 0, 1, 0.01).name('brightness');
fWeather.addColor(params, 'wColor').name('colour');
fWeather.add(params, 'wRepel', 0, 20, 0.1).name('cursor push');
fWeather.add(params, 'wRepelR', 1, 30, 0.5).name('cursor radius');

const fGrid = gui.addFolder('Grid');
fGrid.add(params, 'cellSize', 3, 32, 0.5).name('cell size');
fGrid.add(params, 'cellAspect', 1, 2.6, 0.05).name('cell aspect').onFinishChange(rebuildAtlas);
fGrid.add(params, 'detail', 0.5, 2, 0.25).name('samples');
fGrid.add(params, 'font', FONTS).onChange(rebuildAtlas);
fGrid.add(params, 'fontWeight', [300, 400, 500, 600, 700]).name('weight').onChange(rebuildAtlas);
fGrid.add(params, 'glyphScale', 0.5, 1.5, 0.01).name('glyph scale').onFinishChange(rebuildAtlas);

const fTone = gui.addFolder('Tone → glyph').close();
fTone.add(params, 'exposure', 0, 4, 0.01);
fTone.add(params, 'gamma', 0.3, 3, 0.01);
fTone.add(params, 'black', 0, 0.5, 0.005).name('black point');
fTone.add(params, 'white', 0.3, 1, 0.005).name('white point');
fTone.add(params, 'saturation', 0, 2, 0.01);
fTone.add(params, 'lift', 0, 1, 0.01).name('colour lift');
fTone.add(params, 'posterize', 0, 12, 1);
fTone.add(params, 'dither', 0, 1, 0.01);

const fEdge = gui.addFolder('Edges').close();
fEdge.add(params, 'edges').name('on');
fEdge.add(params, 'depthThresh', 0.005, 1, 0.005).name('silhouette');
fEdge.add(params, 'normalThresh', 0.05, 1.5, 0.01).name('crease');
fEdge.add(params, 'edgeCoverage', 0.02, 0.6, 0.01).name('coverage');
fEdge.add(params, 'edgeGain', 0, 3, 0.01).name('brightness');
fEdge.add(params, 'edgeGlyphs').name('glyphs - / | \\').onFinishChange(rebuildAtlas);
fEdge.addColor(params, 'edgeTint').name('tint');
fEdge.add(params, 'edgeTintMix', 0, 1, 0.01).name('tint amount');

const fSets = gui.addFolder('Glyph sets').close();
fSets.add(params, 'orientMin', 0, 1, 0.01).name('orient min');
fSets.add(params, 'orientRot', 0, 1, 0.125).name('orient rotate');
params.sets.forEach((s, i) => {
  const f = fSets.addFolder(`${i} · ${s.name}`).close();
  f.add(s, 'ramp').onFinishChange(rebuildAtlas);
  f.add(s, 'fill', 0, 2, 0.01).name('cell fill');
  f.add(s, 'orient').onChange(rebuildAtlas);
});

const fLook = gui.addFolder('Look').close();
fLook.addColor(params, 'bg').name('background');
fLook.add(params, 'cellFill', 0, 1, 0.01).name('cell fill');
fLook.add(params, 'glyphGain', 0, 3, 0.01).name('glyph gain');
fLook.add(params, 'bloom', 0, 3, 0.01);
fLook.add(params, 'bloomThreshold', 0, 1, 0.01).name('bloom threshold');
fLook.add(params, 'bloomRadius', 0.2, 4, 0.05).name('bloom radius');

const fTilt = gui.addFolder('Tilt-shift').close();
fTilt.add(params, 'tilt', 0, 1, 0.01).name('amount');
fTilt.add(params, 'tiltCenter', 0, 1, 0.01).name('focus centre');
fTilt.add(params, 'tiltWidth', 0, 1, 0.01).name('focus width');
fTilt.add(params, 'tiltFeather', 0, 1, 0.01).name('feather');
fTilt.add(params, 'tiltBlurX', 0, 6, 0.05).name('blur x');
fTilt.add(params, 'tiltBlurY', 0, 6, 0.05).name('blur y');

const fFinish = gui.addFolder('Finish').close();
fFinish.add(params, 'vignette', 0, 1, 0.01);
fFinish.add(params, 'grain', 0, 0.2, 0.001);

const fDebug = gui.addFolder('Debug view').close();
fDebug.add(params, 'view', Object.keys(VIEWS));
fDebug.add(params, 'split', 0, 1, 0.01).name('split position');

const fOut = gui.addFolder('Export');
fOut.add(exportActions, 'png').name('save PNG  [P]');
fOut.add(preview, 'frame', { 'this window': 'window', 'X landscape 16:9': 'landscape', 'X portrait 9:16': 'portrait' })
  .name('preview frame')
  .onChange((v) => { recordMode = v === 'window' ? null : v; resize(); });
fOut.add(app, 'recordSeconds', 2, 60, 1).name('video seconds');
fOut.add(app, 'xCell', 3, 16, 0.5).name('X cell size').onChange(() => recordMode && resize(true));
fOut.add(app, 'xFps', [30, 60]).name('X frame rate');
const recordCtrls = {
  null: fOut.add(exportActions, 'record').name(RECORD_LABELS.null),
  landscape: fOut.add(exportActions, 'recordLandscape').name(RECORD_LABELS.landscape),
  portrait: fOut.add(exportActions, 'recordPortrait').name(RECORD_LABELS.portrait),
};
fOut.add(exportActions, 'copy').name('copy settings JSON');
fOut.add(exportActions, 'resetLook').name('reset this scene’s look');
fOut.add(exportActions, 'reset').name('reset everything');

gui.onFinishChange((e) => {
  if (e.property === 'fill' && params.sets.includes(e.object)) {
    const L = (app.looks[app.scene] ||= {});
    (L.setFill ||= {})[e.object.name] = e.value;
  }
  if (e.object === params && LOOK_KEYS.includes(e.property)) (app.looks[app.scene] ||= {})[e.property] = e.value;
  save();
});

loadScene(app.scene);

// ---------- hud / keys ----------
const hud = document.getElementById('stats');
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2200);
}
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h') { gui.show(gui._hidden); document.body.classList.toggle('clean'); }
  if (e.key === ' ') { app.paused = !app.paused; e.preventDefault(); }
  if (e.key === 'p') exportActions.png();
});

// ---------- loop ----------
const clock = new THREE.Clock();
const Y = new THREE.Vector3(0, 1, 0);
const offset = new THREE.Vector3();
let t = 0, frames = 0, fpsT = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!app.paused) t += dt * app.timeScale;
  const swayDeg = effectiveFrame(world.def.frame).sway;
  controls.autoRotate = app.autoRotate && !app.paused && !swayDeg;
  controls.autoRotateSpeed = app.rotateSpeed;
  if (swayDeg && app.autoRotate && !app.paused) {
    // Framed scenes drift side to side instead of orbiting all the way round.
    sway.phase += dt * app.rotateSpeed * 0.12;
    const a = THREE.MathUtils.degToRad(swayDeg) * Math.sin(sway.phase);
    offset.subVectors(camera.position, controls.target).applyAxisAngle(Y, a - sway.angle);
    camera.position.copy(controls.target).add(offset);
    sway.angle = a;
  }
  controls.update(dt);
  engine.focusDistance = camera.position.distanceTo(controls.target);
  world.update?.(t, app.paused ? 0 : dt * app.timeScale);
  engine.render(world.scene, camera, t);
  if (pendingPNG) {
    pendingPNG = false;
    canvas.toBlob((b) => { download(b, `noxe-ascii-${stamp()}.png`); toast('PNG saved'); }, 'image/png');
  }
  frames++; fpsT += dt;
  if (fpsT > 0.5) {
    const s = engine.size;
    hud.textContent = `${s.cols}×${s.rows} cells · ${Math.round(frames / fpsT)} fps`;
    frames = 0; fpsT = 0;
  }
  requestAnimationFrame(tick);
}
await engine.rebuildAtlas();
window.__ascii = { engine, params, app, renderer, camera, controls, preview, get world() { return world; } };
tick();
