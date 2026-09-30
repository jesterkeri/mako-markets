'use client';

import { useLoginWithEmail, usePrivy } from '@privy-io/react-auth';
import { useEffect } from 'react';

// Privy's headless email sign-in, for the sign-in dialog (14a). Privy's hooks need its provider, which exists only
// when NEXT_PUBLIC_PRIVY_APP_ID is set, so they live in this child, mounted only then; without it the dialog says
// email sign-in is not configured.
//
// Two properties carried over from the reviewed /signup flow:
//  - a Privy session left over from an earlier visit is ended before a code is sent, so the email is proven now and
//    the account signed in is the one typed;
//  - a token is read only after this dialog's own code check succeeds, so a restored Privy session never signs
//    anyone in by itself.

export type EmailAuth = {
  sendCode: (email: string) => Promise<void>;
  /// Checks the code; resolves to Privy's access token (null if Privy returned none), rejects on a wrong code.
  verify: (code: string) => Promise<string | null>;
};

export function PrivyEmailBridge({ register }: { register: (auth: EmailAuth | null) => void }) {
  const { authenticated, logout, getAccessToken } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  useEffect(() => {
    register({
      sendCode: async (email) => {
        if (authenticated) {
          try {
            await logout();
          } catch (e) {
            console.warn('Privy logout before sign-in failed', e instanceof Error ? e.name : 'unknown');
          }
        }
        await sendCode({ email });
      },
      verify: async (code) => {
        await loginWithCode({ code });
        return getAccessToken();
      },
    });
    return () => register(null);
  }, [authenticated, logout, getAccessToken, sendCode, loginWithCode, register]);
  return null;
}
