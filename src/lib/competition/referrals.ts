import 'server-only';

// Referrals for the $100 trading competition (REFERRAL_COMPETITION_PLAN r1, sections 2-3, plus the owner's 2026-10-23
// change: a friend may type the code on the Me page instead of opening the link). No table of its own: a referral is
// `users.ref` holding a referral tag (src/lib/ref-tag.ts), and a code is computed from an account's address.
//
// An account's address is its wallet for a wallet account and its Safe on Monad testnet for an email account, the
// address its bets come from. lower() on both: Safe addresses are stored checksummed (leaderboard/identity.ts).

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { MAKO_ADDRESS } from '@/lib/contract';

import { COMPETITION_END, COMPETITION_START } from './config';

/// The referral-tag rule as SQL (isReferralTag): marketing tags such as `r-launch` never count.
export const REFERRAL_RE = '^r-[0-9a-f]{30}$';
/// Ledger rows of the live contract only: market ids are per contract, and outcomes are read from MAKO_ADDRESS.
export const CONTRACT_LOWER = MAKO_ADDRESS.toLowerCase();

/// Every account with its lowercase address (NULL for an email account with no Safe row yet), as `accounts`.
export const ACCOUNTS_CTE = sql`
  accounts AS (
    SELECT u.id, u.ref, u.created_at, lower(coalesce(u.wallet_address, s.safe_address)) AS addr, lower(u.magic_eoa) AS eoa
    FROM users u
    LEFT JOIN user_safes s ON s.user_id = u.id AND s.chain_id = ${MONAD_TESTNET_ID}
  )`;

/// The same person on both sides (Codex referral code review R1 F2): the referrer whose code is `a.ref` controls the
/// referred account's address (its embedded EOA signed in as a wallet account), or the other way round. Mako stores
/// that link in users.magic_eoa, so it is excluded here, not left to the manual review.
const LINKED = sql`EXISTS (
        SELECT 1 FROM accounts r
        WHERE r.addr IS NOT NULL AND 'r-' || substr(r.addr, 3, 30) = a.ref
          AND ((r.eoa IS NOT NULL AND r.eoa = a.addr) OR (a.eoa IS NOT NULL AND (a.eoa = r.addr OR a.eoa = r.eoa)))
      )`;

/// Referred accounts that count, as `qualified (code)`: a referral tag, not the account's own code nor the same
/// person, an account created at or after the start, and a bet from the account's own address inside [START, END)
/// (Codex referral code review R1 F1: no pre-start sign-up or bet counts). Each is one users row, so it counts once,
/// for one referrer.
export const QUALIFIED_CTE = sql`
  qualified AS (
    SELECT a.ref AS code
    FROM accounts a
    WHERE a.ref ~ ${REFERRAL_RE}
      AND a.addr IS NOT NULL
      AND 'r-' || substr(a.addr, 3, 30) <> a.ref
      AND NOT ${LINKED}
      AND a.created_at >= ${COMPETITION_START.toISOString()}::timestamptz
      AND EXISTS (
        SELECT 1 FROM mako_market_events e
        WHERE e.chain_id = ${MONAD_TESTNET_ID} AND e.contract_address = ${CONTRACT_LOWER}
          AND e.kind = 'bet' AND e.actor = a.addr
          AND e.block_timestamp >= ${COMPETITION_START.toISOString()}::timestamptz
          AND e.block_timestamp < ${COMPETITION_END.toISOString()}::timestamptz
      )
  )`;

// Both adapters expose row arrays; pglite wraps them in `{ rows }` (leaderboard/queries.ts).
export function unwrapRows(result: unknown): Record<string, unknown>[] {
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown[])) as Record<string, unknown>[];
}

/// The caller's own progress (slice 2): friends who joined with `code`, and how many of them have bet. Counts only,
/// never who. `canAddInviter` is true while the caller may still enter a friend's code (setReferrer's rules).
export async function referralCounts(
  db: DbOrTx,
  userId: string,
  code: string,
): Promise<{ joined: number; qualified: number; canAddInviter: boolean }> {
  const rows = unwrapRows(
    await db.execute(sql`
      WITH ${ACCOUNTS_CTE}, ${QUALIFIED_CTE}
      SELECT
        (SELECT count(*) FROM accounts a
          WHERE a.ref = ${code} AND (a.addr IS NULL OR 'r-' || substr(a.addr, 3, 30) <> a.ref) AND NOT ${LINKED}
            AND a.created_at >= ${COMPETITION_START.toISOString()}::timestamptz)::int AS "joined",
        (SELECT count(*) FROM qualified q WHERE q.code = ${code})::int AS "qualified",
        EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = ${userId}::uuid
            AND (u.ref IS NULL OR u.ref !~ ${REFERRAL_RE})
            AND u.created_at >= ${COMPETITION_START.toISOString()}::timestamptz
        ) AS "canAddInviter"
    `),
  );
  const r = rows[0] ?? {};
  return { joined: Number(r.joined ?? 0), qualified: Number(r.qualified ?? 0), canAddInviter: r.canAddInviter === true };
}

export type SetReferrerResult = { ok: true } | { ok: false; error: 'invalid' | 'own' | 'already' | 'too_old' };

/// Records a friend's code as the caller's referrer, typed on the Me page (owner change 2026-10-23). The code must
/// already pass isReferralTag (the route checks). ONE conditional UPDATE, so two concurrent requests cannot both write
/// and a referral tag, once set, never changes; a marketing tag may be replaced. When nothing is written, a read says
/// which rule refused it, and the answer never says whose code it is.
export async function setReferrer(db: DbOrTx, userId: string, code: string): Promise<SetReferrerResult> {
  const written = unwrapRows(
    await db.execute(sql`
      WITH ${ACCOUNTS_CTE}
      UPDATE users u SET ref = ${code}
      WHERE u.id = ${userId}::uuid
        AND (u.ref IS NULL OR u.ref !~ ${REFERRAL_RE})
        AND u.created_at >= ${COMPETITION_START.toISOString()}::timestamptz
        AND (SELECT 'r-' || substr(a.addr, 3, 30) FROM accounts a WHERE a.id = u.id) IS DISTINCT FROM ${code}
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.addr IS NOT NULL AND 'r-' || substr(a.addr, 3, 30) = ${code})
        AND NOT EXISTS (
          SELECT 1 FROM accounts me, accounts r
          WHERE me.id = u.id AND r.addr IS NOT NULL AND 'r-' || substr(r.addr, 3, 30) = ${code}
            AND ((r.eoa IS NOT NULL AND r.eoa = me.addr) OR (me.eoa IS NOT NULL AND (me.eoa = r.addr OR me.eoa = r.eoa)))
        )
      RETURNING u.id
    `),
  );
  if (written.length > 0) return { ok: true };

  const why = unwrapRows(
    await db.execute(sql`
      WITH ${ACCOUNTS_CTE}
      SELECT
        a.ref ~ ${REFERRAL_RE} AS "already",
        a.created_at < ${COMPETITION_START.toISOString()}::timestamptz AS "tooOld",
        ('r-' || substr(a.addr, 3, 30) = ${code} OR EXISTS (
          SELECT 1 FROM accounts r
          WHERE r.addr IS NOT NULL AND 'r-' || substr(r.addr, 3, 30) = ${code}
            AND ((r.eoa IS NOT NULL AND r.eoa = a.addr) OR (a.eoa IS NOT NULL AND (a.eoa = r.addr OR a.eoa = r.eoa)))
        )) AS "own"
      FROM accounts a WHERE a.id = ${userId}::uuid
    `),
  )[0];
  if (why?.own === true) return { ok: false, error: 'own' };
  if (why?.already === true) return { ok: false, error: 'already' };
  if (why?.tooOld === true) return { ok: false, error: 'too_old' };
  return { ok: false, error: 'invalid' };
}
