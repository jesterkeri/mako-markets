// MACRO (Macro Lens) kit: generates self-contained HyperFrames sub-compositions.
// Each shot = the scene drawn three times (heavy blur, light blur, sharp); the two upper copies are masked to a
// soft horizontal focus band (CSS vars --fy/--fh on .mk-stage). Camera, rack focus, breathing, sweeps and presses
// all live on ONE paused GSAP timeline per shot. The band is sampled at 60 Hz from an analytic projection of the
// focus targets (pre-computed at setup, never measured from the DOM), so it tracks targets while the camera moves.

export const T = {
  bg: "#0b0b0b",
  surface: "#121212",
  raise: "#1c1c1c",
  fg: "#EDE6D6",
  dim: "#8E8A80",
  signal: "#FACC15",
  red: "#D94A3D",
  cyan: "#06B6D4",
  ink: "#000000",
};

export const LOGO_PATH =
  "M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z";

const FONTS = `@font-face{font-family:"Bricolage Grotesque Variable";font-style:normal;font-weight:200 800;src:url("assets/fonts/captured-bricolage-grotesque-latin-wght-normal.0hh3pksc_dt39.woff2") format("woff2-variations");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Bricolage Grotesque Variable";font-style:normal;font-weight:200 800;src:url("assets/fonts/captured-bricolage-grotesque-latin-ext-wght-normal.0-cv.c7uda8um.woff2") format("woff2-variations");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;src:url("assets/fonts/captured-inter-latin-wght-normal.055ydel_y7o6i.woff2") format("woff2-variations")}
@font-face{font-family:"JetBrains Mono";font-weight:100 800;src:url("assets/fonts/jbmono-latin.woff2") format("woff2")}`;

/** Sheen markup: a 300%-wide band, screen + overlay copies (overlay only lifts light pixels). */
export function sheen(cls, { angle = 104, strength = 1, round = 0, inset = "0", screen = true } = {}) {
  const band = (a) =>
    `linear-gradient(${angle}deg, transparent 0%, transparent 40%, rgba(255,255,255,${(a * 0.5).toFixed(3)}) 46%, rgba(255,255,255,${a.toFixed(3)}) 50%, rgba(255,255,255,${(a * 0.5).toFixed(3)}) 54%, transparent 60%, transparent 100%)`;
  return `<div class="mk-sheen ${cls}" data-layout-ignore style="inset:${inset};border-radius:${round}px">${screen ? `<i data-layout-ignore data-layout-allow-occlusion style="background-image:${band(0.07 * strength)};mix-blend-mode:screen;border-radius:${round}px"></i>` : ""}<i data-layout-ignore data-layout-allow-occlusion style="background-image:${band(0.55 * strength)};mix-blend-mode:overlay;border-radius:${round}px"></i></div>`;
}

export const finSvg = (size, fill, extra = "") =>
  `<svg viewBox="-3 -3 406 316" width="${size}" height="${((size * 316) / 406).toFixed(1)}" style="display:block;overflow:visible" ${extra}><path d="${LOGO_PATH}" fill="${fill}" stroke="${fill}" stroke-width="3" stroke-linejoin="round"/></svg>`;

export const cursorSvg = `<svg width="115" height="115" viewBox="0 0 24 24" style="position:absolute;left:-22px;top:-10px;overflow:visible"><path d="M5 2 L5 19 L9.5 15.5 L12.5 22 L15.5 20.5 L12.5 14 L18.5 14 Z" fill="#ffffff" stroke="#000000" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

/** CSS gradient angle whose bands run parallel to the panel's rows on screen (180 = to bottom). */
export function bandAngle(S) {
  const rz = ((S.rz || 0) * Math.PI) / 180, t = (S.tilt * Math.PI) / 180;
  return S.fa ?? 180 + (Math.atan2(Math.sin(rz) * Math.cos(t), Math.cos(rz)) * 180) / Math.PI;
}

function css(id, cfg) {
  const S = cfg.surf;
  const R = `#${id}-root`;
  const lin = (dir, c, h) => `linear-gradient(${dir}, transparent calc(var(${c}) - (var(${h}) + var(--ff)) * var(--sp)), #000 calc(var(${c}) - var(${h}) * var(--sp)), #000 calc(var(${c}) + var(${h}) * var(--sp)), transparent calc(var(${c}) + (var(${h}) + var(--ff)) * var(--sp)))`;
  // band: one soft band parallel to the panel rows. rect: a soft rectangle (x band intersect y band) around a target.
  const mask =
    cfg.mode === "rect"
      ? `${lin("to right", "--fx", "--fw")}, ${lin("to bottom", "--fy", "--fh")};-webkit-mask-composite:source-in;mask-composite:intersect`
      : lin(`${bandAngle(S).toFixed(2)}deg`, "--fy", "--fh");
  const spread = cfg.spread ?? (cfg.mode === "rect" ? 1.35 : 2.3);
  return `${FONTS}
${R}{position:absolute;inset:0;overflow:hidden;background:${T.bg};color:${T.fg};font-family:"Inter Variable",sans-serif}
${R} .mk-stage{position:absolute;inset:0;--fx:960px;--fw:400px;--fy:540px;--fh:120px;--ff:${cfg.feather ?? 110}px}
${R} .mk-copy{position:absolute;inset:0;overflow:hidden}
${R} .mk-deep{filter:blur(${cfg.blur?.[0] ?? 26}px)}
${R} .mk-mid{filter:blur(${cfg.blur?.[1] ?? 8}px);--sp:${spread};-webkit-mask-image:${mask};mask-image:${mask}}
${R} .mk-sharp{--sp:1;-webkit-mask-image:${mask};mask-image:${mask}}
${R} .mk-br{position:absolute;inset:0;transform-origin:50% 50%}
${R} .mk-bg{position:absolute;inset:0;background:${cfg.ground ?? T.bg}}
${R} .mk-cam,${R} .mk-fcam{position:absolute;left:960px;top:540px;width:1920px;height:1080px;transform-origin:0 0}
${R} .mk-pan,${R} .mk-fpan{position:absolute;left:0;top:0;width:1920px;height:1080px}
${R} .mk-persp{position:absolute;left:0;top:0;width:1920px;height:1620px;perspective:${cfg.persp ?? 2600}px;perspective-origin:960px 200px}
${R} .mk-surf{position:absolute;left:${S.left}px;top:${S.top}px;width:${S.w}px;height:${S.h}px;transform:rotateX(${S.tilt}deg) rotateY(${S.ry || 0}deg) rotateZ(${S.rz || 0}deg);transform-origin:${S.origin ? S.origin[0] + "px " + S.origin[1] + "px" : "50% 100%"};border-radius:${S.round ?? 72}px;background:${S.bg ?? T.surface};box-shadow:inset 0 0 0 2px ${T.raise}${S.rim ? ", inset 0 3px 0 0 #2c2b28" : ""};overflow:hidden}
${R} .mk-fall{position:absolute;inset:0;background:linear-gradient(to bottom, ${T.bg} 0%, rgba(11,11,11,0.45) 18%, rgba(11,11,11,0) 45%)}
${R} .mk-sheen{position:absolute;pointer-events:none;overflow:hidden}
${R} .mk-sheen i{position:absolute;inset:0;background-size:300% 100%;background-position:140% 0%}
${R} .mk-a{position:absolute}
${R} .mk-disp{font-family:"Bricolage Grotesque Variable",sans-serif;font-weight:800;letter-spacing:-0.025em;line-height:1;white-space:nowrap}
${R} .mk-mono{font-family:"JetBrains Mono",monospace;font-weight:700}
${R} .mk-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 95% at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)}
${R} .mk-cursor{position:absolute;left:0;top:0;width:10px;height:10px}
${R} .mk-cursor .mk-cs{position:absolute;left:0;top:0;width:10px;height:10px;transform-origin:0 0}
${R} .hud{position:absolute;inset:0;pointer-events:none;font-family:"JetBrains Mono",monospace;font-size:15px;letter-spacing:0.08em;color:${T.fg}}
${R} .hud .hl{position:absolute;white-space:nowrap}
${R} .hud .soft{color:rgba(237,230,214,0.62);font-weight:500}
${R} .hud .ink{font-weight:700}
${cfg.css ?? ""}`;
}

function scene(cfg, i) {
  const s = (v) => (typeof v === "function" ? v(i) : v ?? "");
  return `<div class="mk-br">
<div class="mk-bg"></div>
<div class="mk-cam" data-layout-allow-overflow><div class="mk-pan" data-layout-allow-overflow><div class="mk-persp"><div class="mk-surf">${s(cfg.surfHtml)}${cfg.mode === "rect" ? "" : '<div class="mk-fall" data-layout-ignore data-layout-allow-occlusion></div>'}${s(cfg.surfTop)}</div></div>${s(cfg.worldHtml)}</div></div>
<div class="mk-fcam" data-layout-allow-overflow><div class="mk-fpan" data-layout-allow-overflow>${s(cfg.farHtml)}</div></div>
${s(cfg.screenHtml)}
${cfg.cursor ? `<div class="mk-cursor"><div class="mk-cs">${cursorSvg}</div></div>` : ""}
</div>`;
}

// Runtime kit (string, inlined per shot). Everything below is a pure function of the config.
const RUNTIME = String.raw`
  const R = document.getElementById(ID + "-root");
  const q = (s) => Array.from(R.querySelectorAll(s));
  const E = (n) => gsap.parseEase(n || "none");
  const tl = gsap.timeline({ paused: true });
  const P = C.persp || 2600, PY = 200, K = C.k == null ? 0.45 : C.k;
  const S = C.surf, rad = (S.tilt * Math.PI) / 180, COS = Math.cos(rad), SIN = Math.sin(rad);
  const RZ = ((S.rz || 0) * Math.PI) / 180, CZ = Math.cos(RZ), SZ = Math.sin(RZ);
  const RY = ((S.ry || 0) * Math.PI) / 180, CY = Math.cos(RY), SY = Math.sin(RY);
  const OX = S.origin ? S.origin[0] : S.w / 2, OY = S.origin ? S.origin[1] : S.h;
  const poy = (c) => (C.pyFollow ? c.y : PY);
  // focus band runs parallel to the panel rows (gradient-line coordinate for angle FA)
  const FA = (C.fa * Math.PI) / 180, FSIN = Math.sin(FA), FCOS = Math.cos(FA), FL = Math.abs(1920 * FSIN) + Math.abs(1080 * FCOS);
  const gl = (p) => (p.x - 960) * FSIN - (p.y - 540) * FCOS + FL / 2;
  const lerp = (a, b, u) => a + (b - a) * u;

  function cam(t) {
    const ks = C.cam;
    if (t <= ks[0].t || ks.length === 1) return ks[0];
    for (let i = 1; i < ks.length; i++) {
      const a = ks[i - 1], b = ks[i];
      if (t <= b.t) { const u = E(b.ease)((t - a.t) / (b.t - a.t)); return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) }; }
    }
    return ks[ks.length - 1];
  }
  const far = (c) => ({ x: 960 + (c.x - 960) * K, y: 540 + (c.y - 540) * K, z: 1 + (c.z - 1) * K });
  // screen position of a target at time t. {s:[u,v]} surface-local point, {f:[x,y]} far-layer point, {y} fixed screen y.
  function scr(tg, t) {
    const c = cam(t);
    if (tg.s) {
      // CSS rotateX(a) rotateY(b) rotateZ(c) about the origin: Rz, then Ry, then Rx, then perspective
      const px = tg.s[0] - OX, py = tg.s[1] - OY, x1 = px * CZ - py * SZ, y1 = px * SZ + py * CZ;
      const x2 = x1 * CY, z2 = -x1 * SY, y3 = y1 * COS - z2 * SIN, z3 = y1 * SIN + z2 * COS;
      const k = P / (P - z3), oy = poy(c);
      const Xw = c.x + (S.left + OX + x2 - c.x) * k, Yw = oy + (S.top + OY + y3 - oy) * k;
      return { x: 960 + (Xw - c.x) * c.z, y: 540 + (Yw - c.y) * c.z };
    }
    if (tg.f) { const f = far(c); return { x: 960 + (tg.f[0] - f.x) * f.z, y: 540 + (tg.f[1] - f.y) * f.z }; }
    return { x: 960, y: tg.y };
  }
  // rect focus: screen bbox of a target. {r:[u0,v0,u1,v1]} surface rect, {fr:[...]} far-layer rect, {sr:[...]} screen rect
  function rectOf(tg, t) {
    if (tg.sr) return tg.sr;
    const k = tg.r ? "s" : "f", b = tg.r || tg.fr, xs = [], ys = [];
    for (const u of [b[0], (b[0] + b[2]) / 2, b[2]]) for (const v of [b[1], b[3]]) { const p = scr({ [k]: [u, v] }, t); xs.push(p.x); ys.push(p.y); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function focusRect(t) {
    const ks = C.focus;
    const at = (key) => { const b = rectOf(key.tg, t), p = key.pad || 0; return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, w: (b[2] - b[0]) / 2 + p, h: (b[3] - b[1]) / 2 + p }; };
    let r;
    if (t <= ks[0].t || ks.length === 1) r = at(ks[0]);
    else {
      for (let i = 1; i < ks.length; i++) {
        const a = ks[i - 1], b = ks[i];
        if (t <= b.t) { const u = E(b.ease)((t - a.t) / (b.t - a.t)), A = at(a), B = at(b); r = { x: lerp(A.x, B.x, u), y: lerp(A.y, B.y, u), w: lerp(A.w, B.w, u), h: lerp(A.h, B.h, u) }; break; }
      }
      if (!r) r = at(ks[ks.length - 1]);
    }
    const br = 1 + 0.025 * Math.sin((t / 1.7) * Math.PI * 2); // focus breathing
    return { x: r.x, y: r.y, w: r.w * br, h: r.h * br };
  }
  function focus(t) {
    const ks = C.focus;
    let y, h;
    if (t <= ks[0].t || ks.length === 1) { y = gl(scr(ks[0].tg, t)); h = ks[0].h; }
    else {
      let done = false;
      for (let i = 1; i < ks.length; i++) {
        const a = ks[i - 1], b = ks[i];
        if (t <= b.t) { const u = E(b.ease)((t - a.t) / (b.t - a.t)); y = lerp(gl(scr(a.tg, t)), gl(scr(b.tg, t)), u); h = lerp(a.h, b.h, u); done = true; break; }
      }
      if (!done) { const l = ks[ks.length - 1]; y = gl(scr(l.tg, t)); h = l.h; }
    }
    // focus breathing: the band's depth swells and settles a hair
    h *= 1 + 0.06 * Math.sin((t / 1.7) * Math.PI * 2);
    return { y, h };
  }

  // ---- camera (all three copies move as one) ----
  const cams = q(".mk-cam"), pans = q(".mk-pan"), pers = q(".mk-persp"), fcams = q(".mk-fcam"), fpans = q(".mk-fpan");
  const poseOf = (c) => { const f = far(c); return {
    cam: { scale: c.z }, pan: { x: -c.x, y: -c.y }, per: { perspectiveOrigin: c.x.toFixed(2) + "px " + poy(c).toFixed(2) + "px" },
    fcam: { scale: f.z }, fpan: { x: -f.x, y: -f.y } }; };
  // NOTE: no tl.set() at 0. A nested child timeline is not re-rendered when the playhead lands exactly on its start,
  // so the local-0 pose must be the build-time state: every chain's first tween is an immediate-render fromTo.
  if (C.cam.length === 1) C.cam.push({ ...C.cam[0], t: DUR });
  for (let i = 1; i < C.cam.length; i++) {
    const a = poseOf(C.cam[i - 1]), b = poseOf(C.cam[i]), d = C.cam[i].t - C.cam[i - 1].t, at = C.cam[i - 1].t;
    const o = { duration: d, ease: C.cam[i].ease || "none", immediateRender: i === 1 };
    tl.fromTo(cams, a.cam, { ...b.cam, ...o }, at);
    tl.fromTo(pans, a.pan, { ...b.pan, ...o }, at);
    tl.fromTo(pers, a.per, { ...b.per, ...o }, at);
    tl.fromTo(fcams, a.fcam, { ...b.fcam, ...o }, at);
    tl.fromTo(fpans, a.fpan, { ...b.fpan, ...o }, at);
  }

  // ---- focus band (rack focus), sampled at 60 Hz ----
  const stage = R.querySelector(".mk-stage");
  const N = Math.ceil(DUR * 60);
  const FOC = C.mode === "rect" ? focusRect : focus;
  const fv = (f) => C.mode === "rect"
    ? { "--fx": f.x.toFixed(2) + "px", "--fw": f.w.toFixed(2) + "px", "--fy": f.y.toFixed(2) + "px", "--fh": f.h.toFixed(2) + "px" }
    : { "--fy": f.y.toFixed(2) + "px", "--fh": f.h.toFixed(2) + "px" };
  tl.fromTo(stage, fv(FOC(0)), { ...fv(FOC(1 / 60)), duration: 1 / 60, ease: "none" }, 0);
  const kf = [];
  for (let i = 2; i <= N; i++) kf.push({ ...fv(FOC(Math.min(DUR, i / 60))), duration: 1 / 60 });
  tl.to(stage, { keyframes: kf, ease: "none", immediateRender: false }, 1 / 60);

  // ---- lens breathing: bounded finite yoyo ----
  const BR = 0.85;
  tl.fromTo(q(".mk-br"), { scale: 1 }, { scale: 1.012, duration: BR, ease: "sine.inOut", yoyo: true, repeat: Math.max(0, Math.floor(DUR / BR) - 1) }, 0);

  // ---- helpers for shot code ----
  function sweep(cls, t0, t1, p0 = 140, p1 = -40, ease = "power2.inOut") {
    tl.fromTo(q("." + cls + " i"), { backgroundPosition: p0 + "% 0%" }, { backgroundPosition: p1 + "% 0%", duration: t1 - t0, ease }, t0);
  }
  function press(cls, t, { fillFrom = 0, label = true, squeeze = 0.965 } = {}) {
    const el = q("." + cls);
    tl.fromTo(el, { scale: 1 }, { scale: squeeze, duration: 0.07, ease: "power2.out", immediateRender: false }, t - 0.04);
    tl.fromTo(el, { scale: squeeze }, { scale: 1, duration: 0.26, ease: "power3.out", immediateRender: false }, t + 0.12);
    tl.fromTo(q("." + cls + " .mk-fill"), { opacity: fillFrom, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.32, ease: "back.out(1.6)" }, t);
    if (label) tl.fromTo(q("." + cls + " .mk-lab"), { color: C.labFrom || "${T.fg}" }, { color: "${T.ink}", duration: 0.16, ease: "power1.out" }, t + 0.02);
  }
  function cursor(keys) {
    // keys: [{t, x, y, click?}] in screen px; tip lands exactly on (x, y)
    const el = q(".mk-cursor"), cs = q(".mk-cursor .mk-cs");
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      tl.fromTo(el, { x: a.x, y: a.y }, { x: b.x, y: b.y, duration: b.t - a.t, ease: b.ease || "power2.inOut", immediateRender: i === 1 }, a.t);
      if (b.click) {
        tl.fromTo(cs, { scale: 1 }, { scale: 0.86, duration: 0.07, ease: "power2.out", immediateRender: false }, b.t - 0.04);
        tl.fromTo(cs, { scale: 0.86 }, { scale: 1, duration: 0.24, ease: "power3.out", immediateRender: false }, b.t + 0.1);
      }
    }
  }
  // HUD running timecode (60 fps, film time). The text at local 0 is authored in the HTML.
  if (C.hud) {
    const tc = q(".hud .tc"), clock = { f: 0 };
    const two = (n) => String(n).padStart(2, "0");
    const fmt = (f) => { const s = Math.floor(f / 60), m = Math.floor(s / 60); return "00:" + two(m) + ":" + two(s % 60) + ":" + two(f % 60); };
    const F0 = Math.round(C.hud.start * 60);
    tl.fromTo(clock, { f: 0 }, { f: DUR * 60, duration: DUR, ease: "none", onUpdate: () => { const s = fmt(F0 + Math.floor(clock.f + 1e-6)); for (const el of tc) if (el.textContent !== s) el.textContent = s; } }, 0);
  }
  // hold a value from 0, then move it at t (both seek-safe, no zero-duration sets)
  function holdThen(sel, prop, a, b, t, d, ease = "power2.out") {
    tl.fromTo(q(sel), { [prop]: a }, { [prop]: a, duration: t, ease: "none" }, 0);
    tl.fromTo(q(sel), { [prop]: a }, { [prop]: b, duration: d, ease, immediateRender: false }, t);
  }
`;

/** Generated markup goes in as one line per optical copy (three copies of the scene would otherwise be ~300 lines). */
const oneLine = (html) => html.replace(/\n\s*/g, " ");

/** Showreel HUD chrome: corner brackets, logo + chapter, timecode, tempo, format. Static except the timecode. */
function hud({ n, name, start }) {
  const m = 44, L = 34, W = 1920, H = 1080;
  const br = (x, y, sx, sy) => `<path d="M${x} ${y + sy * L} L${x} ${y} L${x + sx * L} ${y}" fill="none" stroke="${T.fg}" stroke-width="2"/>`;
  const f = Math.round(start * 60), s = Math.floor(f / 60), two = (v) => String(v).padStart(2, "0");
  const tc = `00:${two(Math.floor(s / 60))}:${two(s % 60)}:${two(f % 60)}`;
  return `<div class="hud" data-layout-ignore>
  <svg width="${W}" height="${H}" style="position:absolute;inset:0"><defs><linearGradient id="hudfade-${n}-${f}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="0.111" stop-color="#000" stop-opacity="0"/><stop offset="0.87" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#hudfade-${n}-${f})"/>${br(m, m, 1, 1)}${br(W - m, m, -1, 1)}${br(m, H - m, 1, -1)}${br(W - m, H - m, -1, -1)}</svg>
  <div class="hl ink" style="left:96px;top:52px;display:flex;align-items:center;gap:12px">${finSvg(30, T.fg)}<span>MAKO MARKET · ${name}</span></div>
  <div class="hl ink" style="right:96px;top:58px">${n} · ${name}</div>
  <div class="hl soft tc" style="left:96px;bottom:54px;font-variant-numeric:tabular-nums">${tc}</div>
  <div class="hl soft" style="left:0;right:0;bottom:54px;text-align:center">120 BPM · ${n} / 09</div>
  <div class="hl soft" style="right:96px;bottom:54px">1920x1080 · 60P</div>
</div>`;
}

export function composition(id, cfg) {
  const copies = [
    ["mk-deep", 0],
    ["mk-mid", 1],
    ["mk-sharp", 2],
  ];
  const conf = {
    surf: cfg.surf,
    cam: cfg.cam,
    focus: cfg.focus,
    k: cfg.k,
    fa: bandAngle(cfg.surf),
    mode: cfg.mode,
    persp: cfg.persp,
    pyFollow: cfg.pyFollow,
    hud: cfg.hud ? { start: cfg.hud.start } : undefined,
    labFrom: cfg.labFrom,
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${id} MACRO</title>
  </head>
  <body>
    <template id="${id}-template">
      <style>
${css(id, cfg)}
      </style>
      <div id="${id}-root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="${cfg.dur}">
        <div class="mk-stage">
${copies.map(([c, i]) => `<div class="mk-copy ${c}"${i < 2 ? " data-layout-ignore" : ""}>${oneLine(scene(cfg, i))}</div>`).join("\n")}
        </div>
        <div class="mk-vig" data-layout-ignore></div>
${cfg.overlayHtml ?? ""}
${cfg.hud ? hud(cfg.hud) : ""}
      </div>
      <script>
        (function () {
          const ID = "${id}", DUR = ${cfg.dur};
          const C = ${JSON.stringify(conf)};
${RUNTIME}
          // ---- shot-specific motion ----
${cfg.js}
          window.__timelines[ID] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;
}
