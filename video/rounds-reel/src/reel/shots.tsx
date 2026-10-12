import type { CSSProperties, FC } from "react";
import { Easing } from "remotion";


import { swapIn } from "../kit/move";
import { step } from "../kit/spring";
import { clamp01 } from "../kit/time";
import { MeasuredCursor } from "../film/MeasuredCursor";
import { Logo, Words } from "../film/parts";
import { C, FONT } from "../film/tokens";
import { Caption, ChainlinkTag, display, Echo, fast, Fill, H, land, Lock, mono, phrase, RoundLine, roundLineEnd, Scrim, type Shot, Slash, Sphere, Stage, type Tone, TypeStack, W } from "./kit";

/**
 * The 23-shot showreel, 30 s at 120 BPM (0.5 s a beat). Every shot is a pure function of its local time t
 * and runs inside its own <Sequence> in Reel.tsx, so the approved board animates directly.
 * `key` is the storyboard keyframe (local seconds).
 */
export type ShotDef = { id: string; chapter: string; start: number; end: number; key: number; tone: Tone; C: FC<{ t: number }>; text: string; note: string };

const yellowUp = { UP: C.signal, "UP.": C.signal, Up: C.signal };

// Page cameras (focus points debug-measured on the flat page: up 1122,443 · chips y582 · countdown 1267,209 ·
// chart 516,531 · pots 516,762).
const wide: Shot = { fx: 900, fy: 470, sx: 1000, sy: 560, scale: 0.92, rx: 16, ry: -24, rz: 6 };
const formShot: Shot = { fx: 1214, fy: 470, sx: 1240, sy: 540, scale: 1.45, rx: 12, ry: -20, rz: 5 };

// ---------------------------------------------------------------------------------------------------------------
// 01 · HOOK

const S1a: FC<{ t: number }> = ({ t }) => {
  const u = step(t + 0.04, { stiffness: 420, damping: 26 }); // already slamming in on frame 0
  return (
    <>
      <Fill color={C.ink} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ ...display(380, C.fg), scale: String(1.6 - 0.6 * u), opacity: clamp01(0.5 + t / 0.08), filter: u < 0.9 ? `blur(${(1 - u) * 18}px)` : undefined }}>Think</div>
      </div>
    </>
  );
};

const S1b: FC<{ t: number }> = ({ t }) => (
  <>
    <Fill color={C.ink} />
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", ...display(250, C.fg) }}>
      <Words t={t} gap="0.2em" words={[{ text: "BTC", at: -0.12 }, { text: "goes", at: 0.25 }, { text: "up", at: 0.5, color: C.signal }]} />
    </div>
  </>
);

const S1c: FC<{ t: number }> = ({ t }) => {
  const k = swapIn(t, 0, Infinity, 0);
  return (
    <>
      <Fill color={C.ink} />
      <TypeStack t={t} text="15 MINUTES" filledText="15 MINUTES?" size={190} rows={9} skip={[-1]} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 540 - 190 - 48, display: "flex", justifyContent: "center", ...display(96, C.fg), opacity: k.opacity, filter: k.filter }}>
        <Words t={t} gap="0.22em" words={phrase("in the next", 0.02, 0.1)} />
      </div>
    </>
  );
};

const S1d: FC<{ t: number }> = ({ t }) => {
  const wipe = clamp01((t + 0.06) / 0.22); // already moving on the cut frame
  const u = land(clamp01((t - 0.14) / 0.3));
  return (
    <>
      <Fill color={C.ink} />
      <div style={{ position: "absolute", inset: 0, background: C.signal, clipPath: `polygon(0 0, ${wipe * 140}% 0, ${wipe * 140 - 40}% 100%, 0 100%)` }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Echo color="rgba(0,0,0,0.55)" n={3} dx={-30 * u} dy={-16 * u} style={{ ...display(400, C.ink), letterSpacing: "-0.055em", opacity: u, translate: `${(1 - u) * 160}px 0` }}>
          Call it.
        </Echo>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 02 · PICK

const S2a: FC<{ t: number }> = ({ t }) => {
  // Whip push out of the yellow "Call it." frame: the yellow slab leaves left as the page arrives from the right.
  const whip = Easing.bezier(0.3, 0.7, 0.2, 1)(clamp01((t + 0.02) / 0.16));
  const arrive = 1 - Easing.bezier(0.1, 0.9, 0.2, 1)(clamp01((t + 0.02) / 0.3));
  return (
    <>
      <div style={{ position: "absolute", inset: 0, translate: `${arrive * 900}px 0` }}>
        <Stage t={t} a={{ ...wide, scale: 0.7, rz: 9 }} b={wide} spring={fast} page={{ clock: 4 + t }} focus={[700, 560]} />
      </div>
      {whip < 1 ? <div style={{ position: "absolute", inset: 0, background: C.signal, translate: `${-whip * 110}% 0` }} /> : null}
    </>
  );
};

const S2b: FC<{ t: number }> = ({ t }) => {
  const pick = 0.45;
  const flash = t >= pick ? Math.max(0, 1 - (t - pick) / 0.22) : 0;
  return (
    <>
      <Stage t={t} a={{ ...formShot, fx: 1122, fy: 443, sx: 960, sy: 540, scale: 3.0, rx: 8, ry: -12, rz: 3 }} b={{ ...formShot, fx: 1122, fy: 443, sx: 960, sy: 540, scale: 3.3, rx: 8, ry: -10, rz: 3 }} spring={fast} page={{ pickAt: pick, clock: 5 + t }} focus={[260, 160]} blur={10} />
      <div style={{ position: "absolute", inset: 0, background: C.signal, opacity: flash * 0.35, mixBlendMode: "screen" }} />
      <MeasuredCursor t={t} selector='[data-copy="sharp"] [data-target="up"]' from={{ t: 0, x: 1500, y: 980 }} arriveAt={pick} anchor={{ x: 0.86, y: 0.8 }} size={2.2} />
    </>
  );
};

const S2c: FC<{ t: number }> = ({ t }) => {
  const u = land(clamp01(t / 0.35));
  const seam = 1000 - 0; // the diagonal runs from (1180,0) to (740,1080)
  const ax = 1100 + (1 - u) * 300;
  const bx = 820 - (1 - u) * 300;
  return (
    <>
      <Fill color={C.red} />
      <div style={{ position: "absolute", inset: 0, background: C.signal, clipPath: `polygon(0 0, ${ax}px 0, ${bx}px 100%, 0 100%)` }} />
      <div style={{ position: "absolute", inset: 0, clipPath: `polygon(${ax - 18}px 0, ${ax + 18}px 0, ${bx + 18}px 100%, ${bx - 18}px 100%)`, background: C.ink }} />
      <div style={{ position: "absolute", left: 90, top: 520, ...display(340, C.ink), letterSpacing: "-0.06em", translate: `${(1 - u) * -200}px 0` }}>↑UP</div>
      <div style={{ position: "absolute", right: 72, top: 150, ...display(220, C.ink), letterSpacing: "-0.06em", translate: `${(1 - u) * 200}px 0` }}>DOWN↓</div>
      <div style={{ position: "absolute", left: 112, top: 150, display: "grid", gap: 10, color: C.ink }}>
        <div style={display(64)}>
          <Words t={t} gap="0.22em" words={[{ text: "Pick", at: 0.2 }, { text: "UP", at: 0.32 }, { text: "or", at: 0.44 }, { text: "DOWN.", at: 0.56 }]} />
        </div>
        <div style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 32, opacity: clamp01((t - 0.75) / 0.2) }}>Before the round starts.</div>
      </div>
      {seam ? null : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 03 · STAKE

const S3a: FC<{ t: number }> = ({ t }) => {
  const chip = 0.55;
  const base = { fx: 1215, fy: 560, sx: 960, sy: 560, scale: 2.6, rx: 10, ry: -16, rz: 4 };
  return (
    <>
      <Stage t={t} a={{ ...base, fx: 1380 }} b={{ ...base, fx: 1120 }} spring={{ stiffness: 40, damping: 14, mass: 1 }} page={{ chipAt: chip, clock: 7.5 + t }} focus={[420, 160]} blur={9} />
      <MeasuredCursor t={t} selector='[data-copy="sharp"] [data-target="chip-0.10"]' from={{ t: 0, x: 1400, y: 1000 }} arriveAt={chip} anchor={{ x: 0.9, y: 0.9 }} size={2} />
    </>
  );
};

const S3b: FC<{ t: number }> = ({ t }) => {
  const k = swapIn(t, 0, Infinity, 0);
  return (
    <>
      <Fill color={C.ink} />
      <TypeStack t={t} text="0.10 USDC" filledText="0.10 USDC." size={200} rows={9} scroll={-260} drift={-24} skip={[-1]} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 540 - 200 - 48, display: "flex", justifyContent: "center", ...display(96, C.fg), opacity: k.opacity, filter: k.filter }}>From</div>
    </>
  );
};

const S3c: FC<{ t: number }> = ({ t }) => {
  const s: Shot = { fx: 1300, fy: 205, sx: 1380, sy: 380, scale: 2.1, rx: 10, ry: -18, rz: 4 };
  return (
    <>
      <Stage t={t} a={{ ...s, scale: 1.8 }} b={s} page={{ clock: 9.5 + t }} focus={[420, 190]} blur={8} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0) 48%, rgba(0,0,0,0.94) 64%, #000 100%)" }} />
      <Caption t={t} y={700} lines={[phrase("One side per account.", 0.1, 0.1)]} size={68} sub={["Predictions close 60 seconds before the start."]} subAt={0.5} subSize={34} width={1000} />
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 04 · 15 MIN

const chartShot: Shot = { fx: 560, fy: 520, sx: 960, sy: 520, scale: 1.75, rx: 12, ry: -14, rz: 3 };

const S4a: FC<{ t: number }> = ({ t }) => <Stage t={t} a={{ ...chartShot, fx: 380 }} b={chartShot} page={{ anchor: true, clock: 11 + t }} focus={[600, 230]} topFade bottomFade />;

const S4b: FC<{ t: number }> = ({ t }) => {
  const cx = 960;
  const cy = 520;
  const r = 380;
  const prog = 0.012 + t * 0.004; // thin progress arc: the round has just begun
  const a = -Math.PI / 2 + prog * Math.PI * 2;
  const s = 15 * 60 - Math.floor(t * 2) * 0; // holds on 15:00 for the board
  const label = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return (
    <>
      <Fill color={C.ink} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.line} strokeWidth={2} />
        {Array.from({ length: 60 }, (_, i) => {
          const th = (i / 60) * Math.PI * 2 - Math.PI / 2;
          const l = i % 5 === 0 ? 18 : 8;
          return <line key={i} x1={cx + Math.cos(th) * (r + 14)} y1={cy + Math.sin(th) * (r + 14)} x2={cx + Math.cos(th) * (r + 14 + l)} y2={cy + Math.sin(th) * (r + 14 + l)} stroke={C.dim} strokeOpacity={i % 5 === 0 ? 0.9 : 0.4} strokeWidth={2} />;
        })}
        <path d={`M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`} fill="none" stroke={C.signal} strokeWidth={4} strokeLinecap="round" />
        <circle cx={cx + Math.cos(a) * r} cy={cy + Math.sin(a) * r} r={9} fill={C.signal} />
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, top: cy, translate: "0 -50%", display: "flex", justifyContent: "center", fontFamily: FONT.mono, fontWeight: 700, fontSize: 300, letterSpacing: "-0.04em", color: C.fg, fontVariantNumeric: "tabular-nums" }}>
        {label.split("").map((ch, i) => {
          const d = land(clamp01((t + 0.1 - i * 0.07) / 0.18));
          return (
            <span key={i} style={{ display: "inline-block", translate: `0 ${(1 - d) * -60}px`, opacity: d, filter: d < 1 ? `blur(${(1 - d) * 10}px)` : undefined }}>
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: cy + 170, textAlign: "center", ...mono(22, C.dim, 700) }}>ONE ROUND · 15 MINUTES</div>
    </>
  );
};

const S4c: FC<{ t: number }> = ({ t }) => (
  <>
    <Stage t={t} a={{ ...chartShot, fx: 420, fy: 540, sx: 1240, sy: 600, scale: 1.3, ry: -20 }} b={{ ...chartShot, fx: 520, fy: 540, sx: 1240, sy: 600, scale: 1.36, ry: -20 }} spring={{ stiffness: 30, damping: 12, mass: 1 }} page={{ anchor: true, clock: 13 + t }} focus={[620, 220]} blur={6} dim={0.3} />
    <Scrim x={560} y={520} rx={1000} ry={560} />
    <Caption t={t} y={330} size={150} lines={[phrase("15 minutes.", 0.05, 0.14), [{ text: "Up", at: 0.45, color: C.signal }, { text: "or", at: 0.57 }, { text: "down?", at: 0.69, color: C.red }]]} />
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// 05 · PRICE

const Hud = ({ rows, t }: { rows: [string, string][]; t: number }) => (
  <div style={{ position: "absolute", left: 112, top: 360, display: "grid", gap: 22 }}>
    {rows.map(([k, v], i) => {
      const s = swapIn(t, 0.1 + i * 0.12, Infinity, 0);
      return (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "150px auto", ...mono(24, C.fg, 700), opacity: s.opacity, filter: s.filter }}>
          <span style={{ color: C.dim }}>{k}</span>
          <span style={{ color: i === 0 ? C.signal : C.fg }}>{v}</span>
        </div>
      );
    })}
  </div>
);

const S5a: FC<{ t: number }> = ({ t }) => (
  <>
    <Fill color={C.ink} />
    <Sphere t={t} cx={1080} cy={520} r={320} />
    <Hud t={t} rows={[["SOURCE", "CHAINLINK"], ["START", "05:00:00 PM"], ["CLOSE", "05:15:00 PM"], ["CHECK", "ON-CHAIN"]]} />
    <div style={{ position: "absolute", left: 112, top: 300, ...mono(16, C.dim, 700) }}>PRICE FEED</div>
    {/* depth scale */}
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <line x1={1760} y1={250} x2={1760} y2={800} stroke={C.dim} strokeOpacity={0.6} strokeWidth={1.5} />
      {Array.from({ length: 23 }, (_, i) => (
        <line key={i} x1={1760} x2={i % 5 === 0 ? 1740 : 1750} y1={250 + i * 25} y2={250 + i * 25} stroke={C.dim} strokeOpacity={0.6} strokeWidth={1.5} />
      ))}
      <path d={`M1772 ${520 + Math.sin(t * 2) * 60} l14 -8 v16 z`} fill={C.signal} />
    </svg>
    <div style={{ position: "absolute", left: 1716, top: 214, ...mono(14, C.dim, 700) }}>DEPTH</div>
    {/* scanlines */}
    <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 4px)" }} />
  </>
);

const S5b: FC<{ t: number }> = ({ t }) => {
  const head = 0.25 + 0.75 * land(clamp01(t / 0.9));
  const end = roundLineEnd(1640, 650, 120);
  return (
    <>
      <Fill color={C.ink} />
      <RoundLine head={head} x0={280} x1={1640} anchor={650} amp={120} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <line x1={280} y1={500} x2={280} y2={760} stroke={C.fg} strokeOpacity={0.5} strokeWidth={2} />
        <line x1={1640} y1={500} x2={1640} y2={760} stroke={C.fg} strokeOpacity={0.5} strokeWidth={2} />
        <circle cx={280} cy={650} r={8} fill={C.fg} />
      </svg>
      <Lock x={280} y={650} p={(t - 0.15) / 0.3} />
      <Lock x={end.x} y={end.y} p={(t - 0.9) / 0.3} />
      <div style={{ position: "absolute", left: 280, top: 790, translate: "-50% 0", opacity: clamp01((t - 0.2) / 0.2) }}>
        <ChainlinkTag label="START · 05:00:00 PM" />
      </div>
      <div style={{ position: "absolute", left: 1640, top: 790, translate: "-50% 0", opacity: clamp01((t - 0.95) / 0.2) }}>
        <ChainlinkTag label="CLOSE · 05:15:00 PM" />
      </div>
      <Caption t={t} y={170} align="center" size={84} lines={[phrase("Prices come from Chainlink.", 0.05, 0.1)]} sub={["The exact start and end second, checked on-chain."]} subAt={0.45} subSize={34} width={1400} />
    </>
  );
};

const S5c: FC<{ t: number }> = ({ t }) => (
  <>
    <Fill color={C.ink} />
    <Caption t={t} y={340} align="center" size={150} lines={[phrase("Nobody at Mako Market", -0.1, 0.1, { Nobody: C.signal }), phrase("picks the price.", 0.5, 0.12)]} />
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// 06 · POT

const potShot: Shot = { fx: 360, fy: 752, sx: 860, sy: 560, scale: 2.4, rx: 12, ry: -12, rz: 3 };
const FEE = "1% to Mako Market. 2% of the smaller side to the round's host.";

const S6a: FC<{ t: number }> = ({ t }) => {
  const share = 0.5 + 0.08 * step(t - 0.1, { stiffness: 120, damping: 20 });
  return <Stage t={t} a={{ ...potShot, scale: 1.55 }} b={potShot} spring={fast} page={{ upShare: share, settled: { wonAt: 0.45, fee: FEE }, clock: 19 + t }} focus={[760, 170]} blur={8} topFade />;
};

const S6b: FC<{ t: number }> = ({ t }) => {
  const x0 = 260;
  const x1 = 1660;
  const split = 0.56;
  const y = 640;
  const n = 9;
  const sx = x0 + (x1 - x0) * split;
  const segW = (x1 - sx) / n;
  return (
    <>
      <Fill color={C.ink} />
      <div style={{ position: "absolute", left: x0, top: y, width: sx - x0, height: 64, borderRadius: "9999px 0 0 9999px", background: C.signal }} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <rect x={sx + 4} y={y + 1} width={x1 - sx - 5} height={62} rx={31} fill="none" stroke={C.red} strokeOpacity={0.45} strokeWidth={2} strokeDasharray="6 8" />
      </svg>
      {Array.from({ length: n }, (_, i) => {
        const go = land(clamp01((t - 0.15 - i * 0.06) / 0.6));
        const fromX = sx + i * segW;
        const toX = x0 + 40 + i * ((sx - x0 - 120) / n);
        const x = fromX + (toX - fromX) * go;
        const arc = Math.sin(go * Math.PI) * -(150 + i * 12);
        const col = go > 0.55 ? C.signal : C.red;
        return <div key={i} style={{ position: "absolute", left: x, top: y + 12 + arc, width: segW - 10, height: 40, borderRadius: 9999, background: col, scale: String(1 - 0.3 * go) }} />;
      })}
      <div style={{ position: "absolute", left: x0, top: y + 90, ...mono(20, C.fg, 700) }}>↑ UP · WON</div>
      <div style={{ position: "absolute", right: W - x1, top: y + 90, ...mono(20, C.dim, 700) }}>DOWN ↓</div>
      <Caption t={t} y={260} align="center" size={140} lines={[phrase("splits the pot.", 0.15, 0.12)]} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 200, textAlign: "center", fontFamily: FONT.sans, fontWeight: 600, fontSize: 36, color: C.dim, opacity: clamp01(t / 0.15) }}>The side that called it</div>
    </>
  );
};

const S6c: FC<{ t: number }> = ({ t }) => {
  const u = land(clamp01((t + 0.12) / 0.4));
  const row = (big: string, text: string, i: number) => {
    const s = swapIn(t, 0.08 + i * 0.22, Infinity, 0);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", alignItems: "center", padding: "30px 0", boxShadow: i ? `inset 0 1px 0 ${C.line}` : undefined, opacity: s.opacity, filter: s.filter }}>
        <span style={{ ...display(120, C.signal), fontVariantNumeric: "tabular-nums" }}>{big}</span>
        <span style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 44, lineHeight: 1.2, color: C.fg }}>{text}</span>
      </div>
    );
  };
  return (
    <>
      <Fill color={C.ink} />
      <div style={{ position: "absolute", left: "50%", top: 520, translate: `-50% calc(-50% + ${(1 - u) * 60}px)`, opacity: u, width: 1220, padding: "44px 64px 30px", borderRadius: 32, background: C.raise, boxSizing: "border-box" }}>
        <div style={{ ...mono(18, C.dim, 700) }}>FEES · TAKEN WHEN A ROUND SETTLES</div>
        <div style={{ marginTop: 14 }}>
          {row("1%", "to Mako Market.", 0)}
          {row("2%", "of the smaller side to the round's host.", 1)}
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// 07 · REFUND (paper)

const card: CSSProperties = { width: 440, padding: 30, boxSizing: "border-box", borderRadius: 26, background: C.ink, color: C.fg, fontFamily: FONT.sans, boxShadow: "0 2px 6px rgba(40,30,10,0.12), 0 36px 90px rgba(40,30,10,0.30)" };

function RefundCard() {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ height: 24, display: "flex", alignItems: "center", padding: "0 10px", borderRadius: 9999, background: C.raise2, color: C.fg, fontSize: 11, fontWeight: 800, letterSpacing: "0.12em" }}>REFUNDED</span>
        <span style={{ ...mono(11, C.dim), letterSpacing: "0.02em" }}>Round #1 · 11:00 AM to 11:15 AM</span>
      </div>
      <div style={{ ...display(34), letterSpacing: "-0.03em", lineHeight: 1.04, marginTop: 16 }}>
        BTC up or down
        <br />
        by 11:15 AM?
      </div>
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 22, paddingTop: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", color: C.dim }}>RESULT</div>
        <div style={{ ...display(68), marginTop: 6 }}>Refund</div>
      </div>
      <div style={{ marginTop: 20, padding: "12px 16px", borderRadius: 12, background: C.raise, fontSize: 16, lineHeight: 1.45 }}>Only one side came in, so everyone gets their stake back.</div>
    </div>
  );
}

const PaperBg = () => <Fill color={C.paper} />;

const S7a: FC<{ t: number }> = ({ t }) => {
  const turn = step(t + 0.04, { stiffness: 110, damping: 18 });
  return (
    <>
      <PaperBg />
      <Caption t={t} y={380} color={C.ink} size={110} lines={[phrase("One side only,", -0.05, 0.12), phrase("or a tie?", 0.3, 0.12)]} />
      <div style={{ position: "absolute", left: 1800 - 440, top: 540, translate: "0 -50%", transform: `perspective(2200px) rotateY(${-70 + 62 * turn}deg) scale(1.38)`, transformOrigin: "100% 50%", opacity: clamp01((t + 0.04) / 0.1) }}>
        <RefundCard />
      </div>
    </>
  );
};

const S7b: FC<{ t: number }> = ({ t }) => (
  <>
    <PaperBg />
    <Caption t={t} y={330} color={C.ink} size={128} lines={[phrase("Everyone gets their", -0.1, 0.1), phrase("full stake back.", 0.4, 0.1)]} />
    <div style={{ position: "absolute", left: 112, top: 690, opacity: clamp01((t - 0.8) / 0.12), scale: String(0.9 + 0.1 * land(clamp01((t - 0.8) / 0.25))), transformOrigin: "0 50%" }}>
      <span style={{ ...display(110, C.ink), background: C.signal, borderRadius: 9999, padding: "4px 40px 14px" }}>No fee.</span>
    </div>
  </>
);

// ---------------------------------------------------------------------------------------------------------------
// 08 · START

function SignInCard({ typed, caretOn }: { typed: string; caretOn: boolean }) {
  return (
    <div style={card}>
      <div style={{ ...display(32), letterSpacing: "-0.03em", lineHeight: 1.05 }}>
        Sign in or
        <br />
        create an account
      </div>
      <div style={{ fontSize: 15, color: C.dim, marginTop: 10 }}>You get a one-time code. No password.</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 24 }}>Email</div>
      <div data-target="email" style={{ marginTop: 8, height: 60, borderRadius: 14, background: C.raise, boxShadow: `inset 0 0 0 1.5px ${typed ? C.fg : C.line}`, display: "flex", alignItems: "center", gap: 12, padding: "0 18px" }}>
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={C.dim} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h16v12H4zM4 7l8 6 8-6" />
        </svg>
        <span style={{ fontSize: 18, color: typed ? C.fg : C.dim }}>{typed || "you@email.com"}</span>
        <span style={{ width: 2, height: 24, background: C.fg, opacity: caretOn ? 1 : 0, marginLeft: -10 }} />
      </div>
      <div data-target="continue" style={{ marginTop: 16, height: 56, borderRadius: 9999, background: C.signal, ...display(18, "#000"), letterSpacing: "-0.01em", display: "flex", alignItems: "center", justifyContent: "center" }}>
        Continue
      </div>
    </div>
  );
}

const S8a: FC<{ t: number }> = ({ t }) => {
  const email = "you@email.com";
  const typed = email.slice(0, Math.floor(clamp01((t - 0.15) / 0.6) * email.length));
  const rise = 1 - step(t, { stiffness: 140, damping: 20 });
  return (
    <>
      <PaperBg />
      <Caption t={t} y={400} color={C.ink} size={110} lines={[phrase("Sign in with email.", 0.05, 0.1)]} sub={["No MON needed."]} subAt={0.35} subSize={56} subColor={C.ink} />
      <div style={{ position: "absolute", left: 1800 - 440, top: 540, translate: `0 calc(-50% + ${rise * 120}px)`, transform: "perspective(2200px) rotateY(-8deg) scale(1.38)", transformOrigin: "100% 50%" }}>
        <SignInCard typed={typed} caretOn={Math.floor(t * 4) % 2 === 0 || typed.length < email.length} />
      </div>
    </>
  );
};

const PERKS: [string, string, string, string][] = [
  ["Gas covered", "M13 3L5 14h6l-1 7 8-11h-6z", C.signal, C.ink],
  ["Free test USDC", "M12 5v14M5 12h14", C.ink, C.fg],
  ["Monad testnet", "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z", C.paper, C.ink],
];
export const perkTone = (t: number): Tone => (Math.min(2, Math.floor(t / 0.333)) === 1 ? "dark" : "light");

export const S8b: FC<{ t: number; only?: number }> = ({ t, only }) => {
  const i = only ?? Math.min(2, Math.floor(t / 0.333));
  const local = only === undefined ? t - i * 0.333 : 0.3;
  const [word, icon, bg, fg] = PERKS[i];
  const u = land(clamp01(local / 0.18));
  return (
    <>
      <Fill color={bg} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 48, translate: `${(1 - u) * 120}px 0` }}>
        <span style={{ width: 170, height: 170, borderRadius: 9999, background: fg === C.ink ? C.ink : C.signal, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width={88} height={88} viewBox="0 0 24 24" fill="none" stroke={fg === C.ink ? (bg === C.paper ? C.signal : C.signal) : C.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </span>
        <span style={display(190, fg)}>{word}</span>
      </div>
    </>
  );
};

const S8c: FC<{ t: number }> = ({ t }) => {
  const u = land(clamp01((t + 0.1) / 0.45));
  const pill = land(clamp01((t - 0.3) / 0.35));
  const s2 = swapIn(t, 0.6, Infinity, 0);
  return (
    <>
      <PaperBg />
      <div style={{ position: "absolute", left: 0, right: 0, top: 210, display: "grid", justifyItems: "center", color: C.ink }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24, opacity: u, translate: `0 ${(1 - u) * 40}px` }}>
          <Logo size={110} color={C.ink} />
          <span style={display(96)}>Mako Market</span>
        </div>
        <div style={{ marginTop: 64, display: "flex", alignItems: "center", gap: 14, ...mono(26, C.ink, 700), opacity: clamp01((t - 0.25) / 0.15) }}>
          <span style={{ width: 16, height: 16, borderRadius: 9999, background: C.ink }} />
          LIVE NOW
        </div>
        <div style={{ marginTop: 20, padding: "22px 56px 26px", borderRadius: 9999, background: C.signal, fontFamily: FONT.mono, fontWeight: 700, fontSize: 92, letterSpacing: "-0.03em", lineHeight: 1, opacity: pill, scale: String(0.92 + 0.08 * pill), clipPath: `inset(0 ${(1 - pill) * 50}% 0 ${(1 - pill) * 50}% round 9999px)` }}>
          makomarket.xyz/rounds
        </div>
        <div style={{ marginTop: 34, fontFamily: FONT.sans, fontWeight: 600, fontSize: 40, color: "rgba(0,0,0,0.66)", opacity: s2.opacity, filter: s2.filter }}>New rounds every 2 hours.</div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------

export const SHOTS: ShotDef[] = [
  { id: "1a", chapter: "01 · HOOK", start: 0, end: 1, key: 0.85, tone: "dark", C: S1a, text: "Think", note: "Chrome brackets draw in; \"Think\" slams in from 1.6x scale with a blur. Hard cut on the beat." },
  { id: "1b", chapter: "01 · HOOK", start: 1, end: 2, key: 0.9, tone: "dark", C: S1b, text: "BTC goes up", note: "Word by word on eighths, \"up\" in signal yellow. Cut." },
  { id: "1c", chapter: "01 · HOOK", start: 2, end: 3, key: 0.85, tone: "dark", C: S1c, text: "in the next 15 minutes?", note: "Outline stack of \"15 MINUTES\" scrolls up and settles; the centre row fills yellow." },
  { id: "1d", chapter: "01 · HOOK", start: 3, end: 4, key: 0.8, tone: "light", C: S1d, text: "Call it.", note: "Yellow diagonal slash wipes full bleed; \"Call it.\" punches in with outline echoes. Music hit." },
  { id: "2a", chapter: "02 · PICK", start: 4, end: 5, key: 0.85, tone: "dark", C: S2a, text: "(round page)", note: "Whip in from yellow: the dark round page in 3D, fast push-in on a spring." },
  { id: "2b", chapter: "02 · PICK", start: 5, end: 6, key: 0.85, tone: "dark", C: S2b, text: "(UP toggle)", note: "Macro on the toggle; cursor taps UP, pill fills, a short yellow flash. Tap SFX." },
  { id: "2c", chapter: "02 · PICK", start: 6, end: 7.5, key: 1.3, tone: "light", C: S2c, text: "Pick UP or DOWN. Before the round starts.", note: "Diagonal split slams together: yellow UP half, red DOWN half; caption lands on the beat." },
  { id: "3a", chapter: "03 · STAKE", start: 7.5, end: 8.5, key: 0.85, tone: "dark", C: S3a, text: "(stake chips)", note: "Macro truck along the chip row; cursor taps 0.10, the chip lights and the field reads 0.10." },
  { id: "3b", chapter: "03 · STAKE", start: 8.5, end: 9.5, key: 0.85, tone: "dark", C: S3b, text: "From 0.10 USDC.", note: "Outline stack of \"0.10 USDC\" scrolls down and settles, centre row in yellow." },
  { id: "3c", chapter: "03 · STAKE", start: 9.5, end: 11, key: 1.3, tone: "dark", C: S3c, text: "One side per account. Predictions close 60 seconds before the start.", note: "Macro on the live countdown, ticking; caption under it on the left." },
  { id: "4a", chapter: "04 · 15 MIN", start: 11, end: 12, key: 0.85, tone: "dark", C: S4a, text: "(chart, starting-price line)", note: "Pan across the chart: candles running, the dashed starting-price line and its note." },
  { id: "4b", chapter: "04 · 15 MIN", start: 12, end: 13, key: 0.8, tone: "dark", C: S4b, text: "15:00", note: "Full-screen mono 15:00 with a thin progress ring and second ticks; digits tick on the beat." },
  { id: "4c", chapter: "04 · 15 MIN", start: 13, end: 14.5, key: 1.2, tone: "dark", C: S4c, text: "15 minutes. Up or down?", note: "Type over the dimmed, drifting chart; yellow slash cut out on the last beat." },
  { id: "5a", chapter: "05 · PRICE", start: 14.5, end: 16, key: 1.3, tone: "dark", C: S5a, text: "SOURCE CHAINLINK · START 05:00:00 PM · CLOSE 05:15:00 PM · CHECK ON-CHAIN", note: "Particle sphere of price points turning, orbit lines, HUD readouts tick in, depth scale, scanlines." },
  { id: "5b", chapter: "05 · PRICE", start: 16, end: 17.5, key: 1.3, tone: "dark", C: S5b, text: "Prices come from Chainlink. The exact start and end second, checked on-chain.", note: "The line runs to CLOSE; lock-on brackets snap onto START, then CLOSE, each with a Chainlink tag." },
  { id: "5c", chapter: "05 · PRICE", start: 17.5, end: 19, key: 1.3, tone: "dark", C: S5c, text: "Nobody at Mako Market picks the price.", note: "Type on black, word by word. Hold one beat." },
  { id: "6a", chapter: "06 · POT", start: 19, end: 20, key: 0.85, tone: "dark", C: S6a, text: "(pot bar, WON)", note: "Macro on the pot bar: UP side fills, the WON tag pops, DOWN dims. No amounts." },
  { id: "6b", chapter: "06 · POT", start: 20, end: 21.5, key: 0.6, tone: "dark", C: S6b, text: "The side that called it splits the pot.", note: "The DOWN side breaks into shares that arc over and land on the UP side, turning yellow." },
  { id: "6c", chapter: "06 · POT", start: 21.5, end: 23, key: 1.2, tone: "dark", C: S6c, text: "1% to Mako Market. 2% of the smaller side to the round's host.", note: "A clean fee card rises; the two rows land on beats." },
  { id: "7a", chapter: "07 · REFUND", start: 23, end: 24.5, key: 1.3, tone: "light", C: S7a, text: "One side only, or a tie?", note: "Paper slash wipe; the round #1 card turns to face the viewer." },
  { id: "7b", chapter: "07 · REFUND", start: 24.5, end: 26, key: 1.3, tone: "light", C: S7b, text: "Everyone gets their full stake back. No fee.", note: "Type on paper; \"No fee.\" lands in a yellow pill." },
  { id: "8a", chapter: "08 · START", start: 26, end: 27, key: 0.9, tone: "light", C: S8a, text: "Sign in with email. No MON needed.", note: "Sign-in card rises; an email types into the Email field." },
  { id: "8b", chapter: "08 · START", start: 27, end: 28, key: 0.5, tone: "dark", C: S8b, text: "Gas covered · Free test USDC · Monad testnet", note: "Three hard cuts, 0.33 s each: yellow, black, paper." },
  { id: "8c", chapter: "08 · START", start: 28, end: 30, key: 1.6, tone: "light", C: S8c, text: "Live now: makomarket.xyz/rounds · New rounds every 2 hours.", note: "End card: logo and wordmark rise, the URL opens in a big yellow pill, cadence blurs in. Hold, music out." },
];

