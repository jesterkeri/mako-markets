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
  consumeProofNonce: async () => true,
});

export const privyAdmissionNone = () => ({
  admissionOf: () => null,
  readAdmission: async () => null,
  writeAdmission: async () => {},
  findMismatchedAccount: async () => null,
});

export const PROOF_BODY = { message: 'm', signature: 's' };
