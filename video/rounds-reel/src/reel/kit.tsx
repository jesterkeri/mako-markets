import { Easing } from "remotion";
import type { CSSProperties, ReactNode } from "react";

import { swapIn } from "../kit/move";
import { step } from "../kit/spring";
import { clamp01 } from "../kit/time";
import { AppPage, type PageOpts } from "../film/AppPage";
import { Dashes, Logo, walk, Words, type Word } from "../film/parts";
import { C, FONT } from "../film/tokens";

/** Showreel kit: chrome, grain, the 3D product stage, type stacks, captions, the round line, the particle sphere. */

export const land = Easing.bezier(0.22, 1, 0.36, 1);
export const W = 1920;
export const H = 1080;
export const SAFE_BOTTOM = 950; // captions stay above the bottom 12%

export const mono = (size: number, color: string = C.dim, weight = 500): CSSProperties => ({ fontFamily: FONT.mono, fontSize: size, fontWeight: weight, color, letterSpacing: "0.08em" });
export const display = (size: number, color?: string): CSSProperties => ({ fontFamily: FONT.display, fontWeight: 800, fontSize: size, letterSpacing: "-0.04em", lineHeight: 1, color });

export type Tone = "dark" | "light";

// ---------------------------------------------------------------------------------------------------------------
// Persistent showreel chrome (reference 4): corner brackets, labels, running timecode, format tag.

function Bracket({ x, y, sx, sy, color }: { x: number; y: number; sx: 1 | -1; sy: 1 | -1; color: string }) {
  const L = 34;
  return <path d={`M${x} ${y + sy * L} L${x} ${y} L${x + sx * L} ${y}`} fill="none" stroke={color} strokeWidth={2} />;
}

export function timecode(t: number, fps = 60) {
  const f = Math.floor(t * fps + 1e-6);
  const s = Math.floor(f / fps);
  const two = (n: number) => String(n).padStart(2, "0");
  return `00:00:${two(s)}:${two(f % fps)}`;
}

export function Chrome({ t, chapter, tone }: { t: number; chapter: string; tone: Tone }) {
  const ink = tone === "dark" ? C.fg : C.ink;
  const soft = tone === "dark" ? "rgba(237,230,214,0.62)" : "rgba(0,0,0,0.62)";
  const draw = 0.35 + 0.65 * clamp01(t / 0.5); // brackets draw in over the first half second (never blank)
  const m = 44;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {tone === "dark" ? (
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0px, rgba(0,0,0,0) 120px, rgba(0,0,0,0) 940px, rgba(0,0,0,0.7) 1080px)" }} />
      ) : null}
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, opacity: draw }}>
        <Bracket x={m} y={m} sx={1} sy={1} color={ink} />
        <Bracket x={W - m} y={m} sx={-1} sy={1} color={ink} />
        <Bracket x={m} y={H - m} sx={1} sy={-1} color={ink} />
        <Bracket x={W - m} y={H - m} sx={-1} sy={-1} color={ink} />
      </svg>
      <div style={{ position: "absolute", left: 96, top: 52, display: "flex", alignItems: "center", gap: 12, opacity: draw }}>
        <Logo size={30} color={ink} />
        <span style={mono(15, ink, 700)}>MAKO MARKET · ROUNDS</span>
      </div>
      <div style={{ position: "absolute", right: 96, top: 58, ...mono(15, ink, 700), opacity: draw }}>{chapter}</div>
      <div style={{ position: "absolute", left: 96, bottom: 54, ...mono(15, soft), opacity: draw, fontVariantNumeric: "tabular-nums" }}>{timecode(t)}</div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 54, textAlign: "center", ...mono(15, soft), opacity: draw }}>120 BPM · {chapter.slice(0, 2)} / 08</div>
      <div style={{ position: "absolute", right: 96, bottom: 54, ...mono(15, soft), opacity: draw }}>1920x1080 · 60P</div>
    </div>
  );
}

/** Fine film grain, a new seed every frame (pure: the seed is the frame number). */
export function Grain({ t, tone }: { t: number; tone: Tone }) {
  const seed = Math.floor(t * 60) % 97;
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: tone === "dark" ? 0.07 : 0.1, mixBlendMode: tone === "dark" ? "screen" : "multiply" }}>
      <filter id={`grain${seed}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={seed} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width={W} height={H} filter={`url(#grain${seed})`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The 3D product stage (direction B). A shot is a camera: the page point `f` is held at screen point `s`.

export type Shot = { fx: number; fy: number; sx: number; sy: number; scale: number; rx: number; ry: number; rz: number };
export const heavy = { stiffness: 60, damping: 16, mass: 1.4 };
export const fast = { stiffness: 170, damping: 26, mass: 1 };

export function Stage({ t, a, b, at = 0, spring = heavy, page, focus = [520, 500], blur = 7, dim = 0, topFade = false, bottomFade = false }: { topFade?: boolean; bottomFade?: boolean; t: number; a: Shot; b: Shot; at?: number; spring?: typeof heavy; page: { pickAt?: number; upShare?: number; clock?: number } & PageOpts; focus?: [number, number]; blur?: number; dim?: number }) {
  const u = step(t - at, spring);
  const m = (k: keyof Shot) => a[k] + (b[k] - a[k]) * u;
  const fx = m("fx");
  const fy = m("fy");
  const mask = `radial-gradient(ellipse ${focus[0]}px ${focus[1]}px at ${fx}px ${fy}px, #000 50%, transparent 100%)`;
  const copy = (kind: "soft" | "sharp") => (
    <div data-copy={kind} style={{ position: "absolute", inset: 0, filter: kind === "soft" ? `blur(${blur}px)` : undefined, maskImage: kind === "sharp" ? mask : undefined, WebkitMaskImage: kind === "sharp" ? mask : undefined }}>
      <AppPage t={t} pickAt={page.pickAt ?? -10} upShare={page.upShare ?? 0.5} {...page} />
    </div>
  );
  return (
    <div style={{ position: "absolute", inset: 0, perspective: 2400, overflow: "hidden", background: C.ink }}>
      <div
        style={{
          position: "absolute",
          left: m("sx") - fx,
          top: m("sy") - fy,
          width: 1440,
          height: 940,
          transformOrigin: `${fx}px ${fy}px`,
          transform: `scale(${m("scale") * (1 + 0.01 * t)}) rotateX(${m("rx")}deg) rotateY(${m("ry") + 0.4 * t}deg) rotateZ(${m("rz")}deg)`,
        }}
      >
        {copy("soft")}
        {copy("sharp")}
      </div>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 120% 95% at 60% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.75) 100%)" }} />
      {dim > 0 ? <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${dim})` }} /> : null}
      {bottomFade ? <div style={{ position: "absolute", inset: 0, background: "linear-gradient(0deg, #000 0%, rgba(0,0,0,0.92) 16%, rgba(0,0,0,0) 34%)" }} /> : null}
      {topFade ? <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, #000 0%, rgba(0,0,0,0.9) 14%, rgba(0,0,0,0) 36%)" }} /> : null}
    </div>
  );
}

/** Thins the world behind words on the left (a gradient, never a panel). */
export function Scrim({ x = 430, y = 520, rx = 760, ry = 520 }: { x?: number; y?: number; rx?: number; ry?: number }) {
  return <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse ${rx}px ${ry}px at ${x}px ${y}px, #000 0%, rgba(0,0,0,0.96) 58%, rgba(0,0,0,0.55) 80%, rgba(0,0,0,0) 95%)` }} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Captions: a display line (words land on the beat) and an Inter sub-line that blur-swaps in.

export function Caption({ t, x = 112, y, lines, size = 92, sub, subAt = 0.6, subSize = 32, subColor = C.dim, color = C.fg, align = "left", width = 820 }: { t: number; x?: number; y: number; lines: Word[][]; size?: number; sub?: string[]; subAt?: number; subSize?: number; subColor?: string; color?: string; align?: "left" | "center"; width?: number }) {
  const s = swapIn(t, subAt, Infinity, 0);
  return (
    <div style={{ position: "absolute", left: align === "center" ? 0 : x, right: align === "center" ? 0 : undefined, top: y, display: "grid", justifyItems: align === "center" ? "center" : "start", color }}>
      <div style={{ ...display(size), lineHeight: 1.04, display: "grid", justifyItems: align === "center" ? "center" : "start" }}>
        {lines.map((l, i) => (
          <Words key={i} t={t} words={l} gap="0.22em" />
        ))}
      </div>
      {sub ? (
        <div style={{ marginTop: size * 0.34, fontFamily: FONT.sans, fontWeight: 500, fontSize: subSize, lineHeight: 1.32, color: subColor, maxWidth: width, textAlign: align, opacity: s.opacity, filter: s.filter, translate: `0 ${(1 - s.opacity) * 14}px` }}>
          {sub.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Words for a phrase, one word per eighth starting at `from`. */
export const phrase = (text: string, from: number, every = 0.12, colors: Record<string, string> = {}): Word[] =>
  text.split(" ").map((w, i) => ({ text: w, at: from + i * every, color: colors[w] }));

// ---------------------------------------------------------------------------------------------------------------
// Kinetic outline type stack (reference 1): a word repeated in outline rows, one row filled, scrolling.

export function TypeStack({ t, text, filledText, size, rows = 9, fill = C.signal, stroke = "rgba(237,230,214,0.32)", scroll = 260, settle = 0.7, drift = 30, shift = 0.18, rowGap = 1.0, skip = [] }: { skip?: number[]; t: number; text: string; filledText?: string; size: number; rows?: number; fill?: string; stroke?: string; scroll?: number; settle?: number; drift?: number; shift?: number; rowGap?: number }) {
  const rowH = size * rowGap;
  const offset = scroll * (1 - land(clamp01(t / settle))) - drift * t;
  const mid = Math.floor(rows / 2);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {Array.from({ length: rows }, (_, i) => {
        const k = i - mid;
        const filled = k === 0;
        if (skip.includes(k)) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: H / 2 + k * rowH + offset - rowH / 2,
              height: rowH,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              whiteSpace: "nowrap",
              translate: `${(k % 2 === 0 ? 1 : -1) * shift * size * (filled ? 0 : 1) + (filled ? 0 : -drift * t * (k % 2 === 0 ? 1 : -1))}px 0`,
              ...display(size),
              lineHeight: 1,
              color: filled ? fill : "transparent",
              WebkitTextStroke: filled ? undefined : `2px ${stroke}`,
            }}
          >
            {filled ? filledText ?? text : text}
          </div>
        );
      })}
    </div>
  );
}

/** Motion-trail echoes behind a word: outline copies stepping back along a direction. */
export function Echo({ children, color, n = 3, dx = -26, dy = -14, style }: { children: ReactNode; color: string; n?: number; dx?: number; dy?: number; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", ...style }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} aria-hidden style={{ position: "absolute", inset: 0, translate: `${dx * (n - i)}px ${dy * (n - i)}px`, color: "transparent", WebkitTextStroke: `2px ${color}`, opacity: 0.18 + (0.5 * i) / n }}>
          {children}
        </div>
      ))}
      <div style={{ position: "relative" }}>{children}</div>
    </div>
  );
}

/** Slash wipe across a cut at `cut` (seconds): the band's leading edge covers the old shot, its trailing edge reveals the new one. */
export function SlashWipe({ t, cut, color = C.signal, half = 0.14 }: { t: number; cut: number; color?: string; half?: number }) {
  const p = (t - (cut - half)) / (2 * half);
  if (p <= 0 || p >= 1) return null;
  const ease = (x: number) => x * x * (3 - 2 * x);
  // Leading edge travels 0 -> 1 in the first half, trailing edge 0 -> 1 in the second half (in frame widths, skewed).
  const lead = ease(clamp01(p * 2));
  const trail = ease(clamp01(p * 2 - 1));
  const sk = 0.42 * H; // horizontal skew of the diagonal
  const xl = -sk + lead * (W + 2 * sk);
  const xt = -sk + trail * (W + 2 * sk);
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <polygon points={`${xt},${H} ${xt + sk},0 ${xl + sk},0 ${xl},${H}`} fill={color} />
    </svg>
  );
}

/** A diagonal colour band (the slash wipe). p 0..1 sweeps it across the frame. */
export function Slash({ p, color = C.signal, width = 520, angle = 22 }: { p: number; color?: string; width?: number; angle?: number }) {
  if (p <= 0 || p >= 1) return null;
  const x = -width * 2 + (W + width * 4) * p;
  return <div style={{ position: "absolute", top: -400, bottom: -400, left: x, width, background: color, rotate: `${angle}deg` }} />;
}

// ---------------------------------------------------------------------------------------------------------------
// The round as one line (direction A): START, the starting price rule, CLOSE.

const PTS = walk(240, 5);

export function RoundLine({ head, x0 = 200, x1 = 1720, anchor = 700, amp = 110, labels = true }: { head: number; x0?: number; x1?: number; anchor?: number; amp?: number; labels?: boolean }) {
  const pt = (i: number) => ({ x: x0 + ((x1 - x0) * i) / (PTS.length - 1), y: anchor - PTS[i] * amp });
  const fi = Math.min(1, Math.max(0, head)) * (PTS.length - 1);
  const k = Math.floor(fi);
  const a = pt(k);
  const b = pt(Math.min(k + 1, PTS.length - 1));
  const hx = a.x + (b.x - a.x) * (fi - k);
  const hy = a.y + (b.y - a.y) * (fi - k);
  const path = (from: number) => {
    let d = "";
    for (let i = from; i <= k; i++) d += `${i === from ? "M" : "L"}${pt(i).x.toFixed(1)} ${pt(i).y.toFixed(1)}`;
    return d + `L${hx.toFixed(1)} ${hy.toFixed(1)}`;
  };
  const r0 = Math.max(0, k - 70);
  const id = `rl${Math.round(anchor)}`;
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <linearGradient id={`${id}t`} x1={pt(r0).x} x2={hx} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity={0} />
          <stop offset="0.5" stopColor="#fff" stopOpacity={1} />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
          <rect width={W} height={H} fill={`url(#${id}t)`} />
        </mask>
        <clipPath id={`${id}a`}>
          <rect width={W} height={anchor} />
        </clipPath>
        <clipPath id={`${id}b`}>
          <rect y={anchor} width={W} height={H - anchor} />
        </clipPath>
      </defs>
      <Dashes x1={x0} y1={anchor} x2={x1} y2={anchor} color={C.dim} width={2} dash={4} gap={10} />
      <path d={path(0)} fill="none" stroke={C.dim} strokeOpacity={0.5} strokeWidth={3} strokeLinejoin="round" />
      <g mask={`url(#${id}m)`}>
        <path d={path(r0)} fill="none" stroke={C.fg} strokeWidth={3.5} strokeLinejoin="round" clipPath={`url(#${id}b)`} />
        <path d={path(r0)} fill="none" stroke={C.signal} strokeWidth={3.5} strokeLinejoin="round" clipPath={`url(#${id}a)`} />
      </g>
      <circle cx={hx} cy={hy} r={10} fill={C.signal} />
      {labels ? null : null}
    </svg>
  );
}
export const roundLineEnd = (x1 = 1720, anchor = 700, amp = 110) => ({ x: x1, y: anchor - PTS[PTS.length - 1] * amp });

// ---------------------------------------------------------------------------------------------------------------
// The particle sphere (reference 2): Fibonacci points, rotated per frame, projected.

export function Sphere({ t, cx = 1010, cy = 520, r = 330, n = 900 }: { t: number; cx?: number; cy?: number; r?: number; n?: number }) {
  const yaw = t * 0.55 + 0.4;
  const tilt = 0.38;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: { x: number; y: number; z: number; hot: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = golden * i;
    let x = Math.cos(th) * rad;
    let z = Math.sin(th) * rad;
    // yaw
    const x1 = x * Math.cos(yaw) - z * Math.sin(yaw);
    const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
    // tilt
    const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt);
    const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
    x = x1;
    z = z2;
    pts.push({ x, y: y2, z, hot: i % 37 === 0 });
  }
  pts.sort((a, b) => a.z - b.z);
  const persp = (z: number) => 1 / (1 - z * 0.28);
  const orbit = (rx: number, ry: number, rot: number, color: string, op: number, dash?: string) => (
    <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeOpacity={op} strokeWidth={1.4} transform={`rotate(${rot} ${cx} ${cy})`} strokeDasharray={dash} />
  );
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      {orbit(r * 1.55, r * 0.34, -14, C.fg, 0.28)}
      {orbit(r * 1.32, r * 0.52, 24 + t * 4, C.fg, 0.18, "3 7")}
      {orbit(r * 1.75, r * 0.2, 6, C.signal, 0.55)}
      {pts.map((p, i) => {
        const s = persp(p.z);
        const depth = (p.z + 1) / 2;
        return <circle key={i} cx={cx + p.x * r * s} cy={cy + p.y * r * s} r={(p.hot ? 3.2 : 1.6) * s * (0.6 + depth * 0.6)} fill={p.hot ? C.signal : C.fg} fillOpacity={p.hot ? 0.5 + depth * 0.5 : 0.12 + depth * 0.7} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export function ChainlinkTag({ label }: { label: string }) {
  return (
    <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
      <span style={{ height: 40, padding: "0 16px 0 10px", borderRadius: 9999, background: C.raise2, display: "flex", alignItems: "center", gap: 10, fontFamily: FONT.sans, fontWeight: 600, fontSize: 19, color: C.fg, whiteSpace: "nowrap" }}>
        <svg width={22} height={22} viewBox="0 0 24 24">
          <circle cx={12} cy={12} r={11} fill={C.signal} />
          <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#000" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Chainlink · verified
      </span>
      <span style={mono(18, C.dim, 700)}>{label}</span>
    </div>
  );
}

/** Lock-on brackets around a point (HUD style), closing in as p goes 0 to 1. */
export function Lock({ x, y, p, color = C.signal }: { x: number; y: number; p: number; color?: string }) {
  const r = 22 + (1 - land(clamp01(p))) * 40;
  const L = 10;
  const c = (sx: number, sy: number) => <path key={`${sx}${sy}`} d={`M${x + sx * r} ${y + sy * (r - L)} L${x + sx * r} ${y + sy * r} L${x + sx * (r - L)} ${y + sy * r}`} fill="none" stroke={color} strokeWidth={2.5} />;
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0, opacity: clamp01(p * 3) }}>
      {c(1, 1)}
      {c(-1, 1)}
      {c(1, -1)}
      {c(-1, -1)}
    </svg>
  );
}

export function Fill({ color }: { color: string }) {
  return <div style={{ position: "absolute", inset: 0, background: color }} />;
}
