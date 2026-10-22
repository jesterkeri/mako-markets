// When a drag on the mobile bet drawer (the pool page's bottom panel) closes it. A drag closes it when it went far
// enough, or when it was moving fast enough in the closing direction AS THE FINGER LIFTED, so a quick flick works as
// well as a long pull (motion pass 3, Joshua 2026-10-16). Pure, so the decision is tested without touch events.
//
// The speed is the release velocity, measured over the last SWIPE_VELOCITY_WINDOW_MS of the touch, not averaged over
// the whole of it: a finger that rests 400 ms and then flicks 40 px in 50 ms is a flick (adversary on c0bcd32), and a
// pull that stops before the finger lifts is not one.

/// A drag down of more than this many pixels closes the open panel, however slow.
export const SWIPE_CLOSE_PX = 60;
/// A drag moving down faster than this (px per ms, over the last SWIPE_VELOCITY_WINDOW_MS) closes it even when short.
export const SWIPE_CLOSE_VELOCITY = 0.11;
/// A flick must still travel this far: a tap whose finger slips a few pixels can be "fast" over a few ms, and must not
/// close the panel under the button it was tapping.
export const SWIPE_FLICK_MIN_PX = 10;
/// How far back from the release the speed is measured.
export const SWIPE_VELOCITY_WINDOW_MS = 100;

/// One touch position: `y` is clientY (px, down is positive), `t` the event's timeStamp (ms).
export type TouchSample = { y: number; t: number };

/// Appends a sample, dropping the ones no release can need any more. The first sample always stays (it gives the
/// total travel); an older sample goes once a later one is itself at least the window old, because a release can only
/// be later than now, so that later sample is nearer the start of its window.
export function addTouchSample(samples: readonly TouchSample[], s: TouchSample): TouchSample[] {
  const all = [...samples, s];
  return all.filter((_, i) => i === 0 || i === all.length - 1 || !(all[i + 1].t <= s.t - SWIPE_VELOCITY_WINDOW_MS));
}

/// Speed in px/ms over the last SWIPE_VELOCITY_WINDOW_MS (or the whole touch, if it was shorter). Touch events fire
/// only when the finger moves, so between two samples the finger stood where the earlier one put it: the position at
/// the start of the window is that of the last sample at or before it.
function releaseVelocity(samples: readonly TouchSample[]): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const from = Math.max(first.t, last.t - SWIPE_VELOCITY_WINDOW_MS);
  let fromY = first.y;
  // Never the release itself (a clock quirk can stamp it earlier than the window start).
  for (const s of samples.slice(0, -1)) {
    if (s.t <= from) fromY = s.y;
    else break;
  }
  // A zero or negative span (clock quirks) is treated as the shortest measurable one, not as infinite speed.
  return (last.y - fromY) / Math.max(last.t - from, 1);
}

/// `samples`: the touch from its start to its end, in order (start first, the touchend position last).
export function shouldCloseDrawer(samples: readonly TouchSample[]): boolean {
  if (samples.length < 2) return false;
  const dy = samples[samples.length - 1].y - samples[0].y;
  if (!(dy > 0)) return false;
  if (dy > SWIPE_CLOSE_PX) return true;
  if (dy < SWIPE_FLICK_MIN_PX) return false;
  return releaseVelocity(samples) > SWIPE_CLOSE_VELOCITY;
}
