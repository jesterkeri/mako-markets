// Mako Market ad, EXPL style kit (Exploded UI). Shared by compositions/sNN.html.
// Pure factories: no module-level state, so several shots can import it at once.
// Every frame is render(t) from local shot time; no clocks, no randomness.
import * as THREE from "./three.module.min.js";
import { RoundedBoxGeometry } from "./RoundedBoxGeometry.js";

export { THREE, RoundedBoxGeometry };

export const W = 1920;
export const H = 1080;
export const C = {
  paper: "#EBE5D9",
  paper2: "#E1DBCB",
  paper3: "#D6CFBE",
  sheet: "#F6F2E9",
  chip: "#FBF8F1",
  ink: "#000000",
  yes: "#FACC15",
  no: "#D94A3D",
  dark: "#121212",
  light: "#EDE6D6",
  grey: "#7a7466",
};
export const BR = '"Bricolage Grotesque Variable", sans-serif';
export const MO = '"JetBrains Mono", monospace';
export const IN = '"Inter Variable", sans-serif';
export const FIN = "M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z";

// ---------- easing (all clamp their input) ----------
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, u) => a + (b - a) * u;
export const seg = (t, a, d) => clamp01((t - a) / d);
export const eOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
export const eOut4 = (x) => 1 - Math.pow(1 - clamp01(x), 4);
export const eIn = (x) => Math.pow(clamp01(x), 3);
export const eIn4 = (x) => Math.pow(clamp01(x), 4);
export const eInOut = (x) => {
  const u = clamp01(x);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};
export const eOpen = (x) => eOut(Math.pow(clamp01(x), 1.3));
export const eBack = (x) => {
  const u = clamp01(x), c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
};
// damped settle bump after a landing at time a (0 before, peaks then decays)
export const bump = (t, a, len = 0.45, k = 5) => {
  const s = t - a;
  return s > 0 && s < len ? Math.sin((s / len) * Math.PI) * Math.exp(-s * k) : 0;
};

export async function fontsReady() {
  await Promise.all([
    document.fonts.load('800 40px "Bricolage Grotesque Variable"'),
    document.fonts.load('600 20px "Inter Variable"'),
    document.fonts.load('600 20px "JetBrains Mono"'),
    document.fonts.load('700 20px "JetBrains Mono"'),
  ]).catch(() => {});
}

// ---------- renderer / camera ----------
export function makeRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(W, H, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.setClearColor(0x000000, 0);
  return r;
}

export function makeScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6cfbe, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-4, 10, 6);
  scene.add(sun);
  return scene;
}

// Orthographic engineering camera. place() puts it on a sphere around `target`
// (azimuth from +z toward +x, elevation above the ground plane), then slides it
// so `target` lands on screen pixel `at`.
export function makeCamera(view = 4.5) {
  const cam = new THREE.OrthographicCamera((-view * W) / H, (view * W) / H, view, -view, 0.1, 200);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const D2R = Math.PI / 180;
  cam.place = (az, el, target, at = [W / 2, H / 2], zoom = 1) => {
    const a = az * D2R, e = el * D2R, r = 40;
    cam.position.set(
      target[0] + r * Math.cos(e) * Math.sin(a),
      target[1] + r * Math.sin(e),
      target[2] + r * Math.cos(e) * Math.cos(a),
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(target[0], target[1], target[2]);
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const upp = (2 * view) / (H * zoom); // world units per pixel
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    cam.position.addScaledVector(right, -(at[0] - W / 2) * upp);
    cam.position.addScaledVector(up, (at[1] - H / 2) * upp);
    cam.updateMatrixWorld();
  };
  const tmp = new THREE.Vector3();
  cam.toScreen = (x, y, z) => {
    tmp.set(x, y, z).project(cam);
    return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H];
  };
  return cam;
}

// ---------- canvas textures ----------
export function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")];
}
export function tex(renderer, c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
export function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
export function soft(g, on, blur = 18, dy = 6, a = 0.16) {
  g.shadowColor = on ? `rgba(0,0,0,${a})` : "transparent";
  g.shadowBlur = on ? blur : 0;
  g.shadowOffsetY = on ? dy : 0;
}
export function fin(g, x, y, s, color = "#000") {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = color;
  g.fill(new Path2D(FIN));
  g.restore();
}
// letter-spaced mono text (canvas letterSpacing where supported)
export function mono(g, text, x, y, size = 16, weight = 600, color = "#000", spacing = 0.16, align = "left") {
  g.font = `${weight} ${size}px ${MO}`;
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.letterSpacing = `${(size * spacing).toFixed(1)}px`;
  g.textAlign = align;
  g.fillText(text, x, y);
  g.letterSpacing = "0px";
  g.textAlign = "left";
}

// ---------- the pool card (5 layers, 680 x 880 px textures on a 3.4 x 4.4 card) ----------
export const CARD = { w: 3.4, d: 4.4, tw: 680, th: 880 };
export function poolCardTextures(renderer, opts = {}) {
  const { tw: TW, th: TH } = CARD;
  const mk = () => canvas2d(TW, TH);
  const out = {};
  {
    const [c, g] = mk();
    g.fillStyle = C.sheet;
    g.fillRect(0, 0, TW, TH);
    g.strokeStyle = "rgba(0,0,0,0.16)";
    g.lineWidth = 2;
    g.strokeRect(1, 1, TW - 2, TH - 2);
    fin(g, 40, 38, 0.11);
    g.fillStyle = "#000";
    g.font = "800 28px " + BR;
    g.textBaseline = "middle";
    g.fillText("Mako Market", 94, 56);
    g.font = "600 17px " + MO;
    const tag = "CRYPTO";
    const tw = g.measureText(tag).width + 30;
    rr(g, TW - 40 - tw, 36, tw, 40, 20);
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(0,0,0,0.45)";
    g.stroke();
    g.fillText(tag, TW - 40 - tw + 15, 57);
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.fillRect(40, 108, TW - 80, 1.5);
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 3;
    g.beginPath();
    const pts = [0, 0.35, 0.28, 0.5, 0.42, 0.62, 0.55, 0.7, 0.64, 0.82, 0.9];
    pts.forEach((v, k) => {
      const x = 40 + (k / (pts.length - 1)) * (TW - 80);
      const y = 420 - v * 90;
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    g.fillStyle = "rgba(0,0,0,0.12)";
    g.fillRect(40, 440, TW - 80, 1.5);
    out.base = tex(renderer, c);
  }
  {
    const [c, g] = mk();
    g.fillStyle = "#000";
    g.font = "800 50px " + BR;
    g.textBaseline = "alphabetic";
    g.fillText("Will Bitcoin close", 40, 190);
    g.fillText("the week higher?", 40, 248);
    out.question = tex(renderer, c);
  }
  const toggle = (hi) => {
    const [c, g] = mk();
    soft(g, true, hi ? 30 : 18, hi ? 10 : 6, hi ? 0.22 : 0.16);
    rr(g, 40, 470, 292, 104, 18);
    g.fillStyle = C.yes;
    g.fill();
    rr(g, 348, 470, 292, 104, 18);
    g.fillStyle = C.no;
    g.fill();
    soft(g, false);
    rr(g, 40, 470, 292, 104, 18);
    g.lineWidth = 2;
    g.strokeStyle = "#000";
    g.stroke();
    g.font = "800 46px " + BR;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#000";
    g.fillText("YES", 186, 524);
    g.fillStyle = C.light;
    g.fillText("NO", 494, 524);
    return tex(renderer, c);
  };
  out.toggle = toggle(false);
  out.chipRect = (k) => {
    const w = (TW - 80 - 5 * 12) / 6;
    return [40 + k * (w + 12), 640, w, 66];
  };
  {
    const [c, g] = mk();
    const vals = ["0.10", "1", "5", "10", "25", "50"];
    vals.forEach((v, k) => {
      if (opts.skipChip === k) return;
      const [x, y, w, h] = out.chipRect(k);
      const sel = opts.selectedChip === k;
      soft(g, true);
      rr(g, x, y, w, h, 14);
      g.fillStyle = sel ? "#000" : C.chip;
      g.fill();
      soft(g, false);
      rr(g, x, y, w, h, 14);
      g.lineWidth = 1.5;
      g.strokeStyle = "rgba(0,0,0,0.35)";
      g.stroke();
      g.fillStyle = sel ? C.yes : "#000";
      g.font = "600 24px " + MO;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(v, x + w / 2, y + h / 2 + 1);
      g.textAlign = "left";
    });
    out.chips = tex(renderer, c);
  }
  {
    const [c, g] = mk();
    soft(g, true);
    rr(g, 40, 734, TW - 80, 84, 18);
    g.fillStyle = "#000";
    g.fill();
    soft(g, false);
    g.fillStyle = C.light;
    g.font = "800 34px " + BR;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("CONFIRM", TW / 2, 777);
    out.cta = tex(renderer, c);
  }
  return out;
}

// ---------- 3D pieces ----------
export function edgeMaterial(color = 0xe9e3d6) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
}
export function colorMaterial(hex, rough = 0.6) {
  const m = new THREE.MeshStandardMaterial({ roughness: rough });
  m.color.setStyle(hex);
  return m;
}

// Dashed hairline rectangle in the XZ plane.
export function dashedRect(w, d, dash = 0.08, gap = 0.06) {
  const hw = w / 2, hd = d / 2;
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hw, 0, -hd), new THREE.Vector3(hw, 0, -hd),
    new THREE.Vector3(hw, 0, hd), new THREE.Vector3(-hw, 0, hd),
  ]);
  const mat = new THREE.LineDashedMaterial({ color: 0x000000, transparent: true, opacity: 0, dashSize: dash, gapSize: gap, depthWrite: false });
  const loop = new THREE.LineLoop(geo, mat);
  loop.computeLineDistances();
  loop.renderOrder = 5;
  return loop;
}
// Dashed hairline box edges (for ghost outlines).
export function dashedBox(w, h, d, dash = 0.07, gap = 0.05) {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  const mat = new THREE.LineDashedMaterial({ color: 0x000000, transparent: true, opacity: 0, dashSize: dash, gapSize: gap, depthWrite: false });
  const ls = new THREE.LineSegments(geo, mat);
  ls.computeLineDistances();
  ls.renderOrder = 4;
  return ls;
}
// Dashed straight line between two points (vertical guides etc).
export function dashedLine(a, b, dash = 0.07, gap = 0.05) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  const mat = new THREE.LineDashedMaterial({ color: 0x000000, transparent: true, opacity: 0, dashSize: dash, gapSize: gap, depthWrite: false });
  const l = new THREE.Line(geo, mat);
  l.computeLineDistances();
  l.renderOrder = 4;
  return l;
}

// A transparent printed sheet (acetate) with dashed hairline frame.
export function sheet(w, d, map, order) {
  const group = new THREE.Group();
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }),
  );
  face.rotation.x = -Math.PI / 2;
  face.renderOrder = 10 + order;
  const frame = dashedRect(w, d);
  const acetate = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  acetate.rotation.x = -Math.PI / 2;
  acetate.renderOrder = 9 + order;
  acetate.position.y = -0.001;
  group.add(frame, acetate, face);
  return { group, face, frame: frame.material, acetate: acetate.material };
}

// Opaque printed slab (rounded box + printed top face).
export function slab(w, h, d, map, edgeMat, radius = 0.05, order = 10) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, Math.min(radius, h / 2 - 0.001)), edgeMat);
  group.add(body);
  let face = null;
  if (map) {
    face = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map, transparent: true }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = h / 2 + 0.002;
    face.renderOrder = order;
    group.add(face);
  }
  return { group, body, face };
}

// Soft contact shadow on the ground.
export function shadowBlob(w, d, strength = 0.26) {
  const [c, g] = canvas2d(256, 256);
  const grad = g.createRadialGradient(128, 128, 30, 128, 128, 128);
  grad.addColorStop(0, `rgba(40,32,16,${strength})`);
  grad.addColorStop(1, "rgba(40,32,16,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}

// ---------- DOM callouts (numbered mono labels with hairline leaders) ----------
// items: [{ idx, name, accent }]. side "right": label starts at column x; "left": label ends there.
export function callouts(rootEl, items, prefix) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "xp-leaders");
  svg.id = prefix + "-leaders";
  rootEl.appendChild(svg);
  const wrap = document.createElement("div");
  wrap.className = "xp-labels";
  wrap.id = prefix + "-labels";
  rootEl.appendChild(wrap);
  const rows = items.map((it) => {
    const el = document.createElement("div");
    el.className = "xp-label" + (it.side === "left" ? " xp-left" : "") + (it.cls ? " " + it.cls : "");
    if (it.idx) {
      const i = document.createElement("span");
      i.className = "xp-idx";
      i.textContent = it.idx;
      el.appendChild(i);
    }
    const n = document.createElement("span");
    n.className = "xp-name";
    n.textContent = it.name;
    el.appendChild(n);
    wrap.appendChild(el);
    const line = document.createElementNS(svgNS, "line");
    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("r", "5");
    dot.style.fill = it.accent ? C.yes : C.paper;
    svg.appendChild(line);
    svg.appendChild(dot);
    return { el, line, dot, side: it.side || "right" };
  });
  // place(i, anchorX, anchorY, columnX, shown 0..1)
  const place = (i, ax, ay, colX, shown) => {
    const r = rows[i];
    const s = clamp01(shown);
    const dir = r.side === "left" ? -1 : 1;
    const end = colX - dir * 18;
    r.el.style.opacity = s.toFixed(3);
    r.el.style.transform = `translate(${(colX + dir * (1 - s) * 14).toFixed(1)}px, ${ay.toFixed(1)}px)`;
    r.line.setAttribute("x1", ax.toFixed(1));
    r.line.setAttribute("y1", ay.toFixed(1));
    r.line.setAttribute("x2", (ax + (end - ax) * s).toFixed(1));
    r.line.setAttribute("y2", ay.toFixed(1));
    r.line.style.opacity = s > 0 ? "1" : "0";
    r.dot.setAttribute("cx", ax.toFixed(1));
    r.dot.setAttribute("cy", ay.toFixed(1));
    r.dot.style.opacity = s.toFixed(3);
  };
  return { rows, place };
}

// ---------- the shot runner ----------
// setup() returns { render(t), tweens?(tl) }. Resolves to { tl } (the paused timeline); the caller registers it.
export async function buildShot(id, duration, setup) {
  await fontsReady();
  const ctx = await setup();
  const clock = { t: 0 };
  const tl = window.gsap.timeline({ paused: true });
  tl.to(clock, { t: duration, duration, ease: "none", onUpdate: () => ctx.render(clock.t) }, 0);
  if (ctx.tweens) ctx.tweens(tl);
  ctx.render(0);
  // wrapped: a GSAP timeline is a thenable, so awaiting it directly would wait for it to finish playing
  return { tl };
}
