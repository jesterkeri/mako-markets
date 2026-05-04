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

export function deriveInitial(
  displayName: string | null,
  email: string,
): string {
  if (displayName) {
    const trimmed = displayName.trim();
    if (trimmed.length > 0) return trimmed[0]!.toUpperCase();
  }
  if (email && email.length > 0) return email[0]!.toUpperCase();
  return 'M';
}

export function derivePaletteIndex(magicEoa: string): number {
  let sum = 0;
  const start = magicEoa.startsWith('0x') ? 2 : 0;
  for (let i = start; i < Math.min(start + 5, magicEoa.length); i++) {
    sum += magicEoa.charCodeAt(i);
  }
  return sum % STATIC_PALETTE.length;
}
