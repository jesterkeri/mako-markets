'use client';

import { useSyncExternalStore } from 'react';

import type { AuthedUser } from '@/lib/use-user';

// The sign-out dialog (21a): one for the whole app, mounted by the shell, so it outlives the signed-in screens that
// open it (the header's wallet menu, Settings). Mako's own session ends first and the app then shows the account as
// signed out at once; if the email sign-in or the wallet does not finish ending, the dialog stays up to say so and
// offer Try again or Continue, whatever the account query says by then (Codex S1 r2).

/// What the dialog says about the account, copied when it opens. Display only: never a sign of being signed in.
export type SignOutWho = { authType: 'magic'; email: string } | { authType: 'wallet' };

let who: SignOutWho | null = null;
const listeners = new Set<() => void>();

function set(next: SignOutWho | null) {
  if (who === next) return;
  who = next;
  for (const l of listeners) l();
}

export function openSignOut(user: AuthedUser) {
  set(user.authType === 'magic' ? { authType: 'magic', email: user.email } : { authType: 'wallet' });
}

export const closeSignOut = () => set(null);

export function useSignOutWho(): SignOutWho | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => who,
    () => null,
  );
}
