// The "no fill leaves 1 to 9 shares" book rule (plan 2 table), written independently of src/match.ts for the fuzz
// oracles: a remainder is valid when it is 0 or at least 10 shares.
export const MIN_LEFT = 10_000_000n;
export const LOT_UNITS = 10_000n;

export const validLeft = (left: bigint): boolean => left === 0n || left >= MIN_LEFT;

/// True when some lot-multiple fill f > 0 leaves both remainders valid: fill both whole, fill one whole and leave the
/// other at least 10 shares, or fill part of both leaving each at least 10 shares.
export function pairTradable(a: bigint, b: bigint): boolean {
  if (a <= 0n || b <= 0n) return false;
  if (a === b) return true;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return hi - lo >= MIN_LEFT || lo >= MIN_LEFT + LOT_UNITS;
}
