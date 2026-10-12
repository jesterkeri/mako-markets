import { useRef, type CSSProperties } from "react";
import { AbsoluteFill } from "remotion";

import { swapIn } from "../kit/move";
import { step, track } from "../kit/spring";
import { useTime } from "../kit/time";
import { countdown } from "./AppPage";
import { CUE } from "./cues";
import { MeasuredCursor } from "./MeasuredCursor";
import { Logo, SideToggle, Words } from "./parts";
import { C, FONT } from "./tokens";

/**
 * Direction C, "Paper": the brand's paper canvas (BRAND.md: paper for backgrounds), ink type set like an editorial
 * cover, and the product as one dark object on it: the round's prediction card, lifted with the app's own soft
 * light-mode shadow (rgba(40,30,10,.22), mako-shell.css --tb-sh), never an offset shadow or an outline.
 */
const display: CSSProperties = { fontFamily: FONT.display, fontWeight: 800 };
const mono: CSSProperties = { fontFamily: FONT.mono };
const CHIPS = ["0.10", "1", "5", "10", "25", "50"];
const CARD_SCALE = 1.42;

function PredictCard({ t }: { t: number }) {
  return (
    <div style={{ width: 420, padding: 28, boxSizing: "border-box", borderRadius: 26, background: C.ink, color: C.fg, fontFamily: FONT.sans, boxShadow: "0 2px 6px rgba(40,30,10,0.12), 0 36px 90px rgba(40,30,10,0.30)" }}>
      <div style={{ ...mono, fontSize: 11, color: C.dim }}>ROUND · BTC/USD · 05:00 PM to 05:15 PM</div>
      <div style={{ ...display, fontSize: 32, lineHeight: 1.04, letterSpacing: "-0.03em", marginTop: 10 }}>
        BTC up or down
        <br />
        by 05:15 PM?
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 20 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: C.dim }}>Predictions close in</div>
          <div style={{ ...display, fontSize: 64, lineHeight: 1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", marginTop: 6 }}>{countdown(t)}</div>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 20, paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ ...display, fontSize: 20 }}>Make a prediction</span>
          <span style={{ ...mono, fontSize: 10, color: C.dim }}>MIN 0.10 USDC</span>
        </div>
        <SideToggle t={t} pickAt={CUE.pick} width={364} target="up" />
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "10px 16px", borderRadius: 12, background: C.raise }}>
          <span style={{ ...display, fontSize: 36, letterSpacing: "-0.02em" }}>5</span>
          <span style={{ ...mono, fontSize: 12, color: C.dim }}>USDC</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 6 }}>
          {CHIPS.map((c) => (
            <span key={c} style={{ height: 32, borderRadius: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: c === "5" ? C.fg : C.raise2, color: c === "5" ? C.ink : C.fg, ...mono, fontSize: 11, fontWeight: 700 }}>
              {c}
            </span>
          ))}
        </div>
        <span style={{ height: 54, borderRadius: 9999, background: C.signal, color: "#000", ...display, fontSize: 17, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>Sign in to predict</span>
      </div>
    </div>
  );
}

export function Paper() {
  const t = useTime();
  const root = useRef<HTMLDivElement>(null);

  const s = step(t - CUE.shrink, { stiffness: 150, damping: 20 });
  // The card is already rising at frame 0, then drifts; it leans in a touch on the pick.
  const rise = 1 - step(t + 0.25, { stiffness: 70, damping: 15 });
  const lean = track(t, [[0, 0], [CUE.pick, 1]], { stiffness: 180, damping: 22 });
  const tag = swapIn(t, CUE.pick + 0.25, Infinity, 0);

  return (
    <AbsoluteFill ref={root} style={{ background: C.paper, color: C.ink }}>
      {/* Brand line */}
      <div style={{ position: "absolute", left: 112, top: 78, display: "flex", alignItems: "center", gap: 14 }}>
        <Logo size={40} color={C.ink} />
        <span style={{ ...display, fontSize: 28, letterSpacing: "-0.03em" }}>Mako Market</span>
      </div>
      <div style={{ position: "absolute", right: 120, top: 88, ...mono, fontSize: 18, fontWeight: 500, letterSpacing: "0.08em", color: "rgba(0,0,0,0.55)" }}>ROUNDS · BTC/USD</div>

      {/* The words */}
      <div style={{ position: "absolute", left: 112, top: 520 - 196 * s, translate: "0 -50%", scale: String(1 - 0.42 * s), transformOrigin: "0 50%", ...display, fontSize: 92, lineHeight: 1.08, letterSpacing: "-0.035em" }}>
        <Words t={t} words={[{ text: "Think", at: CUE.think }, { text: "BTC", at: CUE.btc }, { text: "goes", at: CUE.goes }, { text: "up", at: CUE.up, accent: "pill" }]} />
        <Words t={t} words={[{ text: "in", at: CUE.inTheNext }, { text: "the", at: CUE.inTheNext + 0.04 }, { text: "next", at: CUE.inTheNext + 0.08 }, { text: "15", at: CUE.minutes }, { text: "minutes?", at: CUE.minutes + 0.05 }]} />
      </div>
      <div style={{ position: "absolute", left: 100, top: 560, translate: "0 -50%", ...display, fontSize: 260, lineHeight: 1, letterSpacing: "-0.05em" }}>
        <Words t={t} gap="0.19em" words={[{ text: "Call", at: CUE.call }, { text: "it.", at: CUE.it }]} />
      </div>
      <div style={{ position: "absolute", left: 116, top: 742, ...mono, fontSize: 24, fontWeight: 500, letterSpacing: "0.04em", color: "rgba(0,0,0,0.6)", opacity: tag.opacity, filter: tag.filter, translate: `0 ${(1 - tag.opacity) * 14}px` }}>
        UP or DOWN · 15 minutes · from 0.10 USDC
      </div>

      {/* The product, one object on the paper */}
      <div style={{ position: "absolute", left: 1800 - 420, top: 540, translate: `0 calc(-50% + ${rise * 140 - t * 6}px)`, transform: `perspective(2200px) rotateY(${-13 + 9 * lean + 1.2 * t}deg) rotateX(${3 - 2 * lean}deg) scale(${CARD_SCALE * (1 + 0.012 * lean)})`, transformOrigin: "100% 50%", opacity: 1 - rise * 0.6 }}>
        <PredictCard t={t} />
      </div>

      <MeasuredCursor t={t} selector='[data-target="up"]' from={{ t: CUE.cursorIn - 0.1, x: 1700, y: 1150 }} arriveAt={CUE.pick} />
    </AbsoluteFill>
  );
}
