// ----------------------------------------------------------------------------
// verify-mako-release.mts  (`pnpm verify:mako-release`)
//
// Proves every reviewed Mako pools deployment in src/lib/mako-release-record.ts against the chain itself (naming
// plan r8 §7.10e). Read-only: no key, no transaction, and the RPC URL is never printed. For each record it prints
// each measured value and checks:
//   1. eth_chainId of the RPC equals the record's chainId;
//   2. the receipt of deployTx has status success, contractAddress equal to address and blockNumber equal to
//      deployBlock;
//   3. keccak256(eth_getCode(address)) equals runtimeCodeHash.
// Exit code 1 on any mismatch or failed read.
//
// Run it whenever a record is written or changed (the author, then the reviewer), and before each production promote
// (.claude/design/RELEASE_RUNBOOK.md section E). Never at app startup and never in CI: both stay free of network
// calls. A new record's runtimeCodeHash is measured here: write the printed hash into the record, run it again, and
// cross-check it once with `cast keccak "$(cast code <address> --rpc-url <rpc>)"`.
//
// RPC: MONAD_RPC_URL if set in the shell, else the chain default (src/lib/chain.ts).
// ----------------------------------------------------------------------------

// src/ loads as CommonJS under tsx, so values come through require() (see check-safe-derivation.mts and
// src/lib/__tests__/scripts-esm-imports.test.ts); the type-only imports keep them checked.
import { createRequire } from 'node:module';
import { createPublicClient, getAddress, http, keccak256, type Hex } from 'viem';
import type * as ChainModule from '../src/lib/chain';
import type * as RecordModule from '../src/lib/mako-release-record';

const require = createRequire(import.meta.url);
const { monadTestnet } = require('../src/lib/chain') as typeof ChainModule;
const { MAKO_RELEASES } = require('../src/lib/mako-release-record') as typeof RecordModule;

const rpcUrl = process.env.MONAD_RPC_URL?.trim() || monadTestnet.rpcUrls.default.http[0];
const rpcLabel = process.env.MONAD_RPC_URL?.trim() ? 'MONAD_RPC_URL (not printed)' : rpcUrl;

async function main(): Promise<number> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  let failed = 0;
  const check = (label: string, measured: string, expected: string) => {
    const ok = measured === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: measured ${measured}${ok ? '' : `, record says ${expected}`}`);
  };

  console.log(`RPC: ${rpcLabel}`);
  const chainId = await client.getChainId();
  for (const r of MAKO_RELEASES) {
    console.log(`\n${r.address} (chain ${r.chainId}, source commit ${r.sourceCommit}, not machine-checked)`);
    check('eth_chainId', String(chainId), String(r.chainId));
    check('address is its own EIP-55 form', getAddress(r.address), r.address);
    const receipt = await client.getTransactionReceipt({ hash: r.deployTx });
    check('deployTx status', receipt.status, 'success');
    check('deployTx contractAddress', receipt.contractAddress ? getAddress(receipt.contractAddress) : 'none', r.address);
    check('deployTx blockNumber', receipt.blockNumber.toString(), String(r.deployBlock));
    const code = (await client.getCode({ address: r.address })) as Hex | undefined;
    check('keccak256(eth_getCode)', code && code !== '0x' ? keccak256(code) : 'no code', r.runtimeCodeHash);
  }
  console.log(failed === 0 ? `\nPASS: ${MAKO_RELEASES.length} record(s) match the chain.` : `\nFAIL: ${failed} check(s) did not match.`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A failed read is a failure; only the error's type and message are printed, never the RPC URL itself.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`FAIL: a read failed. ${msg.split(rpcUrl).join('<rpc>')}`);
    process.exit(1);
  },
);
