'use client';

import { useCreateWallet, useLoginWithEmail, useMfa, useMfaEnrollment, usePrivy, useSignMessage, useWallets } from '@privy-io/react-auth';
import { useEffect, useRef } from 'react';

import { recordEmailVerification, startEmailCeremony, type StepAResult, type GateBridge } from '@/lib/privy-gated-signin';

// Privy's headless email sign-in, for the sign-in dialog (14a). Privy's hooks need its provider, which exists only
// when NEXT_PUBLIC_PRIVY_APP_ID is set, so they live in this child, mounted only then; without it the dialog says
// email sign-in is not configured.
//
// Two properties carried over from the reviewed /signup flow:
//  - a Privy session left over from an earlier visit is ended before a code is sent, so the email is proven now and
//    the account signed in is the one typed;
//  - a token is read only after this dialog's own code check succeeds, so a restored Privy session never signs
//    anyone in by itself (a remembered browser continues one only after the server says so: shortcut-check).
//
// Remembered browsers (SIGNIN_REMEMBERED_BROWSER_PLAN r29 2.2): before a code is sent, /api/user/auth/email-start
// gives this browser an email ceremony; right after loginWithCode resolves, the token from the FIRST getAccessToken()
// goes to step A (/api/user/auth/email-verified) before any other Privy call (enrollment, wallet creation, promptMfa,
// signMessage), and a retry of step A reuses that same token.

export type EmailAuth = {
  sendCode: (email: string) => Promise<void>;
  /// Checks the code; resolves to Privy's access token (null if Privy returned none) and step A's answer, rejects on a
  /// wrong code.
  verify: (code: string) => Promise<{ token: string | null; stepA: StepAResult }>;
  /// The Privy session this browser already holds, if any: the dialog offers "Continue as" for it.
  current: () => { email: string } | null;
  /// Ends this browser's Privy session ("Use a different email", or a remembered session the server will not continue).
  logout: () => Promise<void>;
  /// The inbox-takeover gate's Privy operations (src/lib/privy-gated-signin.ts).
  gate: GateBridge;
};


export function PrivyEmailBridge({ register }: { register: (auth: EmailAuth | null) => void }) {
  const { authenticated, logout, getAccessToken, user } = usePrivy();
  const currentEmail = authenticated ? (user?.email?.address ?? null) : null;
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
        // No confirmation box showing the raw message (Joshua, 2026-10-07: it looked like a developer tool). Privy still
        // asks the authenticator code before the wallet signs: the factor is enforced by Privy, not by this box, and a
        // signature it refuses fails the sign-in closed.
        const { signature } = await signMessage({ message }, { address, uiOptions: { showWalletUIs: false } });
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
        // The ceremony first; a failure here does not stop the code (the server's step B decides).
        await startEmailCeremony();
        await sendCode({ email });
      },
      verify: async (code) => {
        await loginWithCode({ code });
        // The first token after the login, captured before any other Privy call and reused by every step-A retry.
        const token = await getAccessToken();
        return { token, stepA: token ? await recordEmailVerification(token) : { ok: false, reason: 'not_confirmed' } };
      },
      current: () => (currentEmail ? { email: currentEmail } : null),
      logout: async () => {
        try {
          await logout();
        } catch (e) {
          console.warn('Privy logout failed', e instanceof Error ? e.name : 'unknown');
        }
      },
      gate,
    });
    return () => register(null);
  }, [authenticated, currentEmail, logout, getAccessToken, sendCode, loginWithCode, register, initEnrollmentWithTotp, submitEnrollmentWithTotp, clearMfa, promptMfa, createWallet, signMessage]);
  return null;
}
