// ----------------------------------------------------------------------------
// src/lib/privy-gate.ts
//
// The inbox-takeover gate (mako-design INBOX_GAP_PLAN r18): which Privy users may hold a Mako email session. Pure, so
// every rule is tested without Privy or a database; src/lib/privy-server.ts feeds it Privy's own records.
//
// Why: an embedded wallet signs for whoever holds a valid Privy session, and a Privy session needs only the email
// inbox. Privy asks a second factor before signing only once the user has enrolled one, and enrollment is optional.
// So Mako admits a Privy user only when (1) an authenticator (TOTP) is enrolled and nothing weaker sits beside it,
// and (2) its one embedded wallet came into existence AFTER that authenticator, so it can never have signed anything
// with the inbox alone ([C5]: a signature given before enrollment stays valid forever).
// ----------------------------------------------------------------------------

/// The parts of a Privy user object the gate reads (`@privy-io/node` User / LinkedAccount*). Unknown linked account
/// types are kept as-is: anything that is a wallet is counted, whatever its chain.
export interface GateUser {
  id: string;
  mfa_methods: ReadonlyArray<{ type: string; verified_at: number }>;
  linked_accounts: ReadonlyArray<{
    type: string;
    address?: string;
    id?: string | null;
    chain_type?: string;
    connector_type?: string;
    wallet_client_type?: string;
    imported?: boolean;
    delegated?: boolean;
    verified_at?: number;
    first_verified_at?: number | null;
  }>;
}

/// The parts of the wallet RESOURCE (`client.wallets().get(id)`) the gate reads. `exported_at` and `imported_at` are
/// in MILLISECONDS (wallets.d.ts), while every `verified_at` above is in SECONDS (users.d.ts).
export interface GateWallet {
  id: string;
  address: string;
  exported_at: number | null;
  imported_at: number | null;
  additional_signers: ReadonlyArray<unknown>;
}

/// What the account already recorded at its first admission ([G1]); null for an account never admitted under this
/// gate, whose next sign-in is its first admission.
export interface GateAdmission {
  /// The embedded wallet the account was admitted with (users.magic_eoa), lowercase.
  wallet: string;
  /// The TOTP `verified_at` (seconds) the account was admitted with.
  totpVerifiedAt: number;
}

/// The server's own record (privy_enrollment_checkpoints, migration 0014) that this Privy user once had exactly one
/// factor, an authenticator, and no embedded wallet on any chain. Written only by the server from its read of Privy;
/// never from anything the browser sent.
export interface EnrollmentCheckpoint {
  /// The authenticator's verified_at (seconds) as the server read it then, before any wallet existed.
  totpVerifiedAt: number;
}

export type GateRefusal =
  /// No authenticator yet, or a factor other than an authenticator: the dialog enrolls one. No cookie.
  | 'mfa_enrollment_required'
  /// An authenticator and no embedded wallet: the dialog creates the wallet after a fresh authenticator code. No cookie.
  | 'wallet_required'
  /// A planted passkey, an extra or foreign wallet, or a wallet that could have signed without the authenticator. The
  /// owner is told to contact support; support never resets this on an email request.
  | 'account_locked';

export type GateVerdict =
  | {
      ok: true;
      /// The single embedded Ethereum wallet, lowercase: the only key that may own the account's Safe.
      wallet: string;
      walletId: string;
      /// The TOTP `verified_at` (seconds) this sign-in judged against: the admission one for an admitted account.
      totpVerifiedAt: number;
      /// The wallet resource's `exported_at`, milliseconds or null, for the key-exported notice.
      exportedAtMs: number | null;
    }
  | { ok: false; status: GateRefusal; reason: string };

/// Embedded wallets of every chain are linked accounts of type 'wallet'. (Any other linked type, Privy smart wallets
/// included, is refused outright by judgeFactors.)
const isWallet = (a: GateUser['linked_accounts'][number]) => a.type === 'wallet';
const isEmbedded = (a: GateUser['linked_accounts'][number]) =>
  a.connector_type === 'embedded' || a.wallet_client_type === 'privy';

/// Step 1, before any wallet is looked at: the factors and passkeys. `wallet_required` and the wallet rules come from
/// judgeWallet, so the dialog can tell "enroll" apart from "create the wallet".
export function judgeFactors(user: GateUser): { ok: true; totpVerifiedAt: number } | { ok: false; status: GateRefusal; reason: string } {
  // [B1] Mako offers no passkey during the beta, so one that exists was planted, possibly before the owner enrolled.
  if (user.linked_accounts.some((a) => a.type === 'passkey')) return { ok: false, status: 'account_locked', reason: 'passkey_linked' };
  // An authorization key can carry wallet authority (root, manager, delegated actions) outside the authenticator check,
  // and nothing on the linked account proves one harmless (Codex S12 r1): locked.
  if (user.linked_accounts.some((a) => a.type === 'authorization_key')) return { ok: false, status: 'account_locked', reason: 'authorization_key_linked' };
  // Fail closed on every other linked-account type (Codex S12 r1): a Mako email account is its email and its embedded
  // wallet, nothing else. An OAuth account, a smart wallet, or a type Privy adds later is another way in that this gate
  // cannot judge.
  const other = user.linked_accounts.find((a) => a.type !== 'email' && a.type !== 'wallet');
  if (other) return { ok: false, status: 'account_locked', reason: `linked_${other.type}` };
  if (user.mfa_methods.some((m) => m.type === 'passkey')) return { ok: false, status: 'account_locked', reason: 'passkey_factor' };
  // [B5] Only an authenticator: an email factor is the inbox itself and SMS is a SIM swap away.
  const totp = user.mfa_methods.filter((m) => m.type === 'totp');
  if (totp.length !== 1 || user.mfa_methods.length !== 1) return { ok: false, status: 'mfa_enrollment_required', reason: 'no_totp_only' };
  const at = totp[0].verified_at;
  if (!Number.isSafeInteger(at) || at <= 0) return { ok: false, status: 'mfa_enrollment_required', reason: 'bad_totp_time' };
  return { ok: true, totpVerifiedAt: at };
}

/// The embedded wallets of EVERY chain type ([D1]: a Solana wallet can share the seed of a later Ethereum one).
export function embeddedWallets(user: GateUser) {
  return user.linked_accounts.filter((a) => isWallet(a) && isEmbedded(a));
}

/// Whether this read may be recorded as the enrollment checkpoint: the factors pass (exactly one, an authenticator,
/// nothing locked) and there is no embedded wallet on ANY chain. Returns the authenticator time to record, or null.
export function checkpointFrom(user: GateUser): EnrollmentCheckpoint | null {
  const factors = judgeFactors(user);
  if (!factors.ok) return null;
  if (embeddedWallets(user).length !== 0) return null;
  return { totpVerifiedAt: factors.totpVerifiedAt };
}

/// The full verdict. `wallet` is the resource of the single embedded Ethereum wallet, read by the caller only when
/// judgeFactors passed and exactly one embedded wallet exists (pass null otherwise). `checkpoint` is the server's
/// enrollment checkpoint for this Privy user, or null when none was ever recorded.
export function judgePrivyUser(
  user: GateUser,
  wallet: GateWallet | null,
  admission: GateAdmission | null,
  checkpoint: EnrollmentCheckpoint | null,
): GateVerdict {
  const factors = judgeFactors(user);
  if (!factors.ok) {
    // An account never admitted that already holds an embedded wallet but no authenticator can never be admitted: no
    // checkpoint can be recorded while a wallet exists, so enrolling now would only lead to a lock. Locked at once
    // rather than asking the owner to enrol an authenticator that cannot unlock it (live test L6, 2026-10-07). An
    // admitted account that lost its authenticator still re-enrols ([G1]).
    if (factors.status === 'mfa_enrollment_required' && admission === null && embeddedWallets(user).length > 0) {
      return { ok: false, status: 'account_locked', reason: 'wallet_without_authenticator' };
    }
    return factors;
  }

  const embedded = embeddedWallets(user);
  // [H2] Enrolled, no wallet yet: a named state, never a lockout.
  if (embedded.length === 0) return { ok: false, status: 'wallet_required', reason: 'no_wallet' };
  if (embedded.length !== 1) return { ok: false, status: 'account_locked', reason: 'several_embedded_wallets' };
  const linked = embedded[0];
  if (linked.chain_type !== 'ethereum') return { ok: false, status: 'account_locked', reason: 'non_ethereum_wallet' };
  if (typeof linked.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(linked.address)) {
    return { ok: false, status: 'account_locked', reason: 'bad_wallet_address' };
  }
  const address = linked.address.toLowerCase();
  // [G3] A null id leaves no resource to check: refused, as in the config check.
  if (!linked.id) return { ok: false, status: 'account_locked', reason: 'wallet_without_id' };
  if (linked.imported === true) return { ok: false, status: 'account_locked', reason: 'imported_wallet' };
  // [B4] A wallet another key can sign for is not the owner's alone.
  if (linked.delegated === true) return { ok: false, status: 'account_locked', reason: 'delegated_wallet' };

  if (!wallet || wallet.id !== linked.id || wallet.address.toLowerCase() !== address) {
    return { ok: false, status: 'account_locked', reason: 'wallet_resource_mismatch' };
  }
  if (wallet.imported_at !== null) return { ok: false, status: 'account_locked', reason: 'imported_wallet' };
  if (wallet.additional_signers.length > 0) return { ok: false, status: 'account_locked', reason: 'additional_signers' };

  let totpVerifiedAt: number;
  if (admission === null) {
    // First admission ([C5], [D2]): the wallet must have been created after the authenticator existed. Proven by the
    // server's enrollment checkpoint, NOT by comparing Privy's timestamps: the live test (2026-10-07) found Privy
    // re-stamps the authenticator's verified_at about a second after the wallet is created, so the two times cannot
    // order the events. A checkpoint is written only while no embedded wallet existed, so the one wallet here was
    // created after it; an inbox-only attacker's wallet made before the owner enrolled prevents the checkpoint.
    if (checkpoint === null) return { ok: false, status: 'account_locked', reason: 'no_enrollment_checkpoint' };
    totpVerifiedAt = checkpoint.totpVerifiedAt;
  } else {
    // [G1] The order rule bound once, at first admission. Later sign-ins need the SAME wallet and an authenticator
    // present now (judgeFactors); a re-enrolled authenticator does not re-run the order check.
    if (admission.wallet !== address) return { ok: false, status: 'account_locked', reason: 'wallet_changed' };
    totpVerifiedAt = admission.totpVerifiedAt;
  }

  // [F1] An export is the owner's only if it happened after the authenticator existed (it then needed the factor).
  // exported_at is milliseconds, verified_at seconds; an export at exactly the enrollment second is refused.
  if (wallet.exported_at !== null && !(wallet.exported_at > totpVerifiedAt * 1000)) {
    return { ok: false, status: 'account_locked', reason: 'exported_before_totp' };
  }

  return { ok: true, wallet: address, walletId: linked.id, totpVerifiedAt, exportedAtMs: wallet.exported_at };
}
