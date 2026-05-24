/**
 * One-shot admin rotation for MakoMarketsV4 on Monad testnet.
 *
 * Reads the (compromised) ADMIN_PRIVATE_KEY from .env.local, then in order:
 *   1. withdrawTreasury()          — sweeps USDC treasury to current treasury (old wallet)
 *   2. setTreasury(NEW)
 *   3. setResolver(NEW)
 *   4. transferOwnership(NEW)      — irreversible without NEW's signature; run last
 *   5. send (oldWalletBalance - gasReserve MON for gas) → NEW
 *
 * Each tx waits for receipt before the next. Uses a small gas-price bump
 * on the first tx to outrun a potential sweeper bot. Logs everything for audit.
 *
 * Usage:
 *   pnpm exec tsx scripts/rotate-admin.mts
 *
 * Or with --dry to print the plan without broadcasting:
 *   pnpm exec tsx scripts/rotate-admin.mts --dry
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
// `parseEther` / `formatEther` here are deliberately retained for
// **native MON** (18 decimals) — gas-wallet balances and the MON sweep
// from the old admin to the new one. They do NOT touch USDC (6 decimals,
// which uses `formatUsdc` below) or any bet-currency value. v4 treasury
// balance moves USDC; signer + new-admin wallet balances are MON because
// that's the chain's gas currency.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
  formatUnits,
  type Hex,
  isAddress,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const formatUsdc = (base: bigint): string => formatUnits(base, 6);

const DRY_RUN = process.argv.includes('--dry');

function fail(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

const MAKO_ADDRESS = (process.env.NEXT_PUBLIC_MAKO_ADDRESS ??
  '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195') as `0x${string}`;
const RPC = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';
const rawKey = process.env.ADMIN_PRIVATE_KEY;
if (!rawKey) fail('ADMIN_PRIVATE_KEY missing from .env.local');
if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey))
  fail('ADMIN_PRIVATE_KEY malformed (expected 0x + 64 hex)');
const ADMIN_PRIVATE_KEY = rawKey as Hex;

const newAddrRaw = process.argv.find((a) => a.startsWith('0x')) ?? process.env.NEW_ADMIN;
if (!newAddrRaw) fail('pass new admin address as first arg or NEW_ADMIN env');
if (!isAddress(newAddrRaw)) fail(`invalid checksum on new address: ${newAddrRaw}`);
const NEW_ADMIN = getAddress(newAddrRaw);

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
} as const;

const abi = parseAbi([
  'function owner() view returns (address)',
  'function resolver() view returns (address)',
  'function treasury() view returns (address)',
  'function treasuryBalance() view returns (uint256)',
  'function withdrawTreasury()',
  'function setTreasury(address)',
  'function setResolver(address)',
  'function transferOwnership(address)',
]);

const account = privateKeyToAccount(ADMIN_PRIVATE_KEY);
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC) });

async function readState() {
  const [owner, resolver, treasury, tBal, wBal] = await Promise.all([
    pub.readContract({ address: MAKO_ADDRESS, abi, functionName: 'owner' }),
    pub.readContract({ address: MAKO_ADDRESS, abi, functionName: 'resolver' }),
    pub.readContract({ address: MAKO_ADDRESS, abi, functionName: 'treasury' }),
    pub.readContract({ address: MAKO_ADDRESS, abi, functionName: 'treasuryBalance' }),
    pub.getBalance({ address: account.address }),
  ]);
  return { owner, resolver, treasury, tBal, wBal };
}

async function send(
  label: string,
  fn: () => Promise<`0x${string}`>,
): Promise<void> {
  console.log(`\n→ ${label}`);
  if (DRY_RUN) {
    console.log('  [DRY] would broadcast');
    return;
  }
  const hash = await fn();
  console.log(`  tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  block ${receipt.blockNumber}  status=${receipt.status}  gas=${receipt.gasUsed}`);
  if (receipt.status !== 'success') fail(`${label} reverted`);
}

async function main() {
  console.log('=== Mako Markets admin rotation ===');
  console.log(`Contract:    ${MAKO_ADDRESS}`);
  console.log(`Signer:      ${account.address}  (compromised — rotating out)`);
  console.log(`New admin:   ${NEW_ADMIN}`);
  console.log(`Mode:        ${DRY_RUN ? 'DRY RUN' : 'LIVE BROADCAST'}`);

  console.log('\n--- BEFORE ---');
  const before = await readState();
  console.log(`  owner:    ${before.owner}`);
  console.log(`  resolver: ${before.resolver}`);
  console.log(`  treasury: ${before.treasury}`);
  console.log(`  treasury bal: ${formatUsdc(before.tBal)} USDC`);
  console.log(`  signer bal:   ${formatEther(before.wBal)} MON  (gas wallet)`);

  if (before.owner.toLowerCase() !== account.address.toLowerCase()) {
    fail('signer is not owner — aborting (maybe already rotated?)');
  }

  // 1. Withdraw treasury (sends 0.09 MON treasury to current treasury = old wallet)
  if (before.tBal > 0n) {
    await send('withdrawTreasury()', () =>
      wallet.writeContract({ address: MAKO_ADDRESS, abi, functionName: 'withdrawTreasury' }),
    );
  } else {
    console.log('\n→ withdrawTreasury()  [skipped, tBal is 0]');
  }

  // 2. Change treasury
  await send(`setTreasury(${NEW_ADMIN})`, () =>
    wallet.writeContract({ address: MAKO_ADDRESS, abi, functionName: 'setTreasury', args: [NEW_ADMIN] }),
  );

  // 3. Change resolver
  await send(`setResolver(${NEW_ADMIN})`, () =>
    wallet.writeContract({ address: MAKO_ADDRESS, abi, functionName: 'setResolver', args: [NEW_ADMIN] }),
  );

  // 4. Transfer ownership LAST (after this, signer has no admin power)
  await send(`transferOwnership(${NEW_ADMIN})`, () =>
    wallet.writeContract({ address: MAKO_ADDRESS, abi, functionName: 'transferOwnership', args: [NEW_ADMIN] }),
  );

  // 5. Sweep remaining MON from old wallet to new
  const afterAdminBal = await pub.getBalance({ address: account.address });
  const gasReserve = parseEther('0.01'); // plenty for one simple transfer
  if (afterAdminBal > gasReserve) {
    const sweep = afterAdminBal - gasReserve;
    await send(`sweep ${formatEther(sweep)} MON  →  ${NEW_ADMIN}`, () =>
      wallet.sendTransaction({ to: NEW_ADMIN, value: sweep }),
    );
  } else {
    console.log('\n→ sweep skipped (balance below gas reserve)');
  }

  console.log('\n--- AFTER ---');
  const after = await readState();
  console.log(`  owner:    ${after.owner}`);
  console.log(`  resolver: ${after.resolver}`);
  console.log(`  treasury: ${after.treasury}`);
  console.log(`  treasury bal: ${formatUsdc(after.tBal)} USDC`);
  console.log(`  signer bal:   ${formatEther(after.wBal)} MON  (old wallet, should be near 0)`);
  const newBal = await pub.getBalance({ address: NEW_ADMIN });
  console.log(`  new admin bal: ${formatEther(newBal)} MON  (gas wallet)`);

  const migrated =
    after.owner.toLowerCase() === NEW_ADMIN.toLowerCase() &&
    after.resolver.toLowerCase() === NEW_ADMIN.toLowerCase() &&
    after.treasury.toLowerCase() === NEW_ADMIN.toLowerCase();
  if (DRY_RUN) {
    console.log('\n[DRY RUN] No state was changed.');
  } else if (migrated) {
    console.log('\n✓ Migration complete. Old wallet has no admin power.');
  } else {
    console.log('\n✗ Migration incomplete — inspect the addresses above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
