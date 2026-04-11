'use client';

/**
 * ============================================================
 * ADMIN UI GATE — COSMETIC ONLY, NOT AUTHORIZATION
 * ============================================================
 *
 * The `useIsAdmin()` hook below is a *UX convenience* that hides the
 * `/admin/resolve` page from non-admin users. It is NOT a security
 * boundary and MUST NOT be relied on for authorization.
 *
 * - Anyone who opens browser devtools can override the hook's return
 *   value and see the admin page.
 * - Anyone with a wallet can call `resolveMarket(...)` directly on-chain
 *   via `cast send` or their own script, regardless of what this UI does.
 *
 * The REAL authorization is enforced on-chain by the `onlyResolver`
 * modifier in `MakoMarkets.sol`, which reverts any write from a
 * non-resolver address with the `NotResolver()` custom error.
 *
 * This file exists to keep the admin UI tidy for demo purposes. Do not
 * add any privileged client-side logic here.
 * ============================================================
 */

import { useAccount } from 'wagmi';

/**
 * The deployer / resolver wallet for the live MakoMarkets contract
 * at 0x87129a4FF7e795286a9939Ce7A73A25A29368389 on Monad testnet.
 *
 * This address is hardcoded rather than read from env because it needs
 * to match the on-chain `resolver` state variable of the deployed
 * contract — changing it here without also calling `setResolver()`
 * on-chain would break the resolve flow.
 */
export const ADMIN_ADDRESS = '0x774f7559E8fa4EAca55490df4F2F138D53323B9f' as const;

/**
 * Returns true if the connected wallet matches the admin address.
 * Returns false if no wallet is connected or if the address differs.
 *
 * Remember: this is a cosmetic gate. See the file header.
 */
export function useIsAdmin(): boolean {
  const { address } = useAccount();
  if (!address) return false;
  return address.toLowerCase() === ADMIN_ADDRESS.toLowerCase();
}
