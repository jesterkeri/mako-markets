import { Easing, interpolateColors } from "remotion";
import type { CSSProperties, ReactNode } from "react";

import { step } from "../kit/spring";
import { clamp01 } from "../kit/time";
import { C, EASE, FONT, LOGO_PATH } from "./tokens";

const land = Easing.bezier(...EASE.land);
const press = Easing.bezier(...EASE.press);

// ---------------------------------------------------------------------------------------------------------------
// Words: the punchline landing from kit/punchlines.tsx (blur 16 px, rise, 0.3 s on cubic-bezier(.22,1,.36,1)),
// generalised so a line can be left-aligned and the accent can be a colour or the product's yellow SidePill.

export type Word = { text: string; at: number; accent?: "color" | "pill"; color?: string };

export function Words({ t, words, accent = C.signal, pillText = C.ink, gap = "0.24em", style }: { t: number; words: Word[]; accent?: string; pillText?: string; gap?: string; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap, whiteSpace: "nowrap", ...style }}>
      {words.map((w) => {
        const u = land(clamp01((t - w.at) / 0.3));
        const pill = w.accent === "pill";
        return (
          <span
            key={w.text}
            style={{
              display: "inline-block",
              position: "relative",
              isolation: "isolate",
              color: w.color ?? (w.accent === "color" ? accent : pill ? pillText : undefined),
              opacity: u,
              filter: u < 1 ? `blur(${(1 - u) * 16}px)` : undefined,
              translate: `0 ${(1 - u) * 0.28}em`,
              padding: pill ? "0 0.22em" : undefined,
              margin: pill ? "0 -0.04em" : undefined,
            }}
          >
            {pill ? (
              <span style={{ position: "absolute", left: 0, right: 0, top: "0.14em", bottom: "-0.06em", borderRadius: 9999, background: accent, zIndex: -1 }} />
            ) : null}
            {w.text}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The UP / DOWN side toggle. Twin of EnterForm's role="group" in src/app/rounds/[id]/RoundClient.tsx:
// raise track, 4 px padding, 44 px pill buttons, display 16 px, UP fills signal with ink text.
// Film change: it starts with no side picked, so the pick can happen on a beat.

export function SideToggle({ t, pickAt, width = 372, dark = true, target }: { t: number; pickAt: number; width?: number; dark?: boolean; target?: string }) {
  const fill = step(t - pickAt, { stiffness: 420, damping: 34 });
  const down = t >= pickAt - 0.02 && t < pickAt + 0.14;
  const squeeze = down ? 0.96 : 0.96 + 0.04 * press(clamp01((t - pickAt - 0.14) / 0.2));
  const pressScale = t < pickAt - 0.02 ? 1 : squeeze;
  const fg = dark ? C.fg : C.ink;
  const upText = interpolateColors(clamp01(fill * 1.4), [0, 1], [fg, C.ink]);
  return (
    <div style={{ width, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, padding: 4, borderRadius: 9999, background: dark ? C.raise2 : C.paperSunk, boxSizing: "border-box" }}>
      <div data-target={target} style={{ position: "relative", height: 44, borderRadius: 9999, display: "flex", alignItems: "center", justifyContent: "center", scale: String(pressScale) }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 9999, background: C.signal, opacity: clamp01(fill * 3), scale: String(0.7 + 0.3 * Math.min(fill, 1.02)) }} />
        <span style={{ position: "relative", fontFamily: FONT.display, fontWeight: 800, fontSize: 16, color: upText }}>↑ UP</span>
      </div>
      <div style={{ height: 44, borderRadius: 9999, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontWeight: 800, fontSize: 16, color: fg }}>↓ DOWN</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// An illustrative BTC path: a seeded walk, no price labels. Same series feeds the candles.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * n points in -1..1: a hand-shaped round (hovers, dips, then climbs past the start) plus seeded wobble.
 * Illustrative only; never labelled with prices.
 */
const SHAPE: [number, number][] = [
  [0, 0], [0.1, 0.22], [0.2, -0.12], [0.3, 0.12], [0.42, -0.3], [0.52, -0.42], [0.6, -0.12], [0.66, 0.1], [0.76, 0.5], [0.86, 0.62], [0.93, 0.82], [1, 0.95],
];
function shapeAt(u: number) {
  const i = Math.max(0, SHAPE.findIndex((p, k) => u >= p[0] && u <= (SHAPE[k + 1]?.[0] ?? 1)));
  const [a, b] = [SHAPE[i], SHAPE[Math.min(i + 1, SHAPE.length - 1)]];
  const f = b[0] === a[0] ? 0 : (u - a[0]) / (b[0] - a[0]);
  const s = f * f * (3 - 2 * f);
  return a[1] + (b[1] - a[1]) * s;
}
export function walk(n: number, seed = 7) {
  const r = rng(seed);
  const phases = [r(), r(), r()].map((x) => x * Math.PI * 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const wobble = 0.07 * Math.sin(u * 70 + phases[0]) + 0.045 * Math.sin(u * 151 + phases[1]) + 0.025 * Math.sin(u * 313 + phases[2]);
    out.push(shapeAt(u) + wobble * Math.min(1, u * 12));
  }
  return out;
}

export type Candle = { o: number; h: number; l: number; c: number };
export function candles(n: number, seed = 11): Candle[] {
  const pts = walk(n * 4 + 1, seed);
  const r = rng(seed + 3);
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const seg = pts.slice(i * 4, i * 4 + 5);
    const o = seg[0];
    const c = seg[seg.length - 1];
    out.push({ o, c, h: Math.max(...seg) + r() * 0.05, l: Math.min(...seg) - r() * 0.05 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

export function Logo({ size, color = "currentColor" }: { size: number; color?: string }) {
  return (
    <svg viewBox="-3 -3 406 316" width={size} height={(size * 316) / 406} style={{ display: "block", flex: "none" }}>
      <path d={LOGO_PATH} fill={color} stroke={color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Dashed rule drawn as SVG at a fixed pitch (CSS dashes crawl when a box resizes). */
export function Dashes({ x1, y1, x2, y2, color, width = 2, dash = 6, gap = 8 }: { x1: number; y1: number; x2: number; y2: number; color: string; width?: number; dash?: number; gap?: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} strokeDasharray={`${dash} ${gap}`} />;
}

export const mono = (size: number, color: string = C.dim, weight = 500): CSSProperties => ({ fontFamily: FONT.mono, fontSize: size, fontWeight: weight, color, letterSpacing: "0.04em" });

export function Layer({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ position: "absolute", inset: 0, ...style }}>{children}</div>;
}
