// ----------------------------------------------------------------------------
// src/lib/magic-browser.ts
//
// Browser Magic SDK loader. The SDK touches `window` at construction time, so
// it must never run on the server. We guard with two protections:
//
//   1. Dynamic `await import('magic-sdk')` inside getMagic() — keeps the SDK
//      out of any server-rendered bundle even if a server module accidentally
//      imports this file.
//   2. `typeof window !== 'undefined'` check — refuses to construct the
//      Magic instance during SSR/prerender.
//
// The function returns a singleton per browser tab. Callers should `await
// getMagic()` at interaction time (button click), not at module load — the
// dynamic import would otherwise run during the page's initial hydration and
// pull magic-sdk into the first paint chunk for no benefit.
//
// Magic flavor: Auth, default OTP UI (`showUI: true`). Do not change without
// revisiting Phase 1A scope — see magic-server.ts header.
// ----------------------------------------------------------------------------

import type { Magic as MagicInstance } from 'magic-sdk';

let cached: MagicInstance | undefined;

export async function getMagic(): Promise<MagicInstance> {
  if (typeof window === 'undefined') {
    throw new Error('getMagic() must only run in the browser.');
  }
  if (cached) return cached;

  const publishableKey = process.env.NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      'NEXT_PUBLIC_MAGIC_PUBLISHABLE_KEY is not set. Add it to .env.local and Vercel env.',
    );
  }

  const { Magic } = await import('magic-sdk');
  cached = new Magic(publishableKey);
  return cached;
}
