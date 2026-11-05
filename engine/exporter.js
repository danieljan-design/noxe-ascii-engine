// Frame-perfect video export. Steps the scene at a fixed frame rate (no matter how fast the machine is),
// encodes H.264 with WebCodecs and writes a standard MP4 (index first, one mdat), which X accepts directly.
// Nothing is dropped or doubled, unlike a live screen or canvas recording of a heavy scene.

const enc = new TextEncoder();
const u8 = (...b) => new Uint8Array(b);
const u16 = (v) => u8((v >> 8) & 255, v & 255);
const u32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const i32 = (v) => u32(v >>> 0);
const u64 = (v) => cat(u32(Math.floor(v / 2 ** 32)), u32(v >>> 0));
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...body) => { const b = cat(...body); return cat(u32(8 + b.length), enc.encode(type), b); };
const full = (type, version, flags, ...body) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);
const MATRIX = cat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

function runLength(values) {
  const out = [];
  for (const v of values) {
    if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
    else out.push([1, v]);
  }
  return out;
}

/** video: { width, height, timescale, samples: [{ data, dur, key, cto }], avcC } → MP4 Blob (video only). */
function muxMp4(video) {
  const movieTs = 1000;
  const { samples, timescale, width, height } = video;
  const mediaDur = samples.reduce((a, s) => a + s.dur, 0);
  const dur = Math.round((mediaDur * movieTs) / timescale);
  const vBytes = samples.reduce((a, s) => a + s.data.length, 0);
  const avc1 = box('avc1', u8(0, 0, 0, 0, 0, 0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(width), u16(height),
    u32(0x480000), u32(0x480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff), box('avcC', video.avcC));
  const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso2avc1mp41'));
  const build = (mdatStart) => {
    const stts = runLength(samples.map((s) => s.dur));
    const parts = [full('stsd', 0, 0, u32(1), avc1), full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => cat(u32(n), u32(d))))];
    if (samples.some((s) => s.cto)) {
      const ctts = runLength(samples.map((s) => s.cto || 0));
      parts.push(full('ctts', 1, 0, u32(ctts.length), ...ctts.map(([n, o]) => cat(u32(n), i32(o)))));
    }
    if (!samples.every((s) => s.key)) {
      const sync = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
      parts.push(full('stss', 0, 0, u32(sync.length), ...sync.map((i) => u32(i))));
    }
    parts.push(full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)));
    parts.push(full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))));
    parts.push(full('co64', 0, 0, u32(1), u64(mdatStart)));
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(dur), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
      MATRIX, u32(width << 16), u32(height << 16));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDur), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), enc.encode('vide'), u32(0), u32(0), u32(0), enc.encode('VideoHandler\0'));
    const minf = box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), box('stbl', ...parts));
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(dur), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
  };
  const moov = build(ftyp.length + build(0).length + 16);
  return new Blob([ftyp, moov, cat(u32(1), enc.encode('mdat'), u64(16 + vBytes)), ...samples.map((s) => s.data)], { type: 'video/mp4' });
}

// H.264 High profile at the lowest level that fits the frame size and rate: 4K at 60fps needs level 5.2,
// 4K at 30fps 5.1, 1080p 4.2. [level_idc, max frame size in macroblocks, max macroblocks per second]
const LEVELS = [[0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
export async function pickCodec(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser has no WebCodecs (use Chrome)');
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const codecs = LEVELS.filter(([, fs, rate]) => mbs <= fs && mbs * fps <= rate).map(([l]) => `avc1.6400${l.toString(16)}`);
  for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
    for (const codec of codecs) {
      // quality, not realtime: the encoder may take its time and spend bits where the detail is
      const cfg = { codec, width, height, bitrate, bitrateMode: 'variable', framerate: fps, latencyMode: 'quality', hardwareAcceleration, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
      } catch (e) { /* try the next */ }
    }
  }
  throw new Error(`This browser cannot encode ${width}×${height} H.264 at ${fps}fps`);
}

// Yield to the browser without timers: background tabs throttle setTimeout to once a second (or a minute),
// which would stall a render if you switch tabs. Channel messages are not throttled.
const channel = new MessageChannel();
const waiting = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldTask = () => new Promise((r) => { waiting.push(r); channel.port2.postMessage(0); });

/**
 * Render `seconds` of the scene to an MP4 Blob at a fixed frame rate.
 * step(dt): advance the scene one frame. render(): draw that frame to `canvas`.
 * width/height: the video size; the canvas may be drawn bigger and is scaled down to it (supersampled).
 */
export async function renderClip({ canvas, width = canvas.width, height = canvas.height, step, render, seconds = 10, fps = 60, bitrate = 45e6, onProgress }) {
  const cfg = await pickCodec(width, height, fps, bitrate);
  const timescale = 90000, frameTicks = Math.round(timescale / fps);
  const out = [];
  let avcC = null, failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push({ data, pts: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { failure = e; },
  });
  venc.configure(cfg);
  // Copy each frame through a 2D canvas: a VideoFrame made straight from a WebGL canvas can return
  // the last frame shown on screen instead of the one just drawn (nothing is presented during export).
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const frames = Math.round(seconds * fps), dt = 1 / fps;
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      step(dt);
      render();
      ctx.drawImage(canvas, 0, 0, width, height);
      const frame = new VideoFrame(copy, { timestamp: Math.round(i * dt * 1e6), duration: Math.round(dt * 1e6) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 4 && !failure) await yieldTask();
      if (i % 10 === 0) {
        onProgress?.(i / frames);
        await yieldTask();
      }
    }
    await venc.flush();
  } finally {
    venc.close();
  }
  if (failure) throw failure;
  // decode order is output order; presentation times give composition offsets if the encoder reorders
  const samples = out.map((s, i) => ({ data: s.data, dur: frameTicks, key: s.key, cto: Math.round((s.pts / 1e6) * timescale) - i * frameTicks }));
  onProgress?.(1);
  return { blob: muxMp4({ width, height, timescale, samples, avcC }), codec: cfg.codec, hardware: cfg.hardwareAcceleration };
}
