// ----------------------------------------------------------------------------
// src/lib/safe-authority-audit.ts
//
// Release gate (INBOX_GAP_PLAN r18 [M4], [C1]): authenticator protection on the Safe's owner protects nothing if the
// Safe has another way in. For a funded email-account Safe, the expected authority is exactly: one owner, equal to the
// account's recorded embedded wallet; threshold 1; exactly the Safe4337 module; no guard; the Safe4337 module as the
// fallback handler; the Safe v1.4.1 singleton. Pure: scripts/pre-beta-audit.ts reads the chain and prints this.
// ----------------------------------------------------------------------------

import { SAFE_CONFIG } from '@/lib/safe-config';

/// keccak256("guard_manager.guard.address") and keccak256("fallback_manager.handler.address"): Safe v1.4.1's storage
/// slots for the guard and the fallback handler. The singleton is storage slot 0.
export const SAFE_GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
export const SAFE_FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';

export interface SafeAuthority {
  owners: readonly string[];
  threshold: bigint;
  /// From getModulesPaginated(SENTINEL, 10).
  modules: readonly string[];
  /// The next page cursor from that call: anything but the sentinel means more than 10 modules.
  modulesNext: string;
  /// Storage words, as 32-byte hex.
  guardSlot: string;
  fallbackSlot: string;
  singletonSlot: string;
}

const SENTINEL = '0x0000000000000000000000000000000000000001';
const word = (addr: string) => `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const lc = (a: string) => a.toLowerCase();

export function judgeSafeAuthority(a: SafeAuthority, expectedOwner: string): string[] {
  const f: string[] = [];
  if (a.owners.length !== 1 || lc(a.owners[0]) !== lc(expectedOwner)) f.push(`owners are [${a.owners.join(', ')}], expected exactly [${expectedOwner}]`);
  if (a.threshold !== 1n) f.push(`threshold is ${a.threshold}, expected 1`);
  if (a.modules.length !== 1 || lc(a.modules[0]) !== lc(SAFE_CONFIG.module4337) || lc(a.modulesNext) !== SENTINEL) {
    f.push(`modules are [${a.modules.join(', ')}]${lc(a.modulesNext) !== SENTINEL ? ' and more' : ''}, expected exactly the Safe4337 module ${SAFE_CONFIG.module4337}`);
  }
  if (BigInt(a.guardSlot) !== 0n) f.push(`a guard is set (${a.guardSlot}), expected none`);
  if (lc(a.fallbackSlot) !== word(SAFE_CONFIG.module4337)) f.push(`fallback handler is ${a.fallbackSlot}, expected the Safe4337 module`);
  if (lc(a.singletonSlot) !== word(SAFE_CONFIG.singleton)) f.push(`singleton is ${a.singletonSlot}, expected Safe v1.4.1 ${SAFE_CONFIG.singleton}`);
  return f;
}

/// One email (Magic-era) account as the pre-beta audit reads it: every `auth_type = 'magic'` user, with its Monad
/// registry row if there is one (LEFT JOIN, Codex release-gates F2).
export interface EmailAccountRow {
  id: string;
  email: string | null;
  magic_eoa: string | null;
  privy_user_id: string | null;
  privy_totp_admitted_at: string | null;
  /// The `user_safes` row for Monad, or null when the account has none.
  safe_address: string | null;
}

/// What the audit reads for one account, and what already blocks before any chain read.
export interface AuditTarget {
  row: EmailAccountRow;
  /// The Safe whose balance and authority are audited: the one the signer derives to (the address the app itself
  /// uses, src/app/api/user/auth/route.ts), else the registry's. Null when the account has neither.
  safe: string | null;
  /// The Safe the signer derives to, when there is a signer.
  derived: string | null;
  blockers: string[];
}

/// The registry is not the authority for the address: the app derives the Safe from `magic_eoa` and writes the registry
/// row opportunistically after sign-in. So every email account is audited at its derived Safe, a registry row that
/// disagrees with it blocks, and an account with no registry row is audited all the same (Codex release-gates F2).
export function planEmailAccountAudit(rows: readonly EmailAccountRow[], derive: (eoa: string) => string): AuditTarget[] {
  return rows.map((row) => {
    const derived = row.magic_eoa ? derive(row.magic_eoa) : null;
    const blockers: string[] = [];
    if (derived && row.safe_address && lc(derived) !== lc(row.safe_address)) {
      blockers.push(`registry Safe ${row.safe_address} differs from the Safe its signer derives to, ${derived}`);
    }
    return { row, safe: derived ?? row.safe_address, derived, blockers };
  });
}

/// The balance verdict for one account: funded and linked to Privy without a gate admission blocks; funded with no
/// registry row blocks (the app would show and use a Safe nothing recorded). Returns the blockers, and whether the
/// account belongs on the old-balance notice list (funded, still a Magic-era account).
export function judgeFundedAccount(t: AuditTarget, balance: bigint): { blockers: string[]; magicFunded: boolean } {
  const blockers: string[] = [];
  const funded = balance > 0n;
  if (funded && t.row.privy_user_id && t.row.privy_totp_admitted_at === null) blockers.push(`linked to Privy, funded (${balance}), not admitted under the gate`);
  if (funded && t.row.safe_address === null) blockers.push(`funded (${balance}) with no user_safes row for its Safe`);
  return { blockers, magicFunded: funded && !t.row.privy_user_id };
}
