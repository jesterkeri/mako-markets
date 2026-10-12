import { at, type Grid } from "../kit/time";

/** Silent test: plan on 120 BPM anyway (story.md). A beat is 0.5 s, a bar 2 s. */
export const GRID: Grid = { bpm: 120, firstBeat: 0, pickupBeats: 0, beatsPerBar: 4 };
export const b = (bar: number, beat = 1, fraction = 0) => at(GRID, bar, beat, fraction);

export const DURATION = 4; // seconds: two bars

/** The hook, word by word on eighths. */
export const CUE = {
  think: b(1, 1, 0.5),
  btc: b(1, 2),
  goes: b(1, 2, 0.5),
  up: b(1, 3),
  inTheNext: b(1, 3, 0.5),
  minutes: b(1, 4),
  shrink: b(2, 1), // the question steps back to a kicker
  call: b(2, 1, 0.5),
  it: b(2, 2),
  cursorIn: b(2, 2, 0.5),
  pick: b(2, 3), // the click on UP
  after: b(2, 4), // the beat after the pick (button lights, line ticks)
} as const;

/** The style-frame moment: "Call it." landed, UP picked. */
export const STILL_T = 3.6;
