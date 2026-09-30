'use client';

import { useSyncExternalStore } from 'react';

// One shared 1-second clock for every countdown on the page. The server render has no clock (null), so a
// countdown never hydrates with a time the client would immediately contradict.
let nowSec = Math.floor(Date.now() / 1000);
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (!timer) {
    timer = setInterval(() => {
      nowSec = Math.floor(Date.now() / 1000);
      for (const f of subscribers) f();
    }, 1000);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  // Between ticks the value is stable; with no clock running yet, read the time fresh.
  if (!timer) nowSec = Math.floor(Date.now() / 1000);
  return nowSec;
}

/// Unix seconds, updated every second; null during the server render. (For slow "X ago" labels, use
/// useNowSec in use-now.ts.)
export function useLiveNowSec(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
