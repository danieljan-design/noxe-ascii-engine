import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import GUI from 'lil-gui';
import { AsciiEngine, defaultParams, VIEWS } from './engine/ascii-engine.js';
import { renderClip } from './engine/exporter.js';
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
// xFps: frame rate of the X renders (they always use the scene's own look: same characters, same grain).
const app = { scene: 'Island', autoRotate: true, rotateSpeed: 0.6, timeScale: 1, paused: false, recordSeconds: 10, looks: {}, xFps: 60 };
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

// X (Twitter) frames. The frame is laid out like the window (the largest 16:9 or 9:16 area that fits it), so
// characters, grain, blur and framing match what you see. Renders draw that same layout at a higher pixel
// ratio for an exact 4K file: X then makes its 1080p and 720p copies by clean halves and thirds.
const X_FRAMES = { landscape: { aspect: 16 / 9, out: [3840, 2160] }, portrait: { aspect: 9 / 16, out: [2160, 3840] } };
const xFrameCss = (mode) => {
  const a = X_FRAMES[mode].aspect, w = window.innerWidth, h = window.innerHeight;
  return w / h > a ? [h * a, h] : [w, w / a];
};
let recordMode = null; // null = record/draw the window as is
let recordingWindow = false; // true while a live recording runs (caps the size the encoder gets)
let exportingX = false; // true while an X render (video or PNG) owns the canvas
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

// Logical (CSS-pixel) size of the drawing: the window, or the X frame letterboxed in it.
const view = { w: 1, h: 1 };
// keepCamera: only change the frame size; leave the camera's position, angle and zoom exactly as they are.
function resize(keepCamera = false) {
  const wasPortrait = camera.aspect < 1;
  const screenPr = Math.min(window.devicePixelRatio || 1, 2);
  engine.exportScale = 1;
  engine.override = {};
  if (recordMode) {
    const [cw, ch] = xFrameCss(recordMode);
    if (exportingX) {
      // The preview's own pixels times a whole number k (at least 4K), scaled down to exact 4K when the
      // frame is saved: every character, row, blur and grain speck is the screen's, k times over.
      const [ow, oh] = X_FRAMES[recordMode].out;
      const Wp = Math.floor((cw * screenPr) / 2) * 2, Hp = Math.floor((ch * screenPr) / 2) * 2; // the preview's pixels
      const k = Math.max(1, Math.ceil(Math.max(ow / Wp, oh / Hp) - 1e-6));
      renderer.setPixelRatio(screenPr * k);
      renderer.setSize(Wp / screenPr + 1e-4, Hp / screenPr + 1e-4, false); // exactly Wp·k × Hp·k
      Object.assign(view, { w: Wp / screenPr, h: Hp / screenPr });
      engine.exportScale = k;
      // characters exactly as the screen rounds them to whole pixels, times k
      const cwS = Math.max(2, Math.round(params.cellSize * screenPr)), chS = Math.max(3, Math.round(params.cellSize * params.cellAspect * screenPr));
      engine.override = { cellSize: cwS / screenPr, cellAspect: chS / cwS };
    } else {
      // Preview: the X frame letterboxed in the window, characters exactly as in the full window.
      let pr = screenPr;
      if (recordingWindow) pr = Math.min(pr, 3840 / Math.max(cw, ch), 2160 / Math.min(cw, ch));
      const W = Math.floor((cw * pr) / 2) * 2, H = Math.floor((ch * pr) / 2) * 2;
      renderer.setPixelRatio(pr);
      renderer.setSize(W / pr + 1e-4, H / pr + 1e-4, false);
      Object.assign(view, { w: W / pr, h: H / pr });
    }
    Object.assign(canvas.style, { width: `${cw}px`, height: `${ch}px`, left: `${(window.innerWidth - cw) / 2}px`, top: `${(window.innerHeight - ch) / 2}px` });
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
  // With an X preview frame on, P saves that frame as an exact 4K PNG; otherwise the window as it is.
  png: () => (recordMode && !recorder ? savePngForX(recordMode) : (pendingPNG = true)),
  photoX: () => !recorder && savePhotoForX(),
  record: () => startRecording(),
  recordLandscape: () => renderForX('landscape'),
  recordPortrait: () => renderForX('portrait'),
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
// X renders: the scene stepped frame by frame at a fixed rate (never drops or doubles a frame), drawn at
// exact 4K with the scene's own look, H.264 High at a high bitrate, standard MP4. Your cursor and clicks are
// not part of a render: for a take with interaction use 'record this window', which records live.
const RECORD_LABELS = { null: 'record this window (live)', landscape: 'render for X: landscape 3840×2160', portrait: 'render for X: portrait 2160×3840' };
let recordTimer = null;
function setRecordLabels(active) {
  for (const [mode, ctrl] of Object.entries(recordCtrls)) ctrl.name(active === undefined ? RECORD_LABELS[mode] : 'stop recording');
}

async function renderForX(mode, { keep = false } = {}) {
  if (exportingX || recorder || recordStarting) return null;
  exportingX = true;
  recordMode = mode;
  resize(true); // render from exactly where the camera is now
  const fps = Number(app.xFps) || 60;
  const [ow, oh] = X_FRAMES[mode].out;
  try {
    const { blob } = await renderClip({
      canvas, width: ow, height: oh, fps, seconds: app.recordSeconds,
      // 45 Mbps at 60fps, 30 at 30fps: X re-encodes everything, so the file it starts from should be near clean
      bitrate: fps > 30 ? 45e6 : 30e6,
      step, render: draw,
      onProgress: (p) => toast(`Rendering for X ${Math.round(p * 100)}%`),
    });
    if (!keep) download(blob, `noxe-ascii-${app.scene.toLowerCase()}-x-${mode}-${stamp()}.mp4`);
    toast(`Video saved: ${ow}×${oh}, ${fps}fps, ${(blob.size / 1e6).toFixed(0)} MB`);
    return blob;
  } catch (e) {
    console.error(e);
    toast('Render failed: ' + e.message);
    return null;
  } finally {
    exportingX = false;
    recordMode = preview.frame === 'window' ? null : preview.frame;
    resize(true);
    clock.getDelta();
  }
}

// The X frame as a still at exact 4K. type 'png': lossless master. type 'jpeg': photo for X, the highest
// quality that stays under X's 5 MB photo limit (X turns photos into JPEGs itself; a dense 4K PNG is 15+ MB).
async function saveStillForX(mode, { type = 'png', keep = false } = {}) {
  if (exportingX) return null;
  exportingX = true;
  recordMode = mode;
  resize(true);
  try {
    draw();
    // copy through a 2D canvas (never a stale frame), scaled down to the exact X size
    const [ow, oh] = X_FRAMES[mode].out;
    const c = document.createElement('canvas');
    c.width = ow;
    c.height = oh;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, ow, oh);
    let blob, q = null;
    if (type === 'jpeg') {
      for (q of [0.95, 0.93, 0.91, 0.89, 0.87, 0.85, 0.82, 0.8]) {
        blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
        if (blob.size < 4.9e6) break;
      }
    } else {
      blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    const ext = type === 'jpeg' ? 'jpg' : 'png';
    if (!keep) download(blob, `noxe-ascii-${app.scene.toLowerCase()}-x-${mode}-${stamp()}.${ext}`);
    toast(`${type === 'jpeg' ? `Photo for X saved (JPEG ${Math.round(q * 100)}%, ` : 'PNG saved ('}${(blob.size / 1e6).toFixed(1)} MB): ${ow}×${oh}`);
    return blob;
  } finally {
    exportingX = false;
    recordMode = preview.frame === 'window' ? null : preview.frame;
    resize(true);
  }
}
const savePngForX = (mode, opts) => saveStillForX(mode, { ...opts, type: 'png' });
const savePhotoForX = (mode = recordMode || 'landscape', opts) => saveStillForX(mode, { ...opts, type: 'jpeg' });

let recordStarting = false;
function startRecording() {
  if (recordStarting || exportingX) return;
  if (recorder) { recorder.stop(); return; }
  // Live recording of whatever is showing (the window, or the X preview frame), for takes with your cursor and clicks.
  recordMode = preview.frame === 'window' ? null : preview.frame;
  const mode = recordMode;
  // H.264 level 5.1 (avc1.640033) allows up to 4K.
  const avc = ['avc1.640033', 'avc1.640032', 'avc1.64002A'];
  const types = [...avc.map((c) => `video/mp4;codecs=${c}`), 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const type = types.find((t) => MediaRecorder.isTypeSupported(t));
  recordingWindow = true;
  resize(true); // record from exactly where the camera is now
  recordStarting = true;
  // Only open the capture once frames at the new size are being drawn: an MP4 (H.264) stream
  // must keep one resolution for the whole file, or the video can come out broken.
  setTimeout(() => {
    recordStarting = false;
    const chunks = [];
    const stream = canvas.captureStream(60);
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
    toast(`Recording ${app.recordSeconds}s live${mode ? ` · X ${mode} frame` : ''}`);
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
fOut.add(exportActions, 'photoX').name('save photo for X (4K JPEG, under 5 MB)');
fOut.add(preview, 'frame', { 'this window': 'window', 'X landscape 16:9': 'landscape', 'X portrait 9:16': 'portrait' })
  .name('preview frame')
  .onChange((v) => { recordMode = v === 'window' ? null : v; resize(); });
fOut.add(app, 'recordSeconds', 2, 60, 1).name('video seconds');
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
// One step of the world: the live loop calls it with real time, X renders with a fixed 1/fps.
function step(dt) {
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
}
function draw() {
  engine.render(world.scene, camera, t);
}
function tick() {
  if (exportingX) { requestAnimationFrame(tick); return; } // an X render is stepping the scene itself
  const dt = Math.min(clock.getDelta(), 0.1);
  step(dt);
  draw();
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
window.__ascii = { engine, params, app, renderer, camera, controls, preview, renderForX, savePngForX, savePhotoForX, step, draw, get world() { return world; } };
tick();
