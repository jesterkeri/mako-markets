'use client';

import { closeSignOut, useSignOutWho } from '@/lib/sign-out-store';

import { SignOutConfirm } from './SignOutConfirm';

/// The one sign-out dialog, mounted by the shell above every signed-in-only screen (see sign-out-store).
export function SignOutHost() {
  const who = useSignOutWho();
  return who ? <SignOutConfirm who={who} onClose={closeSignOut} /> : null;
}
