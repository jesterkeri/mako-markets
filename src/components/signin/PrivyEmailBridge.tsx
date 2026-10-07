'use client';

import { useCreateWallet, useLoginWithEmail, useMfa, useMfaEnrollment, usePrivy, useSignMessage, useWallets } from '@privy-io/react-auth';
import { useEffect, useRef } from 'react';

import { type GateBridge } from '@/lib/privy-gated-signin';

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
  /// The inbox-takeover gate's Privy operations (src/lib/privy-gated-signin.ts).
  gate: GateBridge;
};


export function PrivyEmailBridge({ register }: { register: (auth: EmailAuth | null) => void }) {
  const { authenticated, logout, getAccessToken } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  // Enrollment through Privy's headless calls only: Mako never shows Privy's own MFA screen, which offers "Remove"
  // ([G1]); the source test fails the build on showMfaEnrollmentModal or any unenroll call.
  const { initEnrollmentWithTotp, submitEnrollmentWithTotp } = useMfaEnrollment();
  const { clear: clearMfa, promptMfa } = useMfa();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { wallets } = useWallets();
  const walletsRef = useRef(wallets);
  useEffect(() => {
    walletsRef.current = wallets;
  }, [wallets]);

  useEffect(() => {
    const gate: GateBridge = {
      token: () => getAccessToken(),
      enrollStart: () => initEnrollmentWithTotp(),
      enrollFinish: async (code) => {
        await submitEnrollmentWithTotp({ mfaCode: code });
      },
      freshFactor: async () => {
        // [H2] A verification left over from earlier must not count: clear it, then ask the code now.
        await clearMfa();
        await promptMfa();
      },
      createWallet: async () => {
        const w = await createWallet();
        return w.address;
      },
      embeddedAddress: () => {
        const embedded = walletsRef.current.filter((w) => w.walletClientType === 'privy');
        return embedded.length === 1 ? embedded[0].address : null;
      },
      signProof: async (message, address) => {
        // A fresh authenticator code for this one signature ([m1]): Privy asks it before the wallet signs.
        await clearMfa();
        const { signature } = await signMessage({ message }, { address, uiOptions: { title: 'Confirm your sign-in', description: 'Mako Market asks your wallet to sign this message to prove the authenticator check passed. It moves no funds.' } });
        return signature;
      },
    };
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
      gate,
    });
    return () => register(null);
  }, [authenticated, logout, getAccessToken, sendCode, loginWithCode, register, initEnrollmentWithTotp, submitEnrollmentWithTotp, clearMfa, promptMfa, createWallet, signMessage]);
  return null;
}
