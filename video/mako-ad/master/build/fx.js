// Mako Market master: seam transitions on the film clock (one paused timeline, seek-safe).
// Host wrappers are #el-sNN. Every seam is centred on its cut C. Proxies (getter/setter objects) drive
// SVG filter attributes and clip paths so they render on any seek, with or without callbacks.
(function () {
  var tl = gsap.timeline({ paused: true });
  var W = function (id) { return "#el-" + id; };
  var E = function (id) { return document.getElementById(id); };
  function px(fn, v0) {
    var o = {}, v = v0 || 0;
    Object.defineProperty(o, "v", { get: function () { return v; }, set: function (x) { v = x; fn(x); } });
    fn(v);
    return o;
  }
  function attr(id, k, val) { var e = E(id); if (e) e.setAttribute(k, val); }
  // seeded hash in [0,1)
  function rnd(i) { var x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function filt(id, f, t) { tl.set(W(id), { filter: f }, t); }
  function zi(id, z, t) { tl.set(W(id), { zIndex: z }, t); }

  // backdrop colour under the shots (black by default)
  function bg(c, a, b) { tl.set("#fx-bg", { backgroundColor: c }, a); tl.set("#fx-bg", { backgroundColor: "#000000" }, b); }

  // ---------- 01>02  2.0  focus pull ----------
  tl.fromTo(W("s01"), { filter: "blur(0px)" }, { filter: "blur(18px)", duration: 0.45, ease: "power1.in", immediateRender: false }, 1.75);
  tl.fromTo(W("s01"), { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power2.in", immediateRender: false }, 1.9);
  tl.fromTo(W("s02"), { opacity: 0, filter: "blur(12px)", scale: 1.02 }, { opacity: 1, filter: "blur(0px)", scale: 1, duration: 0.36, ease: "power2.out" }, 1.9);
  tl.set(W("s02"), { filter: "none" }, 2.27);

  // ---------- 02>03  3.5  glitch slam, RGB split ----------
  (function () {
    var C = 3.5, A = 3.38, B = 3.63, N = 10;
    var p = px(function (v) {
      var k = Math.min(N - 1, Math.floor(v * N)), env = v <= 0 || v >= 1 ? 0 : 1 - Math.abs(v - 0.5) * 1.6;
      var r1 = rnd(k + 1) - 0.5, r2 = rnd(k + 17) - 0.5, r3 = rnd(k + 33);
      attr("gl-or", "dx", (env * (34 + 40 * r1)).toFixed(1));
      attr("gl-ob", "dx", (-env * (34 + 40 * r2)).toFixed(1));
      attr("gl-disp", "scale", (env * (60 + 180 * r3)).toFixed(1));
      attr("gl-turb", "seed", String(3 + k));
      var x = env * 60 * r2, y = env * 14 * r1;
      gsap.set([W("s02"), W("s03")], { x: x, y: y });
    });
    filt("s02", "url(#fx-glitch)", A);
    filt("s03", "url(#fx-glitch)", C);
    tl.fromTo(p, { v: 0 }, { v: 1, duration: B - A, ease: "none", immediateRender: false }, A);
    filt("s03", "none", B + 0.001);
    tl.fromTo("#fx-glbar", { opacity: 0 }, { opacity: 0.9, duration: 0.03, ease: "steps(1)", immediateRender: false }, C - 0.06);
    tl.fromTo("#fx-glbar", { yPercent: 0 }, { yPercent: 340, duration: 0.18, ease: "steps(6)", immediateRender: false }, C - 0.06);
    tl.to("#fx-glbar", { opacity: 0, duration: 0.01 }, C + 0.12);
  })();

  // ---------- 03>04  5.0  light leak in signal yellow ----------
  tl.fromTo("#lk-warm", { opacity: 0 }, { opacity: 0.55, duration: 0.3, ease: "power2.in", immediateRender: false }, 4.7);
  tl.to("#lk-warm", { opacity: 0, duration: 0.38, ease: "power2.out" }, 5.0);
  tl.fromTo("#lk-1", { opacity: 0, x: -700, y: -120 }, { opacity: 1, x: 120, y: 0, duration: 0.32, ease: "sine.in", immediateRender: false }, 4.68);
  tl.to("#lk-1", { opacity: 0, x: 820, duration: 0.42, ease: "sine.out" }, 5.0);
  tl.fromTo("#lk-2", { opacity: 0, x: 600, y: 160 }, { opacity: 0.9, x: -80, y: 40, duration: 0.3, ease: "sine.in", immediateRender: false }, 4.74);
  tl.to("#lk-2", { opacity: 0, x: -640, duration: 0.4, ease: "sine.out" }, 5.04);
  tl.fromTo(W("s03"), { filter: "brightness(1)" }, { filter: "brightness(1.7)", duration: 0.33, ease: "power2.in", immediateRender: false }, 4.72);
  tl.fromTo(W("s04"), { opacity: 0, filter: "brightness(1.8)" }, { opacity: 1, filter: "brightness(1.8)", duration: 0.1, ease: "none" }, 4.95);
  tl.to(W("s04"), { filter: "brightness(1)", duration: 0.4, ease: "power2.out" }, 5.05);
  tl.set(W("s04"), { filter: "none" }, 5.46);

  // ---------- 04>05  7.0  zoom through ----------
  tl.fromTo(W("s04"), { scale: 1, filter: "blur(0px)" }, { scale: 2.4, filter: "blur(10px)", duration: 0.3, ease: "power3.in", immediateRender: false }, 6.8);
  tl.fromTo(W("s04"), { opacity: 1 }, { opacity: 0, duration: 0.18, ease: "power2.in", immediateRender: false }, 6.92);
  tl.fromTo(W("s05"), { scale: 0.55, opacity: 0, filter: "blur(10px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.3, ease: "power3.out" }, 6.9);
  tl.set(W("s05"), { filter: "none" }, 7.21);

  // 05>06 .. 09>10: hard cuts on the beat (the board flips are the transition)

  // ---------- 10>11  11.5  shutter ----------
  tl.fromTo("#sh-top", { yPercent: -101 }, { yPercent: 0, duration: 0.2, ease: "power3.in", immediateRender: true }, 11.3);
  tl.fromTo("#sh-bot", { yPercent: 101 }, { yPercent: 0, duration: 0.2, ease: "power3.in", immediateRender: true }, 11.3);
  tl.to("#sh-top", { yPercent: -101, duration: 0.2, ease: "power3.out" }, 11.52);
  tl.to("#sh-bot", { yPercent: 101, duration: 0.2, ease: "power3.out" }, 11.52);

  // ---------- 11>12  13.0  circle iris opening from the YES tile ----------
  (function () {
    var cx = 560, cy = 444, el = E("el-s12"), ring = E("fx-ring");
    var p = px(function (r) {
      if (el) el.style.clipPath = r >= 1600 ? "none" : "circle(" + r.toFixed(1) + "px at " + cx + "px " + cy + "px)";
      if (ring) {
        var d = 2 * r + 10;
        ring.style.width = d + "px"; ring.style.height = d + "px";
        ring.style.left = cx - d / 2 + "px"; ring.style.top = cy - d / 2 + "px";
        ring.style.opacity = r <= 0 || r >= 1600 ? "0" : String(Math.max(0, 1 - r / 1500));
      }
    }, 1600);
    tl.fromTo(p, { v: 0 }, { v: 1600, duration: 0.5, ease: "power2.out", immediateRender: false }, 12.8);
  })();

  // ---------- 12>13  15.0  3D card flip (cube turn) ----------
  tl.fromTo(W("s12"), { rotationY: 0, scale: 1, transformPerspective: 2600, transformOrigin: "50% 50% -960px" },
    { rotationY: -90, scale: 0.9, duration: 0.6, ease: "power2.inOut", immediateRender: false }, 14.7);
  tl.fromTo(W("s13"), { rotationY: 90, scale: 0.9, transformPerspective: 2600, transformOrigin: "50% 50% -960px" },
    { rotationY: 0, scale: 1, duration: 0.6, ease: "power2.inOut" }, 14.7);
  tl.fromTo(W("s12"), { filter: "brightness(1)" }, { filter: "brightness(0.72)", duration: 0.6, ease: "power1.in", immediateRender: false }, 14.7);
  tl.fromTo(W("s13"), { filter: "brightness(0.72)" }, { filter: "brightness(1)", duration: 0.6, ease: "power1.out" }, 14.7);
  tl.set(W("s13"), { filter: "none" }, 15.31);

  // ---------- 13>14  16.5  directional blur through, colour dip ----------
  tl.fromTo(W("s13"), { filter: "blur(0px)", skewX: 0, x: 0, opacity: 1 }, { filter: "blur(16px)", skewX: -8, x: -260, opacity: 0, duration: 0.25, ease: "power3.in", immediateRender: false }, 16.3);
  tl.fromTo(W("s14"), { filter: "blur(16px)", skewX: 8, x: 260, opacity: 0 }, { filter: "blur(0px)", skewX: 0, x: 0, opacity: 1, duration: 0.3, ease: "power3.out" }, 16.45);
  tl.set(W("s14"), { filter: "none" }, 16.76);
  tl.fromTo("#fx-wash", { opacity: 0, backgroundColor: "#D6CFBE" }, { opacity: 0.75, duration: 0.17, ease: "power2.in", immediateRender: false }, 16.33);
  tl.to("#fx-wash", { opacity: 0, duration: 0.24, ease: "power2.out" }, 16.5);

  // ---------- 14>15  18.0  diagonal split ----------
  (function () {
    var el = E("el-s14"), ln = E("fx-diag");
    var p = px(function (s) {
      // visible old region: x/W - y/H >= s  (s from -1 = full frame to 1 = top-right corner)
      var Wd = 1920, H = 1080, poly, a, b;
      if (s <= -1) poly = null;
      else if (s < 0) { poly = "polygon(0px 0px," + Wd + "px 0px," + Wd + "px " + H + "px," + (Wd * (1 + s)).toFixed(1) + "px " + H + "px,0px " + (-s * H).toFixed(1) + "px)"; a = [0, -s * H]; b = [Wd * (1 + s), H]; }
      else { poly = "polygon(" + (s * Wd).toFixed(1) + "px 0px," + Wd + "px 0px," + Wd + "px " + ((1 - s) * H).toFixed(1) + "px)"; a = [s * Wd, 0]; b = [Wd, (1 - s) * H]; }
      if (el) el.style.clipPath = poly || "none";
      if (ln) {
        if (!poly || s >= 1) ln.setAttribute("opacity", "0");
        else { ln.setAttribute("opacity", "1"); ln.setAttribute("x1", a[0]); ln.setAttribute("y1", a[1]); ln.setAttribute("x2", b[0]); ln.setAttribute("y2", b[1]); }
      }
    }, -1);
    zi("s14", 300, 17.75);
    tl.fromTo(p, { v: -1 }, { v: 1, duration: 0.5, ease: "power3.inOut", immediateRender: false }, 17.75);
    zi("s14", 14, 18.26);
  })();

  // ---------- 15>16  19.5  vertical push, up ----------
  tl.fromTo(W("s15"), { y: 0 }, { y: -1080, duration: 0.5, ease: "power3.inOut", immediateRender: false }, 19.25);
  tl.fromTo(W("s16"), { y: 1080 }, { y: 0, duration: 0.5, ease: "power3.inOut" }, 19.25);

  // ---------- 16>17  21.0  staggered blocks in yellow ----------
  ["#bk-1", "#bk-2", "#bk-3"].forEach(function (s, i) {
    tl.fromTo(s, { x: -1940 }, { x: 0, duration: 0.2, ease: "power3.inOut", immediateRender: true }, 20.72 + i * 0.04);
    tl.to(s, { x: 1940, duration: 0.22, ease: "power3.inOut" }, 21.1 - i * 0.04);
  });

  // ---------- 17>18  22.0  colour dip through paper ----------
  tl.fromTo("#fx-dip", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power2.in", immediateRender: false }, 21.8);
  tl.to("#fx-dip", { opacity: 0, duration: 0.26, ease: "power2.out" }, 22.0);

  // ---------- 18>19  24.0  zoom punch + 2-frame white flash ----------
  tl.fromTo(W("s18"), { scale: 1, transformOrigin: "50% 50%" }, { scale: 1.12, duration: 0.15, ease: "power3.in", immediateRender: false }, 23.85);
  tl.fromTo(W("s19"), { scale: 1.12, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.18, ease: "power3.out" }, 24.0);
  tl.fromTo("#fx-flash", { opacity: 0.85 }, { opacity: 0, duration: 0.034, ease: "none", immediateRender: false }, 24.0);
  tl.set("#fx-flash", { opacity: 0 }, 24.04);

  // ---------- 19>21  26.5  squeeze ----------
  bg("#D6CFBE", 26.3, 26.71);
  tl.fromTo(W("s19"), { scaleX: 1, transformOrigin: "0% 50%" }, { scaleX: 0, duration: 0.35, ease: "power3.inOut", immediateRender: false }, 26.3);
  tl.fromTo(W("s21"), { scaleX: 0, transformOrigin: "100% 50%" }, { scaleX: 1, duration: 0.35, ease: "power3.inOut" }, 26.35);

  // ---------- 21>22  28.0  whip pan ----------
  (function () {
    var b = px(function (v) { attr("wp-blur", "stdDeviation", v.toFixed(1) + " 0"); });
    filt("s21", "url(#fx-hblur)", 27.82); filt("s22", "url(#fx-hblur)", 27.82);
    tl.fromTo(W("s21"), { x: 0 }, { x: -1920, duration: 0.36, ease: "expo.inOut", immediateRender: false }, 27.82);
    tl.fromTo(W("s22"), { x: 1920 }, { x: 0, duration: 0.36, ease: "expo.inOut" }, 27.82);
    tl.fromTo(b, { v: 0 }, { v: 110, duration: 0.18, ease: "power2.in", immediateRender: false }, 27.82);
    tl.to(b, { v: 0, duration: 0.18, ease: "power2.out" }, 28.0);
    filt("s22", "none", 28.19);
  })();

  // ---------- 22>23  29.5  domain-warp dissolve ----------
  (function () {
    var K = 30;
    var m = px(function (B) {
      attr("dw-m1", "values", "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  " + K + " 0 0 0 " + B.toFixed(3));
      attr("dw-m2", "values", "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  " + K + " 0 0 0 " + (B + 0.5).toFixed(3));
    }, -27);
    var d = px(function (s) { attr("dw-disp", "scale", s.toFixed(1)); attr("dwo-disp", "scale", s.toFixed(1)); });
    filt("s22", "url(#fx-dwo)", 29.2); filt("s23", "url(#fx-dw)", 29.2);
    tl.fromTo(m, { v: -27 }, { v: -2.5, duration: 0.6, ease: "power1.inOut", immediateRender: false }, 29.2);
    tl.fromTo(d, { v: 0 }, { v: 90, duration: 0.3, ease: "sine.in", immediateRender: false }, 29.2);
    tl.to(d, { v: 0, duration: 0.3, ease: "sine.out" }, 29.5);
    filt("s23", "none", 29.81);
  })();

  // ---------- 23>24  32.0  horizontal blinds ----------
  for (var i = 0; i < 8; i++) {
    tl.fromTo("#hb-" + i, { x: -1940 }, { x: 0, duration: 0.16, ease: "power3.inOut", immediateRender: true }, 31.70 + i * 0.02);
    tl.to("#hb-" + i, { x: 1940, duration: 0.16, ease: "power3.inOut" }, 32.02 + i * 0.02);
  }

  // ---------- 24>25  33.5  diamond iris ----------
  (function () {
    var el = E("el-s25"), dm = E("fx-diamond");
    var p = px(function (k) {
      var rx = k * 1920, ry = k * 1080, pts = [[960, 540 - ry], [960 + rx, 540], [960, 540 + ry], [960 - rx, 540]];
      if (el) el.style.clipPath = k >= 1.08 ? "none" : "polygon(" + pts.map(function (q) { return q[0].toFixed(1) + "px " + q[1].toFixed(1) + "px"; }).join(",") + ")";
      if (dm) { dm.setAttribute("points", pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ")); dm.setAttribute("opacity", k <= 0 || k >= 1.08 ? "0" : String(Math.max(0, 1 - k * 0.9))); }
    }, 1.08);
    tl.fromTo(p, { v: 0 }, { v: 1.08, duration: 0.5, ease: "power2.out", immediateRender: false }, 33.3);
  })();

  // ---------- 25>26  35.0  chromatic radial split ----------
  (function () {
    var a = px(function (s) { attr("ca-r-a", "scale", (s * 130).toFixed(1)); attr("ca-b-a", "scale", (-s * 130).toFixed(1)); });
    var b = px(function (s) { attr("ca-r-b", "scale", (s * 130).toFixed(1)); attr("ca-b-b", "scale", (-s * 130).toFixed(1)); });
    filt("s25", "url(#fx-ca-a)", 34.75); filt("s26", "url(#fx-ca-b)", 34.94);
    tl.fromTo(a, { v: 0 }, { v: 1, duration: 0.31, ease: "power2.in", immediateRender: false }, 34.75);
    tl.fromTo(W("s25"), { scale: 1 }, { scale: 1.06, duration: 0.31, ease: "power2.in", immediateRender: false }, 34.75);
    tl.fromTo(b, { v: 1 }, { v: 0, duration: 0.31, ease: "power2.out", immediateRender: false }, 34.94);
    tl.fromTo(W("s26"), { scale: 1.06, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.31, ease: "power2.out" }, 34.94);
    tl.set(W("s26"), { opacity: 1 }, 35.06);
    filt("s26", "none", 35.26);
  })();

  // ---------- 26>27  36.5  VHS tape ----------
  (function () {
    var N = 12;
    var p = px(function (v) {
      var k = Math.min(N - 1, Math.floor(v * N)), env = v <= 0 || v >= 1 ? 0 : Math.sin(v * Math.PI);
      attr("vh-turb", "seed", String(20 + k));
      attr("vh-disp", "scale", (env * (90 + 70 * rnd(k + 5))).toFixed(1));
      attr("vh-or", "dx", (env * 14).toFixed(1));
      attr("vh-ob", "dx", (-env * 14).toFixed(1));
      var band = E("fx-vband");
      if (band) { band.style.opacity = (env * 0.55).toFixed(3); band.style.transform = "translateY(" + (-200 + 1400 * v).toFixed(1) + "px)"; }
      var sc = E("fx-scan"); if (sc) sc.style.opacity = (env * 0.5).toFixed(3);
    });
    filt("s26", "url(#fx-vhs)", 36.3); filt("s27", "url(#fx-vhs)", 36.45);
    tl.fromTo(p, { v: 0 }, { v: 1, duration: 0.4, ease: "none", immediateRender: false }, 36.3);
    tl.fromTo(W("s27"), { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, 36.45);
    filt("s27", "none", 36.71);
  })();

  // ---------- 27>28  38.0  grid dissolve ----------
  tl.fromTo(".gc", { scale: 0 }, { scale: 1.02, duration: 0.14, ease: "power2.out", stagger: function (i) { return window.__gcDelay[i]; }, immediateRender: true }, 37.75);
  tl.to(".gc", { scale: 0, duration: 0.14, ease: "power2.in", stagger: function (i) { return window.__gcDelay[i]; } }, 38.02);

  // ---------- 28>29  40.0  gravity drop ----------
  zi("s28", 300, 39.75);
  tl.fromTo(W("s28"), { y: 0, rotation: 0, transformOrigin: "35% 0%" }, { y: 1300, rotation: 6, duration: 0.45, ease: "power2.in", immediateRender: false }, 39.75);
  tl.fromTo(W("s29"), { filter: "brightness(0.55)", scale: 0.97 }, { filter: "brightness(1)", scale: 1, duration: 0.5, ease: "power2.out" }, 39.75);
  zi("s28", 28, 40.21);
  tl.set(W("s29"), { filter: "none" }, 40.26);

  // ---------- 29>30  42.0  elastic push, left ----------
  bg("#121212", 41.75, 42.5);
  tl.fromTo(W("s29"), { x: 0 }, { x: -1920, duration: 0.4, ease: "power3.in", immediateRender: false }, 41.75);
  tl.fromTo(W("s30"), { x: 1920 }, { x: 34, duration: 0.4, ease: "power4.out" }, 41.85);
  tl.to(W("s30"), { x: -16, duration: 0.15, ease: "sine.inOut" }, 42.25);
  tl.to(W("s30"), { x: 0, duration: 0.12, ease: "sine.out" }, 42.4);

  // ---------- 30>31  43.5  film burn ----------
  tl.fromTo(W("s30"), { filter: "brightness(1)" }, { filter: "brightness(2.2)", duration: 0.3, ease: "power2.in", immediateRender: false }, 43.2);
  tl.fromTo("#bn-a", { opacity: 0, x: 700 }, { opacity: 1, x: -300, duration: 0.32, ease: "power1.in", immediateRender: false }, 43.18);
  tl.fromTo("#bn-b", { opacity: 0, x: 900 }, { opacity: 1, x: -500, duration: 0.3, ease: "power1.in", immediateRender: false }, 43.22);
  tl.fromTo("#bn-c", { opacity: 0, x: 600 }, { opacity: 0.95, x: -200, duration: 0.26, ease: "power1.in", immediateRender: false }, 43.26);
  tl.to("#bn-a", { opacity: 0, x: -900, duration: 0.3, ease: "power2.out" }, 43.5);
  tl.to("#bn-b", { opacity: 0, x: -1100, duration: 0.34, ease: "power2.out" }, 43.54);
  tl.to("#bn-c", { opacity: 0, x: -800, duration: 0.36, ease: "power2.out" }, 43.58);
  tl.fromTo(W("s31"), { filter: "brightness(2)" }, { filter: "brightness(1)", duration: 0.4, ease: "power2.out" }, 43.5);
  tl.set(W("s31"), { filter: "none" }, 43.91);

  // ---------- 31>32  46.0  clock wipe ----------
  (function () {
    var el = E("el-s32"), hand = E("fx-hand"), R = 1500;
    var p = px(function (a) {
      if (el) {
        if (a >= 360) el.style.clipPath = "none";
        else {
          var pts = ["960px 540px"], n = Math.max(1, Math.ceil(a / 6));
          for (var i = 0; i <= n; i++) {
            var t = ((-90 + (a * i) / n) * Math.PI) / 180;
            pts.push((960 + R * Math.cos(t)).toFixed(1) + "px " + (540 + R * Math.sin(t)).toFixed(1) + "px");
          }
          el.style.clipPath = "polygon(" + pts.join(",") + ")";
        }
      }
      if (hand) { hand.style.transform = "rotate(" + a.toFixed(2) + "deg)"; hand.style.opacity = a <= 0 || a >= 360 ? "0" : "1"; }
    }, 360);
    tl.fromTo(p, { v: 0 }, { v: 360, duration: 0.4, ease: "power1.inOut", immediateRender: false }, 45.8);
  })();

  // ---------- 32>33  47.5  morph circle in yellow ----------
  tl.fromTo("#fx-morph", { scale: 0, opacity: 1 }, { scale: 22, duration: 0.25, ease: "power3.in", immediateRender: true }, 47.25);
  tl.to("#fx-morph", { scale: 30, opacity: 0, duration: 0.22, ease: "power2.out" }, 47.5);
  tl.fromTo(W("s33"), { scale: 1.08 }, { scale: 1, duration: 0.4, ease: "power3.out" }, 47.5);

  // ---------- 33>34  49.0  zoom out ----------
  zi("s33", 300, 48.8);
  tl.fromTo(W("s33"), { scale: 1, borderRadius: 0 }, { scale: 0.3, borderRadius: 40, duration: 0.4, ease: "power2.inOut", immediateRender: false }, 48.8);
  tl.fromTo(W("s33"), { opacity: 1 }, { opacity: 0, duration: 0.22, ease: "power2.in", immediateRender: false }, 48.98);
  tl.fromTo(W("s34"), { scale: 1.06 }, { scale: 1, duration: 0.5, ease: "power2.out" }, 48.8);
  zi("s33", 33, 49.21);

  // ---------- 34>35  51.0  ripple ----------
  (function () {
    function wob(id, sign) {
      return px(function (v) {
        // v: 0..1 envelope phase; sign 1 = outgoing (growing), -1 = incoming (decaying)
        var env = sign > 0 ? v : 1 - v, ph = v * 0.2 * 2 * Math.PI * 12.5;
        var x = env * 30 * Math.sin(ph), s = 1 + env * 0.03 * Math.sin(ph + 1.3), b = env * 7;
        gsap.set(W(id), { x: x, scale: s, filter: env > 0.001 ? "blur(" + b.toFixed(2) + "px)" : "none" });
      });
    }
    tl.fromTo(wob("s34", 1), { v: 0 }, { v: 1, duration: 0.2, ease: "none", immediateRender: false }, 50.8);
    tl.fromTo(wob("s35", -1), { v: 0 }, { v: 1, duration: 0.2, ease: "none", immediateRender: false }, 51.0);
  })();

  // ---------- 35>36  52.5  vertical blinds ----------
  for (var j = 0; j < 12; j++) {
    tl.fromTo("#vb-" + j, { y: -1100 }, { y: 0, duration: 0.16, ease: "power3.inOut", immediateRender: true }, 52.142 + j * 0.018);
    tl.to("#vb-" + j, { y: 1100, duration: 0.16, ease: "power3.inOut" }, 52.52 + j * 0.018);
  }

  // ---------- 36>37  54.0  flash through white ----------
  tl.fromTo(W("s36"), { filter: "brightness(1)" }, { filter: "brightness(2.4)", duration: 0.2, ease: "power2.in", immediateRender: false }, 53.8);
  tl.fromTo("#fx-white", { opacity: 0 }, { opacity: 1, duration: 0.15, ease: "power2.in", immediateRender: false }, 53.85);
  tl.to("#fx-white", { opacity: 0, duration: 0.25, ease: "power2.out" }, 54.0);
  tl.fromTo(W("s37"), { filter: "brightness(1.9)" }, { filter: "brightness(1)", duration: 0.3, ease: "power2.out" }, 54.0);
  tl.set(W("s37"), { filter: "none" }, 54.31);

  // ---------- 37>38  56.0  cross-warp morph ----------
  (function () {
    var a = px(function (s) { attr("xw-a", "scale", s.toFixed(1)); });
    var b = px(function (s) { attr("xw-b", "scale", (-s).toFixed(1)); });
    filt("s37", "url(#fx-xwa)", 55.7); filt("s38", "url(#fx-xwb)", 55.7);
    tl.fromTo(a, { v: 0 }, { v: 160, duration: 0.6, ease: "power2.in", immediateRender: false }, 55.7);
    tl.fromTo(b, { v: 160 }, { v: 0, duration: 0.6, ease: "power2.out", immediateRender: false }, 55.7);
    tl.fromTo(W("s38"), { opacity: 0 }, { opacity: 1, duration: 0.44, ease: "sine.inOut" }, 55.78);
    filt("s38", "none", 56.31);
  })();

  // ---------- 38>39  58.5  blur crossfade (slow) ----------
  tl.fromTo(W("s38"), { filter: "blur(0px)", scale: 1, opacity: 1 }, { filter: "blur(14px)", scale: 1.03, opacity: 0, duration: 0.6, ease: "power2.inOut", immediateRender: false }, 58.2);
  tl.fromTo(W("s39"), { filter: "blur(14px)", scale: 0.97, opacity: 0 }, { filter: "blur(0px)", scale: 1, opacity: 1, duration: 0.6, ease: "power2.inOut" }, 58.2);
  tl.set(W("s39"), { filter: "none" }, 58.81);

  tl.to({}, { duration: 0.001 }, 59.99);
  window.__timelines["main"] = tl;
})();
