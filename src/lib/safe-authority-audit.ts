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
