// Generates the FLAP (Departures Board) shot sub-compositions + index.html.
// Each compositions/sNN.html is self-contained (styles, markup, engine inside <template>);
// it only needs the global gsap (loaded by the host) and assets/fonts/*.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const P = join(dirname(fileURLToPath(import.meta.url)), "..");

// Continuous push across the 05-10 flip sequence (film 7.0 to 11.5), so the cuts read as one board.
const seqCam = (start, end) => {
  const s = (t) => +(1.045 - (0.045 * (t - 7.0)) / 4.5).toFixed(4);
  return [s(start), s(end), "none"];
};

const CAT = { CRYPTO: 0, FOOTBALL: 1, NBA: 2, FOREX: 3, COMMODITIES: 4, STOCKS: 5 };

// Category board (05-10): one huge row, identical in every shot.
const catRow = (init, text, o) => ({
  cells: 11, cw: 142, gap: 10, init,
  seq: [[0, text]],
  flipDur: o.fd, stagger: o.st, maxWalk: o.mw,
});
const catShot = (id, start, dur, prev, word, o) => ({
  id, start, dur, key: start + (dur < 1 ? 0.4 : 0.7), label: "CATEGORY", cam: seqCam(start, start + dur),
  rows: [catRow(prev || "scramble", word, o)],
  ticker: prev ? [[0, [CAT[prev]]], [o.lit, [CAT[word]]]] : [[0, []], [o.lit, [CAT[word]]]],
});
const beat = { fd: 0.05, st: 0.016, mw: 5, lit: 0.3 };
const half = { fd: 0.036, st: 0.01, mw: 3, lit: 0.2 };

export const SHOTS = [
  {
    id: "s03", start: 3.5, dur: 1.5, key: 4.7, label: "MARKET", right: "YOUR CALL",
    rows: [{ cells: 14, cw: 112, gap: 8, init: "scramble", seq: [[0, "BET YES OR NO.", "....YYY....NN."]], flipDur: 0.05, stagger: 0.03, maxWalk: 7 }],
  },
  catShot("s05", 7.0, 1.0, null, "CRYPTO", beat),
  catShot("s06", 8.0, 1.0, "CRYPTO", "FOOTBALL", beat),
  catShot("s07", 9.0, 1.0, "FOOTBALL", "NBA", beat),
  catShot("s08", 10.0, 0.5, "NBA", "FOREX", half),
  catShot("s09", 10.5, 0.5, "FOREX", "COMMODITIES", half),
  catShot("s10", 11.0, 0.5, "COMMODITIES", "STOCKS", half),
  {
    id: "s11", start: 11.5, dur: 1.5, key: 12.8, label: "MARKET", right: "YOUR CALL", rowGap: 24,
    rows: [
      { cells: 11, cw: 124, gap: 10, init: "STOCKS", seq: [[0.04, "YES OR NO", "YYY....NN"]], flipDur: 0.045, atOnce: true, maxWalk: 11 },
      { cells: 11, cw: 124, gap: 10, init: "", seq: [[0.04, "ON ANYTHING"]], flipDur: 0.045, atOnce: true, maxWalk: 11 },
    ],
    ticker: [[0, [5]], [0.62, [0, 1, 2, 3, 4, 5]]],
  },
  {
    id: "s17", start: 21.0, dur: 1.0, key: 21.7, label: "STATUS",
    rows: [{ cells: 15, cw: 104, gap: 8, init: "scramble", seq: [[0, "BET IN SECONDS."]], flipDur: 0.034, stagger: 0.012, maxWalk: 6 }],
  },
  {
    id: "s24", start: 32.0, dur: 1.5, key: 33.2, label: "PAYOUT", rowGap: 24,
    rows: [
      { cells: 13, cw: 118, gap: 8, init: "scramble", seq: [[0, "WINNERS SPLIT", "YYYYYYY......"]], flipDur: 0.05, stagger: 0.022, maxWalk: 6 },
      { cells: 13, cw: 118, gap: 8, init: "scramble", seq: [[0.22, "THE POOL."]], flipDur: 0.05, stagger: 0.022, maxWalk: 6 },
    ],
  },
  {
    id: "s27", start: 36.5, dur: 1.5, key: 37.7, label: "REFUNDS", rowGap: 24,
    rows: [
      { cells: 14, cw: 112, gap: 8, init: "scramble", seq: [[0, "ONE SIDE ONLY?"]], flipDur: 0.05, stagger: 0.02, maxWalk: 6 },
      { cells: 14, cw: 112, gap: 8, init: "scramble", seq: [[0.24, "FULL REFUND.", ".....CCCCCC."]], flipDur: 0.05, stagger: 0.022, maxWalk: 7 },
    ],
  },
  {
    id: "s31", start: 43.5, dur: 2.5, key: 45.4, label: "HOSTS", rowGap: 26,
    rows: [
      { cells: 10, cw: 140, gap: 10, init: "scramble", seq: [[0, "HOSTS EARN"]], flipDur: 0.055, stagger: 0.03, maxWalk: 7 },
      { cells: 10, cw: 140, gap: 10, init: "scramble", seq: [[0.45, "UP TO 2%.", "......YY."]], flipDur: 0.055, stagger: 0.03, maxWalk: 8 },
    ],
  },
  {
    id: "s32", start: 46.0, dur: 1.5, key: 47.2, label: "ROUNDS", rowGap: 26,
    rows: [
      { cells: 11, cw: 120, gap: 8, init: "HOSTS EARN", seq: [[0.02, ""], [0.3, "NEW: ROUNDS", "YYYY......."]], flipDur: 0.04, stagger: 0.012, maxWalk: 5 },
      { cells: 19, cw: 82, gap: 6, init: "UP TO 2%.", initTint: "......YY.", seq: [[0.05, ""], [0.38, "15 MIN. UP OR DOWN.", "........YY....NNNN."]], flipDur: 0.04, stagger: 0.012, maxWalk: 5 },
    ],
  },
  {
    id: "s38", start: 56.0, dur: 2.5, key: 57.8, label: "NEXT", right: "YOUR CALL", rowGap: 30,
    rows: [
      { cells: 18, cw: 86, gap: 8, init: "scramble", seq: [[0, "WHAT HAPPENS NEXT?"]], flipDur: 0.05, stagger: 0.026, maxWalk: 7 },
      { cells: 18, cw: 86, gap: 8, init: "scramble", seq: [[0.55, "MAKOMARKET.XYZ", "YYYYYYYYYYYYYY"]], flipDur: 0.05, stagger: 0.026, maxWalk: 7 },
    ],
  },
];

const FONTS = `
@font-face{font-family:"Bricolage Grotesque Variable";font-style:normal;font-weight:200 800;src:url("assets/fonts/captured-bricolage-grotesque-latin-wght-normal.0hh3pksc_dt39.woff2") format("woff2-variations")}
@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;src:url("assets/fonts/captured-inter-latin-wght-normal.055ydel_y7o6i.woff2") format("woff2-variations")}
@font-face{font-family:"JetBrains Mono";font-weight:100 800;src:url("assets/fonts/jbmono-latin.woff2") format("woff2")}`;

const LOGO = "M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z";

function css(id) {
  const R = `#${id}-root`;
  return `${FONTS}
${R}{position:absolute;inset:0;overflow:hidden;background:#030303;font-family:"Inter Variable",sans-serif;color:#EDE6D6}
${R} .fx-bg{position:absolute;inset:0;background:radial-gradient(80% 60% at 50% 46%,#141414 0%,#080808 55%,#020202 100%)}
${R} .fx-cam{position:absolute;inset:0}
${R} .fx-glow{position:absolute;left:0;top:0;width:1920px;height:1080px}
${R} .fx-housing{position:absolute;left:84px;width:1752px;border-radius:18px;background:linear-gradient(180deg,#0d0d0d,#090909);box-shadow:inset 0 0 0 1px rgba(237,230,214,.07),0 40px 80px rgba(0,0,0,.6)}
${R} .fx-rivet{position:absolute;width:8px;height:8px;border-radius:50%;background:#1d1d1d;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
${R} .fx-lab{position:absolute;font:600 17px "JetBrains Mono",monospace;letter-spacing:.24em;text-transform:uppercase;color:#7f7b72;white-space:nowrap}
${R} .fx-call{color:#FACC15}
${R} .fx-dot{position:absolute;width:9px;height:9px;border-radius:50%;background:#FACC15;box-shadow:0 0 14px rgba(250,204,21,.8)}
${R} .fx-hdr{position:absolute;left:96px;top:86px;display:flex;align-items:center;gap:18px}
${R} .fx-hdr svg{width:58px;height:45px;display:block}
${R} .fx-word{font:800 40px "Bricolage Grotesque Variable",sans-serif;letter-spacing:-.01em;color:#EDE6D6;white-space:nowrap}
${R} .fx-rule{position:absolute;left:96px;right:96px;height:1px;background:rgba(237,230,214,.09)}
${R} .fx-tick{position:absolute;left:96px;top:930px;display:flex;gap:44px;font:600 22px "JetBrains Mono",monospace;letter-spacing:.16em;white-space:nowrap}
${R} .fx-tick span{color:#7b7871}
${R} .fx-foot{right:96px;top:934px;color:#8a857a;text-transform:lowercase}
${R} .sf-row{position:absolute;height:0}
${R} .sf-cell{position:absolute;top:0;perspective:900px;border-radius:7px;background:#070707;box-shadow:0 14px 26px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.045)}
${R} .sf-face{position:absolute;left:0;width:100%;height:50%;overflow:hidden;background:linear-gradient(180deg,var(--ft) 0%,var(--fm) 100%)}
${R} .sf-top,${R} .sf-la{top:0;border-radius:7px 7px 0 0}
${R} .sf-bot,${R} .sf-lb{top:50%;border-radius:0 0 7px 7px;background:linear-gradient(180deg,var(--fb) 0%,var(--fm2) 100%)}
${R} .sf-la{transform-origin:50% 100%;z-index:3;backface-visibility:hidden}
${R} .sf-lb{transform-origin:50% 0%;z-index:3;backface-visibility:hidden}
${R} .sf-glyph{position:absolute;left:0;width:100%;display:block;text-align:center;font-family:"JetBrains Mono",ui-monospace,monospace;font-weight:700;color:var(--gc);white-space:pre}
${R} .sf-seam{position:absolute;left:0;top:50%;width:100%;height:2px;margin-top:-1px;background:rgba(0,0,0,.85);z-index:4}
${R} .th-ink{--ft:#242424;--fm:#1b1b1b;--fb:#151515;--fm2:#1f1f1f;--gc:#EDE6D6}
${R} .th-Y{--ft:#FBD43A;--fm:#F5C513;--fb:#E9B90E;--fm2:#F7C916;--gc:#000000}
${R} .th-N{--ft:#DE5649;--fm:#D94A3D;--fb:#C94236;--fm2:#D44739;--gc:#EDE6D6}
${R} .th-C{--ft:#22C3DD;--fm:#06B6D4;--fb:#05A6C1;--fm2:#06B1CE;--gc:#000000}`;
}

// The board engine. Runs inside the template; SPEC is injected per shot.
function engine(SPEC) {
  var ID = SPEC.id;
  var root = document.getElementById(ID + "-root");
  var ALPHA = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,'?%:";
  var N = ALPHA.length;
  var DEG = Math.PI / 180;
  var GLOW = { Y: "250,204,21", N: "217,74,61", C: "6,182,212" };

  function idx(ch) { var g = ALPHA.indexOf(ch); return g < 0 ? 0 : g; }
  function pad(text, tint, n) {
    text = (text || "").toUpperCase().slice(0, n);
    tint = tint || "";
    var lead = Math.floor((n - text.length) / 2), out = [];
    for (var i = 0; i < n; i++) {
      var j = i - lead, inside = j >= 0 && j < text.length;
      var th = inside && tint.charAt(j) && tint.charAt(j) !== "." ? tint.charAt(j) : "ink";
      out.push({ g: inside ? idx(text.charAt(j)) : 0, th: inside && text.charAt(j) !== " " ? th : "ink" });
    }
    return out;
  }

  // Layout (pre-calculated once). Housing spans the frame; rows centred inside it.
  var rowGap = SPEC.rowGap || 24, PADT = 70, PADB = 46;
  var heights = SPEC.rows.map(function (r) { return Math.round(r.cw * 1.42); });
  var boardH = heights.reduce(function (a, b) { return a + b; }, 0) + rowGap * (SPEC.rows.length - 1);
  var houseH = PADT + boardH + PADB;
  var houseTop = Math.round(534 - houseH / 2);

  var cam = root.querySelector(".fx-cam");
  var house = root.querySelector(".fx-housing");
  house.style.top = houseTop + "px";
  house.style.height = houseH + "px";
  root.querySelector(".fx-lab-l").style.top = houseTop + 30 + "px";
  var labR = root.querySelector(".fx-lab-r");
  if (labR) labR.style.top = houseTop + 30 + "px";
  root.querySelector(".fx-dot").style.top = houseTop + 35 + "px";

  var cells = [];
  var glowPts = [], glowKind = null, glowAt = 0;
  var y = houseTop + PADT;
  SPEC.rows.forEach(function (row, r) {
    var cw = row.cw, chh = heights[r];
    var w = row.cells * cw + (row.cells - 1) * row.gap;
    var x0 = Math.round((1920 - w) / 2);
    var rowEl = document.createElement("div");
    rowEl.className = "sf-row";
    rowEl.setAttribute("data-layout-allow-overlap", "");
    rowEl.setAttribute("data-layout-allow-overflow", "");
    rowEl.style.left = x0 + "px";
    rowEl.style.top = y + "px";
    rowEl.style.width = w + "px";
    cam.appendChild(rowEl);
    var maxWalk = row.maxWalk || 5, fd = row.flipDur || 0.05, st = row.stagger || 0;
    var stages = row.seq.map(function (s) { return { t: s[0], tg: pad(s[1], s[2], row.cells) }; });
    var init = row.init === "scramble" ? null : pad(row.init, row.initTint, row.cells);

    function face(cls, glyphTop) {
      var f = document.createElement("div");
      f.className = "sf-face " + cls + " th-ink";
      f.setAttribute("data-layout-allow-overlap", "");
      f.setAttribute("data-layout-allow-occlusion", "");
      var g = document.createElement("span");
      g.className = "sf-glyph";
      g.setAttribute("data-layout-allow-overlap", "");
      g.setAttribute("data-layout-allow-occlusion", "");
      g.style.height = chh + "px";
      g.style.lineHeight = chh + "px";
      g.style.fontSize = Math.round(cw * 0.86) + "px";
      g.style.top = glyphTop + "px";
      f.appendChild(g);
      return f;
    }
    for (var c = 0; c < row.cells; c++) {
      var cell = document.createElement("div");
      cell.className = "sf-cell";
      cell.style.left = c * (cw + row.gap) + "px";
      cell.style.width = cw + "px";
      cell.style.height = chh + "px";
      cell.setAttribute("data-layout-allow-overlap", "");
      cell.setAttribute("data-layout-allow-occlusion", "");
      cell.setAttribute("data-layout-allow-overflow", "");
      var top = face("sf-top", 0), bot = face("sf-bot", -Math.round(chh / 2));
      var la = face("sf-la", 0), lb = face("sf-lb", -Math.round(chh / 2));
      var seam = document.createElement("div");
      seam.className = "sf-seam";
      cell.appendChild(top); cell.appendChild(bot); cell.appendChild(la); cell.appendChild(lb); cell.appendChild(seam);
      rowEl.appendChild(cell);

      // Drum walk: every change turns the drum FORWARD over a few flaps and lands on the target.
      // Intermediate flaps are ink; the landing flap carries the target tint.
      var jit = function (s) { return (c * 7 + s * 3 + r * 5) % 3; };
      var first = stages[0].tg[c];
      var cur;
      if (init) cur = init[c];
      else if (first.g === 0) cur = { g: 0, th: "ink" };
      else cur = { g: (first.g - (maxWalk + jit(0)) + N * 4) % N, th: "ink" };
      var segs = [], free = 0;
      for (var s = 0; s < stages.length; s++) {
        var tgt = stages[s].tg[c];
        if (tgt.g === cur.g && tgt.th === cur.th) continue;
        var dist = (tgt.g - cur.g + N) % N || N;
        var k = Math.min(dist, maxWalk + jit(s));
        var path = [cur];
        for (var j = k - 1; j >= 1; j--) path.push({ g: (tgt.g - j + N * 4) % N, th: "ink" });
        path.push(tgt);
        var off = row.atOnce ? ((c * 37 + r * 11) % 7) * 0.012 : c * st;
        var t0 = Math.max(stages[s].t + off, free);
        segs.push({ t0: t0, path: path });
        free = t0 + (path.length - 1) * fd;
        cur = tgt;
        if (tgt.th !== "ink" && s === stages.length - 1) {
          glowPts.push([x0 + c * (cw + row.gap) + cw / 2, y + chh / 2]);
          glowKind = glowKind || tgt.th;
          glowAt = Math.max(glowAt, free);
        }
      }
      cells.push({ segs: segs, fd: fd, start: init ? init[c] : (segs.length ? segs[0].path[0] : cur),
        top: top, bot: bot, la: la, lb: lb });
    }
    y += chh + rowGap;
  });

  function setFace(f, st, show) {
    var cls = "th-" + st.th;
    if (f._th !== cls) { f.className = f.className.replace(/th-\S+/, cls); f._th = cls; }
    f.firstChild.textContent = show ? ALPHA.charAt(st.g) : "";
  }
  function leaf(f, st, angle, shade) {
    if (!st) { f.style.opacity = "0"; f.style.transform = ""; f.style.filter = ""; f.firstChild.textContent = ""; return; }
    setFace(f, st, true);
    f.style.opacity = "1";
    f.style.transform = "rotateX(" + angle.toFixed(2) + "deg)";
    f.style.filter = "brightness(" + shade + ")";
  }
  // Pure function of local time: seek-safe.
  function paint(t) {
    for (var i = 0; i < cells.length; i++) {
      var cl = cells[i], seg = null;
      for (var s = 0; s < cl.segs.length; s++) if (cl.segs[s].t0 <= t) seg = cl.segs[s];
      var out, inc = null, p = 0;
      if (!seg) out = cl.start;
      else {
        var raw = (t - seg.t0) / cl.fd, n = Math.floor(raw), last = seg.path.length - 1;
        if (n >= last) out = seg.path[last];
        else { p = raw - n; out = seg.path[n]; if (p > 0) inc = seg.path[n + 1]; }
      }
      if (!inc) {
        setFace(cl.top, out, true); setFace(cl.bot, out, true);
        leaf(cl.la, null); leaf(cl.lb, null);
        continue;
      }
      setFace(cl.top, inc, true); setFace(cl.bot, out, true);
      var th = 180 * p * p, shade = (1 - 0.5 * Math.sin(th * DEG)).toFixed(3);
      if (th < 90) { leaf(cl.la, out, -th, shade); leaf(cl.lb, null); }
      else { leaf(cl.la, null); leaf(cl.lb, inc, 180 - th, shade); }
    }
  }

  // Glow under the tinted tiles, centred on them (computed once).
  var glow = root.querySelector(".fx-glow");
  if (glowPts.length) {
    var gx = 0, gy = 0;
    glowPts.forEach(function (q) { gx += q[0]; gy += q[1]; });
    gx /= glowPts.length; gy /= glowPts.length;
    var spread = Math.max(14, Math.min(40, glowPts.length * 4));
    glow.style.background = "radial-gradient(" + spread + "% 26% at " + (gx / 19.2).toFixed(1) + "% " + (gy / 10.8).toFixed(1) +
      "%,rgba(" + GLOW[glowKind] + ",.16),rgba(" + GLOW[glowKind] + ",0) 70%)";
  }

  var D = SPEC.dur;
  var tl = gsap.timeline({ paused: true });
  var tm = 0;
  var driver = {};
  Object.defineProperty(driver, "t", { get: function () { return tm; }, set: function (v) { tm = v; paint(v); } });
  tl.fromTo(driver, { t: 0 }, { t: D, duration: D, ease: "none" }, 0);
  var cf = SPEC.cam || [1.03, 1, "power1.out"];
  tl.fromTo(cam, { scale: cf[0], transformOrigin: "50% 50%" }, { scale: cf[1], duration: D, ease: cf[2] }, 0);
  if (glowPts.length) {
    tl.fromTo(glow, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power2.out" }, Math.max(0, glowAt - 0.06));
  } else tl.set(glow, { opacity: 0 }, 0);
  var pulses = Math.max(1, Math.round(D / 0.25) - 1);
  tl.fromTo(root.querySelector(".fx-dot"), { opacity: 1 }, { opacity: 0.3, duration: 0.25, ease: "power1.inOut", repeat: pulses, yoyo: true }, 0);

  // Category ticker: [time, [lit indices]] states.
  var spans = root.querySelectorAll(".fx-tick span");
  var tk = SPEC.ticker || [[0, []]];
  for (var q = 0; q < spans.length; q++) {
    var was = tk[0][1].indexOf(q) >= 0;
    tl.set(spans[q], { color: was ? "#FACC15" : "#7b7871" }, 0);
    for (var z = 1; z < tk.length; z++) {
      var on = tk[z][1].indexOf(q) >= 0;
      if (on !== was) tl.to(spans[q], { color: on ? "#FACC15" : "#7b7871", duration: 0.08, ease: "none" }, tk[z][0]);
      was = on;
    }
  }
  paint(0);
  window.__timelines[ID] = tl;
}

function shotHtml(s) {
  const id = s.id;
  const spec = { id, dur: s.dur, rows: s.rows, rowGap: s.rowGap, cam: s.cam, ticker: s.ticker };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${id} FLAP</title>
  </head>
  <body>
    <template>
      <style>${css(id)}
      </style>
      <div id="${id}-root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="${s.dur}">
        <div class="fx-bg"></div>
        <div class="fx-cam">
          <div class="fx-glow"></div>
          <div class="fx-housing">
            <div class="fx-rivet" style="left:14px;top:14px"></div><div class="fx-rivet" style="right:14px;top:14px"></div>
            <div class="fx-rivet" style="left:14px;bottom:14px"></div><div class="fx-rivet" style="right:14px;bottom:14px"></div>
          </div>
          <div class="fx-lab fx-lab-l" style="left:118px">${s.label}</div>
          ${s.right ? `<div class="fx-lab fx-lab-r fx-call" style="right:140px">${s.right}</div>` : ""}
          <div class="fx-dot" style="right:118px"></div>
        </div>
        <div class="fx-hdr">
          <svg viewBox="-3 -3 406 316"><path fill="#EDE6D6" d="${LOGO}"/></svg>
          <div class="fx-word">Mako Market</div>
        </div>
        <div class="fx-rule" style="top:176px"></div><div class="fx-rule" style="top:892px"></div>
        <div class="fx-tick"><span>CRYPTO</span><span>FOOTBALL</span><span>NBA</span><span>FOREX</span><span>COMMODITIES</span><span>STOCKS</span></div>
        <div class="fx-lab fx-foot">makomarket.xyz</div>
      </div>
      <script>
        (${engine.toString()})(${JSON.stringify(spec)});
      </script>
    </template>
  </body>
</html>
`;
}

// Index: shots back to back (storyboard order), for lint/snapshot only.
let t = 0;
const hosts = [];
const keys = [];
for (const s of SHOTS) {
  writeFileSync(join(P, "compositions", `${s.id}.html`), shotHtml(s));
  hosts.push(`    <div id="h-${s.id}" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${+t.toFixed(3)}" data-duration="${s.dur}" data-track-index="1" data-width="1920" data-height="1080"></div>`);
  const key = (s.key ?? s.start + s.dur * 0.7) - s.start;
  keys.push({ id: s.id, at: +(t + key).toFixed(3), local: +key.toFixed(3) });
  t += s.dur;
}
const index = `<!doctype html>
<html lang="en" data-resolution="landscape">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=1920, height=1080">
<script src="assets/gsap.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#030303}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#030303}
#root > div[data-composition-src]{position:absolute;inset:0}
</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="${+t.toFixed(3)}" data-fps="30">
${hosts.join("\n")}
  </div>
  <script>
    window.__timelines["main"] = gsap.timeline({ paused: true });
  </script>
</body>
</html>
`;
writeFileSync(join(P, "index.html"), index);
writeFileSync(join(P, "build", "keys.json"), JSON.stringify(keys, null, 1));
console.log("total", t, keys.map((k) => `${k.id}@${k.at}`).join(" "));
