// ----------------------------------------------------------------------------
// avatar-glyph.ts
//
// Pure helpers extracted from AvatarCircle so the deterministic-color
// + initial-derivation logic can be unit-tested under the existing
// Node vitest environment. Adding @testing-library/react + jsdom for
// component-level tests is deferred (see Group 4 plan addendum).
//
// The static palette + the index function MUST stay in sync with
// AvatarCircle.tsx; the test suite asserts both on this module.
// ----------------------------------------------------------------------------

export const STATIC_PALETTE = [
  { bg: 'bg-mako-yellow', fg: 'text-ink' },
  { bg: 'bg-mako-red', fg: 'text-paper' },
  { bg: 'bg-mako-blue', fg: 'text-paper' },
  { bg: 'bg-mako-green', fg: 'text-ink' },
  { bg: 'bg-mako-pink', fg: 'text-ink' },
  { bg: 'bg-mako-purple', fg: 'text-paper' },
] as const;

/**
 * Returns the single uppercase initial used in the AvatarCircle
 * fallback. Prefer the user's chosen displayName; fall back to
 * `fallback` (Magic users pass their email, wallet users pass their
 * formatted address). 'M' is the final fallback for empty input.
 *
 * Param renamed from `email` → `fallback` so the helper is shape-
 * agnostic (codex round-2 plan step 17).
 */
export function deriveInitial(
  displayName: string | null,
  fallback: string,
): string {
  if (displayName) {
    const trimmed = displayName.trim();
    if (trimmed.length > 0) return trimmed[0]!.toUpperCase();
  }
  if (fallback && fallback.length > 0) return fallback[0]!.toUpperCase();
  return 'M';
}

/**
 * Returns a deterministic STATIC_PALETTE index from the first 5 hex
 * chars of the seed (after stripping the 0x prefix if present). The
 * seed is the user's identity address — Magic passes magicEoa,
 * wallet passes walletAddress. Both are normalized to lowercase
 * upstream, so the same identity always lands on the same palette.
 *
 * Param renamed from `magicEoa` → `seed` so the helper is shape-
 * agnostic (codex round-2 plan step 17).
 */
export function derivePaletteIndex(seed: string): number {
  let sum = 0;
  const start = seed.startsWith('0x') ? 2 : 0;
  for (let i = start; i < Math.min(start + 5, seed.length); i++) {
    sum += seed.charCodeAt(i);
  }
  return sum % STATIC_PALETTE.length;
}
