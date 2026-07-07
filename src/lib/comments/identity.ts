import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/comments/identity.ts
//
// Resolve a comment author's DISPLAY identity from their user_id (which every
// comment row carries — unlike the leaderboard, no reverse address lookup).
//
// Per author:
//   - authorLabel = display_name (trimmed) ?? formatAddress(on-chain address).
//     When a display_name exists the raw address is NOT shown; when it doesn't,
//     the truncated address IS the label (intended fallback, plan §2).
//   - avatarSeed  = sha256(user_id) — stable, NON-REVERSIBLE, drives a glyph
//     avatar. Never the raw address (a named author would leak it otherwise).
//   - addressLower = the author's on-chain address, lowercased, for the
//     position-badge join (Magic → deriveSafeAddress(magic_eoa); wallet →
//     wallet_address). null if not derivable (defensive; valid rows always have
//     one).
//
// PRIVACY: this NEVER selects email / magic_eoa into the wire — only the
// display_name + the address-derivation inputs, which stay server-side.
// ----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Address } from 'viem';

import type { DbOrTx } from '@/db/client';
import { users } from '@/db/schema';
import { isAppOwnedAvatarUrl } from '@/lib/avatar-url';
import { deriveSafeAddress } from '@/lib/safe';
import { formatAddress } from '@/lib/user-display';

export interface CommentAuthor {
  authorLabel: string;
  avatarSeed: string;
  /// The author's uploaded profile photo (single-origin Vercel Blob URL) or
  /// null. Included in the wire per the 2026-07-07 decision; see CommentWire.
  avatarUrl: string | null;
  addressLower: string | null;
}

function seedFor(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

export async function resolveCommentAuthors(
  db: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, CommentAuthor>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, CommentAuthor>();
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      authType: users.authType,
      magicEoa: users.magicEoa,
      walletAddress: users.walletAddress,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, ids));

  for (const r of rows) {
    let addressLower: string | null = null;
    try {
      if (r.authType === 'magic' && r.magicEoa) {
        addressLower = deriveSafeAddress(r.magicEoa as Address).toLowerCase();
      } else if (r.walletAddress) {
        addressLower = r.walletAddress.toLowerCase();
      }
    } catch {
      addressLower = null;
    }

    const named = r.displayName?.trim();
    const authorLabel = named
      ? named
      : addressLower
        ? formatAddress(addressLower)
        : 'anon';

    // Codex MAJOR (avatar wire, r2): avatar_url predates the upload infra
    // (migration 0004 = "https-only paste"), so a LEGACY row can hold an
    // arbitrary URL — even one on an ATTACKER'S OWN Vercel Blob store. Only
    // serve it if it's on THIS app's exact store host under this user's own
    // /avatars/<id>/ prefix; otherwise null → glyph. Fails closed when the app
    // host can't be resolved. Keeps the public comments JSON from beaconing
    // third-party hosts.
    const avatarUrl =
      r.avatarUrl && isAppOwnedAvatarUrl(r.avatarUrl, r.id) ? r.avatarUrl : null;

    out.set(r.id, {
      authorLabel,
      avatarSeed: seedFor(r.id),
      avatarUrl,
      addressLower,
    });
  }
  return out;
}
