import { AbsoluteFill, Img, staticFile } from "remotion";

import { Logo } from "../film/parts";
import { C, FONT } from "../film/tokens";
import { SHOTS } from "./shots";

/** The storyboard sheet: paper, the 23 keyframes grouped by chapter, with id, time, on-screen text and motion note. */
export const SHEET = { width: 2400, pad: 80, thumbW: 530, gap: 34, thumbH: 298, textH: 226, chapterH: 70, titleH: 250 };
const chapters = [...new Set(SHOTS.map((s) => s.chapter))];
export const SHEET_HEIGHT = SHEET.titleH + chapters.length * (SHEET.chapterH + SHEET.thumbH + SHEET.textH + 30) + SHEET.pad;

const fmt = (n: number) => n.toFixed(1);

export function ShotList() {
  return (
    <AbsoluteFill style={{ background: C.paper, color: C.ink, fontFamily: FONT.sans, padding: SHEET.pad, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", height: SHEET.titleH - SHEET.pad }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Logo size={56} color={C.ink} />
            <span style={{ fontFamily: FONT.display, fontWeight: 800, fontSize: 64, letterSpacing: "-0.035em" }}>Mako Market Rounds · shot list</span>
          </div>
          <div style={{ fontFamily: FONT.mono, fontSize: 20, color: "rgba(0,0,0,0.6)", marginTop: 14, letterSpacing: "0.04em" }}>
            30 s · 1920x1080 · 60P · 120 BPM · 23 shots · B (in the product) main, A (type on black) and C (paper) accents
          </div>
        </div>
        <div style={{ fontFamily: FONT.mono, fontSize: 18, color: "rgba(0,0,0,0.55)", textAlign: "right", lineHeight: 1.5, whiteSpace: "nowrap" }}>
          STORYBOARD STILLS · FOR APPROVAL
          <br />
          ONE KEYFRAME PER SHOT · CAPTIONS + MUSIC, NO VOICEOVER
        </div>
      </div>
      {chapters.map((ch) => (
        <div key={ch} style={{ marginTop: 30 }}>
          <div style={{ height: SHEET.chapterH, display: "flex", alignItems: "center", gap: 16, boxShadow: "inset 0 -1.5px 0 rgba(0,0,0,0.85)" }}>
            <span style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 24, letterSpacing: "0.08em" }}>{ch}</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 18, color: "rgba(0,0,0,0.55)" }}>
              {(() => {
                const list = SHOTS.filter((s) => s.chapter === ch);
                return `${fmt(list[0].start)} to ${fmt(list[list.length - 1].end)} s`;
              })()}
            </span>
          </div>
          <div style={{ display: "flex", gap: SHEET.gap, marginTop: 20 }}>
            {SHOTS.filter((s) => s.chapter === ch).map((s) => (
              <div key={s.id} style={{ width: SHEET.thumbW }}>
                <div style={{ width: SHEET.thumbW, height: SHEET.thumbH, borderRadius: 10, overflow: "hidden", background: "#000", display: "flex", boxShadow: "0 1px 2px rgba(40,30,10,0.12), 0 10px 26px rgba(40,30,10,0.16)" }}>
                  {s.id === "8b" ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: C.paperSunk, width: "100%", height: "100%" }}>
                      {[1, 2, 3].map((k) => (
                        <Img key={k} src={staticFile(`storyboard/shot-8b-${k}.png`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ))}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.mono, fontSize: 17, fontWeight: 700, color: "rgba(0,0,0,0.6)" }}>3 CUTS · 0.33 s EACH</div>
                    </div>
                  ) : (
                    <Img src={staticFile(`storyboard/shot-${s.id}.png`)} style={{ width: SHEET.thumbW, height: SHEET.thumbH }} />
                  )}
                </div>
                <div style={{ height: SHEET.textH, paddingTop: 14, boxSizing: "border-box" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "baseline", fontFamily: FONT.mono, fontSize: 19 }}>
                    <span style={{ fontWeight: 700, background: C.signal, padding: "2px 8px", borderRadius: 6 }}>{s.id}</span>
                    <span style={{ color: "rgba(0,0,0,0.6)" }}>
                      {fmt(s.start)} to {fmt(s.end)} s
                    </span>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 19, lineHeight: 1.35, marginTop: 10 }}>{s.text.startsWith("(") ? <span style={{ color: "rgba(0,0,0,0.5)", fontWeight: 500 }}>{s.text}</span> : `“${s.text}”`}</div>
                  <div style={{ fontSize: 16.5, lineHeight: 1.4, marginTop: 6, color: "rgba(0,0,0,0.66)" }}>{s.note}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
}
