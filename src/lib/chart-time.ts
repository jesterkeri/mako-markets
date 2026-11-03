// ----------------------------------------------------------------------------
// src/lib/chart-time.ts
//
// lightweight-charts draws every time value (axis ticks, crosshair label) as UTC and has no time zone option. To show
// the viewer's own wall-clock time, like the rest of the site, every time given to the chart is shifted by the
// viewer's UTC offset. Nothing reads a chart time back as a real instant today (drawings stay in chart time).
//
// One offset for the whole page load, read on the client the first time a chart needs it (inside an effect, never
// during a server render). A per-candle offset would make the autumn DST hour produce repeated or out-of-order times,
// which lightweight-charts refuses, and the chart's dedupe would drop candles.
//
// shortcut: in zones with daylight saving, two cases are labelled one hour off: intraday candles from before the last
// DST switch (they get today's offset, not the offset they had), and every new candle in a tab left open across a
// switch, until reload (the offset is kept for the tab's life, so drawings never move). Accepted by the owner
// 2026-11-03 (Nigeria has no DST). Fix if anyone needs exact labels across a DST switch:
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
