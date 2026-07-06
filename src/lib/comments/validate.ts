// ----------------------------------------------------------------------------
// src/lib/comments/validate.ts
//
// Pure, browser-safe validators for the comments POST body + query inputs.
// No Node globals (TextEncoder, not Buffer) so the composer can import
// bodyByteLength for its live counter. The route re-runs these server-side —
// the client copy is UX only, never a trust boundary.
//
// Discipline (plan §6): explicit allowlist, EXPLICIT unknown-key rejection
// (the profile route only IGNORES extras; comments must REJECT them), canonical
// uint256 marketId (reject overlong/huge BEFORE BigInt), slug charset.
// ----------------------------------------------------------------------------

import { BODY_MAX_BYTES, BODY_MIN_BYTES, type CommentScope } from './types';

const UINT256_MAX = (1n << 256n) - 1n;
// 2^256-1 is 78 decimal digits — anything longer can't be a valid uint256, and
// bailing on length BEFORE BigInt() avoids a pathological huge-string parse.
const UINT256_MAX_DIGITS = 78;
const CANONICAL_UINT_RE = /^(0|[1-9][0-9]*)$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mirrors slug.ts: bare 8-char base62, optionally a `dx-` synthetic prefix.
const SLUG_RE = /^(dx-)?[0-9A-Za-z]{8}$/;

export function bodyByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/// Canonical uint256 decimal string: digits only, no leading zeros (except
/// "0"), value <= 2^256-1. The on-chain marketId is a uint256; this rejects
/// non-canonical/overlong input before any BigInt/RPC/SQL touches it.
export function isCanonicalUint256(s: string): boolean {
  if (!CANONICAL_UINT_RE.test(s)) return false;
  if (s.length > UINT256_MAX_DIGITS) return false;
  return BigInt(s) <= UINT256_MAX;
}

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

/// Validate + normalize a comment body. Trim first, then bound by BYTES
/// (octet_length parity with the DB CHECK). Whitespace-only trims to '' → 0
/// bytes → rejected.
export function validateBody(raw: unknown): { body: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'bad_body' };
  const trimmed = raw.trim();
  const bytes = bodyByteLength(trimmed);
  if (bytes < BODY_MIN_BYTES || bytes > BODY_MAX_BYTES) return { error: 'bad_body' };
  return { body: trimmed };
}

export type ParsedPost =
  | { scope: 'main'; marketId: string; parentId: string | null; body: string }
  | { scope: 'pm'; slug: string; parentId: string | null; body: string };

/// Strict POST-body parser. Rejects unknown keys, bad scope, malformed target,
/// bad parentId, and bad body. Returns the normalized shape or an error code.
export function parsePostBody(raw: unknown): ParsedPost | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'bad_body' };
  }
  const body = raw as Record<string, unknown>;

  const scope = body.scope;
  if (scope !== 'main' && scope !== 'pm') return { error: 'bad_scope' };

  // Exact allowlist per scope — any other key is a hard 400 (no mass
  // assignment, no scope-crossing target column).
  const targetKey = scope === 'main' ? 'marketId' : 'slug';
  const allowed = new Set<string>(['scope', targetKey, 'parentId', 'body']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { error: 'unknown_key' };
  }

  const bodyRes = validateBody(body.body);
  if ('error' in bodyRes) return bodyRes;

  // parentId is optional; absent OR explicit null both mean "top-level".
  let parentId: string | null = null;
  if (body.parentId !== undefined && body.parentId !== null) {
    if (typeof body.parentId !== 'string' || !isUuid(body.parentId)) {
      return { error: 'bad_parent' };
    }
    parentId = body.parentId;
  }

  if (scope === 'main') {
    const marketId = body.marketId;
    if (typeof marketId !== 'string' || !isCanonicalUint256(marketId)) {
      return { error: 'bad_market_id' };
    }
    return { scope: 'main', marketId, parentId, body: bodyRes.body };
  }

  const slug = body.slug;
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    return { error: 'bad_slug' };
  }
  return { scope: 'pm', slug, parentId, body: bodyRes.body };
}

/// Clamp a client-supplied `limit` query param into [1, max]. Junk (non-numeric,
/// NaN, <=0) falls back to `def`. Never trust the raw number.
export function clampLimit(raw: string | null, def: number, max: number): number {
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, max);
}

export type { CommentScope };
