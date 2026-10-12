import { AbsoluteFill } from "remotion";

import { cursorAt, UserCursor } from "../kit/cursor";
import { swapIn } from "../kit/move";
import { step } from "../kit/spring";
import { clamp01, useTime } from "../kit/time";
import { CUE } from "./cues";
import { Dashes, mono, SideToggle, walk, Words } from "./parts";
import { C, FONT } from "./tokens";

/**
 * Direction A, "Signal": type-first on pure black, Apple keynote energy. One illustrative BTC line runs from
 * START toward CLOSE under the words the whole time; the question steps back, "Call it." lands, UP is picked.
 */
const W = 1920;
const ANCHOR = 934; // the starting price rule
const X0 = 150; // START
const X1 = 1770; // CLOSE
const AMP = 96;
const PTS = walk(240, 5);

const pt = (i: number) => ({ x: X0 + ((X1 - X0) * i) / (PTS.length - 1), y: ANCHOR - PTS[i] * AMP });

export function Signal() {
  const t = useTime();

  // The line is already running at frame 0 and keeps running (pure function of t).
  const head = 0.16 + 0.62 * (t / 4);
  const fi = head * (PTS.length - 1);
  const k = Math.floor(fi);
  const a = pt(k);
  const bpt = pt(Math.min(k + 1, PTS.length - 1));
  const f = fi - k;
  const hx = a.x + (bpt.x - a.x) * f;
  const hy = a.y + (bpt.y - a.y) * f;
  let d = "";
  for (let i = 0; i <= k; i++) {
    const p = pt(i);
    d += `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  d += `L${hx.toFixed(1)} ${hy.toFixed(1)}`;
  // The recent stretch (about a fifth of the round) carries colour; older line settles to dim.
  const r0 = Math.max(0, k - 56);
  let recent = "";
  for (let i = r0; i <= k; i++) {
    const p = pt(i);
    recent += `${i === r0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  recent += `L${hx.toFixed(1)} ${hy.toFixed(1)}`;
  const rx = pt(r0).x;

  // The question steps back to a kicker on the bar (spring ~150/20, ingredients.md).
  const s = step(t - CUE.shrink, { stiffness: 150, damping: 20 });
  const qScale = 1 - 0.54 * s;
  const qY = 486 - 268 * s;

  const toggle = swapIn(t, CUE.it + 0.15, Infinity, 0);
  const cursor = cursorAt(
    t,
    [
      { t: CUE.cursorIn - 0.1, x: 1460, y: 1130 },
      { t: CUE.pick, x: 902, y: 742, click: true },
    ],
    (x, y) => ({ x, y }),
  );

  const bandIn = 1; // already running at frame 0 (a hook must not open on black)

  return (
    <AbsoluteFill style={{ background: C.ink, color: C.fg, fontFamily: FONT.sans }}>
      {/* 1. The round, drawn as one line: START, the starting price rule, CLOSE. */}
      <svg width={W} height={1080} style={{ position: "absolute", inset: 0, opacity: bandIn }}>
        <defs>
          <linearGradient id="trail" x1={rx} x2={hx} y1="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity={0} />
            <stop offset="0.55" stopColor="#fff" stopOpacity={1} />
            <stop offset="1" stopColor="#fff" stopOpacity={1} />
          </linearGradient>
          <mask id="fade" maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={1080}><rect x={0} y={0} width={W} height={1080} fill="url(#trail)" /></mask>
          <clipPath id="above"><rect x={0} y={0} width={W} height={ANCHOR} /></clipPath>
          <clipPath id="below"><rect x={0} y={ANCHOR} width={W} height={1080 - ANCHOR} /></clipPath>
        </defs>
        <Dashes x1={X0} y1={ANCHOR} x2={X1} y2={ANCHOR} color={C.dim} width={2} dash={4} gap={10} />
        <line x1={X0} y1={ANCHOR - 96} x2={X0} y2={ANCHOR + 48} stroke={C.line} strokeWidth={2} />
        <Dashes x1={X1} y1={ANCHOR - 96} x2={X1} y2={ANCHOR + 48} color={C.dim} width={2} dash={4} gap={10} />
        {/* Above the starting price the line is UP, so it takes the signal colour. */}
        <path d={d} fill="none" stroke={C.dim} strokeOpacity={0.5} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        <g mask="url(#fade)">
          <path d={recent} fill="none" stroke={C.fg} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" clipPath="url(#below)" />
          <path d={recent} fill="none" stroke={C.signal} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" clipPath="url(#above)" />
        </g>
        <line x1={hx} y1={hy} x2={hx} y2={ANCHOR} stroke={C.dim} strokeOpacity={0.6} strokeWidth={2} />
        <circle cx={hx} cy={hy} r={10} fill={C.signal} />
      </svg>
      <div style={{ position: "absolute", left: X0, top: ANCHOR + 64, ...mono(20), opacity: bandIn }}>START</div>
      <div style={{ position: "absolute", right: W - X1, top: ANCHOR + 64, ...mono(20), opacity: bandIn, textAlign: "right" }}>CLOSE · 15:00</div>

      {/* 2. The hook. */}
      <div style={{ position: "absolute", left: 0, right: 0, top: qY, translate: "0 -50%", scale: String(qScale), display: "grid", justifyItems: "center", fontFamily: FONT.display, fontWeight: 800, fontSize: 116, lineHeight: 1.06, letterSpacing: "-0.035em" }}>
        <Words t={t} words={[{ text: "Think", at: CUE.think }, { text: "BTC", at: CUE.btc }, { text: "goes", at: CUE.goes }, { text: "up", at: CUE.up, accent: "color" }]} />
        <Words t={t} words={[{ text: "in", at: CUE.inTheNext }, { text: "the", at: CUE.inTheNext + 0.04 }, { text: "next", at: CUE.inTheNext + 0.08 }, { text: "15", at: CUE.minutes }, { text: "minutes?", at: CUE.minutes + 0.05 }]} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 500, translate: "0 -50%", display: "grid", justifyItems: "center", fontFamily: FONT.display, fontWeight: 800, fontSize: 300, lineHeight: 1, letterSpacing: "-0.045em" }}>
        <Words t={t} gap="0.2em" words={[{ text: "Call", at: CUE.call }, { text: "it.", at: CUE.it }]} />
      </div>

      {/* 3. The product's own answer: the side toggle. */}
      {toggle.visible ? (
        <div style={{ position: "absolute", left: W / 2, top: 742, translate: `-50% calc(-50% + ${(1 - toggle.opacity) * 24}px)`, opacity: toggle.opacity, filter: toggle.filter }}>
          <div style={{ scale: "1.55" }}>
            <SideToggle t={t} pickAt={CUE.pick} />
          </div>
        </div>
      ) : null}

      <div style={{ position: "absolute", left: 0, top: 0, translate: `${cursor.x}px ${cursor.y}px` }}>
        <div style={{ scale: "1.35", transformOrigin: "0 0" }}>
          <UserCursor x={0} y={0} squash={cursor.squash} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
