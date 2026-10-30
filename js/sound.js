/* Audio Cut: everything that touches samples.
   Reading a file, finding sounds, rendering a clip, and writing WAV, MP3 and ZIP.
   Nothing in here touches the page, and preview and export both use render(),
   so what you hear is what you get. */
(() => {
"use strict";

const SR = 48000;        // everything decodes to this; a common ceiling for game audio
const EDGE = 96;         // 2 ms at each end of a clip, so a cut never clicks
const TAIL = 1.2;        // seconds of ring added after a clip with reverb
const OFF_LOW = 20, OFF_HIGH = 20000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const db = (v) => Math.pow(10, v / 20);

/* --- reading --- */
function analyse(buffer, file) {
  const n = buffer.length, chs = buffer.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  // min and max per 128 and per 2048 samples, so any zoom draws fast
  const L1 = new Float32Array(2 * Math.ceil(n / 128));
  let peak = 0;
  for (let b = 0; b * 128 < n; b++) {
    let lo = 1, hi = -1;
    const end = Math.min(n, (b + 1) * 128);
    for (let i = b * 128; i < end; i++) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    L1[2 * b] = lo; L1[2 * b + 1] = hi;
    peak = Math.max(peak, Math.abs(lo), Math.abs(hi));
  }
  const L2 = new Float32Array(2 * Math.ceil(L1.length / 32));
  for (let b = 0; b * 32 < L1.length; b++) {
    let lo = 1, hi = -1;
    const end = Math.min(L1.length, (b + 1) * 32);
    for (let i = b * 32; i < end; i += 2) { if (L1[i] < lo) lo = L1[i]; if (L1[i + 1] > hi) hi = L1[i + 1]; }
    L2[2 * b] = lo; L2[2 * b + 1] = hi;
  }
  // loudness per 5 ms, for finding sounds
  const win = 240, rms = new Float32Array(Math.ceil(n / win));
  for (let b = 0; b < rms.length; b++) {
    let sum = 0;
    const end = Math.min(n, (b + 1) * win);
    for (let i = b * win; i < end; i++) sum += mono[i] * mono[i];
    rms[b] = Math.sqrt(sum / (end - b * win));
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  return {
    file, buffer, mono, L1, L2, rms, win,
    peak: peak || 1,
    quiet: Math.max(floor * 4, peak * 0.012),
    dur: buffer.duration,
    noise: null,
    thumbs: null,
  };
}

// min and max of a stretch of samples, read from the coarsest table that will do
function scan(S, a, b, spp, out) {
  let lo = 1, hi = -1;
  if (spp < 128) {
    const m = S.mono;
    for (let i = a; i < b; i++) { const v = m[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  } else {
    const size = spp < 2048 ? 128 : 2048, L = spp < 2048 ? S.L1 : S.L2;
    const end = Math.min(L.length, 2 * Math.ceil(b / size));
    for (let i = 2 * Math.floor(a / size); i < end; i += 2) { if (L[i] < lo) lo = L[i]; if (L[i + 1] > hi) hi = L[i + 1]; }
  }
  if (lo > hi) lo = hi = 0;
  out[0] = lo; out[1] = hi;
}

/* --- finding sounds --- */
const quietDb = (S) => Math.round(20 * Math.log10(S.quiet / S.peak));

function sounds(S, a, b, { quiet = quietDb(S), gap = 0.25 } = {}) {
  const { rms, win } = S;
  const thr = S.peak * db(quiet), gapW = Math.max(1, Math.round(gap * SR / win));
  const first = Math.floor(a * SR / win), last = Math.min(rms.length, Math.ceil(b * SR / win));
  const found = [];
  let start = -1, loud = -1;
  const close = () => {
    const s = Math.max(a, start * win / SR - 0.005), e = Math.min(b, (loud + 1) * win / SR + 0.03);
    if (e - s >= 0.03) found.push({ s, e });
    start = -1;
  };
  for (let i = first; i < last; i++) {
    if (rms[i] >= thr) { if (start < 0) start = i; loud = i; }
    else if (start >= 0 && i - loud >= gapW) close();
  }
  if (start >= 0) close();
  return found;
}

// the whole sound around a moment, out to the quiet on each side
function soundAround(S, t) {
  const { rms, quiet, win } = S;
  const gap = Math.round(0.12 * SR / win);
  let at = clamp(Math.floor(t * SR / win), 0, rms.length - 1);
  if (rms[at] < quiet) {
    let near = -1;
    for (let d = 1; d < Math.round(0.4 * SR / win) && near < 0; d++) {
      if (at - d >= 0 && rms[at - d] >= quiet) near = at - d;
      else if (at + d < rms.length && rms[at + d] >= quiet) near = at + d;
    }
    if (near < 0) return null;
    at = near;
  }
  let first = at, run = 0;
  for (let i = at - 1; i >= 0 && run < gap; i--) { if (rms[i] >= quiet) { first = i; run = 0; } else run++; }
  let last = at; run = 0;
  for (let i = at + 1; i < rms.length && run < gap; i++) { if (rms[i] >= quiet) { last = i; run = 0; } else run++; }
  return { s: Math.max(0, first * win / SR - 0.005), e: Math.min(S.dur, (last + 1) * win / SR + 0.03) };
}

/* --- clip arithmetic --- */
const playLength = (c) => (c.out - c.in) / c.speed;
const clipLength = (c) => playLength(c) + (c.reverb > 0 ? TAIL : 0);
const sourceAt = (c, u) => {
  const go = Math.min(u, playLength(c)) * c.speed;
  return c.reverse ? c.out - go : c.in + go;
};

/* --- noise reduction: spectral subtraction against the quietest parts of the file --- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
const FRAME = 1024, HOP = 256;
const hann = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME));

function noiseProfile(S) {
  if (S.noise) return S.noise;
  const { rms, win, mono } = S;
  const order = Array.from(rms.keys()).filter((i) => rms[i] > 1e-5).sort((x, y) => rms[x] - rms[y]);
  const take = order.slice(0, Math.ceil(order.length * 0.1)).slice(0, 400);
  const sum = new Float32Array(FRAME / 2 + 1);
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  let used = 0;
  for (const w of take) {
    const at = w * win;
    if (at + FRAME > mono.length) continue;
    for (let i = 0; i < FRAME; i++) { re[i] = mono[at + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= FRAME / 2; k++) sum[k] += Math.hypot(re[k], im[k]);
    used++;
  }
  for (let k = 0; k <= FRAME / 2; k++) sum[k] /= used || 1;
  return (S.noise = sum);
}

function denoise(data, S) {
  const noise = noiseProfile(S), n = data.length;
  const out = new Float32Array(n), weight = new Float32Array(n);
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME), keep = new Float32Array(FRAME / 2 + 1).fill(1);
  for (let at = -FRAME + HOP; at < n; at += HOP) {
    for (let i = 0; i < FRAME; i++) {
      const j = at + i;
      re[i] = j >= 0 && j < n ? data[j] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= FRAME / 2; k++) {
      const mag = Math.hypot(re[k], im[k]) || 1e-9;
      const want = Math.max(0.08, 1 - 2 * noise[k] / mag);
      keep[k] += (want - keep[k]) * (want > keep[k] ? 0.8 : 0.25);   // open fast, close slowly
      re[k] *= keep[k]; im[k] *= keep[k];
      if (k && k < FRAME / 2) { re[FRAME - k] = re[k]; im[FRAME - k] = -im[k]; }
    }
    // an inverse transform, by swapping the two halves
    fft(im, re);
    for (let i = 0; i < FRAME; i++) {
      const j = at + i;
      if (j < 0 || j >= n) continue;
      out[j] += re[i] / FRAME * hann[i];
      weight[j] += hann[i] * hann[i];
    }
  }
  for (let i = 0; i < n; i++) out[i] = weight[i] > 1e-4 ? out[i] / weight[i] : data[i];
  return out;
}

/* --- reverb: a short room made of decaying noise, the same every time --- */
function impulse(channels) {
  const len = Math.round(TAIL * SR), buf = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: SR });
  for (let c = 0; c < channels; c++) {
    let seed = 0x9e3779b9 + c * 7919;
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const noise = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
      d[i] = noise * Math.pow(1 - i / len, 3.2);
    }
  }
  return buf;
}

/* --- render one clip to its final samples --- */
const cache = new Map();
let cachedSamples = 0;
const keyOf = (c) => [c.in, c.out, c.gain, c.fadeIn, c.fadeOut, c.speed, c.reverse, c.denoise, c.lowCut, c.highCut, c.reverb].join("|");

async function render(S, c) {
  const key = keyOf(c), hit = cache.get(key);
  if (hit) return hit;

  const a = Math.round(c.in * SR), b = Math.max(a + 1, Math.round(c.out * SR));
  const channels = S.buffer.numberOfChannels;
  let data = [];
  for (let ch = 0; ch < channels; ch++) {
    let d = S.buffer.getChannelData(ch).slice(a, b);
    if (c.denoise) d = denoise(d, S);
    if (c.reverse) d.reverse();
    data.push(d);
  }

  let out;
  if (c.speed !== 1 || c.lowCut > OFF_LOW || c.highCut < OFF_HIGH || c.reverb > 0) {
    const length = Math.ceil(clipLength(c) * SR);
    const ctx = new OfflineAudioContext(channels, length, SR);
    const raw = new AudioBuffer({ length: data[0].length, numberOfChannels: channels, sampleRate: SR });
    data.forEach((d, i) => raw.copyToChannel(d, i));
    const src = ctx.createBufferSource();
    src.buffer = raw;
    src.playbackRate.value = c.speed;
    let tail = src;
    if (c.lowCut > OFF_LOW) {
      const f = ctx.createBiquadFilter();
      f.type = "highpass"; f.frequency.value = c.lowCut;
      tail = tail.connect(f);
    }
    if (c.highCut < OFF_HIGH) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = c.highCut;
      tail = tail.connect(f);
    }
    if (c.reverb > 0) {
      const wet = ctx.createGain(), dry = ctx.createGain(), room = ctx.createConvolver();
      wet.gain.value = c.reverb; dry.gain.value = 1 - c.reverb * 0.5;
      room.buffer = impulse(channels);
      tail.connect(dry).connect(ctx.destination);
      tail.connect(room).connect(wet).connect(ctx.destination);
    } else {
      tail.connect(ctx.destination);
    }
    src.start();
    out = await ctx.startRendering();
  } else {
    out = new AudioBuffer({ length: data[0].length, numberOfChannels: channels, sampleRate: SR });
    data.forEach((d, i) => out.copyToChannel(d, i));
  }

  // volume, fades, and the anti-click edge, last so they follow speed and reverb
  const gain = db(c.gain), n = out.length;
  let fi = Math.round(c.fadeIn * SR), fo = Math.round(c.fadeOut * SR);
  if (fi + fo > n) { const k = n / (fi + fo); fi = Math.floor(fi * k); fo = Math.floor(fo * k); }
  const edge = Math.min(EDGE, n >> 1);
  for (let ch = 0; ch < channels; ch++) {
    const d = out.getChannelData(ch);
    if (gain !== 1) for (let i = 0; i < n; i++) d[i] *= gain;
    for (let i = 0; i < fi; i++) d[i] *= i / fi;
    for (let i = 0; i < fo; i++) d[n - 1 - i] *= i / fo;
    for (let i = 0; i < edge; i++) { d[i] *= i / edge; d[n - 1 - i] *= i / edge; }
  }

  if (cachedSamples > 60 * SR * 10) { cache.clear(); cachedSamples = 0; }
  cache.set(key, out);
  cachedSamples += n * channels;
  return out;
}

const clearCache = () => { cache.clear(); cachedSamples = 0; };

function peakOf(buf) {
  let p = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > p) p = v; }
  }
  return p;
}

// the volume that puts this clip's loudest sample at -1 dB
async function normalGain(S, c) {
  const flat = await render(S, { ...c, gain: 0, fadeIn: 0, fadeOut: 0 });
  const p = peakOf(flat);
  return p ? clamp(Math.round((-1 - 20 * Math.log10(p)) * 10) / 10, -30, 40) : 0;
}

/* --- writing files --- */
function channelsOf(buffers) {
  const channels = buffers[0].numberOfChannels;
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = [];
  for (let ch = 0; ch < channels; ch++) {
    const d = new Float32Array(total);
    let at = 0;
    for (const b of buffers) { d.set(b.getChannelData(ch), at); at += b.length; }
    out.push(d);
  }
  return out;
}

function wav(chans) {
  const n = chans[0].length, ch = chans.length, bytes = n * ch * 2;
  const out = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); out.setUint32(4, 36 + bytes, true); tag(8, "WAVE");
  tag(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, SR, true); out.setUint32(28, SR * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  tag(36, "data"); out.setUint32(40, bytes, true);
  for (let i = 0, o = 44; i < n; i++) {
    for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, clamp(chans[c][i], -1, 1) * 32767, true);
  }
  return new Uint8Array(out.buffer);
}

async function mp3(chans) {
  const ch = Math.min(chans.length, 2), n = chans[0].length, enc = new lamejs.Mp3Encoder(ch, SR, 192);
  const ints = chans.slice(0, ch).map((d) => Int16Array.from(d, (v) => clamp(v, -1, 1) * 32767));
  const parts = [];
  for (let i = 0, round = 0; i < n; i += 1152, round++) {
    const l = ints[0].subarray(i, i + 1152);
    const out = ch > 1 ? enc.encodeBuffer(l, ints[1].subarray(i, i + 1152)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    if (round % 400 === 399) await new Promise((r) => setTimeout(r));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// a zip with no compression: audio barely shrinks, and this keeps it small and fast
function zip(entries) {
  const enc = new TextEncoder(), chunks = [], central = [];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const { name, data } of entries) {
    const path = enc.encode(name), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true); head.setUint32(22, data.length, true); head.setUint16(26, path.length, true);
    chunks.push(new Uint8Array(head.buffer), path, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint16(12, time, true); dir.setUint16(14, date, true); dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, path.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), path);
    offset += 30 + path.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

function cleanName(raw) {
  let n = raw.trim().replace(/\.(wav|mp3|zip)$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
  return n.slice(0, 120);
}

window.Sound = {
  SR, TAIL, OFF_LOW, OFF_HIGH, clamp,
  analyse, scan, quietDb, sounds, soundAround,
  playLength, clipLength, sourceAt,
  render, clearCache, normalGain, channelsOf, wav, mp3, zip, cleanName,
};
})();
