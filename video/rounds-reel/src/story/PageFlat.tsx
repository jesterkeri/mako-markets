import { AbsoluteFill } from "remotion";

import { TargetLog } from "../kit/debug";
import { useTime } from "../kit/time";
import { AppPage } from "../film/AppPage";

/** Debug: the page flat at 1:1 with every [data-target] box printed, to measure camera focus points. */
export function PageFlat() {
  const t = useTime();
  return (
    <AbsoluteFill style={{ background: "#222" }}>
      <AppPage t={t} pickAt={0.5} upShare={0.5} anchor />
      <div style={{ position: "absolute", left: 1460, top: 0, width: 460 }}>
        <TargetLog />
      </div>
    </AbsoluteFill>
  );
}
