import { formatUnits, parseUnits } from 'viem';

/**
 * USDC token wiring for Mako on Monad testnet.
 *
 * v4 placeBet pulls USDC via IERC20.transferFrom, so every bet path needs
 * `approve(MAKO_ADDRESS, amount)` against this token first.
 *
 * Per-chain pinning: Phase 1C only ships Monad testnet. Base Sepolia /
 * Monad mainnet / Base mainnet land in Phase 3 (MoonPay delivery).
 *
 * USDC is 6-decimal across every chain we'll touch — keep `USDC_DECIMALS`
 * as a constant and never read `decimals()` at runtime; an off-decimal
 * token at the same address would be a deployment-config bug, not a
 * recoverable runtime condition.
 */
export const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS_MONAD_TESTNET
  || '0x534b2f3A21130d7a60830c2Df862319e593943A3') as `0x${string}`;

export const USDC_DECIMALS = 6;

/**
 * Minimal IERC20 ABI. Only the four functions Phase 1C call sites use:
 * `approve` + `allowance` for the bet flow, `balanceOf` for the BetSheet
 * pill / portfolio surfaces, `decimals` for occasional sanity checks.
 *
 * `transfer` is deliberately omitted — no 1C call site sends USDC directly.
 * Phase 3 (MoonPay delivery) will widen this if needed.
 */
export const usdcAbi = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
] as const;

/** Pre-composed contract object for wagmi's useReadContract / useWriteContract. */
export const usdcContract = {
  address: USDC_ADDRESS,
  abi: usdcAbi,
} as const;

/**
 * Parse a human-readable USDC string ("5", "1.25") into 6-decimal base units.
 *
 * Use this everywhere a user-typed amount enters the wire layer. Raw
 * `parseUnits(_, 6)` outside `usdc.ts` is forbidden in `src/` — a typo
 * like `parseUnits(_, 18)` silently scales wrong and slips past grep.
 */
export function parseUsdc(human: string): bigint {
  return parseUnits(human, USDC_DECIMALS);
}

/**
 * Format a USDC base-unit bigint as a human display string.
 *
 * **Display only.** Default is 2dp because USDC's 4 trailing zeros are
 * never meaningful at the rendering layer ("34.5 USDC", not "34.500000").
 * Wire-layer / API / aggregation contexts MUST use `formatUsdcExact`
 * instead — rounding here corrupts sums and sort orders downstream.
 */
export function formatUsdc(base: bigint, dp: number = 2): string {
  const full = formatUnits(base, USDC_DECIMALS);
  if (dp < 0 || !Number.isFinite(dp)) return full;
  const num = Number(full);
  if (!Number.isFinite(num)) return full;
  return num.toFixed(dp);
}

/**
 * Full 6-decimal precision USDC string for wire/API/aggregation contexts.
 *
 * Used by `src/app/api/admin/analytics/route.ts` and any callsite that
 * passes the value into `parseFloat(...)` for sums, sort keys, or chart
 * aggregation. The 2dp default `formatUsdc` would silently round wire
 * values; this helper preserves every base unit so downstream math stays
 * exact.
 */
export function formatUsdcExact(base: bigint): string {
  return formatUnits(base, USDC_DECIMALS);
}
