// ----------------------------------------------------------------------------
// src/lib/avatar-scrub.ts  (#189)
//
// Pure planner + orchestration for the avatar scrub. `users.avatar_url` predates
// the upload infra (migration 0004 = "https-only paste"), so LEGACY rows can
// hold an arbitrary attacker-controlled URL — even one on the attacker's OWN
// Vercel Blob store, and even one on a DIFFERENT app's store under this user's
// own /avatars/<id>/ path. The public comments wire already filters these at
// read time (isAppOwnedAvatarUrl); this drives the one-time DB scrub that NULLs
// any non-owned value at rest so no surface, present or future, can serve one
// (and so legacy rows re-imported from the old DB get cleaned).
//
// Kept pure (no DB, no env) so the classification reuses the EXACT ownership
// rule the comments filter uses (isAppOwnedAvatarUrlForHost) — the two cannot
// drift — and so the destructive orchestration is unit-testable.
//
// SAFETY MODEL (why this is more than a one-line UPDATE):
//   The script CANNOT know from the DB alone which Blob host is "correct" for a
//   given database — avatar_url is free text and legacy rows are arbitrary, so a
//   real row can point at ANY store. It therefore cannot PROVE a host is right;
//   it can only make a wrong host loud and force the operator to authorize the
//   EXACT destructive plan they reviewed:
//     1. FAIL CLOSED if the app Blob host can't be resolved (every row would
//        look non-owned) — checkScrubGuards → no_host.
//     2. Require an operator-supplied --expect-host that EXACTLY matches the
//        token-derived host: a cross-check that the token belongs with this DB
//        (checkScrubGuards → host_mismatch). NECESSARY BUT NOT SUFFICIENT — a
//        consistent-but-wrong (token, --expect-host) pair still passes it.
//     3. TWO-STEP CONFIRM — the real gate (Codex #189 r3). --apply requires a
//        --confirm=<token> equal to the planFingerprint printed by a PRIOR
//        dry-run. So a single invocation can't both discover and execute a
//        plan, and a token minted against a different db / host / row-set won't
//        validate. This forces the operator to SEE the breakdown (their real
//        host sitting in the "to null" list is the wrong-host alarm) before any
//        write. It does NOT prove correctness — no heuristic can — it forces
//        review of the exact plan.
//     4. keptOwned === 0 (a plan that keeps ZERO owned avatars) is the strongest
//        wrong-host signature; on --apply it ALSO requires --force-empty-kept.
//        This is a SECONDARY speed bump, not the primary defense: a single
//        owned-looking stray row makes keptOwned > 0, which is exactly how the
//        r2 version was bypassed (Codex #189 r3 MAJOR). The confirm token, not
//        this counter, is what binds the decision to a reviewed plan.
// ----------------------------------------------------------------------------

import { isAppOwnedAvatarUrlForHost } from './avatar-url';

export interface AvatarRow {
  id: string;
  avatarUrl: string;
}

export interface ScrubPlan {
  /// The full flagged rows (id + the exact non-owned url). The runner nulls by
  /// BOTH id and avatar_url so a concurrent upload between read and write isn't
  /// clobbered — carrying the url here, not just the id, is what enables that.
  toNull: AvatarRow[];
  /// count of rows kept (owned by this app on this user's own path).
  keptOwned: number;
}

/// Partition rows into owned-kept vs to-be-nulled using the app Blob host.
/// The caller MUST pass a resolved, non-empty `appHost` (fail closed upstream
/// if it can't be resolved) — against an empty/wrong host this flags EVERYTHING
/// as non-owned.
export function planAvatarScrub(
  rows: readonly AvatarRow[],
  appHost: string,
): ScrubPlan {
  const toNull: AvatarRow[] = [];
  let keptOwned = 0;
  for (const r of rows) {
    if (isAppOwnedAvatarUrlForHost(r.avatarUrl, r.id, appHost)) {
      keptOwned++;
    } else {
      toNull.push(r);
    }
  }
  return { toNull, keptOwned };
}

/// Hostname → count of to-be-nulled rows on that host, for triage output.
/// Emits HOSTNAMES ONLY (never full URLs) so the operator's log doesn't itself
/// echo attacker-controlled paths / query strings. Unparseable URLs bucket
/// under `<unparseable>`.
export function hostBreakdown(toNull: readonly AvatarRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of toNull) {
    let host: string;
    try {
      host = new URL(r.avatarUrl).hostname.toLowerCase();
    } catch {
      host = '<unparseable>';
    }
    out.set(host, (out.get(host) ?? 0) + 1);
  }
  return out;
}

/// A short, deterministic checksum of the EXACT scrub plan: db identity + app
/// host + kept count + every (id, url) pair to be nulled. This is NOT a security
/// MAC — the operator already holds the DB credentials, so forging is pointless.
/// Its job is INTEGRITY + FORCING REVIEW: `--apply` requires the operator to
/// pass the token printed by a PRIOR dry-run, so (a) one invocation can't both
/// discover and execute a destructive plan without the operator seeing the
/// breakdown, and (b) a token minted against one db/host/row-set won't validate
/// once any of them changes (the checksum differs). This is the control that
/// replaces the unsound `keptOwned > 0` heuristic (Codex #189 r3): it does not
/// GUESS whether the host is right, it binds authorization to the reviewed plan.
export function planFingerprint(input: {
  dbIdentity: string;
  appHost: string;
  keptOwned: number;
  toNull: readonly AvatarRow[];
}): string {
  // Sort by the UNIQUE row id so the token is independent of DB row order.
  const tuples = input.toNull
    .map((r) => [r.id, r.avatarUrl] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // JSON.stringify is an UNAMBIGUOUS encoding: control characters in a legacy
  // avatar_url (\n, \t) are escaped and every field is quoted, so record/field
  // boundaries can't be forged by embedding separators inside a url — a raw
  // "id\turl\n…" join collided when a url carried tabs/newlines (Codex #189 r4
  // MAJOR). Pairing the id with the exact url keeps the token bound to the CAS
  // target, so any changed avatar changes the token.
  const canonical = JSON.stringify([
    'v1',
    input.dbIdentity,
    input.appHost,
    input.keptOwned,
    tuples,
  ]);
  return fnv1a64Hex(canonical);
}

/// FNV-1a 64-bit over UTF-16 code units → 16 lowercase hex chars. Deterministic
/// and dependency-free (kept pure/testable, no node:crypto). A checksum, not a
/// cryptographic hash — see planFingerprint for why that is the right strength.
function fnv1a64Hex(s: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/// Discriminated result of redactDbUrl. `ok: false` means the string is not a
/// connection URL we can parse into a trustworthy identity — the caller MUST
/// abort (never fall back to a placeholder identity, which would let a confirm
/// token replay across distinct-but-unparseable targets — Codex #189 r7 MAJOR).
export type RedactedDbUrl =
  | { ok: true; identity: string }
  | { ok: false; reason: 'unredactable' };

/// Redact ONLY the userinfo password from a connection string, preserving every
/// routing-relevant part verbatim (scheme, user, host LIST, ports, database,
/// ?options), and return it as the target's non-secret ROUTING identity. Edges:
///   - The authority's userinfo ends at its LAST '@' — a password may itself
///     contain a literal '@' (postgres.js accepts `u:@secret@host`), so
///     anchoring on the FIRST '@' leaked the password (Codex #189 r5 MAJOR).
///   - postgres.js trims surrounding whitespace before parsing, so we trim first
///     (Codex #189 r6 MAJOR). But it ALSO accepts some prefixes trim() can't
///     strip (e.g. leading C0 controls U+0001–U+0008), so anything that does not
///     parse into a `scheme://authority` URL after trimming returns
///     `{ ok: false }` — the caller aborts, so no password leaks AND no
///     collapsed placeholder identity can replay a token (Codex #189 r7 MAJOR).
export function redactDbUrl(raw: string): RedactedDbUrl {
  const url = raw.trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i.exec(url);
  if (!m) return { ok: false, reason: 'unredactable' };
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf('@'); // userinfo | host separator (LAST '@')
  if (at === -1) return { ok: true, identity: url }; // no userinfo → no password
  const userinfo = authority.slice(0, at);
  const hostAndOn = authority.slice(at); // starts with '@'
  const colon = userinfo.indexOf(':'); // user : password (first ':' splits)
  if (colon === -1) return { ok: true, identity: url }; // user present, no password
  const user = userinfo.slice(0, colon);
  return { ok: true, identity: `${scheme}${user}:<redacted>${hostAndOn}${rest}` };
}

/// The userinfo password of a connection string (userinfo ends at the LAST '@'),
/// or null. Internal — used ONLY to scrub it out of error text before logging.
function extractDbPassword(rawUrl: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(rawUrl.trim());
  if (!m) return null;
  const authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at === -1) return null;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return null;
  const pw = userinfo.slice(colon + 1);
  return pw.length > 0 ? pw : null;
}

/// Build a scrubber that removes the raw connection string (trimmed + verbatim)
/// AND its password from any string. Longest secrets first so a password that
/// is a substring of the URL is still fully masked.
function makeSecretScrubber(rawUrl: string): (s: string) => string {
  const pw = extractDbPassword(rawUrl);
  // postgres.js percent-DECODES the password before use, so a backend/proxy
  // error can echo the DECODED credential (p%40ss → p@ss). Mask that form too
  // (Codex #189 r9). decodeURIComponent throws on malformed input → guarded.
  let decodedPw: string | null = null;
  if (pw) {
    try {
      const d = decodeURIComponent(pw);
      if (d !== pw) decodedPw = d;
    } catch {
      // malformed percent-encoding — only the raw form is maskable
    }
  }
  const secrets = [rawUrl, rawUrl.trim(), pw, decodedPw]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  return (s: string) => {
    let out = s;
    for (const secret of secrets) out = out.split(secret).join('<redacted>');
    return out;
  };
}

/// One-line, SECRET-SAFE description of a thrown error for logging. NEVER log a
/// raw pg-client error: its `.input` / `.config` / stack can embed the whole
/// connection string incl. the password — e.g. `new URL()` on a bad port throws
/// ERR_INVALID_URL with `.input` = the DATABASE_URL, and `console.error(err)`
/// prints it (Codex #189 r8 MAJOR). We surface ONLY name + code + a message
/// scrubbed of the connection string / password; never the raw object or stack.
export function describeErrorSafely(err: unknown, rawUrl: string): string {
  const scrub = makeSecretScrubber(rawUrl);
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codePart = typeof code === 'string' && code.length > 0 ? ` [${scrub(code)}]` : '';
    return `${scrub(err.name)}${codePart}: ${scrub(err.message)}`;
  }
  return `Non-Error thrown: ${scrub(String(err))}`;
}

export type ScrubGuardResult =
  | { ok: true; appHost: string }
  | { ok: false; reason: 'no_host' | 'no_expected_host' | 'host_mismatch' };

/// Gate the scrub BEFORE it can touch the DB. Two independent facts must line
/// up: the token in the env derives an app Blob host (`appHost`), AND the
/// operator has independently stated which host they expect (`expectedHost`).
/// A parseable token alone is NOT enough — Vercel allows multiple Blob stores,
/// so a valid-but-wrong token (e.g. a dev token exported alongside the prod
/// DATABASE_URL) would derive a host under which every legitimate avatar looks
/// non-owned and, with --apply, gets wiped. Requiring an exact match with an
/// operator-supplied host turns that silent mismatch into an abort. (Codex
/// #189 MAJOR.) Comparison is case-insensitive; hosts are lowercased.
export function checkScrubGuards(
  appHost: string | null,
  expectedHost: string | null,
): ScrubGuardResult {
  if (!appHost) return { ok: false, reason: 'no_host' };
  if (!expectedHost) return { ok: false, reason: 'no_expected_host' };
  if (expectedHost.trim().toLowerCase() !== appHost.toLowerCase()) {
    return { ok: false, reason: 'host_mismatch' };
  }
  return { ok: true, appHost };
}

/// Single compare-and-set null of one row, scoped by BOTH id and the exact
/// avatar_url read earlier. Returns rows affected (0 if the avatar changed
/// since the read → the row is left intact).
export interface ScrubApplyDeps {
  nullOne: (id: string, avatarUrl: string) => Promise<number>;
}

/// Apply the scrub over the flagged rows via the injected `nullOne`. Injecting
/// the DB op keeps the accounting (nulled vs skipped) unit-testable without a
/// live database. The caller runs this inside a transaction so a mid-loop
/// throw rolls the whole batch back.
export async function applyScrub(
  toNull: readonly AvatarRow[],
  deps: ScrubApplyDeps,
): Promise<{ nulled: number; skipped: number }> {
  let nulled = 0;
  for (const r of toNull) {
    nulled += await deps.nullOne(r.id, r.avatarUrl);
  }
  return { nulled, skipped: toNull.length - nulled };
}

/// A DB handle the runner opens ONLY after the guards pass — so a guard failure
/// never touches a database. Injected so the orchestration is unit-testable.
export interface ScrubDb {
  /// Authoritative identity of the LIVE target read from the server itself
  /// (e.g. current_database() + effective search_path). Folded into the confirm
  /// token so it binds to the ACTUAL database + schema the unqualified `users`
  /// query resolves to — not a lossy parse of the connection string, which
  /// collapses multi-host URLs and ?options search_path variants (Codex #189
  /// r4 MAJOR).
  identify: () => Promise<string>;
  loadRows: () => Promise<AvatarRow[]>;
  applyInTx: (
    toNull: readonly AvatarRow[],
  ) => Promise<{ nulled: number; skipped: number }>;
  end: () => Promise<void>;
}

export interface ScrubRunnerDeps {
  appHost: string | null;
  expectedHost: string | null;
  apply: boolean;
  forceEmptyKept: boolean;
  /// Non-secret ROUTING identity of the target: the connection string with ONLY
  /// the password redacted (host list, ports, database, user, ?options all
  /// preserved). runScrub folds this with the server-authoritative `identify()`
  /// into the confirm token, so a token from one target can't be replayed
  /// against another. A lossy host+db parse was NOT enough — it collapsed
  /// multi-host URLs and ?options search_path variants (Codex #189 r4 MAJOR).
  dbIdentity: string;
  /// The --confirm=<token> the operator passed (null if absent). On --apply it
  /// MUST equal the planFingerprint of the freshly-loaded plan (i.e. the token
  /// a prior dry-run printed for this exact db/host/row-set).
  confirmToken: string | null;
  /// Opens the DB. runScrub calls this ONLY after checkScrubGuards passes.
  connect: () => Promise<ScrubDb>;
  log: (msg: string) => void;
}

export type ScrubRunResult =
  | { status: 'guard_failed'; reason: 'no_host' | 'no_expected_host' | 'host_mismatch' }
  | { status: 'nothing_to_scrub'; total: number; keptOwned: number }
  | {
      status: 'dry_run';
      total: number;
      keptOwned: number;
      toNull: number;
      emptyKept: boolean;
      fingerprint: string;
    }
  | { status: 'confirm_required'; total: number; keptOwned: number; toNull: number; fingerprint: string }
  | { status: 'confirm_mismatch'; expected: string; got: string }
  | { status: 'refused_empty_kept'; total: number; toNull: number }
  | {
      status: 'applied';
      total: number;
      keptOwned: number;
      toNull: number;
      nulled: number;
      skipped: number;
      remainingNonOwned: number;
    };

/// Orchestrates the scrub. Guards run FIRST and short-circuit before any
/// connection. The DESTRUCTIVE branch (--apply) is gated on a --confirm token
/// equal to the planFingerprint of the freshly-loaded plan — the token a PRIOR
/// dry-run printed. This is the primary defense (Codex #189 r3): it forces the
/// operator to review the exact plan (their real host in the "to null"
/// breakdown = the wrong-host alarm) and binds authorization to that plan, so a
/// wrong-but-consistent (token, --expect-host) pair can't discover-and-wipe in
/// one shot, and a token can't be replayed against a different db/host/row-set.
/// keptOwned === 0 remains only as a SECONDARY --force-empty-kept speed bump for
/// the total-wipe case; it is deliberately not relied on (a single stray
/// owned-looking row defeats it — that was the r3 bypass).
export async function runScrub(deps: ScrubRunnerDeps): Promise<ScrubRunResult> {
  const guard = checkScrubGuards(deps.appHost, deps.expectedHost);
  if (!guard.ok) return { status: 'guard_failed', reason: guard.reason };

  const db = await deps.connect();
  try {
    // Bind the token to the ACTUAL target: the redacted routing string (host
    // list, ports, db, user, ?options) folded with an authoritative identity
    // read from the LIVE connection (current_database + effective search_path).
    // A lossy URL parse alone collapsed multi-host URLs and search_path variants
    // onto one identity, letting a token replay across targets (Codex #189 r4
    // MAJOR). Combined as a JSON array so the two halves can't blur together.
    const resolvedIdentity = await db.identify();
    const targetIdentity = JSON.stringify([deps.dbIdentity, resolvedIdentity]);

    const rows = await db.loadRows();
    const { toNull, keptOwned } = planAvatarScrub(rows, guard.appHost);

    deps.log(`app Blob host (matched --expect-host): ${guard.appHost}`);
    deps.log(`target db (routing):                   ${deps.dbIdentity}`);
    deps.log(`target db (resolved):                  ${resolvedIdentity}`);
    deps.log(`rows with a non-null avatar_url:       ${rows.length}`);
    deps.log(`  owned (kept):                        ${keptOwned}`);
    deps.log(`  non-owned (to null):                 ${toNull.length}`);
    if (toNull.length > 0) {
      deps.log('  non-owned host breakdown:');
      for (const [h, n] of hostBreakdown(toNull)) deps.log(`    ${h}: ${n}`);
    }

    if (toNull.length === 0) {
      deps.log('\nNothing to scrub. Done.');
      return { status: 'nothing_to_scrub', total: rows.length, keptOwned };
    }

    const fingerprint = planFingerprint({
      dbIdentity: targetIdentity,
      appHost: guard.appHost,
      keptOwned,
      toNull,
    });

    const emptyKept = keptOwned === 0;
    if (emptyKept) {
      deps.log(
        'WARNING: this plan keeps ZERO owned avatars — the strongest signature of a\n' +
          'WRONG Blob host/token for THIS database (every avatar looks non-owned). If\n' +
          "the host breakdown above shows your app's OWN Blob host, STOP: the token/host\n" +
          'is wrong for this database.',
      );
    }

    if (!deps.apply) {
      deps.log(
        `\nplan confirm token: ${fingerprint}\n` +
          'DRY RUN — no changes written. Review the "to null" host breakdown above.\n' +
          "If (and ONLY if) every host there is a genuine legacy/foreign host (NOT your\n" +
          `app's own store), re-run WITH:  --apply --confirm=${fingerprint}\n` +
          'The token is bound to THIS db + host + exact row set; if any row changes it\n' +
          'stops matching and you must run a fresh dry-run.',
      );
      return {
        status: 'dry_run',
        total: rows.length,
        keptOwned,
        toNull: toNull.length,
        emptyKept,
        fingerprint,
      };
    }

    // --- destructive branch: --apply ---
    // Gate 1: a matching confirm token from a prior dry-run must be present.
    if (!deps.confirmToken) {
      deps.log(
        '\nREFUSING to --apply without --confirm. Run WITHOUT --apply first, read the\n' +
          'breakdown, then --apply --confirm=<the token it prints>.',
      );
      return {
        status: 'confirm_required',
        total: rows.length,
        keptOwned,
        toNull: toNull.length,
        fingerprint,
      };
    }
    if (deps.confirmToken.trim().toLowerCase() !== fingerprint) {
      deps.log(
        '\nREFUSING to --apply: --confirm does not match this plan. The rows, host, or\n' +
          'target db changed since your dry-run (or the token is from a different run).\n' +
          'Run WITHOUT --apply to see the current plan and get a fresh token.',
      );
      return { status: 'confirm_mismatch', expected: fingerprint, got: deps.confirmToken.trim() };
    }
    // Gate 2 (secondary): the total-wipe case needs an explicit extra ack.
    if (emptyKept && !deps.forceEmptyKept) {
      deps.log(
        '\nREFUSING to --apply: this plan keeps ZERO owned avatars (likely a wrong\n' +
          'host/token). If the breakdown truly shows only legacy/foreign hosts, add\n' +
          '--force-empty-kept.',
      );
      return { status: 'refused_empty_kept', total: rows.length, toNull: toNull.length };
    }

    const { nulled, skipped } = await db.applyInTx(toNull);
    deps.log(
      `\nAPPLIED — nulled ${nulled} row(s)` +
        (skipped > 0 ? ` (${skipped} skipped — avatar changed since the read)` : '') +
        '.',
    );

    const remaining = planAvatarScrub(await db.loadRows(), guard.appHost);
    deps.log(
      `post-scrub: ${remaining.toNull.length} non-owned avatar_url remain (expect 0).`,
    );
    return {
      status: 'applied',
      total: rows.length,
      keptOwned,
      toNull: toNull.length,
      nulled,
      skipped,
      remainingNonOwned: remaining.toNull.length,
    };
  } finally {
    await db.end();
  }
}
