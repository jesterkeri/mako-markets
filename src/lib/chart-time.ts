// ----------------------------------------------------------------------------
// src/lib/chart-time.ts
//
// lightweight-charts draws every time value (axis ticks, crosshair label) as UTC and has no time zone option. To show
// the viewer's own wall-clock time, like the rest of the site, every time given to the chart is shifted by the
// viewer's UTC offset, and any chart time read back as a real instant is shifted back.
//
// One offset for the whole page load, read on the client the first time a chart needs it (inside an effect, never
// during a server render). A per-candle offset would make the autumn DST hour produce repeated or out-of-order times,
// which lightweight-charts refuses, and the chart's dedupe would drop candles.
//
// shortcut: in zones with daylight saving, intraday candles from before the last DST switch are labelled one hour
// off (they get today's offset, not the offset they had). Fix if anyone needs exact labels across a DST switch:
// lightweight-charts' `localization.timeFormatter` + `timeScale.tickMarkFormatter` with real per-instant formatting.
// ----------------------------------------------------------------------------

import type { Time } from 'lightweight-charts';

let offsetSec: number | null = null;

/** The viewer's current UTC offset in seconds (UTC+1 = 3600, UTC-5 = -18000), fixed for the page load. */
export function chartTimeOffsetSec(): number {
  if (offsetSec === null) offsetSec = 0 - new Date().getTimezoneOffset() * 60; // `0 -`: UTC gives 0, not -0
  return offsetSec;
}

/** A real instant (ms since epoch) as the chart time that lightweight-charts labels with the viewer's local time. */
export function toChartTime(ms: number): Time {
  return (ms / 1000 + chartTimeOffsetSec()) as Time;
}

/** A chart time back to the real instant (ms since epoch). Use it before formatting or comparing a chart time. */
export function fromChartTime(t: Time): number {
  return ((t as number) - chartTimeOffsetSec()) * 1000;
}
