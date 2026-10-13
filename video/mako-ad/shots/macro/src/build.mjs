// node src/build.mjs  -> writes compositions/sNN.html + index.html
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { T, sheen, finSvg, composition } from "./kit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(ROOT, "compositions"), { recursive: true });

// ---------------------------------------------------------------- shared pieces
const spill = (cls, x, y, w, h, rgb = "250,204,21", a = 0.3) =>
  `<div class="mk-a ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:radial-gradient(closest-side, rgba(${rgb},${a}), rgba(${rgb},${(a / 3).toFixed(3)}) 55%, rgba(${rgb},0) 100%)"></div>`;

const farLine = (text, y, size, cls = "sh-head") => `
<div class="mk-a" style="left:0;top:${y}px;width:1920px;height:${Math.round(size * 1.25)}px;display:flex;justify-content:center;align-items:center">
  <div style="position:relative;padding:0 30px">
    <div class="mk-disp" data-layout-allow-occlusion style="font-size:${size}px;color:${T.fg}">${text}</div>
    ${sheen(cls, { angle: 100, strength: 1.1, inset: "-20px -40px" })}
  </div>
</div>`;

const shots = {};

// ================================================================ IN THE PRODUCT (01, 02, 22, 28, 34)
// The real page rebuilt at 2400 x 1400 local px: header, title, chart with yellow/red candles, pots bar, and the bet
// panel on the right. Gentle 3D (a few degrees of rotateX/rotateY), the panel sharp inside a soft focus rectangle,
// the rest of the page deep in the 26px copy. Panel copy is real app copy; no prices, balances, odds or counts.
const PAGE = { left: -240, top: -160, w: 2400, h: 1400, round: 28, bg: "#050505", origin: [1200, 700] };
const PANEL_R = [1490, 372, 2340, 1032]; // bet panel rect (local) used for focus
const CTA_R = [1500, 898, 2330, 1022];
const YES_R = [1510, 442, 1910, 554];
const CHART_R = [70, 400, 1420, 960];

const CANDLES = (() => {
  const out = [];
  let v = 0, s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 64; i++) {
    const o = v, c = Math.max(-0.92, Math.min(0.92, v + (rnd() - 0.46) * 0.22));
    const h = Math.max(o, c) + rnd() * 0.07, l = Math.min(o, c) - rnd() * 0.07;
    out.push({ o, c, h, l });
    v = c;
  }
  return out;
})();
const chartSvg = (w, h) => {
  const slot = w / CANDLES.length, pad = 26, y = (v) => pad + (1 - (v + 1) / 2) * (h - pad * 2);
  let g = "";
  for (const f of [0.2, 0.4, 0.6, 0.8]) g += `<line x1="0" x2="${w}" y1="${h * f}" y2="${h * f}" stroke="#141413" stroke-width="2"/><line y1="0" y2="${h}" x1="${w * f}" x2="${w * f}" stroke="#141413" stroke-width="2"/>`;
  CANDLES.forEach((c, i) => {
    const col = c.c >= c.o ? T.signal : T.red, x = i * slot + slot / 2, top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="3"/><rect x="${(x - slot * 0.32).toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" y="${top.toFixed(1)}" height="${Math.max(4, bot - top).toFixed(1)}" fill="${col}" rx="2"/>`;
  });
  return `<svg class="mk-a" style="left:${CHART_R[0]}px;top:${CHART_R[1]}px" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${g}</svg>`;
};

const bar = (x, y, w, h, c = "#2a2926") => `<div class="mk-a" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${h / 2}px;background:${c}"></div>`;

// page chrome around the panel (all of it ends up deep in the blur)
const pageShell = ({ nav = 0, upShare = 0.58 } = {}) => `
<div class="mk-a" style="left:70px;top:52px">${finSvg(48, T.fg)}</div>
${bar(136, 64, 210, 28, "#2f2e2b")}
<div class="mk-a" style="left:520px;top:44px;width:600px;height:64px;border-radius:9999px;background:${T.raise};display:flex;gap:6px;padding:7px;box-sizing:border-box">${[0, 1, 2, 3, 4]
  .map((i) => `<span style="flex:1;border-radius:9999px;background:${i === nav ? T.fg : "transparent"}"></span>`)
  .join("")}</div>
<div class="mk-a" style="left:2060px;top:46px;width:90px;height:60px;border-radius:9999px;box-shadow:inset 0 0 0 2px #1c1c1a"></div>
<div class="mk-a" style="left:2170px;top:46px;width:170px;height:60px;border-radius:9999px;background:${T.signal}"></div>
${bar(70, 168, 380, 22)}
${bar(70, 212, 1180, 66, "#353430")}
${bar(70, 296, 720, 66, "#2c2b28")}
${bar(1890, 190, 440, 96, "#2a2926")}
${bar(70, 372, 210, 22)}
${chartSvg(CHART_R[2] - CHART_R[0], CHART_R[3] - CHART_R[1])}
<div class="mk-a" style="left:70px;top:1010px;width:1350px;height:44px;border-radius:9999px;overflow:hidden;display:flex;background:#181715"><span style="width:${upShare * 100}%;background:${T.signal}"></span><span style="flex:1;background:${T.red}"></span></div>
${bar(70, 1080, 1100, 22, "#1f1e1c")}
${bar(70, 1118, 820, 22, "#1f1e1c")}`;

// the bet panel (local px, top-left at PANEL_R). side: "pool" (YES/NO) or "round" (UP/DOWN).
const betPanel = ({ side = "pool", picked = false } = {}) => {
  const [a, b] = side === "pool" ? ["YES", "NO"] : ["↑ UP", "↓ DOWN"];
  return `
<div class="mk-a" style="left:1500px;top:380px;width:830px">
  ${bar(0, 0, 330, 30)}
  ${bar(640, 4, 190, 22, "#22211f")}
  <div class="mk-a" style="left:0;top:60px;width:830px;height:132px;padding:10px;gap:10px;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;border-radius:9999px;background:${T.raise}">
    <div class="mk-yes" style="position:relative;border-radius:9999px;display:flex;align-items:center;justify-content:center">
      <div class="mk-fill" style="position:absolute;inset:0;border-radius:9999px;background:${T.signal};box-shadow:0 0 70px 12px rgba(250,204,21,0.45);opacity:${picked ? 1 : 0}"></div>
      <span class="mk-lab mk-disp" data-layout-allow-occlusion style="position:relative;font-size:62px;letter-spacing:-0.02em;color:${picked ? T.ink : T.fg}">${a}</span>
    </div>
    <div style="position:relative;border-radius:9999px;display:flex;align-items:center;justify-content:center">
      <span class="mk-disp" data-layout-allow-occlusion style="position:relative;font-size:62px;letter-spacing:-0.02em;color:${T.dim}">${b}</span>
    </div>
    ${sheen("sh-toggle", { round: 9999, strength: 1.2 })}
  </div>
  <div class="mk-a" style="left:0;top:222px;width:830px;height:160px;border-radius:24px;background:${T.raise};overflow:hidden">
    <span class="mk-a mk-disp" data-layout-allow-occlusion style="left:36px;top:34px;font-size:96px;letter-spacing:-0.02em;color:${T.fg}">0.10</span>
    <span class="mk-a mk-mono" data-layout-allow-occlusion style="right:36px;bottom:30px;font-size:28px;font-weight:500;letter-spacing:0.06em;color:${T.dim}">USDC</span>
    ${sheen("sh-field", { round: 24, strength: 1.0 })}
  </div>
  <div class="mk-a" style="left:0;top:412px;width:830px;display:grid;grid-template-columns:repeat(6,1fr);gap:12px">${["0.10", "1", "5", "10", "25", "50"]
    .map((c) => {
      const on = c === "0.10";
      return `<div style="position:relative;height:76px;border-radius:9999px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:${on ? T.fg : T.raise};color:${on ? T.ink : T.fg};font:700 28px 'JetBrains Mono',monospace"><span style="position:relative">${c}</span></div>`;
    })
    .join("")}</div>
  <div class="mk-a mk-cta" style="left:0;top:518px;width:830px;height:124px">
    <div class="mk-a mk-ctaglow" style="inset:0;border-radius:9999px;box-shadow:0 0 90px 16px rgba(250,204,21,0.55);opacity:0.45"></div>
    <div class="mk-a mk-ctabody" style="inset:0;border-radius:9999px;background:${T.signal};overflow:hidden;display:flex;align-items:center;justify-content:center">
      <span class="mk-disp" data-layout-allow-occlusion style="position:relative;font-size:50px;letter-spacing:-0.02em;color:${T.ink}">Confirm · 0.10 USDC</span>
      ${sheen("sh-cta", { round: 9999, strength: 1.4 })}
    </div>
  </div>
</div>`;
};

// settled pool card for 28: cyan Refund status pill and Refund button
const refundIcon = (c, s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>`;
const settledCard = () => `
<div class="mk-a" style="left:1500px;top:380px;width:830px">
  ${bar(0, 8, 300, 30)}
  <div class="mk-a mk-pill" style="right:0;top:0;height:64px;padding:0 26px 0 20px;border-radius:9999px;background:rgba(6,182,212,0.1);box-shadow:inset 0 0 0 3px ${T.cyan};display:flex;align-items:center;gap:12px">
    ${refundIcon(T.cyan, 34)}<span class="mk-disp" data-layout-allow-occlusion style="font-size:36px;letter-spacing:-0.01em;color:${T.cyan}">Refund</span>
  </div>
  ${bar(0, 112, 800, 56, "#3a3834")}
  ${bar(0, 186, 540, 56, "#33322e")}
  <div class="mk-a" style="left:0;top:290px;width:830px;height:34px;border-radius:9999px;overflow:hidden;background:#181715"><span style="display:block;width:100%;height:100%;background:${T.signal};opacity:.55"></span></div>
  ${bar(0, 350, 620, 24, "#24231f")}
  ${bar(0, 390, 460, 24, "#24231f")}
  <div class="mk-a mk-cta" style="left:0;top:470px;width:830px;height:124px">
    <div class="mk-a mk-ctaglow" style="inset:0;border-radius:9999px;box-shadow:0 0 90px 16px rgba(6,182,212,0.5);opacity:0.5"></div>
    <div class="mk-a mk-ctabody" style="inset:0;border-radius:9999px;background:${T.cyan};overflow:hidden;display:flex;align-items:center;justify-content:center;gap:18px">
      ${refundIcon(T.ink, 50)}<span class="mk-disp" data-layout-allow-occlusion style="position:relative;font-size:54px;letter-spacing:-0.02em;color:${T.ink}">Refund</span>
      ${sheen("sh-cta", { round: 9999, strength: 1.4 })}
    </div>
  </div>
</div>`;

const panelSpill = (rgb = "250,204,21", a = 0.2) => spill("mk-spill", 1300, 250, 1250, 950, rgb, a);

// screen-space headline that lands sharp over the soft page (outside the optical stack)
const landLine = (text, { x = 0, y = 440, w = 1920, size = 140, align = "center" } = {}) => `
<div class="mk-a mk-scrim" data-layout-ignore style="inset:0;opacity:0;background:radial-gradient(70% 60% at ${align === "center" ? "50%" : "30%"} ${((y + size / 2) / 10.8).toFixed(1)}%, rgba(0,0,0,0.62), rgba(0,0,0,0) 100%)"></div>
<div class="mk-a mk-land" style="left:${x}px;top:${y}px;width:${w}px;display:flex;justify-content:${align === "center" ? "center" : "flex-start"};opacity:0">
  <div style="position:relative;padding:0 30px">
    <div class="mk-disp mk-landtx" style="font-size:${size}px;letter-spacing:-0.035em;padding:0.08em 0;color:transparent;-webkit-background-clip:text;background-clip:text;background-image:linear-gradient(100deg, ${T.fg} 0%, ${T.fg} 42%, #ffffff 50%, ${T.fg} 58%, ${T.fg} 100%);background-size:300% 100%;background-position:100% 0%">${text}</div>
  </div>
</div>`;
const LAND_JS = (t0, d = 0.5) => `
    tl.fromTo(q(".mk-land"), { opacity: 0, y: 26, scale: 1.035, filter: "blur(16px)" }, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: ${d}, ease: "power3.out" }, ${t0});
    tl.fromTo(q(".mk-scrim"), { opacity: 0 }, { opacity: 1, duration: ${d}, ease: "power2.out" }, ${t0 - 0.05});
    // light sweep through the letterforms (gradient clipped to the text)
    tl.fromTo(q(".mk-landtx"), { backgroundPosition: "100% 0%" }, { backgroundPosition: "0% 0%", duration: 0.8, ease: "power2.inOut" }, ${t0 + d * 0.5});`;

const PRODUCT = { mode: "rect", persp: 2600, pyFollow: true, feather: 90 };

// ---- 01  Pools bet panel, slow push, cursor presses YES at ~1.0 s, YES glows. Opens lit. (2.0 s, key 1.6)
shots.s01 = {
  ...PRODUCT,
  dur: 2.0,
  hud: { n: "01", name: "HOOK", start: 0 },
  surf: { ...PAGE, tilt: 8, ry: -10, rz: 1.5 },
  surfHtml: `${panelSpill()}${pageShell({ nav: 0 })}${betPanel({ side: "pool" })}`,
  surfTop: sheen("sh-surf", { strength: 0.5 }),
  cursor: true,
  cam: [
    { t: 0, x: 1470, y: 545, z: 1.1 },
    { t: 2.0, x: 1505, y: 548, z: 1.2, ease: "sine.inOut" },
  ],
  focus: [{ t: 0, tg: { r: PANEL_R }, pad: 30 }],
  tune: { target: PANEL_R, key: 1.6 },
  js: `
    const CLICK = 1.0;
    holdThen(".mk-spill", "opacity", 0.55, 1, CLICK, 0.5);
    sweep("sh-toggle", 0, 1.6, 120, -40, "sine.inOut");
    sweep("sh-field", 0.2, 1.8, 120, -40, "sine.inOut");
    sweep("sh-cta", 0.35, 1.95, 120, -40, "sine.inOut");
    sweep("sh-surf", 0, 2.0, 100, -40, "sine.inOut");
    press("mk-yes", CLICK);
    const yes = scr({ s: [1840, 540] }, CLICK);
    cursor([
      { t: 0, x: 1820, y: 1000 },
      { t: CLICK, x: yes.x, y: yes.y, click: true, ease: "power3.inOut" },
      { t: CLICK + 0.3, x: yes.x + 4, y: yes.y + 3, ease: "none" },
      { t: 2.0, x: yes.x + 150, y: yes.y + 360, ease: "sine.inOut" },
    ]);
  `,
};

// ---- 02  focus racks off the panel (it goes soft) and the headline lands sharp over it. (1.5 s, key 1.2)
shots.s02 = {
  ...PRODUCT,
  dur: 1.5,
  hud: { n: "01", name: "HOOK", start: 2.0 },
  surf: { ...PAGE, tilt: 8, ry: -10, rz: 1.5 },
  surfHtml: `${panelSpill()}${pageShell({ nav: 0 })}${betPanel({ side: "pool", picked: true })}`,
  surfTop: sheen("sh-surf", { strength: 0.5 }),
  overlayHtml: landLine("What happens next?", { y: 455, size: 150 }),
  cam: [
    { t: 0, x: 1505, y: 548, z: 1.2 },
    { t: 1.5, x: 1420, y: 540, z: 1.08, ease: "power2.out" },
  ],
  focus: [
    { t: 0, tg: { r: PANEL_R }, pad: 30 },
    { t: 0.6, tg: { r: CTA_R }, pad: 0, ease: "power2.inOut" },
  ],
  js: `
    // rack off: the sharp copy, then the light-blur copy, fall away so the whole page goes soft
    tl.fromTo(q(".mk-sharp"), { opacity: 1 }, { opacity: 0, duration: 0.42, ease: "power2.inOut" }, 0.08);
    tl.fromTo(q(".mk-mid"), { opacity: 1 }, { opacity: 0, duration: 0.6, ease: "power2.inOut" }, 0.18);
    sweep("sh-cta", 0, 0.8, 90, -40, "sine.out");
    ${LAND_JS(0.42, 0.55)}
  `,
};

// ---- 22  same panel, different angle; YES already picked; cursor presses the CTA, it glows. (1.5 s, key 1.0)
shots.s22 = {
  ...PRODUCT,
  dur: 1.5,
  hud: { n: "04", name: "BET", start: 28.0 },
  surf: { ...PAGE, tilt: 11, ry: 11, rz: -2 },
  surfHtml: `${panelSpill("250,204,21", 0.22)}${pageShell({ nav: 0 })}${betPanel({ side: "pool", picked: true })}`,
  surfTop: sheen("sh-surf", { strength: 0.5 }),
  cursor: true,
  cam: [
    { t: 0, x: 1560, y: 640, z: 1.22 },
    { t: 1.5, x: 1585, y: 660, z: 1.3, ease: "sine.inOut" },
  ],
  focus: [
    { t: 0, tg: { r: PANEL_R }, pad: 20 },
    { t: 0.5, tg: { r: [1490, 600, 2340, 1032] }, pad: 30, ease: "power2.inOut" },
  ],
  tune: { target: CTA_R, key: 1.0 },
  js: `
    const CLICK = 0.55;
    holdThen(".mk-spill", "opacity", 0.5, 1, CLICK, 0.5);
    holdThen(".mk-ctaglow", "opacity", 0.4, 1, CLICK, 0.4);
    tl.fromTo(q(".mk-ctabody"), { scale: 1 }, { scale: 0.975, duration: 0.07, ease: "power2.out", immediateRender: false }, CLICK - 0.04);
    tl.fromTo(q(".mk-ctabody"), { scale: 0.975 }, { scale: 1, duration: 0.28, ease: "power3.out", immediateRender: false }, CLICK + 0.12);
    tl.fromTo(q(".mk-ctabody"), { filter: "brightness(1)" }, { filter: "brightness(1.12)", duration: 0.3, ease: "power2.out", immediateRender: false }, CLICK);
    sweep("sh-cta", 0.6, 1.35, 140, -40, "power2.inOut");
    sweep("sh-toggle", 0, 1.2, 100, -40, "sine.inOut");
    sweep("sh-surf", 0, 1.5, 110, -40, "sine.inOut");
    const pt = scr({ s: [2120, 980] }, CLICK);
    cursor([
      { t: 0, x: pt.x + 300, y: pt.y + 330 },
      { t: CLICK, x: pt.x, y: pt.y, click: true, ease: "power3.inOut" },
      { t: CLICK + 0.3, x: pt.x + 4, y: pt.y + 3, ease: "none" },
      { t: 1.5, x: pt.x + 200, y: pt.y + 300, ease: "sine.inOut" },
    ]);
  `,
};

// ---- 28  settled pool card, cyan Refund pill and button; headline lands. (2.0 s, key 1.4)
shots.s28 = {
  ...PRODUCT,
  dur: 2.0,
  hud: { n: "05", name: "PAYOUT", start: 38.0 },
  surf: { ...PAGE, tilt: 8, ry: -9, rz: 1 },
  surfHtml: `${panelSpill("6,182,212", 0.2)}${pageShell({ nav: 0, upShare: 1 })}${settledCard()}`,
  surfTop: sheen("sh-surf", { strength: 0.5 }),
  overlayHtml: landLine("No fee on refunds.", { x: 110, y: 150, w: 1100, size: 112, align: "left" }),
  cam: [
    { t: 0, x: 1220, y: 440, z: 0.97 },
    { t: 2.0, x: 1200, y: 428, z: 0.93, ease: "sine.inOut" },
  ],
  focus: [{ t: 0, tg: { r: [1490, 372, 2340, 1000] }, pad: 30 }],
  tune: { target: [1490, 372, 2340, 1000], key: 1.4 },
  js: `
    holdThen(".mk-ctaglow", "opacity", 0.45, 0.85, 0.2, 0.8, "sine.inOut");
    sweep("sh-cta", 0.05, 0.9, 120, -40, "sine.inOut");
    sweep("sh-surf", 0, 2.0, 110, -40, "sine.inOut");
    ${LAND_JS(0.75, 0.55)}
  `,
};

// ---- 34  round page: chart with candles and the UP/DOWN panel; focus racks to the headline. (2.0 s, key 1.4)
shots.s34 = {
  ...PRODUCT,
  dur: 2.0,
  hud: { n: "07", name: "ROUNDS", start: 49.0 },
  surf: { ...PAGE, tilt: 7, ry: 9, rz: -1 },
  surfHtml: `${spill("mk-spill", 0, 260, 1500, 900, "250,204,21", 0.12)}${pageShell({ nav: 1 })}${betPanel({ side: "round", picked: true })}`,
  surfTop: sheen("sh-surf", { strength: 0.5 }),
  overlayHtml: landLine("Prices from Chainlink.", { y: 455, size: 140 }),
  cam: [
    { t: 0, x: 900, y: 560, z: 0.9 },
    { t: 2.0, x: 980, y: 548, z: 0.82, ease: "sine.inOut" },
  ],
  focus: [
    { t: 0, tg: { r: CHART_R }, pad: 20 },
    { t: 0.6, tg: { r: CHART_R }, pad: 20 },
  ],
  tune: { target: CHART_R, key: 1.4 },
  js: `
    tl.fromTo(q(".mk-sharp"), { opacity: 1 }, { opacity: 0, duration: 0.45, ease: "power2.inOut" }, 0.55);
    tl.fromTo(q(".mk-mid"), { opacity: 1 }, { opacity: 0, duration: 0.6, ease: "power2.inOut" }, 0.65);
    sweep("sh-surf", 0, 1.4, 110, -40, "sine.inOut");
    ${LAND_JS(0.8, 0.55)}
  `,
};
// ================================================================ 37  the shark-fin logo, light sweep, rack focus. (2.0 s, key 1.4)
const FIN_W = 860;
const bigFin = (i) => `
<div class="mk-a" style="left:${960 - FIN_W / 2}px;top:${470 - (FIN_W * 316) / 406 / 2}px">
  <svg viewBox="-3 -3 406 316" width="${FIN_W}" height="${((FIN_W * 316) / 406).toFixed(1)}" style="display:block;overflow:visible">
    <defs>
      <linearGradient id="s37-fin-${i}" class="mk-fing" gradientUnits="objectBoundingBox" x1="-1.2" y1="0" x2="-0.2" y2="0.35">
        <stop offset="0" stop-color="#a7a194"/><stop offset="0.4" stop-color="#d9d2c2"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="0.6" stop-color="#d9d2c2"/><stop offset="1" stop-color="#a7a194"/>
      </linearGradient>
      <linearGradient id="s37-edge-${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.0"/><stop offset="1" stop-color="${T.signal}" stop-opacity="0.35"/></linearGradient>
    </defs>
    <path d="M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z" fill="url(#s37-fin-${i})" stroke="url(#s37-fin-${i})" stroke-width="3" stroke-linejoin="round"/>
    <path d="M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z" fill="url(#s37-edge-${i})"/>
  </svg>
</div>`;
const rings = (() => {
  let g = "";
  for (let r = 160; r <= 1100; r += 150) g += `<circle cx="1150" cy="520" r="${r}" fill="none" stroke="rgba(237,230,214,${(0.1 - r / 16000).toFixed(3)})" stroke-width="4"/>`;
  return g;
})();
shots.s37 = {
  dur: 2.0,
  k: 0.6,
  surf: { left: -190, top: -150, w: 2300, h: 1150, tilt: 74 },
  surfHtml: `${spill("mk-spill", 350, -200, 1600, 1400, "237,230,214", 0.18)}
<svg class="mk-a" style="left:0;top:0" width="2300" height="1150" viewBox="0 0 2300 1150">${rings}</svg>
${spill("mk-spill2", 650, 120, 1000, 800, "250,204,21", 0.22)}`,
  farHtml: bigFin,
  cam: [
    { t: 0, x: 780, y: 640, z: 1.62 },
    { t: 2.0, x: 1080, y: 560, z: 1.34, ease: "sine.inOut" },
  ],
  focus: [
    { t: 0, tg: { f: [960, 720] }, h: 110 },
    { t: 0.15, tg: { f: [960, 720] }, h: 110 },
    { t: 1.25, tg: { f: [960, 330] }, h: 150, ease: "power2.inOut" },
    { t: 2.0, tg: { f: [960, 300] }, h: 160, ease: "sine.inOut" },
  ],
  js: `
    // specular stop travels across the brushed fin
    tl.fromTo(q(".mk-fing"), { attr: { x1: -1.1, x2: -0.1 } }, { attr: { x1: 0.6, x2: 1.6 }, duration: 1.8, ease: "sine.inOut" }, 0.15);
    tl.fromTo(q(".mk-spill2"), { opacity: 0.5 }, { opacity: 1, duration: 1.2, ease: "sine.inOut" }, 0.4);
  `,
};

// ---------------------------------------------------------------- write
const ORDER = ["s01", "s02", "s22", "s28", "s34", "s37"];
const KEY = { s01: 1.6, s02: 1.2, s22: 1.0, s28: 1.4, s34: 1.4, s37: 1.4 };
let t = 0;
const slots = [];
const keys = [];
for (const id of ORDER) {
  const cfg = shots[id];
  writeFileSync(join(ROOT, "compositions", `${id}.html`), composition(id, cfg));
  slots.push(
    `      <div id="el-${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${t.toFixed(2)}" data-duration="${cfg.dur}" data-track-index="1" data-width="1920" data-height="1080"></div>`,
  );
  keys.push({ id, at: +(t + KEY[id]).toFixed(3), start: +t.toFixed(3), dur: cfg.dur });
  t += cfg.dur;
}
writeFileSync(
  join(ROOT, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="assets/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #0b0b0b; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b0b0b; }
      [data-composition-id="macro"] > div[data-composition-src] { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="macro" data-width="1920" data-height="1080" data-duration="${t.toFixed(2)}">
${slots.join("\n")}
    </div>
    <script>
      window.__timelines["macro"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`,
);
writeFileSync(join(ROOT, "src", "keys.json"), JSON.stringify(keys, null, 1));
console.log("total", t, keys.map((k) => `${k.id}@${k.at}`).join(" "));

// ---------------------------------------------------------------- framing report: node src/build.mjs --tune
if (process.argv.includes("--tune")) {
  const { createRequire } = await import("node:module");
  const gsap = createRequire(import.meta.url)("./gsap.cjs").gsap;
  const E = (n) => gsap.parseEase(n || "none");
  for (const id of ORDER) {
    const c = shots[id], S = c.surf;
    const cam = (t) => {
      const ks = c.cam;
      if (t <= ks[0].t || ks.length === 1) return ks[0];
      for (let i = 1; i < ks.length; i++) { const a = ks[i - 1], b = ks[i]; if (t <= b.t) { const u = E(b.ease)((t - a.t) / (b.t - a.t)); return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }; } }
      return ks[ks.length - 1];
    };
    const r = (d) => ((d || 0) * Math.PI) / 180, ax = r(S.tilt), ay = r(S.ry), az = r(S.rz), P = c.persp || 2600;
    const OX = S.origin ? S.origin[0] : S.w / 2, OY = S.origin ? S.origin[1] : S.h;
    const scr = (u, v, t) => {
      const C = cam(t), px = u - OX, py = v - OY, x1 = px * Math.cos(az) - py * Math.sin(az), y1 = px * Math.sin(az) + py * Math.cos(az);
      const x2 = x1 * Math.cos(ay), z2 = -x1 * Math.sin(ay), y3 = y1 * Math.cos(ax) - z2 * Math.sin(ax), z3 = y1 * Math.sin(ax) + z2 * Math.cos(ax);
      const k = P / (P - z3), oy = c.pyFollow ? C.y : 200;
      const Xw = C.x + (S.left + OX + x2 - C.x) * k, Yw = oy + (S.top + OY + y3 - oy) * k;
      return [960 + (Xw - C.x) * C.z, 540 + (Yw - C.y) * C.z];
    };
    const box = (b, t) => { const p = [scr(b[0], b[1], t), scr(b[2], b[1], t), scr(b[0], b[3], t), scr(b[2], b[3], t)]; const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round); };
    const tg = c.tune?.target;
    for (const t of [0, c.tune?.key ?? KEY[id], c.dur]) {
      const pb = box([0, 0, S.w, S.h], t);
      const tb = tg ? box(tg, t) : null;
      console.log(id, "t=" + t, "panel", pb.join(","), tb ? `target ${tb.join(",")} w=${((tb[2] - tb[0]) / 1920).toFixed(2)}` : "");
    }
  }
}
