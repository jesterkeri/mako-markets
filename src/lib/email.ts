// ----------------------------------------------------------------------------
// src/lib/email.ts
//
// Shared email normalization. Used by:
//   - allowlist gate (deciding if a given input matches an allowlisted row)
//   - user upsert (deciding if a given input matches an existing users row)
//
// Both call sites MUST use this helper so the same input string lands at the
// same canonical form regardless of which code path normalizes it. Any drift
// between the two would let "Josh@Example.com" pass the allowlist check but
// then collide with "josh@example.com" in the users table on insert.
//
// Trim + lowercase handle the 99% case (leading space / mixed case). Unicode
// NFC handles the rare same-glyph-different-codepoint case (e.g., 'é' as one
// codepoint vs 'e' + combining acute). We deliberately do NOT punycode the
// domain or strip '+tag' aliases — those are policy decisions to make
// explicitly when we know we need them.
// ----------------------------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize('NFC');
}
