'use client';

import { useSyncExternalStore } from 'react';

// Whether the feedback sheet is open. One sheet for the whole app, mounted by the shell; the desktop corner button,
// the wallet menu and Me's Feedback row all open it over the page the person is on.

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const openFeedback = () => set(true);
export const closeFeedback = () => set(false);

export function useFeedbackOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
