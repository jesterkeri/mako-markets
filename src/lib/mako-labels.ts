// ----------------------------------------------------------------------------
// src/lib/mako-labels.ts
//
// Pure types + validation for MAKO off-chain outcome labels. NO 'use client',
// NO `import 'server-only'`. Importable from anywhere in the codebase: API
// routes, server components, client components, vitest, scripts.
//
// What this layer is for:
//   `MakoMarketsV4` stores binary outcomes as `Outcome.YES = 1` /
//   `Outcome.NO = 2` with no label fields. Admin-curated MAKO markets
//   (admin question + manual resolution) can attach display labels here
//   (e.g. label_1 = "APC", label_2 = "PDP") without touching the contract.
//
// Key-discipline rule (BINDING — see plan round 9, attack area 11):
//
//   All market IDs in this layer are `string`. Callers convert from the
//   on-chain bigint at the boundary via `m.id.toString()`. The Map type is
//   `Map<string, MakoOutcomeLabels>` — never `Map<bigint, ...>`. Do NOT
//   add a bigint overload anywhere in the labels layer; doing so creates
//   two equality semantics for the same logical key and silently
//   reintroduces the round-8 Map-miss bug where a bigint-keyed lookup
//   against a string-keyed Map always returned undefined and the UI
//   silently fell back to YES/NO.
//
//   JSON has no bigint either, so any wire shape forces string already —
//   string at the type level is the cheapest enforcement.
//
// The fallback rule (BINDING — see plan round 3, helper-rule correctness):
//
//   If a MAKO market has no row in this table, callers must fall back to
//   "YES" / "NO". `outcomeLabelForMarket` in admin-shared.tsx is the only
//   place that decides; it overrides ONLY outcomes 1 and 2, only when
//   `mType === MAKO` AND labels are present. Outcomes 0 (pending) and 3
//   (refund) ALWAYS delegate to the pure `outcomeLabel(o)` helper.
// ----------------------------------------------------------------------------

/// Per-label byte cap. Mirrors `oracleRef`'s 32-byte cap on the contract
/// (the closest existing convention). Enforced at three layers:
///   - this module's `validateLabelPair` (client + server)
///   - zod schema in the admin write route
///   - SQL CHECK constraint in `0007_mako_outcome_labels.sql`
/// Defense in depth: a label that exceeds 32 bytes can be caught at the
/// form, the API, or the DB — whichever fires first.
export const MAKO_LABEL_MAX_BYTES = 32;

/// Display labels for a single MAKO market's binary outcomes. `label1`
/// corresponds to on-chain `Outcome.YES = 1`; `label2` corresponds to
/// `Outcome.NO = 2`.
export type MakoOutcomeLabels = {
  label1: string;
  label2: string;
};

/// Wire shape for a single row in the `GET /api/mako-labels` response. The
/// `marketId` is the on-chain id stringified (see key-discipline rule above).
export type MakoLabelsRow = MakoOutcomeLabels & {
  marketId: string;
};

/// Read-side Map keyed by stringified market id. The Map type intentionally
/// uses `string` — see key-discipline rule above. NEVER widen this to
/// `Map<bigint | string, ...>`.
export type MakoLabelsMap = Map<string, MakoOutcomeLabels>;

/// UTF-8 byte length. We measure bytes (not chars) because the contract's
/// own string fields are byte-bounded, and non-ASCII labels (Yoruba
/// diacritics, smart quotes from a paste, emoji) inflate per-char into
/// multi-byte sequences that would otherwise sneak past a char-based cap.
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/// Discriminated-union result so callers can switch on `ok` without
/// stringly-typed reason-matching. Reasons map 1:1 to UI copy.
export type LabelPairValidation =
  | { ok: true; mode: 'empty' | 'filled' }
  | {
      ok: false;
      reason:
        | 'mixed_empty'        // one label provided, the other blank
        | 'label1_too_long'    // > MAKO_LABEL_MAX_BYTES UTF-8 bytes
        | 'label2_too_long';
    };

/// Validate a (label1, label2) pair from the admin form. Both labels must
/// be either present-and-within-cap, or both empty — partial pairs are
/// rejected because rendering "APC" vs "NO" (or "YES" vs "PDP") is
/// incoherent: one half taken from DB, the other from fallback.
///
/// Empty pair (mode === 'empty') is the documented signal for "no DB
/// row, fall back to YES/NO". The admin form, the API route, and the DB
/// CHECK constraint all use this same rule.
export function validateLabelPair(
  rawLabel1: string,
  rawLabel2: string,
): LabelPairValidation {
  const l1 = rawLabel1.trim();
  const l2 = rawLabel2.trim();
  const l1Empty = l1.length === 0;
  const l2Empty = l2.length === 0;

  if (l1Empty && l2Empty) return { ok: true, mode: 'empty' };
  if (l1Empty || l2Empty) return { ok: false, reason: 'mixed_empty' };
  if (utf8ByteLength(l1) > MAKO_LABEL_MAX_BYTES) {
    return { ok: false, reason: 'label1_too_long' };
  }
  if (utf8ByteLength(l2) > MAKO_LABEL_MAX_BYTES) {
    return { ok: false, reason: 'label2_too_long' };
  }
  return { ok: true, mode: 'filled' };
}
