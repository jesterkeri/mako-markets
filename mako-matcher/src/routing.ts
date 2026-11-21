// Market identity at the edge (plan 6.1): ids are canonical decimal, and the only way to reach a market is
// env.MARKET.idFromName(<canonical id>).
import { canonicalUint } from './order';

const U256 = (1n << 256n) - 1n;

/// The canonical decimal string for a market id (no sign, no leading zeros, no spaces, below 2^256), or null.
export function parseMarketId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const n = canonicalUint(raw, U256);
  return n === null ? null : n.toString();
}
