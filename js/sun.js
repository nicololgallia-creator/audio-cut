/* Audio Cut: the first screen. A sun made of waveform bars, rising behind a
   planet's edge. The horizon is a string: a moving hand plucks it, and the
   pulse runs both ways along it. */
(() => {
"use strict";
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const cv = document.querySelector("#sun"), c = cv.getContext("2d");
let w, h, dpr, step, n, hz, R, cx, arc, hgt, vel, raf = 0, ptr = null, wake = 0, wakeTo = 0, time = 0;

function size() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  w = innerWidth; h = innerHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  step = w < 600 ? 5 : 6;
  n = Math.ceil(w / step) + 1;
  hz = h * 0.64; cx = w / 2;
  R = Math.min(w * 0.3, h * 0.34);
  const rP = Math.max(w * 1.5, 900);
  arc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = i * step - cx;
    arc[i] = hz + rP - Math.sqrt(rP * rP - dx * dx);
  }
  hgt = new Float32Array(n); vel = new Float32Array(n);
  for (let i = 0; i < n; i++) hgt[i] = rest(i);
  if (reduced.matches) paint();
}
function rest(i) {
  const x = (i * step - cx) / R;
  if (Math.abs(x) >= 1) return 0;
  const ripple = reduced.matches ? 1 : 0.84 + 0.16 * Math.sin(i * 0.21 + time * 1.1) * Math.sin(i * 0.047 - time * 0.6);
  return Math.sqrt(1 - x * x) * R * 0.62 * ripple * (1 + wake * 0.55);
}
function paint() {
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = c.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, "#0E0D16"); sky.addColorStop(0.55, "#120F1A"); sky.addColorStop(1, "#2C1624");
  c.fillStyle = sky; c.fillRect(0, 0, w, h);

  const heat = c.createLinearGradient(0, hz, 0, hz - R * 0.95);
  heat.addColorStop(0, "#FDEBC8"); heat.addColorStop(0.3, "#F8C870");
  heat.addColorStop(0.62, "#F06B3C"); heat.addColorStop(1, "#6A2A38");
  c.fillStyle = heat;
  c.beginPath();
  const ceiling = hz - 60;
  for (let i = 0; i < n; i++) {
    const t = Math.min(Math.max(0, hgt[i]), ceiling);
    if (t > 0.5) c.rect(i * step, arc[i] - t, step - 3, t + 2);
  }
  c.fill();

  c.fillStyle = "#0B0A0E";
  c.beginPath(); c.moveTo(0, arc[0]);
  for (let i = 1; i < n; i++) c.lineTo(i * step, arc[i]);
  c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill();

  const rim = c.createLinearGradient(0, 0, w, 0);
  rim.addColorStop(0, "rgba(240,107,60,0)"); rim.addColorStop(0.3, "rgba(240,107,60,.55)");
  rim.addColorStop(0.5, "rgba(253,235,200,.95)");
  rim.addColorStop(0.7, "rgba(240,107,60,.55)"); rim.addColorStop(1, "rgba(240,107,60,0)");
  c.strokeStyle = rim; c.lineWidth = 1.25;
  c.beginPath(); c.moveTo(0, arc[0]);
  for (let i = 1; i < n; i++) c.lineTo(i * step, arc[i]);
  c.stroke();
}
function frame() {
  raf = requestAnimationFrame(frame);
  time += 1 / 60;
  wake += (wakeTo - wake) * 0.07;
  for (let i = 0; i < n; i++) {
    const l = hgt[i ? i - 1 : 0], r = hgt[i < n - 1 ? i + 1 : i];
    vel[i] += 0.016 * (rest(i) - hgt[i]) + 0.2 * (l + r - 2 * hgt[i]) - 0.055 * vel[i];
  }
  for (let i = 0; i < n; i++) hgt[i] += vel[i];
  paint();
}
function pluck(x, force, spread) {
  const mid = x / step, reach = Math.ceil(spread * 2.5 / step);
  for (let i = Math.max(0, Math.floor(mid - reach)); i < Math.min(n, mid + reach); i++) {
    const d = (i - mid) * step;
    vel[i] += force * Math.exp(-d * d / (2 * spread * spread)) * (0.55 + Math.random() * 0.45);
  }
}
cv.addEventListener("pointermove", (e) => {
  if (reduced.matches) return;
  if (ptr) pluck(e.clientX, Math.min(Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y), 60) * 0.26, 34);
  ptr = { x: e.clientX, y: e.clientY };
});
cv.addEventListener("pointerdown", (e) => { if (!reduced.matches) pluck(e.clientX, 26, 22); });
addEventListener("resize", () => { if (!document.querySelector("#empty").hidden) size(); });

window.Sun = {
  start() {
    if (hgt === undefined) size();
    if (reduced.matches) { paint(); return; }
    if (!raf) frame();
  },
  stop() { cancelAnimationFrame(raf); raf = 0; },
  wake(on) {
    wakeTo = on ? 1 : 0;
    if (reduced.matches) { wake = wakeTo; for (let i = 0; i < n; i++) hgt[i] = rest(i); paint(); }
  },
};
window.Sun.start();
document.addEventListener("visibilitychange", () => {
  if (!document.querySelector("#empty").hidden) document.hidden ? window.Sun.stop() : window.Sun.start();
});
})();
