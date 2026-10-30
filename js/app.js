/* Audio Cut: the editor. A timeline of clips with no gaps, like a magnetic main
   track. A clip is a window onto the source plus its settings, so editing never
   changes the source and undo is cheap. */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const { SR, clamp, clipLength, playLength, sourceAt } = Sound;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const touch = matchMedia("(pointer: coarse)").matches;

const MIN_CLIP = 0.01;   // shortest clip, in source seconds
const MIN_SPAN = 0.05;   // tightest zoom, in seconds
const RULER = 24;

const ICON = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z"/></svg>',
  stop: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2h3v8H2zM7 2h3v8H7z"/></svg>',
};
const DEFAULTS = { gain: 0, fadeIn: 0, fadeOut: 0, speed: 1, reverse: false, denoise: false, lowCut: Sound.OFF_LOW, highCut: Sound.OFF_HIGH, reverb: 0 };

let S = null;              // the open source: decoded audio, tables, thumbnails
let clips = [];            // the timeline, in order
let markers = [];          // timeline seconds
let layout = [];           // { c, start, len } for each clip
let total = 0;             // timeline length
let selected = new Set();  // clip ids
let view = { s: 0, e: 1 }; // what the timeline shows
let ph = 0;                // playhead, in timeline seconds
let snapOn = true;
let past = [], future = [];
let nextId = 1;
let actx = null;
let reveal = 1;            // 0 to 1 while the timeline first draws in
let pin = null;            // keeps a trimmed clip's left edge under the hand during a drag
let loadToken = 0;
let saveKey = null;

const say = (text) => { $("#status").textContent = text; };

/* --- time text --- */
function fmt(t, dec = true) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const head = h ? `${h}:${String(m).padStart(2, "0")}` : String(m);
  return `${head}:${String(s).padStart(2, "0")}` + (dec ? `.${String(ms % 1000).padStart(3, "0")}` : "");
}
function parseTime(text) {
  const parts = text.trim().split(":");
  if (parts.length > 3 || !parts.every((p) => /^(\d+\.?\d*|\.\d+)$/.test(p))) return null;
  return parts.reduce((sum, p) => sum * 60 + parseFloat(p), 0);
}

/* --- the model --- */
const newClip = (a, b, name, from) => ({ ...DEFAULTS, ...from, id: nextId++, in: a, out: b, name });
const byId = (id) => clips.find((c) => c.id === id);
const only = () => (selected.size === 1 ? byId([...selected][0]) : null);
const picks = () => clips.filter((c) => selected.has(c.id));

function relayout() {
  let t = 0;
  layout = clips.map((c) => {
    const len = clipLength(c);
    const start = t + (pin && pin.id === c.id ? pin.dt : 0);
    t = start + len;
    return { c, start, len };
  });
  total = t;
}
function at(t) {
  let lo = 0, hi = layout.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = layout[mid];
    if (t < r.start) hi = mid - 1;
    else if (t >= r.start + r.len) lo = mid + 1;
    else return r;
  }
  return null;
}
const rowOf = (c) => layout.find((r) => r.c === c);

function nextName(like, also = []) {
  const m = (like || "sfx_000").match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : `${like}_`, width = m ? m[2].length : 3;
  let top = 0;
  for (const c of [...clips, ...also]) {
    if (c.name.startsWith(stem)) {
      const rest = c.name.slice(stem.length);
      if (/^\d+$/.test(rest)) top = Math.max(top, +rest);
    }
  }
  return stem + String(top + 1).padStart(width, "0");
}

/* --- undo: a list of whole states, small because clips hold no samples --- */
const snapshot = () => JSON.stringify({ clips, markers });
function restore(json) {
  const was = JSON.parse(json);
  clips = was.clips; markers = was.markers;
  nextId = Math.max(nextId, ...clips.map((c) => c.id + 1), 1);
  selected = new Set([...selected].filter(byId));
}
function commit(label, change) {
  halt();
  past.push(snapshot());
  if (past.length > 300) past.shift();
  future = [];
  change();
  settle(label);
}
function settle(label) {
  relayout();
  ph = clamp(ph, 0, total);
  if (view.e - view.s > total && total > 0) view = { s: 0, e: total };
  setView(view.s, view.e - view.s);
  buildList();
  syncAll();
  drawOver();
  persist();
  if (label) say(label);
}
function undo() {
  if (!past.length) return;
  halt();
  future.push(snapshot());
  restore(past.pop());
  settle("Undone.");
}
function redo() {
  if (!future.length) return;
  halt();
  past.push(snapshot());
  restore(future.pop());
  settle("Redone.");
}
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(saveKey, snapshot()); } catch {}
  }, 300);
}

/* --- opening a file --- */
function showState(name) {
  document.body.className = `state-${name}`;
  $("#empty").hidden = name !== "empty";
  $("#loading").hidden = name !== "loading";
  $("#work").hidden = name !== "work";
  $("#fileBox").hidden = $("#openBtn").hidden = $("#exportBtn").hidden = name !== "work";
  name === "empty" ? Sun.start() : Sun.stop();
}
function refuse(text) {
  $("#emptyErr").textContent = text;
  if (S) say(text);
}
const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name);

async function openFile(file) {
  if (!isVideo(file)) {
    const ext = (file.name.match(/\.\w+$/) || ["That file"])[0];
    return refuse(`${ext} is not a video. Use an mp4, mov or webm.`);
  }
  halt();
  const token = ++loadToken;
  $("#emptyErr").textContent = "";
  $("#loadName").textContent = file.name;
  const had = S;
  showState("loading");
  let next;
  try {
    actx = actx || new AudioContext({ sampleRate: SR });
    const bytes = await file.arrayBuffer();
    next = Sound.analyse(await actx.decodeAudioData(bytes), file);
  } catch (err) {
    showState(had ? "work" : "empty");
    return refuse(file.size > 1.5 * 2 ** 30
      ? `${(file.size / 2 ** 30).toFixed(1)} GB is too big for the browser to read. Trim the video first.`
      : err.name === "NotReadableError"
        ? "This file could not be read. Check it still exists, then try again."
        : "No audio could be read from this file. It may have no sound track.");
  }
  S = next;
  Sound.clearCache();

  const v = $("#video"), tv = $("#thumbVideo");
  if (v.src) URL.revokeObjectURL(v.src);
  $("#noPicture").hidden = true;
  const url = URL.createObjectURL(file);
  v.src = url;

  saveKey = `audio-cut:v1:${file.name}:${file.size}:${file.lastModified}`;
  past = []; future = []; markers = []; ph = 0; selected = new Set();
  clips = [newClip(0, S.dur, "sfx_001")];
  let back = null;
  try { back = localStorage.getItem(saveKey); } catch {}
  if (back) {
    try { past.push(snapshot()); restore(back); } catch { past = []; }
  }
  relayout();
  view = { s: 0, e: Math.max(total, MIN_SPAN) };
  $("#fileName").textContent = file.name;
  $("#fileFacts").textContent = `${SR / 1000} kHz  ${S.buffer.numberOfChannels > 1 ? "stereo" : "mono"}`;
  document.title = `${file.name} | Audio Cut`;
  showState("work");
  size();
  if (clips.length === 1) select([clips[0].id]);
  settle(back ? "Your last edit of this video is back. Ctrl+Z starts over." : `Press Auto Split to find every sound, or ${touch ? "double tap" : "double click"} one.`);
  setButtons();
  if (!reduced.matches) playReveal();
  makeThumbs(tv, url, token);
}

function once(el, name, ms) {
  return new Promise((done) => {
    const finish = () => { el.removeEventListener(name, finish); clearTimeout(t); done(); };
    const t = setTimeout(finish, ms);
    el.addEventListener(name, finish);
  });
}
// a strip of frames, read in the background from a second video
async function makeThumbs(v, url, token) {
  v.src = url;
  await once(v, "loadedmetadata", 4000);
  if (token !== loadToken || !v.videoWidth) return;
  const tw = 128, th = Math.round(tw * v.videoHeight / v.videoWidth);
  const n = clamp(Math.ceil(S.dur / 2), 8, 120), cols = 12;
  const atlas = document.createElement("canvas");
  atlas.width = tw * cols; atlas.height = th * Math.ceil(n / cols);
  const c = atlas.getContext("2d");
  S.thumbs = { atlas, tw, th, n, cols, ready: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    v.currentTime = (i + 0.5) / n * S.dur;
    await once(v, "seeked", 2500);
    if (token !== loadToken) return;
    c.drawImage(v, (i % cols) * tw, Math.floor(i / cols) * th, tw, th);
    S.thumbs.ready[i] = 1;
    if (i % 3 === 2 || i === n - 1) queueDraw();
  }
}

const fileInput = $("#fileInput");
$("#chooseBtn").onclick = $("#openBtn").onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ""; };

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
function dropState(on) {
  if (!$("#work").hidden) $("#cover").hidden = !on;
  if (!$("#empty").hidden) {
    Sun.wake(on);
    $("#emptyTitle").textContent = on ? "Let go." : "Cut the sound out of a video.";
  }
}
addEventListener("dragenter", (e) => { if (hasFiles(e) && dragDepth++ === 0) dropState(true); });
addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth === 0) dropState(false); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropState(false);
  if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
$("#video").addEventListener("error", () => { if (S) $("#noPicture").hidden = false; });

/* --- drawing --- */
const waveCv = $("#wave"), wc = waveCv.getContext("2d");
const overCv = $("#overCv"), oc = overCv.getContext("2d");
const mainBox = $("#main"), overBox = $("#over");
let mainW = 0, mainH = 0, overW = 0, overH = 0, dpr = 1, drawQueued = false, overQueued = false;

const pps = () => mainW / (view.e - view.s);
const px = (t) => (t - view.s) * pps();
const timeAt = (clientX) => clamp(view.s + (clientX - mainBox.getBoundingClientRect().left) / pps(), 0, total);

function size() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  mainW = mainBox.clientWidth; mainH = mainBox.clientHeight;
  overW = overBox.clientWidth; overH = overBox.clientHeight;
  waveCv.width = mainW * dpr; waveCv.height = mainH * dpr;
  overCv.width = overW * dpr; overCv.height = overH * dpr;
  drawOver(); draw();
}
new ResizeObserver(() => { if (S && !$("#work").hidden) size(); }).observe(mainBox);

// a curve, so a quiet sound in a loud file can still be seen
const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v) / S.peak, 0.55);
const pair = [0, 0];

function bars(path, r, x1, perSec, top, height, stepPx, barPx, xmin, xmax) {
  const c = r.c, mid = top + height / 2, half = height / 2 - 1;
  const spp = stepPx / perSec * c.speed * SR, play = playLength(c);
  const gain = clamp(Math.pow(10, c.gain / 20), 0, 2);
  const startX = Math.max(xmin, x1 + ((Math.ceil((xmin - x1) / stepPx) * stepPx) || 0));
  for (let x = startX; x < Math.min(xmax, x1 + play * perSec); x += stepPx) {
    const u = (x - x1) / perSec;
    const src = sourceAt(c, u);
    const a = Math.max(0, Math.floor((c.reverse ? src - stepPx / perSec * c.speed : src) * SR));
    const b = Math.min(S.mono.length, Math.ceil(a + spp));
    if (b <= a) continue;
    Sound.scan(S, a, b, spp, pair);
    let k = gain;
    if (c.fadeIn > 0 && u < c.fadeIn) k *= u / c.fadeIn;
    if (c.fadeOut > 0 && play - u < c.fadeOut) k *= (play - u) / c.fadeOut;
    const y1 = mid - curve(pair[1]) * half * k, y2 = mid - curve(pair[0]) * half * k;
    path.rect(x, clamp(y1, top, top + height), barPx, Math.max(1, clamp(y2, top, top + height) - clamp(y1, top, top + height)));
  }
}

function film(c, r, x1, x2, top, height, w) {
  const T = S.thumbs;
  if (!T) return;
  const tile = height * T.tw / T.th, perSec = pps();
  const first = Math.max(x1, x1 + Math.floor((0 - x1) / tile) * tile);
  for (let x = first; x < Math.min(x2, w); x += tile) {
    const src = sourceAt(r.c, (x - x1) / perSec);
    let i = clamp(Math.floor(src / S.dur * T.n), 0, T.n - 1);
    while (i > 0 && !T.ready[i]) i--;
    if (!T.ready[i]) continue;
    c.drawImage(T.atlas, (i % T.cols) * T.tw, Math.floor(i / T.cols) * T.th, T.tw, T.th, x, top, tile, height);
  }
}

function ruler(c, w) {
  const span = view.e - view.s;
  const steps = [.001, .002, .005, .01, .02, .05, .1, .2, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const major = steps.find((s) => s / span * w >= 92) || 3600;
  c.font = '13px "Geist Mono", monospace';
  c.textBaseline = "middle";
  c.fillStyle = "#2B2631";
  c.fillRect(0, RULER - 1, w, 1);
  for (let i = Math.floor(view.s / major * 5); i * major / 5 <= view.e; i++) {
    const t = i * major / 5, x = Math.round(px(t));
    const big = i % 5 === 0;
    c.fillStyle = big ? "#4A4250" : "#2B2631";
    c.fillRect(x, big ? 0 : RULER - 7, 1, big ? RULER : 6);
    if (big) { c.fillStyle = "#A39A92"; c.fillText(fmt(t, major < 1), x + 6, 11); }
  }
  c.fillStyle = "#F8C870";
  for (const m of markers) {
    const x = px(m);
    if (x < -6 || x > w + 6) continue;
    c.beginPath(); c.moveTo(x - 5, RULER - 12); c.lineTo(x + 5, RULER - 12); c.lineTo(x + 5, RULER - 5); c.lineTo(x, RULER - 1); c.lineTo(x - 5, RULER - 5); c.closePath(); c.fill();
  }
}

function draw() {
  drawQueued = false;
  if (!S) return;
  const c = wc, w = mainW, h = mainH, perSec = pps();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  ruler(c, w);

  const top = RULER + 4, height = h - top - 2;
  const filmH = clamp(Math.round(height * 0.3), 24, 54);
  const waveTop = top + filmH + 2, waveH = height - filmH - 2;
  const span = view.e - view.s, stepPx = span < 1 ? 2 : 3, barPx = span < 1 ? 1 : 2;
  const quiet = new Path2D(), hot = new Path2D();
  const limit = w * reveal;

  for (const r of layout) {
    const x1 = px(r.start), x2 = px(r.start + r.len);
    if (x2 < 0 || x1 > w) continue;
    const on = selected.has(r.c.id), bw = Math.max(1, x2 - x1 - 1);
    c.save();
    c.beginPath(); c.roundRect(x1, top, bw, height, 3); c.clip();
    c.fillStyle = on ? "#1E1A1C" : "#131118";
    c.fillRect(x1, top, bw, height);
    film(c, r, x1, x2, top, filmH, w);
    bars(on ? hot : quiet, r, x1, perSec, waveTop, waveH, stepPx, barPx, Math.max(0, x1), Math.min(limit, x2 - 1));
    c.restore();
  }
  c.fillStyle = "#8A8078"; c.fill(quiet);
  c.fillStyle = "#F8C870"; c.fill(hot);

  c.textBaseline = "top";
  for (const r of layout) {
    const x1 = px(r.start), x2 = px(r.start + r.len);
    if (x2 < 0 || x1 > w) continue;
    const on = selected.has(r.c.id), bw = Math.max(1, x2 - x1 - 1);
    // fades, as a slope cut from the corners
    const clipLeft = x1, clipRight = x1 + playLength(r.c) * perSec;
    c.fillStyle = "rgba(11,10,14,.62)";
    if (r.c.fadeIn > 0) { const fx = clipLeft + r.c.fadeIn * perSec; c.beginPath(); c.moveTo(clipLeft, top); c.lineTo(fx, top); c.lineTo(clipLeft, top + filmH); c.closePath(); c.fill(); }
    if (r.c.fadeOut > 0) { const fx = clipRight - r.c.fadeOut * perSec; c.beginPath(); c.moveTo(clipRight, top); c.lineTo(fx, top); c.lineTo(clipRight, top + filmH); c.closePath(); c.fill(); }

    c.strokeStyle = on ? "#F8C870" : "#2B2631";
    c.lineWidth = on ? 2 : 1;
    c.beginPath(); c.roundRect(x1 + (on ? 1 : 0.5), top + (on ? 1 : 0.5), Math.max(1, bw - (on ? 2 : 1)), height - (on ? 2 : 1), 3); c.stroke();

    if (bw > 44) {
      const tags = (r.c.speed !== 1 ? ` ${r.c.speed.toFixed(2)}x` : "") + (r.c.reverse ? " rev" : "");
      const label = r.c.name + tags, x = Math.max(x1, 0) + 5;
      c.save();
      c.beginPath(); c.rect(x1, top, bw, height); c.clip();
      const tw = c.measureText(label).width;
      c.fillStyle = "rgba(11,10,14,.74)";
      c.fillRect(x - 3, top + 3, tw + 6, 18);
      c.fillStyle = "#F0E8DC";
      c.fillText(label, x, top + 6);
      c.restore();
    }
  }

  if (drag && drag.kind === "clip" && drag.moved) {
    const row = layout[drag.insert], x = px(row ? row.start : total);
    c.fillStyle = "#F06B3C";
    c.fillRect(x - 1, top, 3, height);
  }
  place();
}
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}
function drawOver() {
  if (overQueued) return;
  overQueued = true;
  requestAnimationFrame(() => {
    overQueued = false;
    if (!S || !total) { oc.clearRect(0, 0, overCv.width, overCv.height); return; }
    const c = oc, perSec = overW / total, path = new Path2D();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, overW, overH);
    for (const r of layout) {
      const x1 = r.start * perSec;
      bars(path, r, x1, perSec, 0, overH, 2, 1, x1, x1 + r.len * perSec);
    }
    c.fillStyle = "#6E6660"; c.fill(path);
    c.fillStyle = "#F8C870";
    for (const r of layout) if (selected.has(r.c.id)) c.fillRect(r.start * perSec, overH - 3, Math.max(2, r.len * perSec), 3);
  });
}
function place() {
  const onScreen = (x) => x >= -2 && x <= mainW + 2;
  const head = $("#ph"), pp = px(ph);
  head.style.transform = `translateX(${pp}px)`;
  head.style.visibility = onScreen(pp) ? "" : "hidden";

  const c = only(), hS = $("#hStart"), hE = $("#hEnd");
  hS.hidden = hE.hidden = !c;
  if (c) {
    const r = rowOf(c), a = px(r.start), b = px(r.start + r.len);
    hS.style.transform = `translateX(${a}px)`;
    hE.style.transform = `translateX(${b}px)`;
    hS.style.visibility = onScreen(a) ? "" : "hidden";
    hE.style.visibility = onScreen(b) ? "" : "hidden";
  }
  if (total) {
    $("#ovWin").style.cssText = `left:${view.s / total * 100}%;width:${Math.max(0.4, (view.e - view.s) / total * 100)}%`;
    $("#ovPh").style.left = `${ph / total * 100}%`;
  }
}
function playReveal() {
  const t0 = performance.now();
  reveal = 0;
  (function step(now) {
    const p = Math.min(1, (now - t0) / 460);
    reveal = 1 - Math.pow(1 - p, 3);
    draw();
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

/* --- the view --- */
function setView(s, span) {
  const end = Math.max(total, MIN_SPAN);
  span = clamp(span, Math.min(MIN_SPAN, end), end);
  s = clamp(s, 0, end - span);
  view = { s, e: s + span };
  const range = $("#zoomRange"), full = Math.log(end / Math.min(MIN_SPAN, end)) || 1;
  range.value = 1 - Math.log(span / Math.min(MIN_SPAN, end)) / full;
  queueDraw();
}
function zoomAt(t, factor) {
  const span = view.e - view.s, end = Math.max(total, MIN_SPAN);
  const next = clamp(span * factor, Math.min(MIN_SPAN, end), end);
  setView(t - (t - view.s) * (next / span), next);
}
const fit = () => setView(0, Math.max(total, MIN_SPAN));
function keepInView(t) {
  const span = view.e - view.s;
  if (t < view.s || t > view.e) setView(t - span * 0.1, span);
}
function zoomToClip() {
  const c = only() || picks()[0];
  if (!c) return;
  const r = rowOf(c), pad = Math.max(r.len * 0.25, 0.02);
  setView(r.start - pad, r.len + pad * 2);
}

/* --- the clip list and inspector --- */
const list = $("#clipList");
function buildList() {
  list.textContent = "";
  for (const r of layout) {
    const li = document.createElement("li"), row = document.createElement("button");
    const name = document.createElement("span"), len = document.createElement("span");
    row.className = "row"; row.type = "button"; row.dataset.id = r.c.id;
    row.setAttribute("aria-current", selected.has(r.c.id));
    name.textContent = r.c.name;
    name.translate = false;
    len.textContent = `${r.len.toFixed(2)} s`;
    row.append(name, len); li.append(row); list.append(li);
  }
  $("#binCount").textContent = clips.length === 1 ? "1 clip" : `${clips.length} clips`;
  $("#totalOut").textContent = `/ ${fmt(total)}`;
}
list.addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const id = +row.dataset.id;
  pick(id, e);
  const c = byId(id);
  if (c) { setPh(rowOf(c).start); keepInView(ph); }
});
list.addEventListener("dblclick", (e) => { if (e.target.closest(".row")) playClip(); });

function select(ids) {
  selected = new Set(ids);
  syncAll();
  drawOver();
  for (const row of list.children) {
    const b = row.firstChild, on = selected.has(+b.dataset.id);
    b.setAttribute("aria-current", on);
    if (on && selected.size === 1) b.scrollIntoView({ block: "nearest" });
  }
}
function pick(id, e) {
  if (e && (e.ctrlKey || e.metaKey)) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    select(next);
  } else if (e && e.shiftKey && selected.size) {
    const ids = clips.map((c) => c.id), first = ids.findIndex((i) => selected.has(i)), to = ids.indexOf(id);
    select(ids.slice(Math.min(first, to), Math.max(first, to) + 1));
  } else {
    select([id]);
  }
}

const log01 = (v, a, b) => a * Math.pow(b / a, v);
const toLog = (hz, a, b) => Math.log(hz / a) / Math.log(b / a);
const CONTROLS = {
  gain: { show: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB` },
  fadeIn: { show: (v) => `${v.toFixed(2)} s` },
  fadeOut: { show: (v) => `${v.toFixed(2)} s` },
  speed: { read: (x) => +Math.pow(2, x).toFixed(3), write: (v) => Math.log2(v), show: (v) => `${v.toFixed(2)}x` },
  lowCut: { read: (x) => (x < 0.01 ? Sound.OFF_LOW : Math.round(log01(x, 20, 2000))), write: (v) => toLog(v, 20, 2000), show: (v) => (v <= Sound.OFF_LOW ? "Off" : `${v} Hz`) },
  highCut: { read: (x) => (x > 0.99 ? Sound.OFF_HIGH : Math.round(log01(x, 500, 20000))), write: (v) => toLog(v, 500, 20000), show: (v) => (v >= Sound.OFF_HIGH ? "Off" : `${v} Hz`) },
  reverb: { show: (v) => (v ? `${Math.round(v * 100)}%` : "Off") },
};

function syncAll() {
  const c = only(), first = c || picks()[0], some = !!first;
  $("#noneMsg").hidden = some;
  $("#panelBody").hidden = !some;
  $("#noneMsg").textContent = clips.length ? "Select a clip to edit it." : "The timeline is empty. Press Ctrl+Z to bring it back.";
  for (const id of ["#splitBtn", "#leftBtn", "#rightBtn"]) $(id).disabled = !clips.length;
  $("#deleteBtn").disabled = !some;
  $("#exportBtn").disabled = !clips.length;
  $("#autoBtn").disabled = !clips.length;
  $("#undoBtn").disabled = !past.length;
  $("#redoBtn").disabled = !future.length;
  $("#zoomClip").disabled = !some;
  $("#playClipBtn").disabled = !some;
  $("#phOut").textContent = fmt(ph);
  if (some) {
    const name = $("#nameField"), startF = $("#startField"), endF = $("#endField");
    if (document.activeElement !== name) name.value = c ? c.name : `${selected.size} clips selected`;
    name.disabled = !c;
    $("#timeRow").hidden = !c;
    if (c) {
      if (document.activeElement !== startF) { startF.value = fmt(c.in); startF.removeAttribute("aria-invalid"); }
      if (document.activeElement !== endF) { endF.value = fmt(c.out); endF.removeAttribute("aria-invalid"); }
      $("#lenOut").textContent = `${clipLength(c).toFixed(3)} s`;
      const r = rowOf(c);
      for (const [el, t, word] of [[$("#hStart"), r.start, "start"], [$("#hEnd"), r.start + r.len, "end"]]) {
        el.setAttribute("aria-valuemin", "0");
        el.setAttribute("aria-valuemax", total.toFixed(3));
        el.setAttribute("aria-valuenow", t.toFixed(3));
        el.setAttribute("aria-valuetext", `${word} ${fmt(t)}`);
      }
    } else {
      $("#lenOut").textContent = `${picks().reduce((n, x) => n + clipLength(x), 0).toFixed(3)} s`;
    }
    for (const input of document.querySelectorAll("[data-key]")) {
      const key = input.dataset.key, ctl = CONTROLS[key];
      if (input.type === "checkbox") { input.checked = !!first[key]; continue; }
      if (document.activeElement !== input || !sliding) input.value = ctl.write ? ctl.write(first[key]) : first[key];
      $(`[data-for="${key}"]`).textContent = ctl.show(first[key]);
    }
  }
  queueDraw();
}

// tabs
const tabs = ["#tabClip", "#tabSound", "#tabFx"].map((s) => $(s));
const showTab = (tab) => {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
  }
  $("#applyFoot").hidden = tab === tabs[0];
};
tabs.forEach((t, i) => {
  t.onclick = () => showTab(t);
  t.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault(); e.stopPropagation();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    showTab(next); next.focus();
  });
});

// sliders and switches change every selected clip
let sliding = null;
for (const input of document.querySelectorAll("[data-key]")) {
  const key = input.dataset.key, ctl = CONTROLS[key];
  if (input.type === "checkbox") {
    input.addEventListener("change", () => commit(`${input.parentElement.textContent.trim()} ${input.checked ? "on" : "off"}.`, () => {
      for (const c of picks()) c[key] = input.checked;
    }));
    continue;
  }
  input.addEventListener("input", () => {
    if (!sliding) { halt(); sliding = snapshot(); }
    const v = ctl.read ? ctl.read(+input.value) : +input.value;
    for (const c of picks()) c[key] = v;
    relayout();
    syncAll();
  });
  input.addEventListener("change", () => {
    if (!sliding) return;
    past.push(sliding); future = []; sliding = null;
    settle();
  });
  // a double click puts a slider back
  input.addEventListener("dblclick", () => commit("Reset.", () => {
    for (const c of picks()) c[key] = DEFAULTS[key];
  }));
}

$("#normBtn").onclick = async () => {
  const list = picks();
  say("Measuring…");
  const gains = [];
  for (const c of list) gains.push(await Sound.normalGain(S, c));
  commit("Loudest point set to -1 dB.", () => list.forEach((c, i) => { c.gain = gains[i]; }));
};
$("#applyAllBtn").onclick = () => {
  const from = only() || picks()[0];
  if (!from) return;
  commit(`Settings copied to ${clips.length} clips.`, () => {
    for (const c of clips) {
      for (const key of Object.keys(DEFAULTS)) c[key] = from[key];
    }
  });
};
function duplicate() {
  const list = picks();
  if (!list.length) return;
  commit("Duplicated.", () => {
    const made = [];
    for (const c of list) {
      const copy = newClip(c.in, c.out, nextName(c.name), c);
      clips.splice(clips.indexOf(c) + 1, 0, copy);
      made.push(copy.id);
    }
    selected = new Set(made);
  });
}
$("#dupBtn").onclick = duplicate;

const nameField = $("#nameField");
function saveName() {
  const c = only(), name = Sound.cleanName(nameField.value);
  if (c && name && name !== c.name) commit(null, () => { c.name = name; });
}
nameField.addEventListener("change", saveName);
nameField.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { const c = only(); if (c) nameField.value = c.name; nameField.blur(); }
  if (e.key !== "Enter") return;
  e.preventDefault();
  saveName();
  // name, Enter, and the next sound plays, so a long list goes quickly
  const i = clips.indexOf(only());
  const next = clips[i + 1];
  if (!next) { nameField.blur(); return say("That was the last clip."); }
  select([next.id]);
  nameField.value = next.name;
  nameField.select();
  setPh(rowOf(next).start);
  keepInView(ph);
  playClip();
});
nameField.addEventListener("focus", () => nameField.select());

function commitTime(el, key) {
  const t = parseTime(el.value), err = $("#timeErr");
  err.hidden = t !== null;
  if (t === null) {
    el.setAttribute("aria-invalid", "true");
    err.textContent = "Use a time like 1:23.450 or 83.45.";
    return false;
  }
  el.removeAttribute("aria-invalid");
  const c = only();
  if (c) commit(null, () => {
    if (key === "in") c.in = clamp(t, 0, c.out - MIN_CLIP);
    else c.out = clamp(t, c.in + MIN_CLIP, S.dur);
  });
  return true;
}
for (const [id, key] of [["#startField", "in"], ["#endField", "out"]]) {
  const el = $(id);
  let fresh = false;
  el.addEventListener("focus", () => { fresh = true; });
  el.addEventListener("click", () => { if (fresh) el.select(); fresh = false; });
  el.addEventListener("change", () => commitTime(el, key));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && commitTime(el, key)) el.blur();
    if (e.key === "Escape") { el.value = fmt(only()[key]); $("#timeErr").hidden = true; el.blur(); }
  });
  el.addEventListener("blur", syncAll);
}

/* --- edits --- */
function clipUnderPlayhead() {
  const c = only();
  if (c) { const r = rowOf(c); if (ph >= r.start && ph <= r.start + r.len) return r; }
  return at(Math.min(ph, Math.max(0, total - 1e-6)));
}
function split() {
  const r = clipUnderPlayhead();
  if (!r) return;
  const c = r.c, u = ph - r.start, cut = u * c.speed;
  if (cut < MIN_CLIP || (c.out - c.in) - cut < MIN_CLIP) return say("Move the playhead inside a clip to split it.");
  commit("Split.", () => {
    const right = newClip(0, 0, nextName(c.name), c);
    if (c.reverse) { right.in = c.in; right.out = c.out - cut; c.in = c.out - cut; }
    else { right.in = c.in + cut; right.out = c.out; c.out = c.in + cut; }
    right.fadeIn = 0; c.fadeOut = 0;
    clips.splice(clips.indexOf(c) + 1, 0, right);
    selected = new Set([right.id]);
  });
}
function trimLeft() {
  const r = clipUnderPlayhead();
  if (!r) return;
  const c = r.c, cut = (ph - r.start) * c.speed;
  if (cut < MIN_CLIP || (c.out - c.in) - cut < MIN_CLIP) return say("Move the playhead inside a clip first.");
  const start = r.start;
  commit("Deleted left of the playhead.", () => {
    if (c.reverse) c.out -= cut; else c.in += cut;
    ph = start;
  });
}
function trimRight() {
  const r = clipUnderPlayhead();
  if (!r) return;
  const c = r.c, keep = (ph - r.start) * c.speed;
  if (keep < MIN_CLIP || (c.out - c.in) - keep < MIN_CLIP) return say("Move the playhead inside a clip first.");
  commit("Deleted right of the playhead.", () => {
    if (c.reverse) c.in = c.out - keep; else c.out = c.in + keep;
  });
}
function remove() {
  const gone = selected;
  if (!gone.size) return;
  const after = clips.find((c, i) => !gone.has(c.id) && i > clips.findIndex((x) => gone.has(x.id)));
  commit(gone.size === 1 ? "Clip deleted." : `${gone.size} clips deleted.`, () => {
    clips = clips.filter((c) => !gone.has(c.id));
    selected = new Set(after ? [after.id] : clips.length ? [clips[clips.length - 1].id] : []);
  });
}
function isolate(t) {
  const r = at(t);
  if (!r) return;
  const c = r.c;
  if (c.reverse) return say("Turn off Reverse on this clip to cut a sound out of it.");
  const hit = Sound.soundAround(S, sourceAt(c, t - r.start));
  if (!hit) return say("No sound near there.");
  const s = Math.max(hit.s, c.in), e = Math.min(hit.e, c.out);
  if (s - c.in < MIN_CLIP && c.out - e < MIN_CLIP) {
    select([c.id]); setPh(r.start);
    return playClip();
  }
  let mid;
  commit("Sound cut out. Name it, or press Delete.", () => {
    const from = c.in, to = c.out, fadeOut = c.fadeOut, ranges = [];
    if (s - from >= MIN_CLIP) ranges.push([from, s]);
    const midAt = ranges.length;
    ranges.push([s, e]);
    if (to - e >= MIN_CLIP) ranges.push([e, to]);
    const made = [];
    ranges.forEach(([a, b], i) => {
      if (i === 0) { c.in = a; c.out = b; made.push(c); return; }
      const piece = newClip(a, b, nextName(c.name, made), c);
      piece.fadeIn = 0;
      made.push(piece);
    });
    made.forEach((p, i) => { if (i < made.length - 1) p.fadeOut = 0; else p.fadeOut = fadeOut; });
    clips.splice(clips.indexOf(c), 1, ...made);
    mid = made[midAt];
    selected = new Set([mid.id]);
  });
  setPh(rowOf(mid).start);
  playClip();
}
function marker() {
  const near = markers.findIndex((m) => Math.abs(px(m) - px(ph)) < 5);
  commit(near >= 0 ? "Marker removed." : "Marker added.", () => {
    if (near >= 0) markers.splice(near, 1); else markers.push(ph);
  });
}
function toggleSnap() {
  snapOn = !snapOn;
  $("#snapBtn").setAttribute("aria-pressed", snapOn);
  say(snapOn ? "Snapping on." : "Snapping off.");
}
function jump(dir) {
  const i = clips.indexOf(only() || (at(ph) || {}).c);
  const next = clips[clamp(i + dir, 0, clips.length - 1)];
  if (!next) return;
  select([next.id]);
  setPh(rowOf(next).start);
  keepInView(ph);
}

function nudge(dir) {
  const list = picks();
  if (!list.length || list.length === clips.length) return;
  const rest = clips.filter((c) => !selected.has(c.id));
  const first = clips.indexOf(list[0]), to = clamp(first + dir, 0, rest.length);
  if (to === first) return;
  commit("Clip moved.", () => { rest.splice(to, 0, ...list); clips = rest; });
  keepInView(rowOf(list[0]).start);
}

$("#undoBtn").onclick = undo;
$("#redoBtn").onclick = redo;
$("#splitBtn").onclick = split;
$("#leftBtn").onclick = trimLeft;
$("#rightBtn").onclick = trimRight;
$("#deleteBtn").onclick = remove;
$("#markBtn").onclick = marker;
$("#snapBtn").onclick = toggleSnap;
$("#zoomFit").onclick = fit;
$("#zoomClip").onclick = zoomToClip;
$("#zoomRange").addEventListener("input", (e) => {
  const end = Math.max(total, MIN_SPAN), floor = Math.min(MIN_SPAN, end);
  const span = floor * Math.pow(end / floor, 1 - +e.target.value), t = clamp(ph, view.s, view.e);
  setView(t - (t - view.s) * (span / (view.e - view.s)), span);
});

/* --- playback: sound from the renderer, so it is exact; the video follows, muted --- */
let voice = null, playToken = 0;
const video = $("#video");
let seekWanted = null;
function seekVideo(t) {
  if (video.seeking) { seekWanted = t; return; }
  try { video.currentTime = t; } catch {}
}
video.addEventListener("seeked", () => {
  if (seekWanted === null) return;
  const t = seekWanted; seekWanted = null;
  video.currentTime = t;
});
function showFrame(t) {
  const r = at(Math.min(t, Math.max(0, total - 1e-6)));
  if (r) seekVideo(sourceAt(r.c, t - r.start));
}
function setPh(t) {
  ph = clamp(t, 0, total);
  showFrame(ph);
  $("#phOut").textContent = fmt(ph);
  place();
}
function setButtons() {
  const on = !!voice;
  $("#playBtn").innerHTML = (on && voice.mode === "free" ? ICON.stop + "Pause" : ICON.play + "Play") + " <kbd>Space</kbd>";
  $("#playClipBtn").innerHTML = (on && voice.mode === "clip" ? ICON.stop + "Stop" : ICON.play + "Clip") + " <kbd>S</kbd>";
}
async function play(from, to, mode) {
  halt();
  if (to - from < 0.001) return;
  const token = ++playToken;
  const parts = layout.filter((r) => r.start + r.len > from && r.start < to);
  const slow = setTimeout(() => say("Preparing…"), 200);
  const sounds = [];
  for (const r of parts) sounds.push(await Sound.render(S, r.c));
  clearTimeout(slow);
  if (token !== playToken) return;
  actx.resume();
  const t0 = actx.currentTime + 0.05;
  const nodes = parts.map((r, i) => {
    const node = actx.createBufferSource();
    node.buffer = sounds[i];
    node.connect(actx.destination);
    node.start(t0 + Math.max(0, r.start - from), Math.max(0, from - r.start), Math.min(r.start + r.len, to) - Math.max(r.start, from));
    return node;
  });
  voice = { nodes, from, to, t0, mode, row: null };
  setButtons();
  requestAnimationFrame(tick);
}
function tick() {
  if (!voice) return;
  const t = clamp(voice.from + actx.currentTime - voice.t0, voice.from, voice.to);
  ph = t;
  if (t >= voice.to) return finish();
  const r = at(t);
  if (r) {
    const want = sourceAt(r.c, t - r.start), moved = r !== voice.row;
    voice.row = r;
    if (r.c.reverse) {
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - want) > 0.12 && !video.seeking) video.currentTime = want;
    } else {
      video.playbackRate = clamp(r.c.speed, 0.25, 4);
      if (moved || Math.abs(video.currentTime - want) > 0.25) { if (!video.seeking) video.currentTime = want; }
      if (video.paused && t >= voice.from) video.play().catch(() => {});
    }
  }
  if (t > view.e) setView(t - (view.e - view.s) * 0.1, view.e - view.s);
  $("#phOut").textContent = fmt(t);
  place();
  requestAnimationFrame(tick);
}
function finish() {
  const v = voice;
  voice = null;
  video.pause();
  setPh(v.mode === "clip" ? v.from : v.to);
  setButtons();
}
function halt() {
  playToken++;
  if (!voice) return;
  const v = voice;
  voice = null;
  for (const n of v.nodes) { try { n.stop(); } catch {} }
  video.pause();
  setPh(ph);
  setButtons();
}
const togglePlay = () => { if (voice) halt(); else play(ph >= total - 0.01 ? 0 : ph, total, "free"); };
function playClip() {
  const c = only() || (at(ph) || {}).c;
  if (!c) return;
  const r = rowOf(c);
  play(r.start, r.start + r.len, "clip");
}
const toggleClip = () => { if (voice && voice.mode === "clip") halt(); else playClip(); };

$("#playBtn").onclick = togglePlay;
$("#playClipBtn").onclick = toggleClip;
$("#player").onclick = togglePlay;

/* --- the timeline by hand --- */
let drag = null;
let lastTap = { at: 0, x: 0 };

function snap(t, e, withPlayhead = true) {
  if (!snapOn || e.ctrlKey || e.metaKey) return t;
  const reach = 7 / pps();
  let best = t, d = reach;
  const test = (v) => { const g = Math.abs(v - t); if (g < d) { d = g; best = v; } };
  for (const r of layout) { test(r.start); test(r.start + r.len); }
  for (const m of markers) test(m);
  if (withPlayhead) test(ph);
  return best;
}
function trimTo(e) {
  const d = drag, c = d.c, t = snap(timeAt(e.clientX), e);
  if (d.kind === "trimEnd") {
    const go = Math.max(MIN_CLIP / c.speed, t - d.start - (clipLength(c) - playLength(c))) * c.speed;
    if (c.reverse) c.in = clamp(c.out - go, 0, c.out - MIN_CLIP);
    else c.out = clamp(c.in + go, c.in + MIN_CLIP, S.dur);
    showSource(c, playLength(c));
  } else {
    const shift = (t - d.start) * c.speed;
    if (c.reverse) c.out = clamp(d.out0 - shift, c.in + MIN_CLIP, S.dur);
    else c.in = clamp(d.in0 + shift, 0, c.out - MIN_CLIP);
    pin = { id: c.id, dt: Math.max(0, (c.reverse ? d.out0 - c.out : c.in - d.in0) / c.speed) };
    showSource(c, 0);
  }
  relayout();
  syncAll();
}
const showSource = (c, u) => seekVideo(sourceAt(c, u));

function dragTo(e) {
  if (drag.kind === "scrub") setPh(snap(timeAt(e.clientX), e, false));
  else if (drag.kind === "clip") {
    const t = timeAt(e.clientX);
    let i = layout.findIndex((r) => t < r.start + r.len / 2);
    drag.insert = i < 0 ? layout.length : i;
    queueDraw();
  } else trimTo(e);
}
function edgeWalk() {
  if (!drag) return;
  const box = mainBox.getBoundingClientRect(), span = view.e - view.s;
  const over = drag.e.clientX < box.left + 24 ? -1 : drag.e.clientX > box.right - 24 ? 1 : 0;
  if (over && drag.moved) { setView(view.s + over * span * 0.015, span); dragTo(drag.e); }
  drag.raf = requestAnimationFrame(edgeWalk);
}
function beginDrag(e, spec) {
  e.preventDefault();
  halt();
  e.currentTarget.setPointerCapture(e.pointerId);
  drag = { ...spec, x0: e.clientX, e, moved: false, el: e.currentTarget };
  drag.raf = requestAnimationFrame(edgeWalk);
}
function moveDrag(e) {
  if (!drag) return;
  drag.e = e;
  if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.before = snapshot();
    drag.el.classList.add("drag");
  }
  dragTo(e);
}
function endDrag(e) {
  if (!drag) return;
  const d = drag;
  cancelAnimationFrame(d.raf);
  d.el.classList.remove("drag");
  drag = null;
  pin = null;

  if (d.kind === "clip") {
    if (!d.moved) {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) select([d.id]);
      const again = e.timeStamp - lastTap.at < 350 && Math.abs(e.clientX - lastTap.x) < 8;
      lastTap = again ? { at: 0, x: 0 } : { at: e.timeStamp, x: e.clientX };
      if (again) isolate(timeAt(e.clientX)); else setPh(timeAt(e.clientX));
      return;
    }
    if (!selected.has(d.id)) selected = new Set([d.id]);
    const moving = picks(), head = clips.slice(0, d.insert).filter((c) => !selected.has(c.id));
    const rest = clips.filter((c) => !selected.has(c.id));
    commit("Clip moved.", () => { rest.splice(head.length, 0, ...moving); clips = rest; });
    return;
  }
  if (d.kind === "scrub") return;
  if (d.moved) {
    past.push(d.before); future = [];
    settle("Trimmed.");
    setPh(rowOf(d.c).start + (d.kind === "trimEnd" ? playLength(d.c) : 0));
  }
}
mainBox.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".handle")) return;
  const y = e.clientY - mainBox.getBoundingClientRect().top;
  const t = timeAt(e.clientX), r = y >= RULER ? at(t) : null;
  if (!r) {
    if (y >= RULER) select([]);
    beginDrag(e, { kind: "scrub" });
    setPh(snap(t, e, false));
    return;
  }
  if (e.ctrlKey || e.metaKey || e.shiftKey) pick(r.c.id, e);
  else if (!selected.has(r.c.id)) select([r.c.id]);
  beginDrag(e, { kind: "clip", id: r.c.id, insert: layout.indexOf(r) });
});
mainBox.addEventListener("pointermove", moveDrag);
mainBox.addEventListener("pointerup", endDrag);
mainBox.addEventListener("pointercancel", endDrag);

for (const [el, kind] of [[$("#hStart"), "trimStart"], [$("#hEnd"), "trimEnd"]]) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = only(), r = rowOf(c);
    beginDrag(e, { kind, c, start: r.start, in0: c.in, out0: c.out });
  });
  el.addEventListener("pointermove", moveDrag);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("keydown", (e) => {
    const unit = e.altKey ? 0.001 : e.shiftKey ? 0.1 : 0.01;
    const move = { ArrowLeft: -unit, ArrowRight: unit, ArrowDown: -unit, ArrowUp: unit }[e.key];
    if (move === undefined) return;
    e.preventDefault(); e.stopPropagation();
    const c = only();
    commit(null, () => {
      const startSide = (kind === "trimStart") !== c.reverse;
      if (startSide) c.in = clamp(c.in + move, 0, c.out - MIN_CLIP);
      else c.out = clamp(c.out + move, c.in + MIN_CLIP, S.dur);
    });
  });
}

function wheel(e) {
  e.preventDefault();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  if ((e.shiftKey || e.altKey) && !dx) { dx = dy; dy = 0; }
  const span = view.e - view.s;
  if (Math.abs(dx) > Math.abs(dy)) setView(view.s + dx / mainW * span, span);
  else zoomAt(timeAt(e.clientX), Math.exp(clamp(dy, -240, 240) * (e.ctrlKey ? 0.01 : 0.0028)));
}
mainBox.addEventListener("wheel", wheel, { passive: false });

let overDrag = false;
function overMove(e) {
  const box = overBox.getBoundingClientRect(), span = view.e - view.s;
  setView(clamp((e.clientX - box.left) / box.width, 0, 1) * total - span / 2, span);
}
overBox.addEventListener("pointerdown", (e) => { overDrag = true; overBox.setPointerCapture(e.pointerId); overMove(e); });
overBox.addEventListener("pointermove", (e) => { if (overDrag) overMove(e); });
overBox.addEventListener("pointerup", () => { overDrag = false; });
overBox.addEventListener("pointercancel", () => { overDrag = false; });
overBox.addEventListener("wheel", wheel, { passive: false });

// a mouse click on a tool button leaves the keyboard shortcuts working
document.querySelectorAll(".tool").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));

addEventListener("keydown", (e) => {
  if (!S || $("#work").hidden || document.querySelector("dialog[open]")) return;
  const t = e.target, typing = t.matches('input:not([type="range"]):not([type="checkbox"])');
  if (typing) return;
  const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (t.matches('input[type="range"]') && key.startsWith("arrow")) return;
  if (t.matches('input[type="checkbox"], button') && (key === " " || key === "enter")) return;
  if (e.repeat && !key.startsWith("arrow") && !mod) return;

  const go = mod ? {
    z: () => (e.shiftKey ? redo() : undo()),
    y: redo,
    b: split,
    a: () => select(clips.map((c) => c.id)),
    d: duplicate,
    "=": () => zoomAt(clamp(ph, view.s, view.e), 0.6),
    "+": () => zoomAt(clamp(ph, view.s, view.e), 0.6),
    "-": () => zoomAt(clamp(ph, view.s, view.e), 1.6),
  }[key] : e.altKey ? { arrowleft: () => nudge(-1), arrowright: () => nudge(1) }[key] : {
    " ": togglePlay,
    s: toggleClip,
    q: trimLeft,
    w: trimRight,
    delete: remove,
    backspace: remove,
    m: marker,
    n: toggleSnap,
    e: () => askExport(),
    z: () => (e.shiftKey ? fit() : zoomToClip()),
    home: () => { setPh(0); keepInView(0); },
    end: () => { setPh(total); keepInView(total); },
    arrowup: () => jump(-1),
    arrowdown: () => jump(1),
    arrowleft: () => { setPh(ph - (e.shiftKey ? 1 : 1 / 30)); keepInView(ph); },
    arrowright: () => { setPh(ph + (e.shiftKey ? 1 : 1 / 30)); keepInView(ph); },
    escape: () => select([]),
  }[key];
  if (go) { e.preventDefault(); go(); }
});

/* --- auto split --- */
const autoDlg = $("#autoDlg");
const autoOpts = () => ({ quiet: +$("#autoQuiet").value, gap: +$("#autoGap").value / 1000 });
const autoScope = () => (selected.size && selected.size < clips.length ? picks() : clips).filter((c) => !c.reverse);
function autoCount() {
  const opts = autoOpts();
  return autoScope().reduce((n, c) => n + Sound.sounds(S, c.in, c.out, opts).length, 0);
}
function autoShow() {
  $("#autoQuietOut").textContent = `${$("#autoQuiet").value} dB`;
  $("#autoGapOut").textContent = `${$("#autoGap").value} ms`;
  const n = autoCount();
  $("#autoHint").textContent = n ? (n === 1 ? "Finds 1 sound." : `Finds ${n} sounds.`) : "Nothing found. Move Quiet Below lower.";
  $("#autoGo").disabled = !n;
  $("#autoGo").textContent = n ? `Split Into ${n} Clips` : "Split";
}
$("#autoBtn").onclick = () => {
  halt();
  $("#autoQuiet").value = Sound.quietDb(S);
  $("#autoGap").value = 250;
  $("#autoPrefix").value = $("#autoPrefix").value || "sfx";
  autoShow();
  autoDlg.showModal();
};
$("#autoQuiet").addEventListener("input", autoShow);
$("#autoGap").addEventListener("input", autoShow);
$("#autoCancel").onclick = () => autoDlg.close();
$("#autoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const opts = autoOpts(), drop = $("#autoDrop").checked, scope = new Set(autoScope());
  const stem = Sound.cleanName($("#autoPrefix").value) || "sfx";
  let n = 0;
  const label = () => `${stem}_${String(++n).padStart(3, "0")}`;
  commit(null, () => {
    const out = [];
    for (const c of clips) {
      const found = scope.has(c) ? Sound.sounds(S, c.in, c.out, opts) : [];
      if (!found.length) { out.push(c); continue; }
      if (drop) {
        for (const f of found) out.push(newClip(f.s, f.e, label(), { ...c, fadeIn: 0, fadeOut: 0 }));
      } else {
        // keep everything, and cut halfway through each silence
        found.forEach((f, i) => {
          const a = i ? (found[i - 1].e + f.s) / 2 : c.in, b = i < found.length - 1 ? (f.e + found[i + 1].s) / 2 : c.out;
          out.push(newClip(a, b, label(), { ...c, fadeIn: 0, fadeOut: 0 }));
        });
      }
    }
    clips = out;
    selected = new Set(clips.length ? [clips[0].id] : []);
  });
  autoDlg.close();
  ph = 0;
  fit();
  setPh(0);
  say(`${n} clips. Name one, press Enter, and the next one plays.`);
  showTab(tabs[0]);
  drawOver();
});

/* --- export --- */
const exportDlg = $("#exportDlg"), exName = $("#exName"), exHint = $("#exHint");
const remember = {
  get() { try { return localStorage.getItem("audio-cut-format"); } catch { return null; } },
  set(v) { try { localStorage.setItem("audio-cut-format", v); } catch {} },
};
const mp3Radio = document.querySelector('input[name="fmt"][value="mp3"]');
if (!window.lamejs) mp3Radio.disabled = true;
else if (remember.get() === "mp3") mp3Radio.checked = true;
const modeEach = () => document.querySelector('input[name="exmode"]:checked').value === "each";
const exportRows = () => ($("#exSel").checked ? layout.filter((r) => selected.has(r.c.id)) : layout);

function exportShow() {
  const rows = exportRows(), many = rows.length > 1, each = many && modeEach();
  $("#exMode").hidden = !many;
  exName.hidden = false;
  exName.setAttribute("aria-label", each ? "Folder name" : "File name");
  const fmt = document.querySelector('input[name="fmt"]:checked').value;
  exHint.className = "hint";
  exHint.textContent = each ? `${rows.length} clips in one .zip, each with its own name.` : many ? `${rows.length} clips joined in order.` : "";
  $("#exSelRow").hidden = !selected.size || selected.size === clips.length;
  $("#exSelText").textContent = selected.size === 1 ? "Only the Selected Clip" : `Only the ${selected.size} Selected Clips`;
  $("#exSave").textContent = each ? "Download .zip" : `Download .${fmt}`;
}
function askExport() {
  if (!clips.length) return;
  halt();
  $("#exSel").checked = selected.size > 0 && selected.size < clips.length;
  const one = only();
  exName.value = $("#exSel").checked && one ? one.name : S.file.name.replace(/\.\w+$/, "");
  exportShow();
  exportDlg.showModal();
  exName.select();
}
$("#exportBtn").onclick = askExport;
$("#exCancel").onclick = () => exportDlg.close();
$("#exSel").addEventListener("change", exportShow);
for (const r of document.querySelectorAll('#exportForm input[type="radio"]')) r.addEventListener("change", exportShow);
exportDlg.addEventListener("cancel", (e) => { if ($("#exSave").disabled) e.preventDefault(); });
exName.addEventListener("input", exportShow);

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const encode = (format, chans) => (format === "mp3" ? Sound.mp3(chans) : Sound.wav(chans));

$("#exportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const base = Sound.cleanName(exName.value);
  if (!base) { exHint.textContent = "Type a name first."; exHint.className = "hint bad"; exName.focus(); return; }
  const format = document.querySelector('input[name="fmt"]:checked').value;
  const rows = exportRows(), each = rows.length > 1 && modeEach();
  const save = $("#exSave"), cancel = $("#exCancel");
  save.disabled = cancel.disabled = true;
  exHint.textContent = "Making the file…"; exHint.className = "hint";
  await new Promise((r) => setTimeout(r));
  try {
    let name;
    if (each) {
      const entries = [], used = new Set();
      for (let i = 0; i < rows.length; i++) {
        exHint.textContent = `Making clip ${i + 1} of ${rows.length}…`;
        await new Promise((r) => setTimeout(r));
        const sound = await Sound.render(S, rows[i].c);
        let label = rows[i].c.name, n = 2;
        while (used.has(label)) label = `${rows[i].c.name}_${n++}`;
        used.add(label);
        entries.push({ name: `${label}.${format}`, data: await encode(format, Sound.channelsOf([sound])) });
      }
      name = `${base}.zip`;
      saveBlob(Sound.zip(entries), name);
    } else {
      const sounds = [];
      for (const r of rows) sounds.push(await Sound.render(S, r.c));
      const bytes = await encode(format, Sound.channelsOf(sounds));
      name = `${base}.${format}`;
      saveBlob(new Blob([bytes], { type: format === "mp3" ? "audio/mpeg" : "audio/wav" }), name);
    }
    remember.set(format);
    exportDlg.close();
    say(`Downloaded ${name}.`);
  } catch (err) {
    exHint.textContent = "That file could not be made. Try the other format.";
    exHint.className = "hint bad";
  }
  save.disabled = cancel.disabled = false;
});

/* --- keys --- */
$("#keysBtn").onclick = () => $("#keysDlg").showModal();
$("#keysClose").onclick = () => $("#keysDlg").close();

setButtons();
})();
