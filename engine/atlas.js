// Glyph atlas: one row per glyph set, plus a last row for the 4 edge glyphs.
// Each row holds up to 16 characters, darkest (index 0) to densest.

export async function buildAtlas({ rows, cols = 16, font, weight, aspect, scale = 1, cellH = 96 }) {
  const spec = (px) => `${weight} ${px}px "${font}", ui-monospace, Menlo, monospace`;
  try { await document.fonts.load(spec(64), rows.join('')); } catch (e) { /* fall back silently */ }

  const gh = cellH;
  const gw = Math.max(8, Math.round(cellH / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = gw * cols;
  canvas.height = gh * rows.length;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Size the font so one advance fills the cell width (glyphs like - = _ join up into bars).
  ctx.font = spec(100);
  const adv = ctx.measureText('M').width / 100;
  const size = Math.min(gw / adv, gh * 0.95) * scale;
  ctx.font = spec(size);
  const cap = ctx.measureText('H').actualBoundingBoxAscent || size * 0.7;

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  rows.forEach((str, r) => {
    Array.from(str).slice(0, cols).forEach((ch, i) => {
      if (ch === ' ') return;
      ctx.fillText(ch, i * gw + gw / 2, r * gh + gh / 2 + cap / 2);
    });
  });
  return canvas;
}
