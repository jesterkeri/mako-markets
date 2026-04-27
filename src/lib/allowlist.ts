import 'server-only';

import { eq, desc } from 'drizzle-orm';

import { db } from '@/db/client';
import { allowlistEmails } from '@/db/schema';
import { normalizeEmail } from './email';

// ----------------------------------------------------------------------------
// src/lib/allowlist.ts
//
// Thin wrapper around `allowlist_emails`. Two-tier gate:
//
//   MAKO_STAGE = 'dev'         → every email allowed (local / solo testing)
//   MAKO_STAGE = 'beta' | ...  → DB lookup required
//
// Emails are always normalized to lowercase before read or write so a user
// typing 'Josh@Example.com' and 'josh@example.com' resolves to the same row.
// ----------------------------------------------------------------------------

type AllowlistStage = 'dev' | 'beta' | 'production';
const VALID_STAGES: ReadonlySet<string> = new Set<AllowlistStage>([
  'dev',
  'beta',
  'production',
]);

/// Reads MAKO_STAGE and fails closed: unset env var → 'production' (safest
/// default, requires allowlist). Typos like 'prod' or 'staging' throw — we'd
/// rather crash at boot than silently disable the gate and let an attacker
/// in because someone set MAKO_STAGE=Production (capital P).
///
/// To run locally without an allowlist, explicitly set MAKO_STAGE=dev in
/// `.env.local`. Any other value is a bug, not a quirk.
function currentStage(): AllowlistStage {
  const raw = process.env.MAKO_STAGE;
  if (raw === undefined || raw === '') return 'production';
  if (!VALID_STAGES.has(raw)) {
    throw new Error(
      `MAKO_STAGE must be 'dev' | 'beta' | 'production' (case-sensitive), got ${JSON.stringify(raw)}.`,
    );
  }
  return raw as AllowlistStage;
}

/**
 * Stage-aware check. In `dev` stage always returns true. In `beta` /
 * `production`, looks up the normalized email in the DB.
 *
 * Call this in the auth route before issuing a session. Never call from the
 * client — MAKO_STAGE is a server-only knob and the allowlist table should
 * not leak to browsers.
 */
export async function isAllowedForCurrentStage(email: string): Promise<boolean> {
  if (currentStage() === 'dev') return true;
  return isOnAllowlist(email);
}

/**
 * Raw allowlist check — no stage gating. Use this for admin UI that wants to
 * show "X is on the list" regardless of stage.
 */
export async function isOnAllowlist(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const rows = await db
    .select({ email: allowlistEmails.email })
    .from(allowlistEmails)
    .where(eq(allowlistEmails.email, normalized))
    .limit(1);
  return rows.length > 0;
}

/**
 * Insert an email into the allowlist. Idempotent — re-adding the same email
 * is a no-op. `addedBy` is a human-readable tag (admin wallet address, admin
 * email, or 'seed' for bootstrap).
 */
export async function addToAllowlist(
  email: string,
  addedBy: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await db
    .insert(allowlistEmails)
    .values({ email: normalized, addedBy })
    .onConflictDoNothing();
}

export async function removeFromAllowlist(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  await db.delete(allowlistEmails).where(eq(allowlistEmails.email, normalized));
}

/**
 * List every allowlisted email, most recently added first. For admin UI.
 */
export async function listAllowlist(): Promise<
  Array<{ email: string; addedBy: string; addedAt: Date }>
> {
  return db
    .select({
      email: allowlistEmails.email,
      addedBy: allowlistEmails.addedBy,
      addedAt: allowlistEmails.addedAt,
    })
    .from(allowlistEmails)
    .orderBy(desc(allowlistEmails.addedAt));
}
