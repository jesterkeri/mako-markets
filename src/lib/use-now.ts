'use client';

import { useEffect, useState } from 'react';

/**
 * Ticks `Date.now()` on an interval so components stay pure.
 *
 * React's purity lint (react-hooks/purity) disallows calling `Date.now()`
 * directly in a render body, because the same inputs wouldn't always
 * produce the same output. This hook stores "now" in state and nudges it
 * forward periodically, so any derived "X ago" label stays fresh without
 * violating the rule.
 *
 * Default 30s interval matches the admin analytics refetch cadence —
 * labels update roughly in lockstep with the data behind them.
 */
export function useNowSec(intervalMs: number = 30_000): number {
  const [now, setNow] = useState<number>(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
