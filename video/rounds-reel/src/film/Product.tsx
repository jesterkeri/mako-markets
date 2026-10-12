import { useRef } from "react";
import { AbsoluteFill } from "remotion";

import { step, track } from "../kit/spring";
import { useTime } from "../kit/time";
import { MeasuredCursor } from "./MeasuredCursor";
import { AppPage } from "./AppPage";
import { CUE } from "./cues";
import { Words } from "./parts";
import { C, FONT } from "./tokens";

/**
 * Direction B, "In the product": the real round page as one plane in space (Linear-style), the camera held on a
 * heavy spring and pushed in on the beats. Depth of field is faked with a blurred copy under a sharp copy whose
 * mask is centred on "Make a prediction". The words sit left, over a thinned (never panelled) area.
 */
const heavy = { stiffness: 60, damping: 16, mass: 1.4 };
const FOCUS = { x: 1214, y: 430 }; // page px: the EnterForm column (debug-measured: form x=1024..1404)

export function Product() {
  const t = useTime();

  // Camera: slow constant drift plus spring push-ins on the bar and on the pick.
  const push = track(t, [[0, 0], [CUE.shrink - 0.1, 1], [CUE.pick, 1.6]], heavy);
  const scale = 1.27 + 0.05 * push + 0.01 * t;
  const rotY = -27 + 2.2 * push + 0.5 * t;
  const rotX = 13 - 1.0 * push;
  const rotZ = 6.5 - 0.6 * push;
  const tx = -16 * push - 6 * t;

  const s = step(t - CUE.shrink, { stiffness: 150, damping: 20 });
  const upShare = 0.5 + 0.06 * step(t - CUE.pick - 0.15, { stiffness: 120, damping: 22 });

  const rootRef = useRef<HTMLDivElement>(null);

  const page = (copy: "sharp" | "soft") => (
    <div
      data-copy={copy}
      style={{
        position: "absolute",
        inset: 0,
        filter: copy === "soft" ? "blur(7px)" : undefined,
        maskImage: copy === "sharp" ? `radial-gradient(ellipse 520px 500px at ${FOCUS.x}px ${FOCUS.y + 40}px, #000 50%, transparent 100%)` : undefined,
        WebkitMaskImage: copy === "sharp" ? `radial-gradient(ellipse 520px 500px at ${FOCUS.x}px ${FOCUS.y + 40}px, #000 50%, transparent 100%)` : undefined,
      }}
    >
      <AppPage t={t} pickAt={CUE.pick} upShare={upShare} />
    </div>
  );

  return (
    <AbsoluteFill ref={rootRef} style={{ background: C.ink, color: C.fg, fontFamily: FONT.sans, perspective: 2400, overflow: "hidden" }}>
      {/* World: the product plane. */}
      <div
        style={{
          position: "absolute",
          left: 1440 - FOCUS.x + tx,
          top: 498 - FOCUS.y - 40,
          width: 1440,
          height: 940,
          transformOrigin: `${FOCUS.x}px ${FOCUS.y + 40}px`,
          transform: `scale(${scale}) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg)`,
          transformStyle: "flat",
        }}
      >
        {page("soft")}
        {page("sharp")}
      </div>

      {/* Thin the world behind the words (a gradient, not a panel), and sink the frame edges. */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 700px 470px at 420px 440px, #000 0%, rgba(0,0,0,0.97) 60%, rgba(0,0,0,0.6) 80%, rgba(0,0,0,0) 94%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 120% 90% at 70% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.7) 100%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.5) 5%, rgba(0,0,0,0) 12%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.95) 100%)" }} />

      {/* Words */}
      <div style={{ position: "absolute", left: 112, top: 470 - 210 * s, translate: "0 -50%", scale: String(1 - 0.43 * s), transformOrigin: "0 50%", fontFamily: FONT.display, fontWeight: 800, fontSize: 84, lineHeight: 1.06, letterSpacing: "-0.035em" }}>
        <Words t={t} words={[{ text: "Think", at: CUE.think }, { text: "BTC", at: CUE.btc }, { text: "goes", at: CUE.goes }, { text: "up", at: CUE.up, accent: "color" }]} />
        <Words t={t} words={[{ text: "in", at: CUE.inTheNext }, { text: "the", at: CUE.inTheNext + 0.04 }, { text: "next", at: CUE.inTheNext + 0.08 }, { text: "15", at: CUE.minutes }, { text: "minutes?", at: CUE.minutes + 0.05 }]} />
      </div>
      <div style={{ position: "absolute", left: 104, top: 520, translate: "0 -50%", fontFamily: FONT.display, fontWeight: 800, fontSize: 250, lineHeight: 1, letterSpacing: "-0.045em" }}>
        <Words t={t} gap="0.2em" words={[{ text: "Call", at: CUE.call }, { text: "it.", at: CUE.it }]} />
      </div>

      <MeasuredCursor t={t} selector='[data-copy="sharp"] [data-target="up"]' from={{ t: CUE.cursorIn - 0.1, x: 1700, y: 1150 }} arriveAt={CUE.pick} />
    </AbsoluteFill>
  );
}
