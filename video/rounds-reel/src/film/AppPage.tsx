import type { CSSProperties } from "react";

import { candles, Logo, SideToggle } from "./parts";
import { C, FONT } from "./tokens";

/**
 * Frame-driven twin of the desktop round page (dark theme), at the app's own CSS pixels for a 1440 px viewport.
 * Structure and sizes copied from:
 *   src/components/shell/DesktopHeader.tsx  (68 px header, logo + wordmark + BETA, nav pills, Sign in)
 *   src/app/rounds/[id]/RoundClient.tsx     (RoundView, Pots, EnterForm)
 *   src/components/MarketChart.tsx          (pair, timeframe pills, candles: up = signal, down = red in dark)
 * Film changes: no live data. No prices, balances, pots or player counts; the pot bar is an illustrative split
 * with no labels; the chart has no axis. The countdown shows the round length (15:00) ticking.
 */
export const PAGE = { width: 1440, height: 900, chrome: 40 } as const;

const display: CSSProperties = { fontFamily: FONT.display, fontWeight: 800 };
const mono: CSSProperties = { fontFamily: FONT.mono };
const CHIPS = ["0.10", "1", "5", "10", "25", "50"];
const NAV = ["Pools", "Rounds", "News", "Leaderboard", "Me"];
const SERIES = candles(64, 3);

export function countdown(t: number, from = 15 * 60) {
  const s = Math.max(0, from - Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const START_CANDLE = 44;

function Chart({ t, width, height, anchor = false }: { t: number; width: number; height: number; anchor?: boolean }) {
  // Candles arrive left to right in the first second, then the live candle breathes.
  const n = SERIES.length;
  const slot = width / n;
  const pad = 18;
  const y = (v: number) => pad + ((1 - (v + 1) / 2) * (height - pad * 2)) * 0.92;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {[0.2, 0.4, 0.6, 0.8].map((g) => (
        <line key={g} x1={0} x2={width} y1={height * g} y2={height * g} stroke={C.grid} strokeWidth={1} />
      ))}
      {[0.2, 0.4, 0.6, 0.8].map((g) => (
        <line key={`v${g}`} y1={0} y2={height} x1={width * g} x2={width * g} stroke={C.grid} strokeWidth={1} />
      ))}
      {anchor ? (
        <g>
          <line x1={START_CANDLE * slot} x2={width} y1={y(SERIES[START_CANDLE].o)} y2={y(SERIES[START_CANDLE].o)} stroke={C.fg} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="5 7" />
          <line x1={START_CANDLE * slot} x2={START_CANDLE * slot} y1={0} y2={height} stroke={C.dim} strokeOpacity={0.8} strokeWidth={1.5} strokeDasharray="5 7" />
        </g>
      ) : null}
      {SERIES.map((c, i) => {
        const shown = Math.min(1, Math.max(0, (t * 90 - i) / 6));
        if (shown <= 0) return null;
        const last = i === n - 1;
        const close = last ? c.c + 0.06 * Math.sin(t * 5.3) : c.c;
        const up = close >= c.o;
        const col = up ? C.signal : C.red;
        const x = i * slot + slot / 2;
        const top = y(Math.max(c.o, close));
        const bot = y(Math.min(c.o, close));
        return (
          <g key={i} opacity={shown}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1.5} />
            <rect x={x - slot * 0.32} width={slot * 0.64} y={top} height={Math.max(2, bot - top)} fill={col} rx={1} />
          </g>
        );
      })}
    </svg>
  );
}

export type PageOpts = {
  /** Film-clock seconds for the countdown (defaults to t). */
  clock?: number;
  /** When the 0.10 chip gets picked (the field and active chip switch from 5 to 0.10). */
  chipAt?: number;
  /** Draw the dashed starting-price line and its note on the chart. */
  anchor?: boolean;
  /** Settled view: Result UP, WON on the UP side, DOWN dims, fee note. */
  settled?: { wonAt: number; fee: string };
};

export function AppPage({ t, pickAt, upShare, clock, chipAt = Infinity, anchor = false, settled }: { t: number; pickAt: number; upShare: number } & PageOpts) {
  const cd = countdown(clock ?? t);
  const tenth = t >= chipAt;
  const won = settled ? Math.min(1, Math.max(0, (t - settled.wonAt) / 0.25)) : 0;
  return (
    <div style={{ width: PAGE.width, height: PAGE.height + PAGE.chrome, background: C.ink, color: C.fg, fontFamily: FONT.sans, fontWeight: 500, overflow: "hidden", borderRadius: 18, boxShadow: `inset 0 0 0 1px ${C.line}`, position: "relative" }}>
      {/* Browser bar */}
      <div style={{ height: PAGE.chrome, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", boxShadow: `inset 0 -1px 0 ${C.line}` }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: 9999, background: C.raise2 }} />
        ))}
        <span style={{ margin: "0 auto", height: 24, padding: "0 14px", borderRadius: 8, background: C.raise, display: "flex", alignItems: "center", ...mono, fontSize: 12, color: C.dim, translate: "-28px 0" }}>makomarket.xyz/rounds</span>
      </div>

      <div style={{ padding: "0 36px" }}>
        {/* DesktopHeader */}
        <header style={{ height: 68, display: "flex", alignItems: "center", gap: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Logo size={28} color={C.fg} />
            <span style={{ ...display, fontSize: 20, letterSpacing: "-0.03em" }}>Mako Market</span>
            <span style={{ height: 22, display: "inline-flex", alignItems: "center", padding: "0 8px", borderRadius: 6, background: C.signal, color: "#000", ...mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em" }}>BETA</span>
          </div>
          <nav style={{ display: "flex", gap: 2, padding: 4, borderRadius: 9999, background: C.raise }}>
            {NAV.map((n) => (
              <span key={n} style={{ height: 36, display: "flex", alignItems: "center", padding: "0 16px", borderRadius: 9999, ...display, fontSize: 15, background: n === "Rounds" ? C.fg : "transparent", color: n === "Rounds" ? C.ink : C.dim }}>
                {n}
              </span>
            ))}
          </nav>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9999, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
              <span style={{ width: 32, height: 32, borderRadius: 9999 }} />
              <span style={{ width: 32, height: 32, borderRadius: 9999, background: C.paper }} />
            </div>
            <span style={{ height: 40, display: "flex", alignItems: "center", padding: "0 20px", borderRadius: 9999, background: C.signal, color: "#000", ...display, fontSize: 15 }}>Sign in</span>
          </div>
        </header>

        {/* RoundView title row */}
        <div style={{ padding: "14px 4px 0", ...mono, fontSize: 12, color: C.dim }}>← ROUNDS</div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 32, padding: "10px 4px 22px" }}>
          <div>
            <div style={{ ...mono, fontSize: 12, color: C.dim }}>ROUND · BTC/USD · 05:00 PM to 05:15 PM</div>
            <h1 style={{ margin: "10px 0 0", ...display, fontSize: 52, lineHeight: 1.02, letterSpacing: "-0.035em" }}>BTC up or down by 05:15 PM?</h1>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: C.dim }}>{settled ? "Result" : "Predictions close in"}</div>
            <div data-target="countdown" style={{ ...display, fontSize: 84, lineHeight: 1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", marginTop: 4 }}>{settled ? "UP" : cd}</div>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 6 }}>{settled ? "Settled on chain from two signed Chainlink prices." : "The starting price is taken at 05:00:00 PM."}</div>
          </div>
        </div>
        <div style={{ padding: "12px 16px", borderRadius: 12, background: C.raise, fontSize: 15, lineHeight: 1.5 }}>
          <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: C.dim, marginRight: 8 }}>COMMENTARY</span>
          {settled ? "The round is settled." : `Nobody has picked a side yet. Predictions close in ${cd}.`}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 28, marginTop: 22 }}>
          {/* Details: chart + pots */}
          <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 4px 10px" }}>
                <span style={{ ...mono, fontSize: 12, fontWeight: 700, color: C.dim }}>BTC/USD</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {["1M", "15M", "1H"].map((x) => (
                    <span key={x} style={{ height: 28, padding: "0 12px", borderRadius: 9999, display: "flex", alignItems: "center", ...mono, fontSize: 12, fontWeight: 700, background: x === "1M" ? C.fg : "transparent", color: x === "1M" ? C.ink : C.dim }}>
                      {x}
                    </span>
                  ))}
                </div>
              </div>
              <div data-target="chart" style={{ position: "relative" }}>
                <Chart t={clock ?? t} width={928} height={250} anchor={anchor} />
                {anchor ? (
                  <span data-target="anchor-note" style={{ position: "absolute", left: START_CANDLE * (928 / 64) + 14, top: 18, height: 28, padding: "0 12px", borderRadius: 9999, background: C.raise2, display: "flex", alignItems: "center", gap: 8, ...mono, fontSize: 12, color: C.fg, whiteSpace: "nowrap" }}>
                    <span style={{ width: 14, borderTop: `1.5px dashed ${C.fg}` }} />
                    The starting price is taken at 05:00:00 PM.
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 12, color: C.dim, padding: "4px 4px 0" }}>The anchor and close prices are set by Chainlink, the second the round starts and ends.</div>
            </div>
            <div data-target="pots" style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ ...display, fontSize: 22 }}>↑ UP</span>
                  {settled ? (
                    <span data-target="won" style={{ ...mono, fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 9999, background: C.signal, color: "#000", opacity: won, scale: String(0.8 + 0.2 * won) }}>WON</span>
                  ) : null}
                </span>
                <span style={{ ...display, fontSize: 22, opacity: 1 - 0.55 * won }}>DOWN ↓</span>
              </div>
              <div style={{ display: "flex", height: 30, borderRadius: 9999, overflow: "hidden", margin: "14px 4px 0", background: C.raise2 }}>
                <div style={{ width: `${upShare * 100}%`, background: C.signal }} />
                <div style={{ flex: 1, background: C.red, opacity: 1 - 0.65 * won }} />
              </div>
              <div style={{ ...mono, fontSize: 11, color: C.dim, padding: "10px 4px 0", lineHeight: 1.5 }}>
                {settled ? `Final pots, set when predictions closed. ${settled.fee}` : "Odds change until predictions close. Winners split the pot in proportion to their stake, after 1% to Mako Market and 2% of the smaller side to the house."}
              </div>
            </div>
          </div>

          {/* EnterForm */}
          <div data-target="form" style={{ visibility: settled ? "hidden" : "visible", borderTop: `1px solid ${C.line}`, padding: "14px 4px 0", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: 0, ...display, fontSize: 22 }}>Make a prediction</h2>
              <span style={{ ...mono, fontSize: 11, color: C.dim }}>MIN 0.10 USDC</span>
            </div>
            <SideToggle t={t} pickAt={pickAt} width={372} target="up" />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "12px 16px", borderRadius: 12, background: C.raise }}>
              <span data-target="amount" style={{ ...display, fontSize: 40, letterSpacing: "-0.02em" }}>{tenth ? "0.10" : "5"}</span>
              <span style={{ ...mono, fontSize: 12, color: C.dim }}>USDC</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 6 }}>
              {CHIPS.map((c) => (
                <span key={c} data-target={`chip-${c}`} style={{ height: 34, borderRadius: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: c === (tenth ? "0.10" : "5") ? C.fg : C.raise, color: c === (tenth ? "0.10" : "5") ? C.ink : C.fg, ...mono, fontSize: 11, fontWeight: 700, scale: String(t >= chipAt && t < chipAt + 0.14 && c === "0.10" ? 0.96 : 1) }}>
                  {c}
                </span>
              ))}
            </div>
            <span data-target="signin" style={{ height: 56, borderRadius: 9999, background: C.signal, color: "#000", ...display, fontSize: 17, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 4 }}>
              Sign in to predict
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
