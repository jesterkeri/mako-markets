import type { FC } from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";

import { useTime } from "../kit/time";
import { Chrome, Grain, SlashWipe } from "./kit";
import { perkTone, SHOTS } from "./shots";

export const REEL_DURATION = 30;

/** The 30 s showreel: one <Sequence> per shot (cut on the beat), the persistent chrome and grain on top. */
export function Reel() {
  const t = useTime();
  const { fps } = useVideoConfig();
  const current = SHOTS.find((s) => t >= s.start && t < s.end) ?? SHOTS[SHOTS.length - 1];
  const tone = current.id === "8b" ? perkTone(t - current.start) : current.tone;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {SHOTS.map((s) => (
        <Sequence key={s.id} name={`shot ${s.id}`} from={Math.round(s.start * fps)} durationInFrames={Math.round((s.end - s.start) * fps)}>
          <ShotFrame C={s.C} />
        </Sequence>
      ))}
      {/* Slash cut out of 04 into 05 (on the bar line at 14.5 s). */}
      <SlashWipe t={t} cut={14.5} />
      {/* Paper slash wipe out of 06 into 07 (23.0 s). */}
      <SlashWipe t={t} cut={23} color="#EBE5D9" />
      <Grain t={t} tone={tone} />
      <Chrome t={t} chapter={current.chapter} tone={tone} />
    </AbsoluteFill>
  );
}

function ShotFrame({ C }: { C: FC<{ t: number }> }) {
  const t = useTime();
  return <AbsoluteFill style={{ overflow: "hidden" }}><C t={t} /></AbsoluteFill>;
}
