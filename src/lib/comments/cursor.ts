import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/cursor.ts
//
// Keyset pagination cursor for the comments list. A cursor encodes the
// (created_at, id) of the last row on a page; the next page selects rows
// strictly "after" it under the list's ORDER BY. Keyset (not OFFSET) so pages
// stay stable as new comments land.
//
// The cursor is OPAQUE to the client — it round-trips it verbatim. Server-only:
// the client never decodes it. decodeCursor is deliberately strict: a garbage
// or tampered cursor returns null (the route maps that to 400), never a partial
// value that could reach SQL.
// ----------------------------------------------------------------------------

import { isUuid } from './validate';

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(c: { createdAt: Date; id: string }): string {
  const payload = JSON.stringify({ t: c.createdAt.toISOString(), id: c.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/// Decode + VALIDATE. Returns null on anything that isn't a well-formed
/// {ISO timestamp, uuid} pair — bad base64, non-JSON, wrong shape, a
/// non-canonical timestamp, or a non-uuid id. Never throws.
export function decodeCursor(raw: string): Cursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.t !== 'string' || typeof p.id !== 'string') return null;
    if (!isUuid(p.id)) return null;
    const d = new Date(p.t);
    if (Number.isNaN(d.getTime())) return null;
    // Round-trip guard: reject a loosely-formatted timestamp (e.g. '2026-1-1')
    // so the cursor is unambiguous.
    if (d.toISOString() !== p.t) return null;
    return { createdAt: d, id: p.id };
  } catch {
    return null;
  }
}
