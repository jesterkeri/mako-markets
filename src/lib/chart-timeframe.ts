'use client';

import { useSyncExternalStore } from 'react';

import type { Timeframe } from '@/types/chart';

// The timeframe last picked on any chart, kept in this browser so every chart opens on it (CryptoTester OBS-001,
// Joshua 2026-11-03: one choice for every chart). A chart that does not offer it uses its own default.

const KEY = 'mako:chart:timeframe';
const ALL: readonly Timeframe[] = ['1m', '15m', '1h', '2h', '4h', '1d'];

let memory: Timeframe | null = null;
/// A pick storage refused (full, or a private mode that reads but will not write) wins in this tab over what storage
/// still holds (adversary on a4d7c11), until another tab saves one.
let unsaved = false;
const listeners = new Set<() => void>();

function read(): Timeframe | null {
  if (unsaved) return memory;
  try {
    const v = window.localStorage.getItem(KEY);
    // Storage is editable by anyone with the browser: only a known timeframe is used.
    memory = ALL.includes(v as Timeframe) ? (v as Timeframe) : null;
  } catch {
    // No storage (private mode, blocked): the choice made in this tab.
  }
  return memory;
}

export function saveTimeframe(tf: Timeframe): void {
  memory = tf;
  try {
    window.localStorage.setItem(KEY, tf);
    unsaved = false;
  } catch {
    unsaved = true;
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    // Another tab saved one: take it from the event, since this tab's own read may be what fails.
    if (e.key === KEY) memory = ALL.includes(e.newValue as Timeframe) ? (e.newValue as Timeframe) : null;
    unsaved = false;
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/// The saved timeframe, or null when none is saved. Null on the server, so the first render matches it.
export function useSavedTimeframe(): Timeframe | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
