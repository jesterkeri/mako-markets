// Assemble the Mako Market master HyperFrames project from the four style projects.
// node build/gen.mjs  (run from anywhere)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const M = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AD = path.resolve(M, "..");

// id, project, film start, duration (SHOTS.md + CHANGES-v2.md)
const SHOTS = [
  ["01", "macro", 0, 2], ["02", "macro", 2, 1.5], ["03", "flap", 3.5, 1.5], ["04", "glass", 5, 2],
  ["05", "flap", 7, 1], ["06", "flap", 8, 1], ["07", "flap", 9, 1], ["08", "flap", 10, 0.5],
  ["09", "flap", 10.5, 0.5], ["10", "flap", 11, 0.5], ["11", "flap", 11.5, 1.5], ["12", "glass", 13, 2],
  ["13", "glass", 15, 1.5], ["14", "expl", 16.5, 1.5], ["15", "glass", 18, 1.5], ["16", "glass", 19.5, 1.5],
  ["17", "flap", 21, 1], ["18", "expl", 22, 2], ["19", "expl", 24, 2.5], ["21", "expl", 26.5, 1.5],
  ["22", "macro", 28, 1.5], ["23", "glass", 29.5, 2.5], ["24", "flap", 32, 1.5], ["25", "expl", 33.5, 1.5],
  ["26", "glass", 35, 1.5], ["27", "flap", 36.5, 1.5], ["28", "macro", 38, 2], ["29", "expl", 40, 2],
  ["30", "glass", 42, 1.5], ["31", "flap", 43.5, 2.5], ["32", "flap", 46, 1.5], ["33", "glass", 47.5, 1.5],
  ["34", "macro", 49, 2], ["35", "expl", 51, 1.5], ["36", "glass", 52.5, 1.5], ["37", "macro", 54, 2],
  ["38", "flap", 56, 2.5], ["39", "glass", 58.5, 1.5],
];
// seam index i = between SHOTS[i] and SHOTS[i+1]: [incoming pre-roll (frozen at local 0), outgoing hold]
const SEAM = [
  [0.1, 0.2], [0, 0], [0.05, 0.05], [0.1, 0.1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
  [0.2, 0.3], [0, 0], [0.05, 0.05], [0.25, 0.25], [0.25, 0.25], [0, 0], [0, 0], [0, 0], [0.15, 0.15],
  [0.18, 0.18], [0.3, 0.3], [0, 0], [0.2, 0.3], [0.06, 0.06], [0.05, 0.05], [0, 0], [0.25, 0.2],
  [0.15, 0.15], [0, 0], [0.2, 0.2], [0, 0], [0.2, 0.2], [0, 0], [0, 0], [0, 0], [0.3, 0.3], [0.3, 0.3],
];
if (SEAM.length !== SHOTS.length - 1) throw new Error("seam count");

const r3 = (x) => Math.round(x * 1000) / 1000;
const plan = SHOTS.map(([id, proj, start, dur], i) => {
  const pre = i > 0 ? SEAM[i - 1][0] : 0;
  const post = i < SHOTS.length - 1 ? SEAM[i][1] : 0;
  return { id: "s" + id, proj, start, dur, pre, post, hs: r3(start - pre), hd: r3(pre + dur + post) };
});

// ---- copy assets (identical shared files collapse) ----
function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !fs.readFileSync(src).equals(fs.readFileSync(dst))) throw new Error("asset collision " + dst);
  fs.copyFileSync(src, dst);
}
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p); }
  return out;
}
for (const proj of ["flap", "macro", "glass", "expl"]) {
  const A = path.join(AD, proj, "assets");
  for (const f of walk(A)) cp(f, path.join(M, "assets", path.relative(A, f)));
}

// ---- copy + patch compositions ----
fs.mkdirSync(path.join(M, "compositions"), { recursive: true });
for (const p of plan) {
  let h = fs.readFileSync(path.join(AD, p.proj, "compositions", p.id + ".html"), "utf8");
  // registration -> optional pre-roll wrapper (holds local 0 for `pre` seconds so the shot's beats stay on the film clock)
  const re = /window\.__timelines\[(ID|"s\d\d")\]\s*=\s*tl;/g;
  const n = (h.match(re) || []).length;
  if (n !== 1) throw new Error(p.id + " registration count " + n);
  h = h.replace(re, (m, k) => `window.__timelines[${k}] = window.__hfPre(${k}, tl);`);
  // sub-root duration covers pre-roll + shot + hold
  const rootRe = new RegExp(`(data-composition-id="${p.id}"[^>]*?data-duration=")([0-9.]+)(")`);
  if (!rootRe.test(h)) throw new Error(p.id + " root duration");
  h = h.replace(rootRe, (m, a, d, b) => {
    if (Math.abs(parseFloat(d) - p.dur) > 1e-6) throw new Error(p.id + " dur mismatch " + d);
    return a + p.hd + b;
  });
  fs.writeFileSync(path.join(M, "compositions", p.id + ".html"), h);
}

// ---- index.html ----
const PRE = Object.fromEntries(plan.filter((p) => p.pre > 0).map((p) => [p.id, p.pre]));
const hosts = plan.map((p, i) =>
  `    <div id="el-${p.id}" class="clip shot" data-composition-id="${p.id}" data-composition-src="compositions/${p.id}.html" data-start="${p.hs}" data-duration="${p.hd}" data-track-index="${i % 2}" data-width="1920" data-height="1080" style="z-index:${10 + i}"></div>`
).join("\n");

// grid dissolve cells 16 x 9, ripple from centre; 5 palette colours cycled
const GC = ["#FACC15", "#EBE5D9", "#121212", "#D6CFBE", "#06B6D4"];
let cells = "", delays = [];
for (let r = 0; r < 9; r++) for (let c = 0; c < 16; c++) {
  const k = r * 16 + c, cx = c * 120 + 60, cy = r * 120 + 60;
  const d = Math.hypot(cx - 960, cy - 540) / Math.hypot(960, 540);
  delays.push(r3(d * 0.11));
  cells += `<i class="gc" style="left:${c * 120}px;top:${r * 120}px;background:${GC[(r * 3 + c) % 5]}"></i>`;
}
let hb = "", vb = "";
for (let i = 0; i < 8; i++) hb += `<i id="hb-${i}" class="hb" style="top:${i * 135}px;background:${i % 2 ? "#EBE5D9" : "#FACC15"}"></i>`;
for (let i = 0; i < 12; i++) vb += `<i id="vb-${i}" class="vb" style="left:${i * 160}px;background:${i % 4 === 3 ? "#FACC15" : i % 2 ? "#1c1c1c" : "#121212"}"></i>`;

const fx = fs.readFileSync(path.join(M, "build", "fx.js"), "utf8");
const DUR = 60;
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Mako Market ad (master)</title>
    <!-- Generated by build/gen.mjs from the four style projects (flap, macro, glass, expl). Edit build/*, then rebuild. -->
    <script src="assets/gsap.min.js"></script>
    <script>
      // Pre-roll: an incoming shot that starts early for a transition holds its local-0 frame until its own film start.
      window.__HF_PRE = ${JSON.stringify(PRE)};
      window.__hfPre = function (id, tl) {
        var pre = window.__HF_PRE[id] || 0;
        if (!pre) return tl;
        var outer = gsap["time" + "line"]({ paused: true }); // wrapper around the shot timeline; the shot registers it
        outer.add(tl, pre);
        tl.paused(false);
        return outer;
      };
      window.__gcDelay = ${JSON.stringify(delays)};
    </script>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #root > .shot { position: absolute; inset: 0; overflow: hidden; }
      #fx-bg { position: absolute; inset: 0; z-index: 0; background: #000; }
      .fx { position: absolute; pointer-events: none; }
      .fx-full { left: 0; top: 0; width: 1920px; height: 1080px; }
      #fx-svg { position: absolute; width: 0; height: 0; overflow: hidden; }
      #fx-glbar { left: 0; top: 140px; width: 1920px; height: 34px; z-index: 1000; opacity: 0; background: repeating-linear-gradient(90deg, rgba(250,204,21,.9) 0 220px, rgba(237,230,214,.75) 220px 300px, rgba(0,0,0,0) 300px 520px); }
      #lk-warm { z-index: 1000; opacity: 0; background: #FACC15; mix-blend-mode: screen; }
      #lk-1, #lk-2 { z-index: 1001; width: 2600px; height: 2600px; opacity: 0; mix-blend-mode: screen; }
      #lk-1 { left: -340px; top: -900px; background: radial-gradient(closest-side, rgba(255,250,232,1) 0%, rgba(250,204,21,.95) 28%, rgba(250,204,21,.45) 58%, rgba(250,204,21,0) 100%); }
      #lk-2 { left: -60px; top: -260px; background: radial-gradient(closest-side, rgba(250,204,21,.9) 0%, rgba(250,204,21,.35) 55%, rgba(250,204,21,0) 100%); }
      #sh-top, #sh-bot { left: 0; width: 1920px; height: 541px; z-index: 1000; background: #0b0b0b; }
      #sh-top { top: 0; } #sh-bot { top: 539px; }
      #sh-top i, #sh-bot i { position: absolute; left: 0; width: 1920px; height: 3px; background: #FACC15; }
      #sh-top i { bottom: 0; } #sh-bot i { top: 0; }
      #fx-ring { z-index: 1000; border: 6px solid #FACC15; border-radius: 50%; box-sizing: border-box; opacity: 0; left: 0; top: 0; width: 0; height: 0; }
      #fx-wash, #fx-dip, #fx-flash, #fx-white { z-index: 1000; opacity: 0; }
      #fx-dip { background: #EBE5D9; } #fx-flash, #fx-white { background: #FFFFFF; } #fx-wash { background: #D6CFBE; }
      .bk { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      #bk-1 { z-index: 1000; background: #FACC15; } #bk-2 { z-index: 1001; background: #EBE5D9; } #bk-3 { z-index: 1002; background: #FACC15; }
      .hb { position: absolute; left: 0; width: 1920px; height: 136px; z-index: 1000; display: block; }
      .vb { position: absolute; top: 0; width: 161px; height: 1080px; z-index: 1000; display: block; }
      .gc { position: absolute; width: 120px; height: 120px; z-index: 1000; display: block; }
      #fx-ov { z-index: 1000; }
      #bn-a, #bn-b, #bn-c { z-index: 1000; width: 2800px; height: 2800px; top: -860px; opacity: 0; }
      #bn-a { left: 600px; background: radial-gradient(closest-side, rgba(250,204,21,1) 0%, rgba(250,204,21,.92) 45%, rgba(250,204,21,0) 100%); }
      #bn-b { left: 400px; background: radial-gradient(closest-side, rgba(255,251,240,1) 0%, rgba(255,246,214,.95) 40%, rgba(250,204,21,0) 100%); }
      #bn-c { left: 900px; background: radial-gradient(closest-side, rgba(235,229,217,1) 0%, rgba(235,229,217,.85) 40%, rgba(235,229,217,0) 100%); }
      #fx-hand { z-index: 1001; left: 958px; top: -760px; width: 4px; height: 1300px; background: linear-gradient(180deg, rgba(250,204,21,0) 0%, #FACC15 30%, #FACC15 100%); transform-origin: 50% 100%; opacity: 0; }
      #fx-morph { z-index: 1000; left: 900px; top: 480px; width: 120px; height: 120px; border-radius: 50%; background: #FACC15; }
      #fx-scan { z-index: 1000; opacity: 0; background: repeating-linear-gradient(180deg, rgba(0,0,0,.55) 0 2px, rgba(0,0,0,0) 2px 5px); }
      #fx-vband { z-index: 1001; left: 0; top: 0; width: 1920px; height: 120px; opacity: 0; background: linear-gradient(180deg, rgba(237,230,214,0) 0%, rgba(237,230,214,.6) 45%, rgba(255,255,255,.85) 52%, rgba(237,230,214,0) 100%); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="${DUR}">
    <div id="fx-bg"></div>
${hosts}
    <svg id="fx-svg" aria-hidden="true">
      <defs>
        <filter id="fx-glitch" x="-5%" y="0%" width="110%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence id="gl-turb" type="fractalNoise" baseFrequency="0.00001 0.03" numOctaves="1" seed="3" result="n" />
          <feComponentTransfer in="n" result="blk"><feFuncR type="discrete" tableValues="0.5 0.5 0.18 0.5 0.86 0.5 0.5 0.3 0.5 0.7 0.5" /><feFuncG type="linear" slope="0" intercept="0.5" /></feComponentTransfer>
          <feDisplacementMap id="gl-disp" in="SourceGraphic" in2="blk" scale="0" xChannelSelector="R" yChannelSelector="G" result="d" />
          <feColorMatrix in="d" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset id="gl-or" in="r" dx="0" dy="0" result="r2" />
          <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feOffset id="gl-ob" in="b" dx="0" dy="0" result="b2" />
          <feComposite in="r2" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
          <feComposite in="rg" in2="b2" operator="arithmetic" k2="1" k3="1" />
        </filter>
        <filter id="fx-hblur" x="-25%" y="0%" width="150%" height="100%" color-interpolation-filters="sRGB">
          <feGaussianBlur id="wp-blur" in="SourceGraphic" stdDeviation="0 0" edgeMode="duplicate" />
        </filter>
        <filter id="fx-dw" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0026 0.0038" numOctaves="3" seed="11" result="n" />
          <feDisplacementMap id="dw-disp" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" result="w" />
          <feColorMatrix id="dw-m1" in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  30 0 0 0 -27" result="m" />
          <feComposite in="w" in2="m" operator="in" result="cut" />
          <feColorMatrix id="dw-m2" in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  30 0 0 0 -26.5" result="m2" />
          <feComposite in="m2" in2="m" operator="out" result="edge" />
          <feFlood flood-color="#FACC15" flood-opacity="1" result="y" />
          <feComposite in="y" in2="edge" operator="in" result="ye" />
          <feGaussianBlur in="ye" stdDeviation="2.5" result="yg" />
          <feMerge><feMergeNode in="yg" /><feMergeNode in="cut" /><feMergeNode in="ye" /></feMerge>
        </filter>
        <filter id="fx-dwo" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0026 0.0038" numOctaves="3" seed="11" result="n" />
          <feDisplacementMap id="dwo-disp" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="fx-ca-a" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feImage class="ca-map" preserveAspectRatio="none" x="0" y="0" width="1920" height="1080" result="map" />
          <feDisplacementMap id="ca-r-a" in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="dr" />
          <feDisplacementMap id="ca-b-a" in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="db" />
          <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
          <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" />
        </filter>
        <filter id="fx-ca-b" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feImage class="ca-map" preserveAspectRatio="none" x="0" y="0" width="1920" height="1080" result="map" />
          <feDisplacementMap id="ca-r-b" in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="dr" />
          <feDisplacementMap id="ca-b-b" in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="db" />
          <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
          <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" />
        </filter>
        <filter id="fx-vhs" x="-5%" y="0%" width="110%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence id="vh-turb" type="fractalNoise" baseFrequency="0.00001 0.021" numOctaves="2" seed="20" result="n" />
          <feComponentTransfer in="n" result="nx"><feFuncG type="linear" slope="0" intercept="0.5" /></feComponentTransfer>
          <feDisplacementMap id="vh-disp" in="SourceGraphic" in2="nx" scale="0" xChannelSelector="R" yChannelSelector="G" result="d" />
          <feColorMatrix in="d" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset id="vh-or" in="r" dx="0" dy="0" result="r2" />
          <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="d" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feOffset id="vh-ob" in="b" dx="0" dy="0" result="b2" />
          <feComposite in="r2" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
          <feComposite in="rg" in2="b2" operator="arithmetic" k2="1" k3="1" />
        </filter>
        <filter id="fx-xwa" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0019 0.0024" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap id="xw-a" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="fx-xwb" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0019 0.0024" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap id="xw-b" in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
    <div id="fx-ov" class="fx fx-full">
      <i id="fx-glbar" class="fx"></i>
      <div id="lk-warm" class="fx fx-full"></div><div id="lk-1" class="fx"></div><div id="lk-2" class="fx"></div>
      <div id="sh-top" class="fx"><i></i></div><div id="sh-bot" class="fx"><i></i></div>
      <div id="fx-ring" class="fx"></div>
      <svg class="fx fx-full" style="z-index:1001" viewBox="0 0 1920 1080"><line id="fx-diag" x1="0" y1="0" x2="0" y2="0" stroke="#FACC15" stroke-width="5" opacity="0" /><polygon id="fx-diamond" points="960,540 960,540 960,540 960,540" fill="none" stroke="#FACC15" stroke-width="7" opacity="0" /></svg>
      <div id="fx-wash" class="fx fx-full"></div>
      <i id="bk-1" class="bk"></i><i id="bk-2" class="bk"></i><i id="bk-3" class="bk"></i>
      <div id="fx-dip" class="fx fx-full"></div>
      <div id="fx-flash" class="fx fx-full"></div>
      ${hb}
      ${cells}
      <div id="bn-a" class="fx"></div><div id="bn-b" class="fx"></div><div id="bn-c" class="fx"></div>
      <div id="fx-hand" class="fx"></div>
      <div id="fx-morph" class="fx"></div>
      <div id="fx-scan" class="fx fx-full"></div><div id="fx-vband" class="fx"></div>
      ${vb}
      <div id="fx-white" class="fx fx-full"></div>
    </div>
    </div>
    <script>
      // radial displacement map for the chromatic radial split (R = x offset, G = y offset from centre)
      (function () {
        var w = 480, h = 270, c = document.createElement("canvas");
        c.width = w; c.height = h;
        var x = c.getContext("2d"), d = x.createImageData(w, h);
        for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
          var u = (i + 0.5) / w - 0.5, v = (j + 0.5) / h - 0.5, k = (j * w + i) * 4;
          d.data[k] = Math.round(255 * (0.5 + u * 0.9)); d.data[k + 1] = Math.round(255 * (0.5 + v * 0.9));
          d.data[k + 2] = 128; d.data[k + 3] = 255;
        }
        x.putImageData(d, 0, 0);
        var url = c.toDataURL("image/png");
        document.querySelectorAll(".ca-map").forEach(function (e) { e.setAttribute("href", url); });
      })();
${fx}
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(M, "index.html"), html);
for (const f of ["hyperframes.json", "package.json"]) cp(path.join(AD, "glass", f), path.join(M, f));
fs.writeFileSync(path.join(M, "meta.json"), JSON.stringify({ id: "mako-master", name: "mako-master" }));
fs.writeFileSync(path.join(M, "build", "plan.json"), JSON.stringify(plan, null, 1));
console.log("ok", plan.length, "shots");
