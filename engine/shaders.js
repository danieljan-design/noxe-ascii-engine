// All GLSL for the ASCII pipeline.
//
//  1. scene colour   (three.js, HDR, + depth texture)
//  2. aux            (view normal xyz + glyph set id in alpha)
//  3. EDGE   per scene pixel: silhouette (laplacian of 1/z) + crease (normal structure tensor) -> strength + orientation
//  4. CELL   per character cell: average colour, tone map, pick glyph (ramp / orientation / edge vote)
//  5. COMPOSE per screen pixel: draw the cell's glyph from the atlas in the cell's colour
//  6. blur chains (tilt-shift + bloom) and FINAL (views, vignette, grain)

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */`
const float PI_ = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 acesFilm(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
`;

export const EDGE_FRAG = /* glsl */`
#include <packing>
${COMMON}
uniform sampler2D tDepth;
uniform sampler2D tAux;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uDepthThresh;
uniform float uNormalThresh;
varying vec2 vUv;

float invZ(vec2 uv) { return -1.0 / perspectiveDepthToViewZ(texture(tDepth, uv).x, uNear, uFar); }
vec3 nrm(vec2 uv) { return texture(tAux, uv).xyz * 2.0 - 1.0; }

void main() {
  float z[9];
  vec3 n[9];
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      vec2 uv = vUv + vec2(float(i - 1), float(j - 1)) * uTexel;
      z[j * 3 + i] = invZ(uv);
      n[j * 3 + i] = nrm(uv);
    }
  }
  // Silhouettes: 1/z is linear across any plane in screen space, so its laplacian is ~0
  // on surfaces and spikes at depth breaks. Divide by 1/z to make it scale free.
  float c = z[4];
  float lap = abs(z[0] + z[1] + z[2] + z[3] + z[5] + z[6] + z[7] + z[8] - 8.0 * c) / max(c, 1e-6);
  float gxz = (z[2] + 2.0 * z[5] + z[8]) - (z[0] + 2.0 * z[3] + z[6]);
  float gyz = (z[6] + 2.0 * z[7] + z[8]) - (z[0] + 2.0 * z[1] + z[2]);

  // Creases: Sobel on each normal channel, combined in a structure tensor.
  vec3 gxn = (n[2] + 2.0 * n[5] + n[8]) - (n[0] + 2.0 * n[3] + n[6]);
  vec3 gyn = (n[6] + 2.0 * n[7] + n[8]) - (n[0] + 2.0 * n[1] + n[2]);
  float jxx = dot(gxn, gxn), jyy = dot(gyn, gyn), jxy = dot(gxn, gyn);
  float nMag = 0.25 * sqrt(max(0.0, 0.5 * (jxx + jyy + sqrt((jxx - jyy) * (jxx - jyy) + 4.0 * jxy * jxy))));

  float eD = smoothstep(uDepthThresh, uDepthThresh * 1.6, lap);
  float eN = smoothstep(uNormalThresh, uNormalThresh * 1.3, nMag);
  float theta = eD >= eN ? atan(gyz, gxz + 1e-9) : 0.5 * atan(2.0 * jxy, jxx - jyy + 1e-9);
  // r: edge strength, g: gradient orientation (mod PI, 0..1), b/a: debug
  gl_FragColor = vec4(max(eD, eN), fract(theta / PI_ + 1.0), eD, eN);
}
`;

export const CELL_FRAG = /* glsl */`
#include <packing>
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tAux;
uniform sampler2D tEdge;
uniform sampler2D tDepth;
uniform vec2 uSceneSize;
uniform vec2 uCellScene;
uniform float uExposure;
uniform float uGamma;
uniform float uBlack;
uniform float uWhite;
uniform float uSaturation;
uniform float uPosterize;
uniform float uDither;
uniform float uEdges;
uniform float uEdgeCoverage;
uniform float uEdgeGain;
uniform vec3 uEdgeTint;
uniform float uEdgeTintMix;
uniform float uRampLen[MAX_SETS];
uniform float uOrient[MAX_SETS];
uniform float uOrientMin;
uniform float uOrientRot;
uniform float uEdgeRow;
uniform float uParticleRow;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uCellAspect;
uniform float uWeather;
uniform float uWDensity;
uniform float uWSpeed;
uniform float uWWind;
uniform float uWSway;
uniform float uWBright;
uniform vec3 uWColor;
uniform vec3 uWDepth;
uniform vec2 uCursor;
uniform float uWRepel;
uniform float uWRepelR;
uniform sampler2D tParticles;
uniform float uParticlesOn;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[x + y * 4] + 0.5) / 16.0;
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 origin = cell * uCellScene;
  vec2 S = clamp(floor(uCellScene), vec2(2.0), vec2(12.0));
  vec2 stp = uCellScene / S;

  // 1. Gather: average colour + vote edge orientations over the cell.
  vec3 col = vec3(0.0);
  vec4 bins = vec4(0.0);
  for (int j = 0; j < 12; j++) {
    if (float(j) >= S.y) break;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= S.x) break;
      vec2 uv = (origin + (vec2(float(i), float(j)) + 0.5) * stp) / uSceneSize;
      col += texture(tColor, uv).rgb;
      vec4 e = texture(tEdge, uv);
      if (e.r > 0.5) {
        // line orientation = gradient + 90deg; buckets: 0 -, 1 /, 2 |, 3 backslash
        float b = floor(fract(e.g + 0.625) * 4.0);
        bins += vec4(equal(vec4(b), vec4(0.0, 1.0, 2.0, 3.0)));
      }
    }
  }
  float total = S.x * S.y;
  col /= total;

  vec2 cuv = (origin + 0.5 * uCellScene) / uSceneSize;
  vec4 aux = texture(tAux, cuv);
  float depth = texture(tDepth, cuv).x;
  float set = floor(aux.a * 32.0 + 0.5); // background clears to the sky set
  int si = int(clamp(set, 0.0, float(MAX_SETS - 1)));

  // 2. Tone: exposure -> filmic -> sRGB -> saturation / posterize.
  vec3 c = toSRGB(acesFilm(col * uExposure));
  float l = dot(c, LUMA);
  c = clamp(mix(vec3(l), c, uSaturation), 0.0, 1.0);
  if (uPosterize >= 2.0) c = floor(c * (uPosterize - 1.0) + 0.5) / (uPosterize - 1.0);

  // 3. Glyph by brightness inside this set's ramp (Bayer-dithered between steps).
  float t = pow(clamp((l - uBlack) / max(uWhite - uBlack, 1e-3), 0.0, 1.0), uGamma);
  float len = uRampLen[si];
  float idx = clamp(floor(t * len + (bayer4(cell) - 0.5) * uDither), 0.0, len - 1.0);
  float row = float(si);
  float colI = idx;

  // 4. Orientation sets (grass etc.): strokes follow the way the surface leans on screen.
  if (uOrient[si] > 0.5 && idx >= 2.0) {
    vec3 n = aux.xyz * 2.0 - 1.0;
    if (length(n.xy) > uOrientMin) {
      float f = fract(atan(n.y, n.x) / PI_ + uOrientRot + 1.125);
      row = uEdgeRow;
      colI = floor(f * 4.0);
    }
  }

  // 5. Edges win when enough of the cell votes for one direction.
  float mx = max(max(bins.x, bins.y), max(bins.z, bins.w));
  if (uEdges > 0.5 && mx >= max(uEdgeCoverage * total, 1.0)) {
    row = uEdgeRow;
    colI = mx == bins.x ? 0.0 : (mx == bins.y ? 1.0 : (mx == bins.z ? 2.0 : 3.0));
    c = mix(c * uEdgeGain, uEdgeTint, uEdgeTintMix);
  }

  // 6. Weather: three layers of falling glyphs in cell space, hidden behind anything nearer than the layer.
  //    The cursor pushes flakes aside.
  if (uWeather > 0.5) {
    float sceneZ = -perspectiveDepthToViewZ(depth, uNear, uFar);
    vec2 dc = (cell - uCursor) * vec2(1.0, uCellAspect);
    float dd = length(dc);
    vec2 push = (dc / max(dd, 1e-3)) * vec2(1.0, 1.0 / uCellAspect) * uWRepel * exp(-dd * dd / max(uWRepelR * uWRepelR, 1e-3));
    for (int L = 0; L < 3; L++) {
      float fl = float(L);
      float layerZ = L == 0 ? uWDepth.x : (L == 1 ? uWDepth.y : uWDepth.z);
      if (layerZ > sceneZ) continue;
      float spd = uWSpeed * (1.0 - fl * 0.3);
      vec2 q = cell + push * (1.0 - fl * 0.35);
      q.y += uTime * spd;
      q.x += -uWWind * uTime * spd + sin(q.y * 0.23 + fl * 2.1 + uTime * 0.7) * uWSway;
      bool rain = uWeather > 1.5 && uWeather < 2.5;
      bool motes = uWeather > 2.5;
      vec2 iq = rain ? floor(vec2(q.x, q.y / 3.0)) : floor(q);
      float h = hash12(iq + fl * 37.17);
      float dens = uWDensity * (0.55 + fl * 0.45);
      if (h < dens) {
        if (rain) {
          row = uEdgeRow;
          colI = uWWind > 0.25 ? 3.0 : (uWWind < -0.25 ? 1.0 : 2.0);
        } else {
          row = uParticleRow;
          colI = clamp(4.0 - fl - floor(h / dens * 1.6), 1.0, uRampLen[int(uParticleRow)] - 1.0);
        }
        // Motes (pollen, dust, plankton) twinkle as they drift.
        float tw = motes ? 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (1.5 + h * 9.0) + h * 61.0)) : 1.0;
        if (motes && tw < 0.45) colI = 1.0;
        c = mix(c, uWColor, uWBright * (1.0 - fl * 0.22) * tw);
        break;
      }
    }
  }

  // 7. 3D particles that landed in this cell, unless something in the scene is in front of them.
  if (uParticlesOn > 0.5) {
    vec4 pp = texelFetch(tParticles, ivec2(cell), 0);
    // Only where the particle is brighter than what's behind it (snow on snow stays snow, not a dark speck).
    if (pp.a > 0.5 && pp.r < -perspectiveDepthToViewZ(depth, uNear, uFar) + 0.05 && pp.b > l * 1.1) {
      float plen = uRampLen[int(uParticleRow)];
      row = uParticleRow;
      colI = clamp(floor(pp.g * (plen - 1.0) + 0.5), 1.0, plen - 1.0);
      c = mix(c, uWColor, clamp(pp.b, 0.0, 1.0));
    }
  }

  // alpha packs the cell's glyph set (for per-set fill) and the atlas glyph: set * 512 + row * 16 + col
  gl_FragColor = vec4(c, float(si) * 512.0 + row * 16.0 + colI);
}
`;

export const COMPOSE_FRAG = /* glsl */`
uniform sampler2D tCells;
uniform sampler2D tAtlas;
uniform vec2 uCellPx;
uniform float uAtlasRows;
uniform vec3 uBg;
uniform float uCellFill;
uniform float uGlyphGain;
uniform float uLift;
uniform float uSetFill[MAX_SETS];

void main() {
  vec2 cf = gl_FragCoord.xy / uCellPx;
  vec2 cell = floor(cf);
  vec2 local = clamp(cf - cell, 0.015, 0.985);
  vec4 d = texelFetch(tCells, ivec2(cell), 0);
  float set = floor(d.a / 512.0 + 0.0001);
  float code = d.a - set * 512.0;
  float row = floor(code / 16.0 + 0.001);
  float col = code - row * 16.0;
  float fill = uSetFill[int(clamp(set, 0.0, float(MAX_SETS - 1)))];
  vec2 auv = vec2((col + local.x) / 16.0, 1.0 - (row + 1.0 - local.y) / uAtlasRows);
  // Gradients from the continuous screen position, so mips don't seam at cell borders.
  float cov = textureGrad(tAtlas, auv, vec2(1.0 / (uCellPx.x * 16.0), 0.0), vec2(0.0, 1.0 / (uCellPx.y * uAtlasRows))).r;
  vec3 c = d.rgb;
  float m = max(c.r, max(c.g, c.b));
  vec3 g = m > 1e-4 ? c * (mix(m, 1.0, uLift) / m) : c;
  vec3 o = uBg + c * uCellFill * fill;
  gl_FragColor = vec4(mix(o, g * uGlyphGain, cov), 1.0);
}
`;

export const DOWN_FRAG = /* glsl */`
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uOffset;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uOffset;
  vec3 c = 0.25 * (texture(tInput, vUv - o).rgb + texture(tInput, vUv + o).rgb
                 + texture(tInput, vUv + vec2(o.x, -o.y)).rgb + texture(tInput, vUv + vec2(-o.x, o.y)).rgb);
  if (uThreshold >= 0.0) c *= smoothstep(uThreshold, uThreshold + 0.25, max(c.r, max(c.g, c.b)));
  gl_FragColor = vec4(c, 1.0);
}
`;

export const BLUR_FRAG = /* glsl */`
uniform sampler2D tInput;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture(tInput, vUv).rgb * 0.2270270270;
  c += texture(tInput, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(tInput, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(tInput, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(tInput, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const FINAL_FRAG = /* glsl */`
${COMMON}
uniform sampler2D tSharp;
uniform sampler2D tSoft;
uniform sampler2D tGlow;
uniform sampler2D tColor;
uniform sampler2D tAux;
uniform sampler2D tEdge;
uniform int uView;
uniform vec2 uRes;
uniform float uSplit;
uniform float uExposure;
uniform float uTilt;
uniform float uTiltCenter;
uniform float uTiltWidth;
uniform float uTiltFeather;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
varying vec2 vUv;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

void main() {
  vec3 ascii = texture(tSharp, vUv).rgb;
  if (uTilt > 0.0) {
    float d = abs(vUv.y - uTiltCenter) - uTiltWidth * 0.5;
    ascii = mix(ascii, texture(tSoft, vUv).rgb, smoothstep(0.0, max(uTiltFeather, 1e-3), d) * uTilt);
  }
  if (uBloom > 0.0) ascii += texture(tGlow, vUv).rgb * uBloom;

  vec3 c = ascii;
  if (uView == 1 || uView == 2) {
    vec3 src = toSRGB(acesFilm(texture(tColor, vUv).rgb * uExposure));
    c = (uView == 1 || vUv.x < uSplit) ? src : ascii;
    if (uView == 2 && abs(gl_FragCoord.x - uSplit * uRes.x) < 1.0) c = vec3(0.69, 0.55, 1.0);
  } else if (uView == 3) {
    c = texture(tAux, vUv).rgb;
  } else if (uView == 4) {
    vec4 e = texture(tEdge, vUv);
    c = e.r * hue(fract(e.g + 0.5));
  } else if (uView == 5) {
    vec4 a = texture(tAux, vUv);
    c = hue(floor(a.a * 32.0 + 0.5) / 24.0) * (0.35 + 0.65 * a.z);
  }

  vec2 q = vUv - 0.5;
  c *= mix(1.0, smoothstep(1.15, 0.35, length(q) * 1.4142), uVignette);
  c += (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 97.0) - 0.5) * uGrain;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;
