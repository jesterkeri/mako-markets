/**
 * Plain constant re-export so both client and server code can read the
 * admin wallet address. `src/lib/admin.ts` is marked `'use client'` (because
 * it exposes the `useIsAdmin()` wagmi hook), which means importing from it
 * on the server returns a client-reference stub — `ADMIN_ADDRESS.toLowerCase`
 * becomes undefined and the verify route crashes with a 500. Keeping the
 * raw constant in this module avoids the 'use client' boundary.
 */
export const ADMIN_ADDRESS = '0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1' as const;
