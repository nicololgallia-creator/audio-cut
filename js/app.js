/* Audio Cut: the editor. The waveform is always the whole recording, and a clip
   is a stretch of it you have marked, plus its settings. Cutting means dragging
   across a sound. Nothing is ever chopped or moved, so undo is cheap. */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const { SR, clamp, clipLength, playLength, sourceAt } = Sound;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const touch = matchMedia("(pointer: coarse)").matches;

const MIN_CLIP = 0.01;   // shortest clip, in seconds
const MIN_SPAN = 0.05;   // tightest zoom, in seconds
const RULER = 24;

const ICON = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1l9 5-9 5z"/></svg>',
  stop: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2h3v8H2zM7 2h3v8H7z"/></svg>',
};
const DEFAULTS = { gain: 0, fadeIn: 0, fadeOut: 0, speed: 1, reverse: false, denoise: false, lowCut: Sound.OFF_LOW, highCut: Sound.OFF_HIGH, reverb: 0 };

let S = null;              // the open recording: decoded audio, tables, thumbnails
let clips = [];            // every marked stretch, in list order
let markers = [];          // seconds
let selected = new Set();  // clip ids
let view = { s: 0, e: 1 }; // what the waveform shows
let ph = 0;                // playhead, in seconds
let snapOn = true;
let past = [], future = [];
let nextId = 1;
let actx = null;
let reveal = 1;            // 0 to 1 while the waveform first draws in
let loadToken = 0;
let saveKey = null;
let lastName = "sfx_000";  // the next clip counts up from this

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
const newClip = (a, b, name, from) => ({ ...DEFAULTS, ...from, id: nextId++, in: a, out: b, name, draft: false });
const byId = (id) => clips.find((c) => c.id === id);
const only = () => (selected.size === 1 ? byId([...selected][0]) : null);
const picks = () => clips.filter((c) => selected.has(c.id));
const draftOf = () => clips.find((c) => c.draft);

function clipAt(t) {
  const on = only();
  if (on && t >= on.in && t < on.out) return on;
  for (let i = clips.length - 1; i >= 0; i--) if (t >= clips[i].in && t < clips[i].out) return clips[i];
  return null;
}
function placeByTime(c) {
  clips = clips.filter((x) => x !== c);
  const i = clips.findIndex((x) => x.in > c.in);
  clips.splice(i < 0 ? clips.length : i, 0, c);
}
// the selection you are still working on: dragging again moves it instead of adding one
function setDraft(a, b) {
  let d = draftOf();
  if (d) { d.in = a; d.out = b; }
  else {
    d = newClip(a, b, nextName(lastName), {});
    d.draft = true;
  }
  placeByTime(d);
  selected = new Set([d.id]);
  return d;
}

function nextName(like, also = []) {
  const m = like.match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : `${like}_`, width = m ? m[2].length : 3;
  let top = m ? +m[2] : 0;
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

  saveKey = `audio-cut:v2:${file.name}:${file.size}:${file.lastModified}`;
  past = []; future = []; markers = []; ph = 0; selected = new Set(); clips = []; lastName = "sfx_000";
  let back = null;
  try { back = localStorage.getItem(saveKey); } catch {}
  if (back) {
    try { past.push(snapshot()); restore(back); } catch { past = []; }
  }
  view = { s: 0, e: S.dur };
  $("#fileName").textContent = file.name;
  $("#fileFacts").textContent = `${fmt(S.dur, false)}  ${SR / 1000} kHz  ${S.buffer.numberOfChannels > 1 ? "stereo" : "mono"}`;
  document.title = `${file.name} | Audio Cut`;
  showState("work");
  size();
  setView(0, S.dur);
  settle(back ? "Your clips from last time are back. Ctrl+Z clears them." : `${touch ? "Drag" : "Drag"} across a sound to select it, then ${touch ? "tap Extract Audio" : "press E"}.`);
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
let waveTop = 80;          // where the frames end and the waveform begins

const pps = () => mainW / (view.e - view.s);
const px = (t) => (t - view.s) * pps();
const timeAt = (clientX) => clamp(view.s + (clientX - mainBox.getBoundingClientRect().left) / pps(), 0, S.dur);

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

// the height a clip's settings give it at one moment, so fades and volume show
function shape(c, t) {
  const play = playLength(c), u = (c.reverse ? c.out - t : t - c.in) / c.speed;
  let k = clamp(Math.pow(10, c.gain / 20), 0, 2);
  if (c.fadeIn > 0 && u < c.fadeIn) k *= Math.max(0, u) / c.fadeIn;
  if (c.fadeOut > 0 && play - u < c.fadeOut) k *= Math.max(0, play - u) / c.fadeOut;
  return k;
}

function film(c, top, height, w) {
  const T = S.thumbs;
  c.fillStyle = "#131118";
  c.fillRect(0, top, w, height);
  if (!T) return;
  const tile = height * T.tw / T.th, perSec = pps();
  const offset = view.s * perSec, first = Math.floor(offset / tile) * tile - offset;
  for (let x = first; x < w; x += tile) {
    const t = view.s + (x + tile / 2) / perSec;
    let i = clamp(Math.floor(t / S.dur * T.n), 0, T.n - 1);
    while (i > 0 && !T.ready[i]) i--;
    if (T.ready[i]) c.drawImage(T.atlas, (i % T.cols) * T.tw, Math.floor(i / T.cols) * T.th, T.tw, T.th, x, top, tile, height);
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
  const filmH = clamp(Math.round(height * 0.24), 22, 46);
  waveTop = top + filmH + 2;
  const waveH = h - waveTop - 2;
  film(c, top, filmH, w);

  // bands behind the sound
  for (const clip of clips) {
    const x1 = px(clip.in), x2 = px(clip.out);
    if (x2 < 0 || x1 > w) continue;
    const on = selected.has(clip.id);
    c.fillStyle = on ? "rgba(248,200,112,.1)" : "rgba(240,232,220,.055)";
    c.fillRect(x1, waveTop, x2 - x1, waveH);
    if (on) { c.fillStyle = "rgba(248,200,112,.28)"; c.fillRect(x1, top, x2 - x1, filmH); }
    else { c.fillStyle = "#4A4250"; c.fillRect(x1, waveTop, 1, waveH); c.fillRect(x2 - 1, waveTop, 1, waveH); }
  }

  // who owns each column of the waveform, with the selection on top
  const span = view.e - view.s, stepPx = span < 1 ? 2 : 3, barPx = span < 1 ? 1 : 2;
  const cols = Math.ceil(w / stepPx) + 1, owner = new Int32Array(cols).fill(-1);
  const mark = (clip, i) => {
    const a = Math.max(0, Math.floor(px(clip.in) / stepPx)), b = Math.min(cols - 1, Math.floor(px(clip.out) / stepPx));
    for (let j = a; j <= b; j++) owner[j] = i;
  };
  clips.forEach((clip, i) => { if (!selected.has(clip.id)) mark(clip, i); });
  clips.forEach((clip, i) => { if (selected.has(clip.id)) mark(clip, i); });

  const quiet = new Path2D(), kept = new Path2D(), hot = new Path2D();
  const mid = waveTop + waveH / 2, half = waveH / 2 - 1, spp = stepPx / perSec * SR, limit = w * reveal;
  for (let i = 0; i < cols && i * stepPx < limit; i++) {
    const x = i * stepPx, t = view.s + x / perSec;
    const a = Math.max(0, Math.floor(t * SR)), b = Math.min(S.mono.length, Math.ceil(a + spp));
    if (b <= a) continue;
    Sound.scan(S, a, b, spp, pair);
    const own = owner[i] >= 0 ? clips[owner[i]] : null;
    const k = own ? shape(own, t) : 1;
    const y1 = clamp(mid - curve(pair[1]) * half * k, waveTop, waveTop + waveH);
    const y2 = clamp(mid - curve(pair[0]) * half * k, waveTop, waveTop + waveH);
    (own ? (selected.has(own.id) ? hot : kept) : quiet).rect(x, y1, barPx, Math.max(1, y2 - y1));
  }
  c.fillStyle = "#8A8078"; c.fill(quiet);
  c.fillStyle = "#F0E8DC"; c.fill(kept);
  c.fillStyle = "#F8C870"; c.fill(hot);

  // names, drawn last so nothing covers them
  c.textBaseline = "top";
  const rows = [];
  for (const clip of clips) {
    const x1 = px(clip.in), x2 = px(clip.out), bw = x2 - x1;
    if (x2 < 0 || x1 > w || bw < 44) continue;
    const tags = (clip.speed !== 1 ? ` ${clip.speed.toFixed(2)}x` : "") + (clip.reverse ? " rev" : "");
    const label = clip.name + tags, x = Math.max(x1, 0) + 6, tw = c.measureText(label).width;
    let row = 0;
    while (rows[row] > x) row++;
    rows[row] = x + tw + 10;
    const y = waveTop + 4 + row * 21;
    c.save();
    c.beginPath(); c.rect(x1, waveTop, bw, waveH); c.clip();
    c.fillStyle = "rgba(11,10,14,.74)";
    c.fillRect(x - 3, y, tw + 6, 18);
    c.fillStyle = selected.has(clip.id) ? "#F8C870" : "#F0E8DC";
    c.fillText(label, x, y + 3);
    c.restore();
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
    if (!S) return;
    const c = oc, path = new Path2D(), spp = 2 * S.dur / overW * SR, mid = overH / 2, half = overH / 2 - 1;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, overW, overH);
    for (let x = 0; x < overW; x += 2) {
      const a = Math.floor(x / overW * S.dur * SR), b = Math.min(S.mono.length, Math.ceil(a + spp));
      if (b <= a) continue;
      Sound.scan(S, a, b, spp, pair);
      const y1 = mid - curve(pair[1]) * half, y2 = mid - curve(pair[0]) * half;
      path.rect(x, y1, 1, Math.max(1, y2 - y1));
    }
    c.fillStyle = "#6E6660"; c.fill(path);
    const perSec = overW / S.dur;
    for (const clip of clips) {
      c.fillStyle = selected.has(clip.id) ? "#F8C870" : "#F0E8DC";
      c.fillRect(clip.in * perSec, overH - 3, Math.max(2, (clip.out - clip.in) * perSec), 3);
    }
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
    const a = px(c.in), b = px(c.out);
    hS.style.transform = `translateX(${a}px)`;
    hE.style.transform = `translateX(${b}px)`;
    hS.style.visibility = onScreen(a) ? "" : "hidden";
    hE.style.visibility = onScreen(b) ? "" : "hidden";
  }
  $("#ovWin").style.cssText = `left:${view.s / S.dur * 100}%;width:${Math.max(0.4, (view.e - view.s) / S.dur * 100)}%`;
  $("#ovPh").style.left = `${ph / S.dur * 100}%`;
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
  const end = S.dur, floor = Math.min(MIN_SPAN, end);
  span = clamp(span, floor, end);
  s = clamp(s, 0, end - span);
  view = { s, e: s + span };
  $("#zoomRange").value = 1 - Math.log(span / floor) / (Math.log(end / floor) || 1);
  queueDraw();
}
function zoomAt(t, factor) {
  const span = view.e - view.s, next = clamp(span * factor, Math.min(MIN_SPAN, S.dur), S.dur);
  setView(t - (t - view.s) * (next / span), next);
}
const fit = () => setView(0, S.dur);
function keepInView(t) {
  const span = view.e - view.s;
  if (t < view.s || t > view.e) setView(t - span * 0.1, span);
}
function zoomToSel() {
  const c = only() || picks()[0];
  if (!c) return;
  const len = c.out - c.in, pad = Math.max(len * 0.25, 0.02);
  setView(c.in - pad, len + pad * 2);
}

/* --- the clip list and inspector --- */
const list = $("#clipList");
function buildList() {
  list.textContent = "";
  for (const c of clips) {
    const li = document.createElement("li"), row = document.createElement("button");
    const name = document.createElement("span"), len = document.createElement("span");
    row.className = "row"; row.type = "button"; row.dataset.id = c.id;
    row.setAttribute("aria-current", selected.has(c.id));
    name.textContent = c.name;
    name.translate = false;
    len.textContent = `${clipLength(c).toFixed(2)} s`;
    row.append(name, len); li.append(row); list.append(li);
  }
  $("#binCount").textContent = clips.length === 1 ? "1 clip" : `${clips.length} clips`;
  $("#totalOut").textContent = `/ ${fmt(S.dur)}`;
}
function select(ids) {
  selected = new Set(ids);
  syncAll();
  drawOver();
  for (const li of list.children) {
    const b = li.firstChild, on = selected.has(+b.dataset.id);
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

// a row can be clicked to select it, or dragged to change the order clips join in
let rowDrag = null;
list.addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".row");
  if (!row || e.button !== 0) return;
  rowDrag = { id: +row.dataset.id, y: e.clientY, moved: false, target: null, end: false, pointer: e.pointerId };
});
list.addEventListener("pointermove", (e) => {
  if (!rowDrag) return;
  if (!rowDrag.moved) {
    if (Math.abs(e.clientY - rowDrag.y) < 6) return;
    rowDrag.moved = true;
    list.setPointerCapture(rowDrag.pointer);
  }
  list.querySelectorAll(".into, .into-end").forEach((r) => r.classList.remove("into", "into-end"));
  const rows = [...list.querySelectorAll(".row")];
  let target = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  rowDrag.end = !target;
  if (!target) target = rows[rows.length - 1];
  rowDrag.target = +target.dataset.id;
  target.classList.add(rowDrag.end ? "into-end" : "into");
});
list.addEventListener("pointerup", (e) => {
  const d = rowDrag;
  rowDrag = null;
  if (!d) return;
  list.querySelectorAll(".into, .into-end").forEach((r) => r.classList.remove("into", "into-end"));
  if (d.moved) {
    if (d.target === d.id) return;
    commit("Clip moved.", () => {
      const c = byId(d.id), rest = clips.filter((x) => x !== c);
      const at = rest.findIndex((x) => x.id === d.target);
      rest.splice(d.end ? rest.length : at, 0, c);
      clips = rest;
    });
    return;
  }
  pick(d.id, e);
  const c = byId(d.id);
  if (c && selected.has(c.id)) { setPh(c.in); keepInView(c.in); }
});
list.addEventListener("pointercancel", () => { rowDrag = null; });
list.addEventListener("dblclick", (e) => { if (e.target.closest(".row")) playClip(); });
list.addEventListener("click", (e) => e.preventDefault());

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

let sliding = null;
function syncAll() {
  const c = only(), first = c || picks()[0], some = !!first;
  $("#noneMsg").hidden = some;
  $("#panelBody").hidden = !some;
  $("#noneMsg").textContent = "Drag across the waveform to select a sound.";
  $("#splitBtn").disabled = !c;
  $("#deleteBtn").disabled = !some;
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
    $("#extractBtn").hidden = !c;
    if (c) {
      if (document.activeElement !== startF) { startF.value = fmt(c.in); startF.removeAttribute("aria-invalid"); }
      if (document.activeElement !== endF) { endF.value = fmt(c.out); endF.removeAttribute("aria-invalid"); }
      $("#lenOut").textContent = `${clipLength(c).toFixed(3)} s`;
      for (const [el, t, word] of [[$("#hStart"), c.in, "start"], [$("#hEnd"), c.out, "end"]]) {
        el.setAttribute("aria-valuemin", "0");
        el.setAttribute("aria-valuemax", S.dur.toFixed(3));
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
  const chosen = picks();
  say("Measuring…");
  const gains = [];
  for (const c of chosen) gains.push(await Sound.normalGain(S, c));
  commit("Loudest point set to -1 dB.", () => chosen.forEach((c, i) => { c.gain = gains[i]; }));
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
  const chosen = picks();
  if (!chosen.length) return;
  commit("Duplicated. Change its settings to make a variation.", () => {
    const made = [];
    for (const c of chosen) {
      const copy = newClip(c.in, c.out, nextName(c.name, made), c);
      c.draft = false;
      clips.splice(clips.indexOf(c) + 1, 0, copy);
      made.push(copy);
    }
    selected = new Set(made.map((c) => c.id));
  });
}
$("#dupBtn").onclick = duplicate;

const nameField = $("#nameField");
function saveName() {
  const c = only(), name = Sound.cleanName(nameField.value);
  if (!c || !name) return;
  if (name !== c.name || c.draft) commit(null, () => { c.name = name; c.draft = false; });
  lastName = name;
}
nameField.addEventListener("change", saveName);
nameField.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { const c = only(); if (c) nameField.value = c.name; nameField.blur(); }
  if (e.key !== "Enter") return;
  e.preventDefault();
  saveName();
  // name, Enter, and the next sound plays, so a long list goes quickly
  const next = clips[clips.indexOf(only()) + 1];
  if (!next) { nameField.blur(); return say("That was the last clip."); }
  select([next.id]);
  nameField.value = next.name;
  nameField.select();
  setPh(next.in);
  keepInView(next.in);
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
  if (!c || Math.abs(c[key] - t) < 0.0005) return true;
  commit(null, () => {
    if (key === "in") c.in = clamp(t, 0, c.out - MIN_CLIP);
    else c.out = clamp(t, c.in + MIN_CLIP, S.dur);
  });
  setPh(c[key]);
  keepInView(c[key]);
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
function setEdge(key) {
  const c = only();
  if (!c) {
    const a = key === "in" ? ph : Math.max(0, ph - 1), b = key === "in" ? Math.min(S.dur, ph + 1) : ph;
    if (b - a < MIN_CLIP) return;
    return commit("Selection made. Press E to extract it.", () => setDraft(a, b));
  }
  if (key === "in" ? ph >= c.out - MIN_CLIP : ph <= c.in + MIN_CLIP) return say("Move the playhead inside the selection first.");
  commit(key === "in" ? "Start set." : "End set.", () => { c[key] = ph; });
}
function split() {
  const c = only() || clipAt(ph);
  if (!c) return say("Select something to split first.");
  if (ph - c.in < MIN_CLIP || c.out - ph < MIN_CLIP) return say("Move the playhead inside the selection to split it.");
  commit("Split.", () => {
    const right = newClip(ph, c.out, nextName(c.name), { ...c, fadeIn: 0 });
    c.out = ph; c.fadeOut = 0; c.draft = false;
    clips.splice(clips.indexOf(c) + 1, 0, right);
    selected = new Set([right.id]);
  });
}
function remove() {
  const gone = selected;
  if (!gone.size) return;
  const after = clips.find((c, i) => !gone.has(c.id) && i > clips.findIndex((x) => gone.has(x.id)));
  commit(gone.size === 1 ? "Deleted. The recording is untouched." : `${gone.size} clips deleted. The recording is untouched.`, () => {
    clips = clips.filter((c) => !gone.has(c.id));
    selected = new Set(after ? [after.id] : []);
  });
}
// double click takes the whole sound under the pointer
function pickSound(t) {
  const there = clipAt(t);
  if (there) { select([there.id]); setPh(there.in); return playClip(); }
  const hit = Sound.soundAround(S, t);
  if (!hit) return say("No sound near there.");
  commit(touch ? "Sound selected." : "Sound selected. Press E to extract it.", () => setDraft(hit.s, hit.e));
  setPh(hit.s);
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
  if (!clips.length) return;
  const i = clips.indexOf(only());
  const next = clips[i < 0 ? 0 : clamp(i + dir, 0, clips.length - 1)];
  select([next.id]);
  setPh(next.in);
  keepInView(next.in);
}
function nudge(dir) {
  const c = only();
  if (!c) return;
  const i = clips.indexOf(c), to = clamp(i + dir, 0, clips.length - 1);
  if (to === i) return;
  commit("Clip moved.", () => { clips.splice(i, 1); clips.splice(to, 0, c); });
}

$("#undoBtn").onclick = undo;
$("#redoBtn").onclick = redo;
$("#leftBtn").onclick = () => setEdge("in");
$("#rightBtn").onclick = () => setEdge("out");
$("#splitBtn").onclick = split;
$("#deleteBtn").onclick = remove;
$("#markBtn").onclick = marker;
$("#snapBtn").onclick = toggleSnap;
$("#zoomFit").onclick = fit;
$("#zoomClip").onclick = zoomToSel;
$("#zoomRange").addEventListener("input", (e) => {
  const floor = Math.min(MIN_SPAN, S.dur), span = floor * Math.pow(S.dur / floor, 1 - +e.target.value);
  const t = clamp(ph, view.s, view.e);
  setView(t - (t - view.s) * (span / (view.e - view.s)), span);
});

/* --- playback: sound from Web Audio, so it is exact; the video follows, muted --- */
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
function setPh(t) {
  ph = clamp(t, 0, S.dur);
  seekVideo(ph);
  $("#phOut").textContent = fmt(ph);
  place();
}
function setButtons() {
  const on = !!voice;
  $("#playBtn").innerHTML = (on && voice.mode === "free" ? ICON.stop + "Pause" : ICON.play + "Play") + " <kbd>Space</kbd>";
  $("#playClipBtn").innerHTML = (on && voice.mode === "clip" ? ICON.stop + "Stop" : ICON.play + "Selection") + " <kbd>S</kbd>";
}
function start(buffer, offset, spec) {
  actx.resume();
  const node = actx.createBufferSource();
  node.buffer = buffer;
  node.connect(actx.destination);
  const t0 = actx.currentTime + 0.05;
  node.start(t0, offset);
  voice = { node, t0, ...spec };
  setButtons();
  requestAnimationFrame(tick);
}
function playFree() {
  halt();
  const from = ph >= S.dur - 0.01 ? 0 : ph;
  video.playbackRate = 1;
  seekVideo(from);
  video.play().catch(() => {});
  start(S.buffer, from, { mode: "free", from, to: S.dur });
}
async function playClip() {
  const c = only() || clipAt(ph);
  if (!c) return;
  halt();
  const token = ++playToken;
  const slow = setTimeout(() => say("Preparing…"), 200);
  const sound = await Sound.render(S, c);
  clearTimeout(slow);
  if (token !== playToken) return;
  start(sound, 0, { mode: "clip", c, to: sound.duration });
}
function tick() {
  if (!voice) return;
  const u = actx.currentTime - voice.t0;
  if (voice.mode === "free") {
    ph = clamp(voice.from + u, 0, S.dur);
    if (ph >= voice.to) return finish();
    if (Math.abs(video.currentTime - ph) > 0.25 && !video.seeking) video.currentTime = ph;
  } else {
    if (u >= voice.to) return finish();
    const c = voice.c;
    ph = sourceAt(c, Math.max(0, u));
    if (c.reverse) {
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - ph) > 0.12 && !video.seeking) video.currentTime = ph;
    } else {
      video.playbackRate = clamp(c.speed, 0.25, 4);
      if (Math.abs(video.currentTime - ph) > 0.25 && !video.seeking) video.currentTime = ph;
      if (video.paused) video.play().catch(() => {});
    }
  }
  if (ph > view.e) setView(ph - (view.e - view.s) * 0.1, view.e - view.s);
  $("#phOut").textContent = fmt(ph);
  place();
  requestAnimationFrame(tick);
}
function finish() {
  const v = voice;
  voice = null;
  video.pause();
  setPh(v.mode === "clip" ? v.c.in : v.to);
  setButtons();
}
function halt() {
  playToken++;
  if (!voice) return;
  const v = voice;
  voice = null;
  try { v.node.stop(); } catch {}
  video.pause();
  setPh(ph);
  setButtons();
}
const togglePlay = () => { if (voice) halt(); else playFree(); };
const toggleClip = () => { if (voice && voice.mode === "clip") halt(); else playClip(); };

$("#playBtn").onclick = togglePlay;
$("#playClipBtn").onclick = toggleClip;
$("#player").onclick = togglePlay;

/* --- the waveform by hand --- */
let drag = null;
let lastTap = { at: 0, x: 0 };

function snap(t, e, skip) {
  if (!snapOn || e.ctrlKey || e.metaKey) return t;
  const reach = 7 / pps();
  let best = t, d = reach;
  const test = (v) => { const g = Math.abs(v - t); if (g < d) { d = g; best = v; } };
  for (const c of clips) if (c !== skip) { test(c.in); test(c.out); }
  for (const m of markers) test(m);
  if (skip !== undefined) test(ph);
  return best;
}
function dragTo(e) {
  const d = drag, t = timeAt(e.clientX);
  if (d.kind === "scrub") setPh(snap(t, e));
  else if (d.kind === "paint") {
    const b = snap(t, e, draftOf() || null), lo = Math.min(d.anchor, b), hi = Math.max(d.anchor, b);
    if (hi - lo >= MIN_CLIP) { setDraft(lo, hi); seekVideo(b); syncAll(); }
  } else if (d.kind === "start") {
    d.c.in = clamp(snap(t, e, d.c), 0, d.c.out - MIN_CLIP);
    seekVideo(d.c.in); syncAll();
  } else {
    d.c.out = clamp(snap(t, e, d.c), d.c.in + MIN_CLIP, S.dur);
    seekVideo(d.c.out); syncAll();
  }
}
// holding past the edge walks the view along
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

  if (d.kind === "scrub") return;
  if (d.kind === "paint" && !d.moved) {
    const t = timeAt(e.clientX);
    const again = e.timeStamp - lastTap.at < 350 && Math.abs(e.clientX - lastTap.x) < 8;
    lastTap = again ? { at: 0, x: 0 } : { at: e.timeStamp, x: e.clientX };
    if (again) return pickSound(t);
    const c = clipAt(t);
    if (e.ctrlKey || e.metaKey || e.shiftKey) { if (c) pick(c.id, e); }
    else select(c ? [c.id] : []);
    setPh(t);
    return;
  }
  if (!d.moved) return;
  past.push(d.before); future = [];
  if (d.kind === "paint") {
    const c = only();
    settle(touch ? "Selected. Tap Extract Audio, or drag again to replace it." : "Selected. Press E to extract it, or drag again to replace it.");
    select([c.id]);
    setPh(c.in);
    return;
  }
  settle("Trimmed.");
  setPh(d.kind === "start" ? d.c.in : d.c.out);
}
mainBox.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".handle")) return;
  const y = e.clientY - mainBox.getBoundingClientRect().top;
  if (y < waveTop) {
    beginDrag(e, { kind: "scrub" });
    setPh(snap(timeAt(e.clientX), e));
    return;
  }
  beginDrag(e, { kind: "paint", anchor: snap(timeAt(e.clientX), e, draftOf() || null) });
});
mainBox.addEventListener("pointermove", moveDrag);
mainBox.addEventListener("pointerup", endDrag);
mainBox.addEventListener("pointercancel", endDrag);

for (const [el, kind, key] of [[$("#hStart"), "start", "in"], [$("#hEnd"), "end", "out"]]) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    beginDrag(e, { kind, c: only() });
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
      if (key === "in") c.in = clamp(c.in + move, 0, c.out - MIN_CLIP);
      else c.out = clamp(c.out + move, c.in + MIN_CLIP, S.dur);
    });
    seekVideo(c[key]);
    keepInView(c[key]);
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
  setView(clamp((e.clientX - box.left) / box.width, 0, 1) * S.dur - span / 2, span);
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
  }[key] : e.altKey ? { arrowup: () => nudge(-1), arrowdown: () => nudge(1) }[key] : {
    " ": togglePlay,
    s: toggleClip,
    i: () => setEdge("in"),
    o: () => setEdge("out"),
    q: () => setEdge("in"),
    w: () => setEdge("out"),
    delete: remove,
    backspace: remove,
    m: marker,
    n: toggleSnap,
    e: () => (only() ? askExtract() : askAll()),
    z: () => (e.shiftKey ? fit() : zoomToSel()),
    home: () => { setPh(0); keepInView(0); },
    end: () => { setPh(S.dur); keepInView(S.dur); },
    arrowup: () => jump(-1),
    arrowdown: () => jump(1),
    arrowleft: () => { setPh(ph - (e.shiftKey ? 1 : 1 / 30)); keepInView(ph); },
    arrowright: () => { setPh(ph + (e.shiftKey ? 1 : 1 / 30)); keepInView(ph); },
    escape: () => select([]),
  }[key];
  if (go) { e.preventDefault(); go(); }
});

/* --- auto split: marks every sound, and never touches a clip you already have --- */
const autoDlg = $("#autoDlg");
const autoOpts = () => ({ quiet: +$("#autoQuiet").value, gap: +$("#autoGap").value / 1000 });
function autoFound() {
  const kept = clips.filter((c) => !c.draft);
  return Sound.sounds(S, 0, S.dur, autoOpts()).filter((f) => !kept.some((c) => c.in < f.e && c.out > f.s));
}
function autoShow() {
  $("#autoQuietOut").textContent = `${$("#autoQuiet").value} dB`;
  $("#autoGapOut").textContent = `${$("#autoGap").value} ms`;
  const n = autoFound().length;
  $("#autoHint").textContent = n ? (n === 1 ? "Finds 1 sound." : `Finds ${n} sounds.`) : "Nothing new found. Move Quiet Below lower.";
  $("#autoGo").disabled = !n;
  $("#autoGo").textContent = n ? `Mark ${n} Sounds` : "Mark";
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
  const found = autoFound(), stem = Sound.cleanName($("#autoPrefix").value) || "sfx";
  commit(null, () => {
    clips = clips.filter((c) => !c.draft);
    const made = [];
    for (const f of found) {
      const c = newClip(f.s, f.e, nextName(`${stem}_000`, made), {});
      made.push(c);
      placeByTime(c);
    }
    selected = new Set(clips.length ? [clips[0].id] : []);
    lastName = made[made.length - 1].name;
  });
  autoDlg.close();
  fit();
  if (clips[0]) setPh(clips[0].in);
  say(`${found.length} sounds marked. Name one, press Enter, and the next one plays.`);
  showTab(tabs[0]);
  drawOver();
});

/* --- extract and export --- */
const exportDlg = $("#exportDlg"), exName = $("#exName"), exHint = $("#exHint");
let extracting = null;   // the one clip being extracted, or null when exporting several
const remember = {
  get() { try { return localStorage.getItem("audio-cut-format"); } catch { return null; } },
  set(v) { try { localStorage.setItem("audio-cut-format", v); } catch {} },
};
const mp3Radio = document.querySelector('input[name="fmt"][value="mp3"]');
if (!window.lamejs) mp3Radio.disabled = true;
else if (remember.get() === "mp3") mp3Radio.checked = true;
const modeEach = () => document.querySelector('input[name="exmode"]:checked').value === "each";
const chosenFormat = () => document.querySelector('input[name="fmt"]:checked').value;
const exportRows = () => ($("#exSel").checked ? picks() : clips);

function exportShow() {
  const format = chosenFormat();
  if (extracting) {
    $("#exTitle").textContent = "Name this clip";
    $("#exMode").hidden = true;
    $("#exSelRow").hidden = true;
    exHint.className = "hint"; exHint.textContent = "";
    $("#exSave").textContent = `Download .${format}`;
    return;
  }
  const rows = exportRows(), many = rows.length > 1, each = many && modeEach();
  $("#exTitle").textContent = "Export audio";
  $("#exMode").hidden = !many;
  exName.setAttribute("aria-label", each ? "Folder name" : "File name");
  exHint.className = "hint";
  exHint.textContent = !rows.length ? "No clips yet, so this exports the whole recording." : each ? `${rows.length} clips in one .zip, each with its own name.` : many ? `${rows.length} clips joined in list order.` : "";
  $("#exSelRow").hidden = !selected.size || selected.size === clips.length;
  $("#exSelText").textContent = selected.size === 1 ? "Only the Selected Clip" : `Only the ${selected.size} Selected Clips`;
  $("#exSave").textContent = each ? "Download .zip" : `Download .${format}`;
}
function askExtract() {
  const c = only();
  if (!c) return;
  halt();
  extracting = c;
  exName.value = c.name;
  exportShow();
  exportDlg.showModal();
  exName.select();
}
function askAll() {
  halt();
  extracting = null;
  $("#exSel").checked = selected.size > 1 && selected.size < clips.length;
  exName.value = S.file.name.replace(/\.\w+$/, "");
  exportShow();
  exportDlg.showModal();
  exName.select();
}
$("#extractBtn").onclick = askExtract;
$("#exportBtn").onclick = askAll;
$("#exCancel").onclick = () => exportDlg.close();
$("#exSel").addEventListener("change", exportShow);
for (const r of document.querySelectorAll('#exportForm input[type="radio"]')) r.addEventListener("change", exportShow);
exportDlg.addEventListener("cancel", (e) => { if ($("#exSave").disabled) e.preventDefault(); });
exName.addEventListener("input", () => { if (!extracting) exportShow(); else { exHint.textContent = ""; exHint.className = "hint"; } });

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const encode = (format, chans) => (format === "mp3" ? Sound.mp3(chans) : Sound.wav(chans));
const mime = (format) => (format === "mp3" ? "audio/mpeg" : "audio/wav");

$("#exportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const base = Sound.cleanName(exName.value);
  if (!base) { exHint.textContent = "Type a name first."; exHint.className = "hint bad"; exName.focus(); return; }
  const format = chosenFormat(), save = $("#exSave"), cancel = $("#exCancel");
  save.disabled = cancel.disabled = true;
  exHint.textContent = "Making the file…"; exHint.className = "hint";
  await new Promise((r) => setTimeout(r));
  try {
    let name, rows = extracting ? [extracting] : exportRows();
    if (!rows.length) rows = [newClip(0, S.dur, base, {})];
    if (rows.length > 1 && modeEach() && !extracting) {
      const entries = [], used = new Set();
      for (let i = 0; i < rows.length; i++) {
        exHint.textContent = `Making clip ${i + 1} of ${rows.length}…`;
        await new Promise((r) => setTimeout(r));
        const sound = await Sound.render(S, rows[i]);
        let label = rows[i].name, n = 2;
        while (used.has(label)) label = `${rows[i].name}_${n++}`;
        used.add(label);
        entries.push({ name: `${label}.${format}`, data: await encode(format, Sound.channelsOf([sound])) });
      }
      name = `${base}.zip`;
      saveBlob(Sound.zip(entries), name);
    } else {
      const sounds = [];
      for (const c of rows) sounds.push(await Sound.render(S, c));
      const bytes = await encode(format, Sound.channelsOf(sounds));
      name = `${base}.${format}`;
      saveBlob(new Blob([bytes], { type: mime(format) }), name);
    }
    remember.set(format);
    const done = extracting;
    exportDlg.close();
    if (done) {
      commit(null, () => { done.name = base; done.draft = false; });
      lastName = base;
    }
    say(done ? `Downloaded ${name}. Drag across the next sound.` : `Downloaded ${name}.`);
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
