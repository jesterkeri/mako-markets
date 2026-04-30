#!/usr/bin/env tsx
// ────────────────────────────────────────────────────────────────────────────
// scripts/probe-pimlico.mts — Phase 1B BLOCKING capability probe
//
// Verifies Pimlico actually supports the chain we need (Monad testnet, 10143)
// with EntryPoint v0.7 BEFORE we sink time into the rest of Phase 1B. If any
// of the six probes fail, STOP and escalate — with Base cut from 1B there is
// no fallback reference chain.
//
// Pure viem + a throwaway secp256k1 key. NO Magic dependency on purpose: this
// probes Pimlico-the-protocol, not the production signing path. The production
// path (Magic personal_sign + safeV = v + 4) lives in src/lib/user-op.ts when
// 1B implementation lands.
//
// Six probes, in order:
//   1. eth_supportedEntryPoints           → must include EntryPoint v0.7
//   2. pimlico_getUserOperationGasPrice    → must return non-zero fees
//   3. eth_estimateUserOperationGas        → bundler estimation works
//   4. pm_sponsorUserOperation             → paymaster sponsors with estimated gas
//   5. eth_sendUserOperation               → bundler accepts the signed op
//   6. eth_getUserOperationReceipt         → on-chain execution succeeded
//
// Probe userOp targets `USDC.transfer(safeAddress, 0n)` wrapped in
// `Safe.executeUserOp`. Zero amount on purpose: the throwaway Safe is unfunded
// (fresh key per run), so a non-zero transfer would simulate-revert and confuse
// the failure mode of probe 5/6. The dev smoke surface (`/dev/aa-smoke`) will
// use `1n` against a Circle-faucet-funded Safe to prove the funded path
// separately. The Phase 1B sponsor-route allowlist accepts both.
//
// Usage:
//   pnpm probe:pimlico 10143
//
// Required in .env.local:
//   PIMLICO_API_KEY_MONAD   (preferred; matches existing convention)
//     — or fallback —
//   PIMLICO_API_KEY         (used if MONAD-specific not present)
// ────────────────────────────────────────────────────────────────────────────

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import {
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  concat,
  pad,
  toHex,
  hexToBigInt,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey, sign } from 'viem/accounts';

import { SAFE_CONFIG } from '../src/lib/safe-config';
import { deriveSafeAddress, buildSafeInitialization } from '../src/lib/safe';

// ── constants ───────────────────────────────────────────────────────────────

const SUPPORTED_CHAIN_ID = 10143; // Monad testnet only — see plan, Base is cut from 1B

const ENTRY_POINT_V07: Address = SAFE_CONFIG.entryPoint as Address;
const SAFE_PROXY_FACTORY: Address = SAFE_CONFIG.proxyFactory as Address;
const SAFE_SINGLETON: Address = SAFE_CONFIG.singleton as Address;
const SAFE_4337_MODULE: Address = SAFE_CONFIG.module4337 as Address;

// USDC on Monad testnet — non-zero target for the probe userOp callData.
// transfer(self, 0) is a valid ERC-20 op that costs no value semantically.
const USDC_MONAD_TESTNET: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';

// SafeOp validity window: 0 → max uint48 means "always valid" for the probe.
const VALIDITY_WINDOW_MAX_UINT48 = 0xFFFFFFFFFFFFn;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// Receipt poll: bundler may take a few seconds to land + index the userOp.
const RECEIPT_POLL_INTERVAL_MS = 3000;
const RECEIPT_POLL_TIMEOUT_MS = 90_000;

// ── ABI snippets ────────────────────────────────────────────────────────────

const SAFE_PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const SAFE_4337_MODULE_ABI = [
  {
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ── helpers ─────────────────────────────────────────────────────────────────

/// Pack the v0.7 paymaster fields into the on-chain paymasterAndData layout.
/// Layout: paymaster (20) || pmVerGasLimit (16 BE) || pmPostOpGasLimit (16 BE) || pmData
function packPaymasterAndData(args: {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
}): Hex {
  return concat([
    args.paymaster,
    pad(toHex(args.paymasterVerificationGasLimit), { size: 16 }),
    pad(toHex(args.paymasterPostOpGasLimit), { size: 16 }),
    args.paymasterData,
  ]) as Hex;
}

/// Big-endian 6-byte encoding of a uint48 with overflow assertion.
/// Mirrors the production helper that will live in src/lib/encoding.ts.
function uint48ToBytes6BE(value: bigint): Hex {
  if (value < 0n) throw new Error('uint48ToBytes6BE: negative value');
  if (value > 0xFFFFFFFFFFFFn)
    throw new Error('uint48ToBytes6BE: value exceeds 2^48 - 1');
  return pad(toHex(value), { size: 6 }) as Hex;
}

/// EntryPoint v0.7 PackedUserOperation, excluding the signature. Used for the
/// SafeOp EIP-712 hash and (in split form) for bundler RPC.
type PackedUserOpFields = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
};

/// Compute the Safe4337Module v0.3.0 SafeOp hash — the digest the Safe
/// signs over. Mirrors Safe4337Module._getOperationHash exactly.
///
/// Type:
///   SafeOp(
///     address safe, uint256 nonce, bytes initCode, bytes callData,
///     uint128 verificationGasLimit, uint128 callGasLimit, uint256 preVerificationGas,
///     uint128 maxPriorityFeePerGas, uint128 maxFeePerGas, bytes paymasterAndData,
///     uint48 validAfter, uint48 validUntil, address entryPoint
///   )
function computeSafeOpHash(args: {
  userOp: PackedUserOpFields;
  validAfter: bigint;
  validUntil: bigint;
  chainId: number;
}): Hex {
  const SAFE_OP_TYPEHASH = keccak256(
    new TextEncoder().encode(
      'SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)',
    ),
  );

  const DOMAIN_TYPEHASH = keccak256(
    new TextEncoder().encode(
      'EIP712Domain(uint256 chainId,address verifyingContract)',
    ),
  );

  const paymasterAndData = packPaymasterAndData({
    paymaster: args.userOp.paymaster,
    paymasterVerificationGasLimit: args.userOp.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: args.userOp.paymasterPostOpGasLimit,
    paymasterData: args.userOp.paymasterData,
  });

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'uint256' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bytes32' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'address' },
      ],
      [
        SAFE_OP_TYPEHASH,
        args.userOp.sender,
        args.userOp.nonce,
        keccak256(args.userOp.initCode),
        keccak256(args.userOp.callData),
        args.userOp.verificationGasLimit,
        args.userOp.callGasLimit,
        args.userOp.preVerificationGas,
        args.userOp.maxPriorityFeePerGas,
        args.userOp.maxFeePerGas,
        keccak256(paymasterAndData),
        args.validAfter,
        args.validUntil,
        ENTRY_POINT_V07,
      ],
    ),
  );

  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, BigInt(args.chainId), SAFE_4337_MODULE],
    ),
  );

  return keccak256(
    encodePacked(
      ['bytes2', 'bytes32', 'bytes32'],
      ['0x1901', domainSeparator, structHash],
    ),
  );
}

/// Build the v0.7 SPLIT-form RPC payload userOp. Optional fields (factory,
/// factoryData, paymaster*) are OMITTED entirely when absent, never included
/// as null — strict bundlers (and ERC-7769) reject `null` for absent fields.
function toRpcUserOp(args: {
  userOp: PackedUserOpFields;
  factory: Address | null;
  factoryData: Hex | null;
  signature: Hex;
}): Record<string, string> {
  const out: Record<string, string> = {
    sender: args.userOp.sender,
    nonce: toHex(args.userOp.nonce),
    callData: args.userOp.callData,
    callGasLimit: toHex(args.userOp.callGasLimit),
    verificationGasLimit: toHex(args.userOp.verificationGasLimit),
    preVerificationGas: toHex(args.userOp.preVerificationGas),
    maxFeePerGas: toHex(args.userOp.maxFeePerGas),
    maxPriorityFeePerGas: toHex(args.userOp.maxPriorityFeePerGas),
    signature: args.signature,
  };

  if (args.factory && args.factoryData) {
    out.factory = args.factory;
    out.factoryData = args.factoryData;
  }

  if (args.userOp.paymaster !== ZERO_ADDRESS) {
    out.paymaster = args.userOp.paymaster;
    out.paymasterVerificationGasLimit = toHex(
      args.userOp.paymasterVerificationGasLimit,
    );
    out.paymasterPostOpGasLimit = toHex(args.userOp.paymasterPostOpGasLimit);
    out.paymasterData = args.userOp.paymasterData;
  }

  return out;
}

/// Classify common Pimlico/bundler error responses into a short tag so the
/// failure-mode tail of the log clearly distinguishes "Pimlico unsupported"
/// from "setup mistake."
function classifyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('invalid api key') || lower.includes('unauthorized'))
    return 'AUTH (api key invalid or missing)';
  if (lower.includes('429') || lower.includes('rate limit'))
    return 'RATE-LIMIT';
  if (lower.includes('chain') && (lower.includes('not supported') || lower.includes('unsupported')))
    return 'CHAIN-UNSUPPORTED (Pimlico does not support this chain — STOP, escalate)';
  if (lower.includes('paymaster') && (lower.includes('balance') || lower.includes('funds')))
    return 'PAYMASTER-EMPTY (gas tank empty — fund Pimlico)';
  // Specific AA codes ordered before the generic regex match.
  if (lower.includes('aa24') || lower.includes('signature error'))
    return 'SIG-VALIDATION (Safe signature math is wrong, or module address mismatch)';
  if (/aa\d+/.test(lower) || lower.includes('reverted'))
    return 'SIMULATION-REVERT (userOp simulation failed — check callData / nonce / gas)';
  return 'UNKNOWN';
}

/// Minimal JSON-RPC client — no SDK so we surface every Pimlico response shape
/// directly, including error bodies (which are the whole point of a probe).
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let body: { result?: T; error?: { code: number; message: string; data?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (body.error) {
    const detail = body.error.data ? ` — ${JSON.stringify(body.error.data).slice(0, 400)}` : '';
    throw new Error(`${method}: ${body.error.code} ${body.error.message}${detail}`);
  }
  if (body.result === undefined)
    throw new Error(`${method}: missing result in response`);
  return body.result;
}

/// Poll eth_getUserOperationReceipt until it resolves with `success` true,
/// times out, or returns an explicit failure receipt.
async function pollUserOpReceipt(
  url: string,
  userOpHash: Hex,
): Promise<{ success: boolean; transactionHash: Hex; receipt: unknown }> {
  const start = Date.now();
  while (Date.now() - start < RECEIPT_POLL_TIMEOUT_MS) {
    const result = await rpc<null | {
      success: boolean;
      receipt: { transactionHash: Hex };
    }>(url, 'eth_getUserOperationReceipt', [userOpHash]);
    if (result !== null) {
      return {
        success: result.success,
        transactionHash: result.receipt.transactionHash,
        receipt: result,
      };
    }
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `eth_getUserOperationReceipt: timed out after ${RECEIPT_POLL_TIMEOUT_MS / 1000}s waiting for ${userOpHash}`,
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── 0. parse args + env ──────────────────────────────────────────────────
  const chainIdArg = process.argv[2];
  if (!chainIdArg) {
    console.error('usage: pnpm probe:pimlico <chainId>');
    console.error(`  e.g.  pnpm probe:pimlico ${SUPPORTED_CHAIN_ID}`);
    process.exit(2);
  }
  const chainId = Number(chainIdArg);
  if (!Number.isFinite(chainId) || chainId !== SUPPORTED_CHAIN_ID) {
    console.error(
      `invalid chainId: ${chainIdArg}. This probe is hard-pinned to chain ${SUPPORTED_CHAIN_ID} (Monad testnet) — Base is cut from 1B.`,
    );
    process.exit(2);
  }

  const apiKey =
    process.env.PIMLICO_API_KEY_MONAD ||
    process.env.PIMLICO_API_KEY ||
    '';
  if (!apiKey) {
    console.error(
      'missing PIMLICO_API_KEY_MONAD (or PIMLICO_API_KEY) in .env.local',
    );
    process.exit(2);
  }

  const monadRpc =
    process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz/';

  const bundlerUrl = `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}`;

  // Throwaway key — fresh on every run so we never reuse a deployed Safe.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const eoa = account.address;
  const safeAddress = deriveSafeAddress(eoa);

  console.log('────────────────────────────────────────────────────────────');
  console.log('Pimlico capability probe — chainId', chainId);
  console.log('  bundler:     https://api.pimlico.io/v2/' + chainId + '/rpc');
  console.log('  monad rpc:   ' + monadRpc);
  console.log('  throwaway eoa:    ' + eoa);
  console.log('  derived safe:     ' + safeAddress);
  console.log('────────────────────────────────────────────────────────────');

  // ── probe 1: eth_supportedEntryPoints ─────────────────────────────────────
  console.log('\n[1/6] eth_supportedEntryPoints');
  const supported = await rpc<Address[]>(bundlerUrl, 'eth_supportedEntryPoints', []);
  const supportedNorm = supported.map((s) => getAddress(s));
  const v07Norm = getAddress(ENTRY_POINT_V07);
  if (!supportedNorm.includes(v07Norm)) {
    console.error(
      `  FAIL: EntryPoint v0.7 ${ENTRY_POINT_V07} not in supported list:\n  ${supported.join(
        '\n  ',
      )}`,
    );
    process.exit(1);
  }
  console.log('  OK — EntryPoint v0.7 supported');

  // ── probe 2: pimlico_getUserOperationGasPrice ─────────────────────────────
  console.log('\n[2/6] pimlico_getUserOperationGasPrice');
  type GasPriceTier = { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  const gasPrice = await rpc<{ slow: GasPriceTier; standard: GasPriceTier; fast: GasPriceTier }>(
    bundlerUrl,
    'pimlico_getUserOperationGasPrice',
    [],
  );
  const standardMaxFee = hexToBigInt(gasPrice.standard.maxFeePerGas);
  const standardPriority = hexToBigInt(gasPrice.standard.maxPriorityFeePerGas);
  if (standardMaxFee === 0n || standardPriority === 0n) {
    console.error('  FAIL: standard tier returned zero gas price');
    console.error('  ' + JSON.stringify(gasPrice));
    process.exit(1);
  }
  console.log(
    '  OK — standard maxFeePerGas=' +
      standardMaxFee +
      ' maxPriorityFeePerGas=' +
      standardPriority,
  );

  // ── build the userOp scaffold (same body across probes 3 → 6) ─────────────
  // initCode = factoryAddress (20 bytes) || createProxyWithNonce(singleton, setupCalldata, saltNonce)
  // callData = Safe.executeUserOp(USDC, 0, transfer(self, 0), 0)

  const { setupCalldata, saltNonce } = buildSafeInitialization(eoa);
  const factoryCallData = encodeFunctionData({
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_SINGLETON, setupCalldata, hexToBigInt(saltNonce)],
  });
  const initCode = concat([SAFE_PROXY_FACTORY, factoryCallData]) as Hex;

  const innerTransferCalldata = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [safeAddress, 0n],
  });

  const wrapperCalldata = encodeFunctionData({
    abi: SAFE_4337_MODULE_ABI,
    functionName: 'executeUserOp',
    args: [USDC_MONAD_TESTNET, 0n, innerTransferCalldata, 0],
  });

  // Nonce: 0 for a freshly-derived Safe. EntryPoint.getNonce would return 0
  // for any sender that's never been used, including pre-deploy Safes.
  const nonce = 0n;

  // Dummy 65-byte signature for estimation/sponsorship calls. Pimlico accepts
  // a placeholder of the right LENGTH for sig-validation simulation.
  const DUMMY_SIG: Hex =
    ('0x' +
      '00'.repeat(12) + // validAfter (6) + validUntil (6)
      'ff'.repeat(65)) as Hex;

  // ── shared base userOp (no gas, no paymaster — sponsor fills both) ────────
  const baseUserOp: PackedUserOpFields = {
    sender: safeAddress,
    nonce,
    initCode,
    callData: wrapperCalldata,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: standardMaxFee,
    maxPriorityFeePerGas: standardPriority,
    paymaster: ZERO_ADDRESS,
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: '0x',
  };

  // ── probe 3: pm_sponsorUserOperation ──────────────────────────────────────
  // Run sponsor BEFORE estimate. Reason: Monad testnet's bundler runs prefund
  // simulation during eth_estimateUserOperationGas, and the throwaway Safe has
  // 0 MON, so a no-paymaster estimate fails AA21. Sponsor returns paymaster
  // fields AND gas estimates in one call; we then run a standalone estimate
  // (probe 4) with sponsor's paymaster filled in as a sanity check.
  console.log('\n[3/6] pm_sponsorUserOperation');
  type SponsorResult = {
    paymaster: Address;
    paymasterVerificationGasLimit: Hex;
    paymasterPostOpGasLimit: Hex;
    paymasterData: Hex;
    callGasLimit?: Hex;
    verificationGasLimit?: Hex;
    preVerificationGas?: Hex;
  };
  const sponsor = await rpc<SponsorResult>(bundlerUrl, 'pm_sponsorUserOperation', [
    toRpcUserOp({
      userOp: baseUserOp,
      factory: SAFE_PROXY_FACTORY,
      factoryData: factoryCallData,
      signature: DUMMY_SIG,
    }),
    ENTRY_POINT_V07,
  ]);
  if (!sponsor.paymaster || sponsor.paymaster === ZERO_ADDRESS) {
    console.error('  FAIL: sponsor returned no paymaster: ' + JSON.stringify(sponsor));
    process.exit(1);
  }
  console.log('  OK — paymaster=' + sponsor.paymaster);

  // ── probe 4: eth_estimateUserOperationGas (with sponsor's paymaster) ──────
  console.log('\n[4/6] eth_estimateUserOperationGas');
  const estimateInput: PackedUserOpFields = {
    ...baseUserOp,
    paymaster: getAddress(sponsor.paymaster),
    paymasterVerificationGasLimit: hexToBigInt(sponsor.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: hexToBigInt(sponsor.paymasterPostOpGasLimit),
    paymasterData: sponsor.paymasterData,
  };

  const estimate = await rpc<{
    callGasLimit: Hex;
    verificationGasLimit: Hex;
    preVerificationGas: Hex;
  }>(bundlerUrl, 'eth_estimateUserOperationGas', [
    toRpcUserOp({
      userOp: estimateInput,
      factory: SAFE_PROXY_FACTORY,
      factoryData: factoryCallData,
      signature: DUMMY_SIG,
    }),
    ENTRY_POINT_V07,
  ]);

  const estCallGas = hexToBigInt(estimate.callGasLimit);
  const estVerGas = hexToBigInt(estimate.verificationGasLimit);
  const estPreVerGas = hexToBigInt(estimate.preVerificationGas);
  if (estCallGas === 0n || estVerGas === 0n || estPreVerGas === 0n) {
    console.error('  FAIL: estimate returned zero for one or more limits: ' + JSON.stringify(estimate));
    process.exit(1);
  }
  console.log(
    '  OK — callGasLimit=' + estCallGas +
      ' verificationGasLimit=' + estVerGas +
      ' preVerificationGas=' + estPreVerGas,
  );

  // ── FREEZE — sign exactly the fields sponsor approved ─────────────────────
  // Pimlico may have refined the gas estimates during sponsorship; if so, use
  // sponsor's values (they are authoritative for sig validation). Otherwise
  // fall back to the estimate values.
  const finalUserOp: PackedUserOpFields = {
    sender: safeAddress,
    nonce,
    initCode,
    callData: wrapperCalldata,
    callGasLimit: hexToBigInt(sponsor.callGasLimit ?? toHex(estCallGas)),
    verificationGasLimit: hexToBigInt(
      sponsor.verificationGasLimit ?? toHex(estVerGas),
    ),
    preVerificationGas: hexToBigInt(
      sponsor.preVerificationGas ?? toHex(estPreVerGas),
    ),
    maxFeePerGas: standardMaxFee,
    maxPriorityFeePerGas: standardPriority,
    paymaster: getAddress(sponsor.paymaster),
    paymasterVerificationGasLimit: hexToBigInt(sponsor.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: hexToBigInt(sponsor.paymasterPostOpGasLimit),
    paymasterData: sponsor.paymasterData,
  };

  // ── probe 5: eth_sendUserOperation ────────────────────────────────────────
  console.log('\n[5/6] eth_sendUserOperation');
  const validAfter = 0n;
  const validUntil = VALIDITY_WINDOW_MAX_UINT48;

  const safeOpHash = computeSafeOpHash({
    userOp: finalUserOp,
    validAfter,
    validUntil,
    chainId,
  });

  // Probe path: raw secp256k1 signature over the SafeOp hash directly.
  // Safe accepts v=27/28 as a "direct hash" signature (no eth_sign envelope).
  // The PRODUCTION path will use Magic personal_sign + safeV = v + 4 instead;
  // see the plan for the divergence.
  const rawSig = await sign({ hash: safeOpHash, privateKey });
  const v = Number(rawSig.v ?? (rawSig.yParity === 1 ? 28 : 27));
  if (v !== 27 && v !== 28) {
    throw new Error(`unexpected v from secp256k1 sign: ${v}`);
  }
  const sig65: Hex = concat([rawSig.r, rawSig.s, toHex(v, { size: 1 })]) as Hex;

  // Final signature layout: validAfter (6 BE) || validUntil (6 BE) || r||s||v (65)
  const finalSignature: Hex = concat([
    uint48ToBytes6BE(validAfter),
    uint48ToBytes6BE(validUntil),
    sig65,
  ]) as Hex;

  const userOpHash = await rpc<Hex>(bundlerUrl, 'eth_sendUserOperation', [
    toRpcUserOp({
      userOp: finalUserOp,
      factory: SAFE_PROXY_FACTORY,
      factoryData: factoryCallData,
      signature: finalSignature,
    }),
    ENTRY_POINT_V07,
  ]);
  console.log('  OK — accepted by bundler. userOpHash=' + userOpHash);

  // ── probe 6: eth_getUserOperationReceipt ──────────────────────────────────
  console.log('\n[6/6] eth_getUserOperationReceipt (polling, up to ' + RECEIPT_POLL_TIMEOUT_MS / 1000 + 's)');
  const receipt = await pollUserOpReceipt(bundlerUrl, userOpHash);
  if (!receipt.success) {
    console.error('  FAIL: userOp landed on chain but reverted');
    console.error('  txHash: ' + receipt.transactionHash);
    console.error('  receipt: ' + JSON.stringify(receipt.receipt).slice(0, 500));
    process.exit(1);
  }
  console.log('  OK — txHash=' + receipt.transactionHash);

  // ── done ──────────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('ALL SIX PROBES PASSED — Phase 1B is unblocked on chain ' + chainId);
  console.log('  Safe deployed: ' + safeAddress);
  console.log('  tx: ' + receipt.transactionHash);
  console.log('────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const tag = classifyError(message);
  console.error('\nPROBE FAILED [' + tag + ']');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
