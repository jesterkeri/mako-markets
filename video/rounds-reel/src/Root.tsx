import { Composition, continueRender, delayRender } from "remotion";
import type { FC } from "react";

import { DURATION } from "./film/cues";
import { fontsReady } from "./film/fonts";
import { Paper } from "./film/Paper";
import { Product } from "./film/Product";
import { Signal } from "./film/Signal";
import { PageFlat } from "./story/PageFlat";
import { Reel, REEL_DURATION } from "./reel/Reel";
import { SHEET, SHEET_HEIGHT, ShotList } from "./reel/ShotList";

const handle = delayRender("fonts");
fontsReady.then(() => continueRender(handle));

type Props = { fps: number };
const films: [string, FC][] = [["Signal", Signal], ["Product", Product], ["Paper", Paper], ["PageFlat", PageFlat]];

export const Root = () => (
  <>
    <Composition id="ShotList" component={ShotList} width={SHEET.width} height={SHEET_HEIGHT} fps={30} durationInFrames={1} />
    <Composition id="Reel" component={Reel as FC<Props>} width={1920} height={1080} fps={60} durationInFrames={REEL_DURATION * 60} defaultProps={{ fps: 60 }} calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.round(REEL_DURATION * props.fps) })} />
    {films.map(([id, C]) => (
      <Composition
        key={id}
        id={id}
        component={C as FC<Props>}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={Math.round(DURATION * 30)}
        defaultProps={{ fps: 30 }}
        calculateMetadata={({ props }) => ({ fps: props.fps, durationInFrames: Math.round(DURATION * props.fps) })}
      />
    ))}
  </>
);
