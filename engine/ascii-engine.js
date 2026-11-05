import * as THREE from 'three';
import { buildAtlas } from './atlas.js';
import { FS_VERT, EDGE_FRAG, CELL_FRAG, COMPOSE_FRAG, DOWN_FRAG, BLUR_FRAG, FINAL_FRAG } from './shaders.js';

export const MAX_SETS = 24;
const SET_DIV = 32; // set id is stored in the aux alpha as id / SET_DIV
export const ATLAS_COLS = 16;
export const EDGE_ROW = MAX_SETS;
export const SKY_SET = 9;
export const PARTICLE_SET = 15;

// Tag any object or material with userData.glyph = '<set name>' to pick its characters.
// Children inherit from parents; a material tag beats an object tag.
export const DEFAULT_SETS = [
  { name: 'default', ramp: ' .:-=+*#%@', orient: false },
  { name: 'grass', ramp: ' .,:;i!|', orient: true },
  { name: 'water', ramp: ' .-~=≈#', orient: false },
  { name: 'foliage', ramp: ' .:o*O0@', orient: false },
  { name: 'stone', ramp: ' .:sS$#', orient: false },
  { name: 'wood', ramp: ' .-=#%', orient: false },
  { name: 'glow', ramp: ' .+*#@', orient: false },
  { name: 'sand', ramp: ' .:;+*', orient: false },
  { name: 'soft', ramp: ' .:-~o', orient: false },
  { name: 'sky', ramp: ' .·:+*', orient: false },
  { name: 'snow', ramp: ' .·:;+*#', orient: false },
  { name: 'ice', ramp: ' .-=≡#', orient: false },
  { name: 'fire', ramp: ' .,^*&#@', orient: false },
  { name: 'smoke', ramp: ' .:~-=', orient: false },
  { name: 'aurora', ramp: ' .:¦|║', orient: false },
  { name: 'particles', ramp: ' .·+*', orient: false },
  { name: 'wheat', ramp: ' .,:;|', orient: true },
  { name: 'cloud', ramp: ' .:-=+*', orient: false },
  { name: 'birds', ramp: 'vvVV', orient: false },
  { name: 'metal', ramp: ' .:+=#', orient: false },
  { name: 'neon', ramp: ' .:+*#@', orient: false },
  { name: 'brick', ramp: ' .:=#▓', orient: false },
  { name: 'dust', ramp: ' .,:;', orient: false },
  { name: 'spare', ramp: ' .:+', orient: false },
];

export const VIEWS = { ASCII: 0, Source: 1, Split: 2, Normals: 3, Edges: 4, 'Glyph sets': 5 };

export function defaultParams() {
  return {
    cellSize: 8, cellAspect: 1.7, detail: 1, font: 'IBM Plex Mono', fontWeight: 600, glyphScale: 1,
    exposure: 1.35, gamma: 1, black: 0.03, white: 0.85, saturation: 1.15, lift: 0.35, posterize: 0, dither: 0.6,
    edges: true, depthThresh: 0.08, normalThresh: 0.8, edgeCoverage: 0.16, edgeGain: 1.3,
    edgeGlyphs: '-/|\\', edgeTint: '#b08cff', edgeTintMix: 0,
    orientMin: 0.3, orientRot: 0,
    bg: '#07080c', cellFill: 0.16, glyphGain: 1.25,
    bloom: 0.5, bloomThreshold: 0.5, bloomRadius: 1.5,
    tilt: 0.8, tiltCenter: 0.45, tiltWidth: 0.35, tiltFeather: 0.3, tiltBlurX: 2.5, tiltBlurY: 1,
    vignette: 0.35, grain: 0.035,
    weather: 'none', wDensity: 0.06, wSpeed: 4, wWind: 0.3, wSway: 0.6, wBright: 0.85, wColor: '#e6efff',
    wRepel: 6, wRepelR: 7,
    view: 'ASCII', split: 0.5,
    sets: DEFAULT_SETS.map((s) => ({ fill: 1, ...s })),
  };
}

const hexToVec3 = (hex, v) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return v.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export class AsciiEngine {
  constructor(renderer, params) {
    this.renderer = renderer;
    this.p = params;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const rt = (o = {}) => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o,
    });
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.rtColor = rt({ depthBuffer: true });
    this.rtColor.depthTexture = new THREE.DepthTexture(1, 1);
    this.rtAux = rt({ depthBuffer: true, ...nearest });
    this.rtEdge = rt(nearest);
    this.rtCells = rt({ ...nearest, type: THREE.FloatType }); // float: alpha packs set + glyph exactly
    // 3D particles (snow, embers...) drawn straight into the character grid: one point = one cell, nearest wins.
    this.rtParticles = rt({ ...nearest, depthBuffer: true });
    this.rtCompose = rt();
    this.rtBase = rt(); // exports only: the characters drawn at screen resolution, for tilt-shift and glow
    this.rtHalf = [rt(), rt()];
    this.rtQuarter = [rt(), rt()];

    const V2 = () => ({ value: new THREE.Vector2() });
    const V3 = () => ({ value: new THREE.Vector3() });
    const F = (v = 0) => ({ value: v });
    const mk = (frag, uniforms, defines = {}) => new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false,
    });

    this.mEdge = mk(EDGE_FRAG, {
      tDepth: F(this.rtColor.depthTexture), tAux: F(this.rtAux.texture), uTexel: V2(),
      uNear: F(0.1), uFar: F(100), uDepthThresh: F(), uNormalThresh: F(),
    });
    this.mCell = mk(CELL_FRAG, {
      tColor: F(this.rtColor.texture), tAux: F(this.rtAux.texture), tEdge: F(this.rtEdge.texture),
      tDepth: F(this.rtColor.depthTexture), uSceneSize: V2(), uCellScene: V2(),
      uExposure: F(), uGamma: F(), uBlack: F(), uWhite: F(), uSaturation: F(), uPosterize: F(), uDither: F(),
      uEdges: F(), uEdgeCoverage: F(), uEdgeGain: F(), uEdgeTint: V3(), uEdgeTintMix: F(),
      uRampLen: { value: new Array(MAX_SETS).fill(1) }, uOrient: { value: new Array(MAX_SETS).fill(0) },
      uOrientMin: F(), uOrientRot: F(), uEdgeRow: F(EDGE_ROW), uParticleRow: F(PARTICLE_SET),
      uNear: F(0.1), uFar: F(100), uTime: F(), uCellAspect: F(1.7),
      uWeather: F(), uWDensity: F(), uWSpeed: F(), uWWind: F(), uWSway: F(), uWBright: F(), uWColor: V3(),
      uWDepth: V3(), uCursor: V2(), uWRepel: F(), uWRepelR: F(),
      tParticles: F(this.rtParticles.texture), uParticlesOn: F(0),
    }, { MAX_SETS });
    this.mCompose = mk(COMPOSE_FRAG, {
      tCells: F(this.rtCells.texture), tAtlas: F(null), uCellPx: V2(), uAtlasRows: F(MAX_SETS + 1),
      uBg: V3(), uCellFill: F(), uGlyphGain: F(), uLift: F(), uSetFill: { value: new Array(MAX_SETS).fill(1) },
    }, { MAX_SETS });
    this.mDown = mk(DOWN_FRAG, { tInput: F(null), uTexel: V2(), uOffset: F(), uThreshold: F(-1) });
    this.mBlur = mk(BLUR_FRAG, { tInput: F(null), uDir: V2() });
    this.mFinal = mk(FINAL_FRAG, {
      tSharp: F(this.rtCompose.texture), tSoft: F(this.rtHalf[0].texture), tGlow: F(this.rtQuarter[0].texture),
      tColor: F(this.rtColor.texture), tAux: F(this.rtAux.texture), tEdge: F(this.rtEdge.texture),
      uView: { value: 0 }, uRes: V2(), uSplit: F(), uExposure: F(),
      uTilt: F(), uTiltCenter: F(), uTiltWidth: F(), uTiltFeather: F(), uBloom: F(),
      uVignette: F(), uGrain: F(), uGrainPx: { value: 1 }, uTime: F(),
    });

    this.auxCache = new Map();
    this.cursor = new THREE.Vector2(-1e4, -1e4); // CSS px, set by the app
    this.windBoost = 0;                          // runtime gusts added to the weather wind
    this.focusDistance = 20;                     // camera to target, used to place snow layers in depth
    this.override = {};                          // temporary param overrides (e.g. recording: { cellSize, grain })
    // Whole number k when an export draws the screen's pixels k times over (1 on screen). Glow and tilt-shift
    // are then worked out from a screen-resolution copy of the characters, and grain specks are k pixels,
    // so the export looks like the screen, just with k×k pixels per screen pixel.
    this.exportScale = 1;
    this._hooks = [];
    this._swapped = [];
    this._hidden = [];
    this._auxClear = new THREE.Color().setRGB(0.5, 0.5, 1.0, THREE.LinearSRGBColorSpace);
    this._cc = new THREE.Color();
    this._black = new THREE.Color(0, 0, 0);
    this._v2 = new THREE.Vector2();
    this._layoutKey = '';
    this._atlasToken = 0;
    this.size = { W: 1, H: 1, cols: 1, rows: 1, sw: 1, sh: 1, cw: 1, ch: 1 };
  }

  get setIndex() {
    const m = {};
    this.p.sets.forEach((s, i) => { m[s.name] = i; });
    return m;
  }

  // Rebuild the glyph atlas (font, aspect, ramps, edge glyphs). Async because of font loading.
  async rebuildAtlas() {
    const token = ++this._atlasToken;
    const p = this.p;
    const rows = [];
    for (let i = 0; i < MAX_SETS; i++) rows.push(p.sets[i]?.ramp || ' ');
    rows.push(p.edgeGlyphs || '-/|\\');
    const canvas = await buildAtlas({
      rows, cols: ATLAS_COLS, font: p.font, weight: p.fontWeight, aspect: p.cellAspect, scale: p.glyphScale,
    });
    if (token !== this._atlasToken) return;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    this.atlasTex?.dispose();
    this.atlasTex = tex;
    this.mCompose.uniforms.tAtlas.value = tex;
    this.atlasCanvas = canvas;
    const u = this.mCell.uniforms;
    for (let i = 0; i < MAX_SETS; i++) {
      u.uRampLen.value[i] = Math.max(1, Math.min(ATLAS_COLS, Array.from(p.sets[i]?.ramp || ' ').length));
      u.uOrient.value[i] = p.sets[i]?.orient ? 1 : 0;
    }
  }

  _layout() {
    const r = this.renderer, p = this.p;
    r.getDrawingBufferSize(this._v2);
    const W = this._v2.x, H = this._v2.y;
    const dpr = r.getPixelRatio();
    // Whole-pixel cells: every glyph renders identically, which looks crisper and compresses far better.
    const cellCss = this.override.cellSize ?? p.cellSize;
    const aspect = this.override.cellAspect ?? p.cellAspect;
    const cw = Math.max(2, Math.round(cellCss * dpr)), ch = Math.max(3, Math.round(cellCss * aspect * dpr));
    const cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);
    const sw = Math.max(16, Math.round((W / dpr) * p.detail));
    const sh = Math.max(16, Math.round((H / dpr) * p.detail));
    const k = Math.max(1, Math.round(this.exportScale));
    const Wb = Math.floor(W / k), Hb = Math.floor(H / k); // screen-resolution size of the frame
    const key = `${W}x${H}|${cols}x${rows}|${sw}x${sh}|${k}`;
    if (key !== this._layoutKey) {
      this._layoutKey = key;
      for (const t of [this.rtColor, this.rtAux, this.rtEdge]) t.setSize(sw, sh);
      this.rtCells.setSize(cols, rows);
      this.rtParticles.setSize(cols, rows);
      this.rtCompose.setSize(W, H);
      this.rtBase.setSize(k > 1 ? Wb : 1, k > 1 ? Hb : 1);
      for (const t of this.rtHalf) t.setSize(Math.ceil(Wb / 2), Math.ceil(Hb / 2));
      for (const t of this.rtQuarter) t.setSize(Math.ceil(Wb / 4), Math.ceil(Hb / 4));
    }
    Object.assign(this.size, { W, H, cols, rows, sw, sh, cw, ch, cellCss: cw / dpr, k, Wb, Hb });
    // Map the camera's full view onto exactly the cells that cover the screen.
    this.rtParticles.viewport.set(0, 0, Math.round(W / cw), Math.round(H / ch));
  }

  _resolveSet(g) {
    if (g == null) return 0;
    if (typeof g === 'number') return Math.max(0, Math.min(MAX_SETS - 1, g | 0));
    return this.setIndex[g] ?? 0;
  }

  _auxMat(src, inherited) {
    const set = this._resolveSet(src.userData?.glyph ?? inherited);
    const side = src.side ?? THREE.FrontSide;
    const flat = !!src.flatShading;
    // A material can carry userData.auxPatch(shader) so the aux pass gets the same vertex animation
    // (wind, waves...) and, if it wants, its own normals for the orientation glyphs.
    const patch = src.userData?.auxPatch;
    const patchKey = patch ? (src.userData.auxPatchKey || src.uuid) : '';
    const key = `${set}|${side}|${flat}|${patchKey}`;
    let m = this.auxCache.get(key);
    if (!m) {
      m = new THREE.MeshNormalMaterial({ side, flatShading: flat });
      m.blending = THREE.NoBlending;
      const uSet = { value: set };
      m.onBeforeCompile = (sh) => {
        if (patch) patch(sh);
        sh.uniforms.uGlyphSet = uSet;
        sh.fragmentShader = 'uniform float uGlyphSet;\n' + sh.fragmentShader.replace(
          /}\s*$/, `  gl_FragColor = vec4( packNormalToRGB( normal ), uGlyphSet / ${SET_DIV}.0 );\n}`);
      };
      m.customProgramCacheKey = () => `ascii-aux|${patchKey}`;
      this.auxCache.set(key, m);
    }
    return m;
  }

  _swapIn(scene) {
    const sw = this._swapped, hd = this._hidden, hk = this._hooks;
    sw.length = 0; hd.length = 0; hk.length = 0;
    const walk = (o, inh) => {
      if (!o.visible) return;
      if (o.userData.aux === false && !o.isScene) { o.visible = false; hd.push(o); return; }
      const g = o.userData.glyph ?? inh;
      if (o.isMesh) {
        const m = o.material;
        const single = !Array.isArray(m);
        // Faint transparent stuff (light beams, halos) stays out unless it is tagged with a glyph set.
        const tagged = o.userData.glyph !== undefined || (single && m.userData.glyph !== undefined);
        const ghost = (single && m.colorWrite === false)
          || (!tagged && single && m.transparent && (m.blending === THREE.AdditiveBlending || m.opacity < 0.35));
        if (ghost) { o.visible = false; hd.push(o); return; }
        // Mirrors render the whole scene again in onBeforeRender; not needed for the aux pass.
        if (o.isReflector || o.isRefractor || o.isWater) { hk.push(o, o.onBeforeRender); o.onBeforeRender = () => {}; }
        sw.push(o, m);
        o.material = Array.isArray(m) ? m.map((x) => this._auxMat(x, g)) : this._auxMat(m, g);
      } else if (o.isPoints || o.isLine || o.isSprite) {
        o.visible = false; hd.push(o); return;
      }
      for (const c of o.children) walk(c, g);
    };
    walk(scene, undefined);
  }

  _swapOut() {
    const sw = this._swapped;
    for (let i = 0; i < sw.length; i += 2) sw[i].material = sw[i + 1];
    for (const o of this._hidden) o.visible = true;
    const hk = this._hooks;
    for (let i = 0; i < hk.length; i += 2) hk[i].onBeforeRender = hk[i + 1];
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.quadCam);
  }

  _blur(pair, rx, ry, iters) {
    const [a, b] = pair;
    const u = this.mBlur.uniforms;
    for (let i = 0; i < iters; i++) {
      u.tInput.value = a.texture; u.uDir.value.set(rx / a.width, 0); this._pass(this.mBlur, b);
      u.tInput.value = b.texture; u.uDir.value.set(0, ry / a.height); this._pass(this.mBlur, a);
    }
  }

  render(scene, camera, time = 0) {
    const r = this.renderer, p = this.p;
    if (!this.atlasTex) return;
    this._layout();
    const s = this.size;

    // Objects listed in scene.userData.cellParticles only draw in the particle pass.
    const parts = (scene.userData.cellParticles || []).filter((o) => o.userData.enabled !== false);
    for (const o of parts) o.visible = false;

    // 1. Scene colour + depth.
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.rtColor);
    r.render(scene, camera);

    // 2. Normals + glyph set id.
    const bg = scene.background, fog = scene.fog;
    scene.background = null; scene.fog = null;
    r.getClearColor(this._cc);
    const ca = r.getClearAlpha();
    r.setClearColor(this._auxClear, SKY_SET / SET_DIV);
    this._swapIn(scene);
    r.setRenderTarget(this.rtAux);
    r.render(scene, camera);
    this._swapOut();
    scene.background = bg; scene.fog = fog;

    // 2b. Particles into the cell grid (R = view depth, G = glyph level 0..1, B = brightness).
    this.mCell.uniforms.uParticlesOn.value = parts.length ? 1 : 0;
    if (parts.length) {
      r.setRenderTarget(this.rtParticles);
      r.setClearColor(this._black, 0);
      r.clear();
      const ac = r.autoClear;
      r.autoClear = false;
      for (const o of parts) { o.visible = true; r.render(o, camera); }
      r.autoClear = ac;
    }
    r.setClearColor(this._cc, ca);

    // 3. Edges.
    const e = this.mEdge.uniforms;
    e.uTexel.value.set(1 / s.sw, 1 / s.sh);
    e.uNear.value = camera.near; e.uFar.value = camera.far;
    e.uDepthThresh.value = p.depthThresh; e.uNormalThresh.value = p.normalThresh;
    this._pass(this.mEdge, this.rtEdge);

    // 4. Cells.
    const c = this.mCell.uniforms;
    c.uSceneSize.value.set(s.sw, s.sh);
    c.uCellScene.value.set((s.cw * s.sw) / s.W, (s.ch * s.sh) / s.H);
    c.uExposure.value = p.exposure; c.uGamma.value = p.gamma; c.uBlack.value = p.black; c.uWhite.value = p.white;
    c.uSaturation.value = p.saturation; c.uPosterize.value = p.posterize; c.uDither.value = p.dither;
    c.uEdges.value = p.edges ? 1 : 0; c.uEdgeCoverage.value = p.edgeCoverage; c.uEdgeGain.value = p.edgeGain;
    hexToVec3(p.edgeTint, c.uEdgeTint.value); c.uEdgeTintMix.value = p.edgeTintMix;
    c.uOrientMin.value = p.orientMin; c.uOrientRot.value = p.orientRot;
    c.uNear.value = camera.near; c.uFar.value = camera.far; c.uTime.value = time; c.uCellAspect.value = this.override.cellAspect ?? p.cellAspect;
    c.uWeather.value = { snow: 1, rain: 2, motes: 3 }[p.weather] ?? 0;
    c.uWDensity.value = p.wDensity; c.uWSpeed.value = p.wSpeed; c.uWWind.value = p.wWind + this.windBoost;
    c.uWSway.value = p.wSway; c.uWBright.value = p.wBright; hexToVec3(p.wColor, c.uWColor.value);
    c.uWDepth.value.set(0.35, 0.8, 1.4).multiplyScalar(this.focusDistance);
    const dpr = r.getPixelRatio();
    c.uCursor.value.set((this.cursor.x * dpr) / s.cw, (s.H - this.cursor.y * dpr) / s.ch);
    c.uWRepel.value = p.wRepel; c.uWRepelR.value = p.wRepelR;
    this._pass(this.mCell, this.rtCells);

    // 5. Glyphs.
    const k = this.mCompose.uniforms;
    k.uCellPx.value.set(s.cw, s.ch);
    hexToVec3(p.bg, k.uBg.value);
    k.uCellFill.value = p.cellFill; k.uGlyphGain.value = p.glyphGain; k.uLift.value = p.lift;
    for (let i = 0; i < MAX_SETS; i++) k.uSetFill.value[i] = p.sets[i]?.fill ?? 1;
    let src = this.rtCompose, srcW = s.W, srcH = s.H;
    if (s.k > 1 && (p.tilt > 0 || p.bloom > 0)) {
      // Export drawn k times over: also draw the characters exactly as the screen does (screen-size cells,
      // screen resolution). Tilt-shift and glow are worked out from that, so they match the screen exactly.
      k.uCellPx.value.set(s.cw / s.k, s.ch / s.k);
      this._pass(this.mCompose, this.rtBase);
      k.uCellPx.value.set(s.cw, s.ch);
      src = this.rtBase; srcW = s.Wb; srcH = s.Hb;
    }
    this._pass(this.mCompose, this.rtCompose);

    // 6. Tilt-shift (half res) and bloom (quarter res), always at screen resolution.
    const d = this.mDown.uniforms;
    if (p.tilt > 0) {
      d.tInput.value = src.texture; d.uTexel.value.set(1 / srcW, 1 / srcH);
      d.uOffset.value = 0; d.uThreshold.value = -1;
      this._pass(this.mDown, this.rtHalf[0]);
      this._blur(this.rtHalf, p.tiltBlurX, p.tiltBlurY, 2);
    }
    if (p.bloom > 0) {
      d.tInput.value = src.texture; d.uTexel.value.set(1 / srcW, 1 / srcH);
      d.uOffset.value = 1; d.uThreshold.value = p.bloomThreshold;
      this._pass(this.mDown, this.rtQuarter[0]);
      this._blur(this.rtQuarter, p.bloomRadius, p.bloomRadius, 2);
    }

    // 7. Final.
    const f = this.mFinal.uniforms;
    f.uView.value = VIEWS[p.view] ?? 0;
    f.uRes.value.set(s.W, s.H); f.uSplit.value = p.split; f.uExposure.value = p.exposure;
    f.uTilt.value = p.tilt; f.uTiltCenter.value = p.tiltCenter; f.uTiltWidth.value = p.tiltWidth;
    f.uTiltFeather.value = p.tiltFeather; f.uBloom.value = p.bloom;
    f.uVignette.value = p.vignette; f.uGrain.value = this.override.grain ?? p.grain; f.uTime.value = time;
    f.uGrainPx.value = Math.max(1, this.exportScale);
    this._pass(this.mFinal, null);
  }
}
