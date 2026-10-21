// Mock modules that make the inbox-takeover gate (src/lib/privy-gate.ts and its route wiring) PASS, for route tests
// that exercise something else (Mako's own TOTP step, account moves, the campaign tag). The gate itself is tested in
// privy-gate.test.ts and api-user-auth-gate.test.ts. `identity` is what the test's Privy mock returns.
export type TestIdentity = { privyUserId: string; email: string; wallets: string[] };

export function privyServerPassing(resolveIdentity: (token: string) => Promise<TestIdentity> | TestIdentity) {
  const reads = new Map<string, TestIdentity>();
  const readOf = (id: TestIdentity) => {
    reads.set(id.privyUserId, id);
    return { privyUserId: id.privyUserId, email: id.email.trim().toLowerCase(), user: {}, wallet: null, _wallet: id.wallets[0] };
  };
  return {
    PrivyConfigError: class PrivyConfigError extends Error {},
    PrivyIdentityError: class PrivyIdentityError extends Error {},
    readPrivyAccount: async (token: string) => readOf(await resolveIdentity(token)),
    readPrivyAccountById: async (privyUserId: string) => {
      const id = reads.get(privyUserId);
      return id ? readOf(id) : { privyUserId, email: null, user: {}, wallet: null, _wallet: null };
    },
    judgeAccount: (read: { _wallet: string | null }) =>
      read._wallet ? { ok: true, wallet: read._wallet.toLowerCase(), walletId: 'w', totpVerifiedAt: 1, exportedAtMs: null } : { ok: false, status: 'wallet_required', reason: 'no_wallet' },
    checkIdentity: () => ({ ok: true }),
  };
}

export const privyProofPassing = () => ({
  checkProofSignature: async () => ({ ok: true, nonce: 'n'.repeat(43) }),
  consumeProofNonce: async () => 'ok',
});

export const privyAdmissionNone = () => ({
  admissionOf: () => null,
  readAdmission: async () => null,
  lockPrivyUser: async () => Date.now(),
  readCheckpoint: async () => ({ totpVerifiedAt: 1 }),
  recordCheckpoint: async () => {},
  isBoundToAccount: async () => true,
  hasLiveCheckpoint: async () => false,
  writeAdmission: async () => {},
  findMismatchedAccount: async () => null,
  detectEmailMismatch: async () => null,
});

export const PROOF_BODY = { message: 'm', signature: 's' };

/// The account lock order's helpers (src/lib/account-locks.ts), for route tests on a fake database: every lock is a
/// no-op, the users row holds no lockout, and an embedded sign-in's candidate rows come from the fake's own plain
/// select (`select().from(users).where().limit()`). The real locks run on PGlite and PostgreSQL elsewhere.
type PlainSelect = { select: () => { from: (t: unknown) => { where: (w?: unknown) => { limit: (n: number) => Promise<unknown[]> } } } };
export const accountLocksPassing = () => ({
  lockUserRow: async () => ({ privyUserId: null, totpFailedAttempts: 0, totpLockedUntil: null, lockedNow: false, privyEmailVerifiedSeen: null }),
  lockEmbeddedCandidates: async (tx: PlainSelect) => {
    const { users } = await import('@/db/schema');
    return tx.select().from(users).where().limit(3);
  },
  lockSafeRows: async () => {},
  lockCeremonies: async () => [],
  lockChallenges: async () => [],
  lockRememberedRows: async () => [],
  lockSessions: async () => {},
});

/// For route tests that stand in upsertEmbeddedUser itself: the route's two halves (prepareEmbeddedUser at lock level
/// (2), finishEmbeddedUser after `t`) call that one stand-in with the arguments it always received.
export function upsertStandIn(upsert: (...args: unknown[]) => unknown) {
  return {
    prepareEmbeddedUser: async (...args: unknown[]) => ({ action: 'reuse', user: { id: 'stand-in' }, directMove: false, args }),
    finishEmbeddedUser: async (_tx: unknown, p: { args: unknown[] }) => upsert(...p.args),
  };
}
