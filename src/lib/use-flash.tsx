'use client';

import { useEffect, useState } from 'react';

// Live value change (motion pass 7, Joshua 2026-10-16; the Polymarket / Kalshi / Robinhood pattern). Pool data re-polls
// every few seconds and a changed number used to swap in silently. Now, when a shown value CHANGES after the first
// render, it flashes for 600 ms: colour (or opacity) only, never movement. The first value, and a value arriving after
// loading (null -> a number), never flash.
//
// "Changes" means the TEXT on screen changes. The raw number behind it only gives the direction: odds 1.94 -> 1.940097
// (a 0.10 USDC bet into a 100 / 100 pool) still read "1.94x", and a 6-decimal amount shown to 2 decimals can move
// without its text moving; neither may flash (adversary on c0bcd32). FlashValue renders the text it compares, so the
// two cannot drift apart at a call site.
//
// - 'direction': a number with a direction (odds, totals) turns --yes-text when it went up, --no-text when it went down.
//   Use it only where those tokens are readable: on the page canvas or a --raise panel (they are set for 4.5:1 there).
// - 'neutral': counts, and any value on a YES/NO fill, a yellow or an inverse card, where a green or red text would
//   vanish or clash: the text dips to 0.6 opacity and back. Reduced motion: a brief underline instead of the dip.
//
// The class is held for FLASH_HOLD_MS and then removed; the 450 ms return is the .mk-flash transition (mako-shell.css),
// so the total is 600 ms. Transitions, not keyframes, so a value that changes again mid-flash retargets smoothly.
// Nothing here is aria-live: the numbers are not announced.

export type FlashKind = 'direction' | 'neutral';
type Comparable = number | bigint | null | undefined;
type Flash = { dir: 'up' | 'down' | 'neutral'; n: number };

/// How long the flash class stays on (the colour or dip comes in over this time, 150 ms).
export const FLASH_HOLD_MS = 150;

const isNum = (v: Comparable): v is number | bigint => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint';

/// The class for a shown value that flashes when it changes: always `mk-flash`, plus `mk-flash-up` / `-down` /
/// `-neutral` for FLASH_HOLD_MS after a change. `shown` is the text on screen and decides THAT it changed; `value` is
/// the raw number behind it and decides only which WAY (and, while it is not a number, that nothing flashes).
export function useFlashOnChange(shown: string, value: Comparable, kind: FlashKind): string {
  const [prev, setPrev] = useState<{ shown: string; value: Comparable }>({ shown, value });
  const [flash, setFlash] = useState<Flash | null>(null);
  // Compared during render (React's "storing information from previous renders" pattern), so the class is on the very
  // render that shows the new value. The raw value is tracked on every change, so the direction of a later text change
  // is measured from the latest number. Object.is, so a NaN cannot re-render for ever.
  if (prev.shown !== shown || !Object.is(prev.value, value)) {
    setPrev({ shown, value });
    if (prev.shown !== shown && isNum(prev.value) && isNum(value)) {
      const dir = kind === 'neutral' ? 'neutral' : value > prev.value ? 'up' : value < prev.value ? 'down' : 'neutral';
      setFlash((f) => ({ dir, n: (f?.n ?? 0) + 1 }));
    }
  }
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [flash]);
  return flash ? `mk-flash mk-flash-${flash.dir}` : 'mk-flash';
}

/// A span showing `text`, which flashes when `text` changes; `value` (the raw number behind it) gives the direction.
/// It renders `text` itself, so what is compared is exactly what is shown. It sets no colour of its own at rest, so the
/// text keeps whatever its parent gives it.
export function FlashValue({ value, text, kind }: { value: Comparable; text: string; kind: FlashKind }) {
  const className = useFlashOnChange(text, value, kind);
  return <span className={className}>{text}</span>;
}
