// Supported wallets: known code only (plan 4.6). Today exactly one shape, the Mako email Safe. Everything here is
// read with eth_getCode and eth_getStorageAt, never through the wallet's own functions: a changed singleton could
// answer for itself.
import { keccak256, toBytes, type Hex } from 'viem';

/// keccak256 of the runtime code of a Safe v1.4.1 proxy as the factory deploys it. Derived, not typed in: the
/// proxy at the order-abi.json `safeTaker` address was created by the real factory (data/safe-v1.4.1/
/// SafeProxyFactory.hex) on a local node with the real singleton, eth_getCode of it is
/// data/safe-v1.4.1/SafeProxy.runtime.hex, and this is its hash (test/wallets.test.ts re-computes it from that
/// file and checks the file is part of the factory's code).
export const SAFE_PROXY_CODE_HASH: Hex = '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c';
/// Safe v1.4.1 singleton, plan 4.6; the proxy's storage slot 0.
export const SAFE_SINGLETON: Hex = '0x41675c099f32341bf84bfc5382af534df5c7461a';
/// Safe4337Module v0.3.0 as the fallback handler, plan 4.6.
export const SAFE_4337_MODULE: Hex = '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226';
/// The factory plan 4.6 names.
export const SAFE_FACTORY: Hex = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
/// Safe's `FALLBACK_HANDLER_STORAGE_SLOT`: keccak256("fallback_manager.handler.address").
export const FALLBACK_HANDLER_SLOT: Hex = keccak256(toBytes('fallback_manager.handler.address'));

export type CodeKind = 'none' | 'delegation' | 'contract';

/// EIP-7702: an account whose code starts 0xef0100 is an EOA with a delegation; plain signatures still work for it
/// (plan 4.6). EIP-3541 forbids a deployed contract from starting with 0xef, so the prefix alone is enough.
export function classifyCode(code: string): CodeKind {
  const c = code.toLowerCase();
  if (c === '0x' || c === '') return 'none';
  if (c.startsWith('0xef0100')) return 'delegation';
  return 'contract';
}

const word = (addr: Hex) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;

export function isSupportedSafe(code: string, singletonSlot: string, handlerSlot: string): boolean {
  if (classifyCode(code) !== 'contract') return false;
  if (keccak256(code as Hex) !== SAFE_PROXY_CODE_HASH) return false;
  return singletonSlot.toLowerCase() === word(SAFE_SINGLETON) && handlerSlot.toLowerCase() === word(SAFE_4337_MODULE);
}
