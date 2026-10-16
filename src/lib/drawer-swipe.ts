// When a drag on the mobile bet drawer (the pool page's bottom panel) closes it. A drag closes it when it went far
// enough, or when it was fast enough in the closing direction, so a quick flick works as well as a long pull
// (motion pass 3, Joshua 2026-10-16). Pure, so the decision is tested without touch events.

/// A drag down of more than this many pixels closes the open panel, however slow.
export const SWIPE_CLOSE_PX = 60;
/// A drag down faster than this (px per ms, over the whole gesture) closes it even when it is short.
export const SWIPE_CLOSE_VELOCITY = 0.11;
/// A flick must still travel this far: a tap whose finger slips a few pixels can be "fast" over a few ms, and must not
/// close the panel under the button it was tapping.
export const SWIPE_FLICK_MIN_PX = 10;

/// `dy`: how far the finger moved down (negative is up). `elapsedMs`: from touch start to touch end.
export function shouldCloseDrawer(dy: number, elapsedMs: number): boolean {
  if (!(dy > 0)) return false;
  if (dy > SWIPE_CLOSE_PX) return true;
  if (dy < SWIPE_FLICK_MIN_PX) return false;
  // A zero or negative duration (clock quirks) is treated as the shortest measurable one, not as infinite speed.
  const velocity = dy / Math.max(elapsedMs, 1);
  return velocity > SWIPE_CLOSE_VELOCITY;
}
