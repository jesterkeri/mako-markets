// ----------------------------------------------------------------------------
// src/lib/safe.ts
//
// Safe derivation + deploy-intent helpers for the Magic-owned Safe model.
//
// `deriveSafeAddress(eoa)` returns the address the user's Safe will have —
// before it's deployed, after it's deployed, on Monad, on Base. Same value
// everywhere, courtesy of Path X (see `safe-config.ts` and
// `docs/safe-address-decision.md`).
//
// The math mirrors SafeProxyFactory v1.4.1's `createProxyWithNonce`:
//   salt     = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
//   initCode = proxyCreationCode ++ abi.encode(singleton)
//   addr     = CREATE2(factory, salt, keccak256(initCode))
//
// The `proxyCreationCode` constant is the output of SafeProxyFactory v1.4.1's
// `proxyCreationCode()` view. It's pinned here so derivation doesn't require
// an RPC round-trip on every call; `verify-safe-addresses.ts` independently
// fetches it from both chains and confirms it matches this constant.
// ----------------------------------------------------------------------------

import {
  keccak256,
  encodeFunctionData,
  encodeAbiParameters,
  concat,
  getAddress,
  toHex,
  type Hex,
  type Address,
} from 'viem';
import { SAFE_CONFIG } from './safe-config';

// SafeProxy v1.4.1 creation code. Source of truth: call
// SafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67).proxyCreationCode()
// on Monad testnet, Base Sepolia, or any chain with canonical Safe deployments.
// Verified byte-identical across Monad testnet + Base Sepolia by
// scripts/verify-safe-addresses.ts on 2026-04-24.
const SAFE_PROXY_CREATION_CODE: Hex =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const SAFE_SETUP_ABI = [
  {
    name: 'setup',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const SAFE_MODULE_SETUP_ABI = [
  {
    name: 'enableModules',
    inputs: [{ name: 'modules', type: 'address[]' }],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/// Calldata passed to the proxy's initial `setup()` call. This is the
/// **production** initializer — any change here (even whitespace in the ABI
/// definitions above) rotates every user's Safe address, orphaning
/// already-deployed Safes from their owners. Treat this function as frozen
/// once Safes start deploying.
///
/// Shape (matches @safe-global/safe-4337 reference setup flow):
/// - owners: [magicEOA], threshold 1 (MVP recovery model)
/// - to + data: delegatecall into SafeModuleSetup.enableModules([module4337])
///   so the 4337 module is active in the same transaction as Safe creation.
///   Without this, the first user op would need a pre-funded EOA to pay gas
///   to enable the module, defeating the sponsored-onboarding UX.
/// - fallbackHandler: **Safe4337Module itself**. The 4337 module serves two
///   distinct roles — as a module (authorized by enableModules above) it can
///   call execTransactionFromModule; as the fallback handler it receives
///   EntryPoint calls to validateUserOp / executeUserOp that aren't in the
///   Safe's own ABI. Setting CompatibilityFallbackHandler here would break
///   4337 validation because the EntryPoint would hit "function selector not
///   found" on every user op.
/// - no setup-time payment (paymentToken, payment, paymentReceiver all zero)
function buildSetupCalldata(eoa: Address): Hex {
  const enableModulesCall = encodeFunctionData({
    abi: SAFE_MODULE_SETUP_ABI,
    functionName: 'enableModules',
    args: [[SAFE_CONFIG.module4337 as Address]],
  });

  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      [eoa],
      1n,
      SAFE_CONFIG.moduleSetup as Address,
      enableModulesCall,
      SAFE_CONFIG.module4337 as Address, // fallbackHandler = 4337 module (see above)
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}

/// keccak256(abi.encodePacked(eoa, saltDomain)) — deterministic per EOA.
/// Folding the salt domain in prevents Mako Safes from colliding with Safes
/// some other app might derive for the same EOA.
function buildSaltNonce(eoa: Address): Hex {
  return keccak256(concat([eoa, toHex(SAFE_CONFIG.saltDomain)]));
}

/**
 * Pure CREATE2 derivation, parameterized on `proxyCreationCode`. Exists so
 * the Path-X verify script can feed in the code it fetched from RPC (rather
 * than the hardcoded constant), and then assert the result matches what
 * `deriveSafeAddress` computes with the hardcoded value. Any drift between
 * the two surfaces is the signal that our constant has gone stale.
 */
export function computeSafeAddressFromProxyCreationCode(
  eoa: Address,
  proxyCreationCode: Hex,
): Address {
  const setupCalldata = buildSetupCalldata(eoa);
  const saltNonce = buildSaltNonce(eoa);

  const initializerHash = keccak256(setupCalldata);
  const salt = keccak256(concat([initializerHash, saltNonce]));

  const singletonEncoded = encodeAbiParameters(
    [{ type: 'uint256' }],
    [BigInt(SAFE_CONFIG.singleton)],
  );
  const initCode = concat([proxyCreationCode, singletonEncoded]);
  const initCodeHash = keccak256(initCode);

  const preimage = concat([
    '0xff',
    SAFE_CONFIG.proxyFactory as Address,
    salt,
    initCodeHash,
  ]);
  const hash = keccak256(preimage);
  return getAddress(`0x${hash.slice(26)}`);
}

/**
 * Deterministically compute the Safe address for a given Magic EOA. Identical
 * on every chain thanks to Path X — no chainId parameter on purpose.
 *
 * This is a *pure* function: no RPC, no network, no state. Safe to call at
 * render time.
 */
export function deriveSafeAddress(eoa: Address): Address {
  return computeSafeAddressFromProxyCreationCode(eoa, SAFE_PROXY_CREATION_CODE);
}

/**
 * The init-code (calldata + salt nonce) that the SafeProxyFactory needs when
 * actually deploying the proxy on chain. Returned separately from
 * `deriveSafeAddress` because the deployment path needs these; plain UI
 * doesn't.
 */
export function buildSafeInitialization(eoa: Address): {
  setupCalldata: Hex;
  saltNonce: Hex;
} {
  return {
    setupCalldata: buildSetupCalldata(eoa),
    saltNonce: buildSaltNonce(eoa),
  };
}
