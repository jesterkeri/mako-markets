import type { Metadata } from 'next';

import { SignInRedirect } from './SignInRedirect';

export const metadata: Metadata = { title: 'Sign in · Mako Market Beta' };

/// /signin: opens the sign-in dialog over the Pools list (14a draws sign-in over a page, never on its own).
export default function SignInPage() {
  return <SignInRedirect />;
}
