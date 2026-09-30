'use client';

import { useSyncExternalStore } from 'react';

// Whether the sign-in dialog (14a) is open. One dialog for the whole app, mounted by the shell, so signing in never
// leaves the page the person was on.

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const openSignIn = () => set(true);
export const closeSignIn = () => set(false);

export function useSignInOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
