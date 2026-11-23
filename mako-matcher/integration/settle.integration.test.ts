// The settler's own encode, simulate, estimate, send, receipt and trace code against a REAL node: anvil in Monad
// mode with MakoOutcomeExchangeV1 deployed from the mako-contracts checkout at the recorded commit (USDC is the
// contract's own test token). It covers one settled direct match, one InsufficientCash found in simulation
// (dropped, not counted), and one revert in a SENT transaction whose error is read from debug_traceTransaction.
//
//   pnpm test:integration        (skips, saying why, when anvil or the checkout is missing; CI does not run it)
//
// Every key is derived from a public label and controls nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCHANGE_ABI, type OrderTuple } from '../src/abi';
import { rpc } from '../src/chain';
import type { Rec, WireProposal } from '../src/encode';
import { ORDER_TYPES, orderHash } from '../src/order';
import type { Outcome } from '../src/outcome';
import { Settler, SETTLER_SCHEMA, type SettleDeps } from '../src/settle';
import { findContracts, jsonRpc, skipReason, startAnvil, type Anvil } from './anvil';
import { nodeSql } from './sqlite';

const CHAIN_ID = 10143;
const reason = skipReason();
if (reason) console.warn(`integration test SKIPPED: ${reason}`);

const key = (label: string) => privateKeyToAccount(keccak256(new TextEncoder().encode(`mako-matcher integration key: ${label} (public label, controls nothing)`) as unknown as Hex));
const ADMIN = key('admin');
const OPERATOR = key('operator');
const MAKER = key('maker');
const TAKER = key('taker');
const BROKE = key('broke');
const TAKER2 = key('taker two');
const TREASURY = key('treasury');
const FUNDER: Hex = '0xf00d000000000000000000000000000000000001';
const SHARE = 1_000_000n;

describe.skipIf(reason !== null)('the settler against a real node (anvil, Monad mode)', () => {
  let anvil: Anvil;
  let exchange: Hex;
  let usdc: Hex;
  let wallet: (a: ReturnType<typeof key>) => ReturnType<typeof createWalletClient>;
  let pub: ReturnType<typeof createPublicClient>;
  let usdcAbi: unknown[];
  const methods: string[] = [];

  const art = (rel: string) => JSON.parse(readFileSync(join(findContracts()!, 'out', rel), 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };

  beforeAll(async () => {
    anvil = await startAnvil(CHAIN_ID);
    const chain = defineChain({ id: CHAIN_ID, name: 'anvil-monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
    pub = createPublicClient({ chain, transport: http(anvil.url) });
    wallet = (a) => createWalletClient({ account: a, chain, transport: http(anvil.url) });
    for (const a of [ADMIN, OPERATOR, MAKER, TAKER, BROKE, TAKER2, TREASURY]) await jsonRpc(anvil.url, 'anvil_setBalance', [a.address, `0x${(10n ** 22n).toString(16)}`]);
    const mock = art('TokenMocks.sol/MockUSDC.json');
    usdcAbi = mock.abi;
    const ex = art('MakoOutcomeExchangeV1.sol/MakoOutcomeExchangeV1.json');
    const send = async (hash: Hex) => {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('setup transaction reverted');
      return r;
    };
    usdc = (await send(await wallet(ADMIN).deployContract({ abi: mock.abi as never, bytecode: mock.bytecode.object, args: [] } as never))).contractAddress!;
    exchange = (await send(await wallet(ADMIN).deployContract({ abi: ex.abi as never, bytecode: ex.bytecode.object, args: [usdc, TREASURY.address] } as never))).contractAddress!;
    const w = (a: ReturnType<typeof key>) => wallet(a);
    const call = async (a: ReturnType<typeof key>, address: Hex, abi: unknown[], functionName: string, args: unknown[]) => send(await w(a).writeContract({ address, abi, functionName, args } as never));
    const now = Number((await pub.getBlock()).timestamp);
    await call(ADMIN, exchange, EXCHANGE_ABI as never, 'setOperator', [OPERATOR.address, true]);
    await call(ADMIN, exchange, EXCHANGE_ABI as never, 'createMarket', [3, 0, BigInt(now + 86_400), BigInt(now + 172_800), 10n ** 12n, `0x${'00'.repeat(32)}`]);
    for (const [who, amount] of [[MAKER, 1000n * SHARE], [TAKER, 1000n * SHARE], [TAKER2, 100n * SHARE]] as const) {
      await call(who, usdc, usdcAbi, 'mint', [who.address, amount]);
      await call(who, usdc, usdcAbi, 'approve', [exchange, amount]);
      await call(who, exchange, EXCHANGE_ABI as never, 'deposit', [amount]);
    }
    await call(MAKER, exchange, EXCHANGE_ABI as never, 'mintSets', [1n, 100n * SHARE]);
    // the funder: a contract whose cap() returns 10^18 wei (PUSH32 cap, MSTORE, RETURN)
    await jsonRpc(anvil.url, 'anvil_setCode', [FUNDER, `0x7f${(10n ** 18n).toString(16).padStart(64, '0')}60005260206000f3`]);
  });

  afterAll(() => anvil?.stop());

  async function order(who: ReturnType<typeof key>, over: Partial<OrderTuple>): Promise<Rec> {
    const now = Number((await pub.getBlock()).timestamp);
    const o: OrderTuple = { salt: BigInt(Math.floor(Math.random() * 1e9)), maker: who.address.toLowerCase() as Hex, marketId: 1n, option: 0, isBuy: true, price: 60, size: 20n * SHARE, expiration: BigInt(now + 3600), nonce: 0n, ...over };
    const signature = await who.signTypedData({ domain: { name: 'Mako Market Exchange', version: '1', chainId: CHAIN_ID, verifyingContract: exchange }, types: ORDER_TYPES, primaryType: 'Order', message: o });
    return {
      hash: orderHash(o, { chainId: CHAIN_ID, exchange }),
      signature,
      bookedAt: Date.now(),
      order: { salt: o.salt.toString(), maker: o.maker, marketId: '1', option: o.option, isBuy: o.isBuy, price: o.price, size: o.size.toString(), expiration: o.expiration.toString(), nonce: '0' },
    };
  }
  const direct = (taker: Rec, maker: Rec): WireProposal => ({ kind: 'direct', marketId: '1', taker, makers: [maker], fills: [maker.order.size], takerFill: maker.order.size });

  function settler(sql: SqlStorage, beforeBroadcast?: () => Promise<void>) {
    const outcomes: Outcome[] = [];
    const alerts: string[] = [];
    const chain = {
      net: { fetch: ((i: RequestInfo | URL, x?: RequestInit) => {
        const b = x?.body ? (JSON.parse(String(x.body)) as { method: string }) : null;
        if (b) methods.push(b.method);
        return fetch(i, x);
      }) as typeof fetch, now: () => Date.now(), deadlineAt: Number.MAX_SAFE_INTEGER },
      rpcUrl: anvil.url,
      exchange,
      chainId: CHAIN_ID,
    };
    const deps: SettleDeps = {
      sql,
      chain,
      verifyChain: async () => undefined,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      sender: OPERATOR.address.toLowerCase() as Hex,
      signRaw: (tx) => OPERATOR.signTransaction({ type: 'eip1559', value: 0n, ...tx }),
      async broadcast(raw) {
        if (beforeBroadcast) await beforeBroadcast();
        const r = await rpc(chain.net, chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
        if (!r.ok) throw new Error(r.kind);
      },
      K: 100n,
      funder: FUNDER,
      gateGt: false,
      alert: (code) => alerts.push(code),
      report: async (_m, b) => void outcomes.push(b),
    };
    return { s: new Settler(deps), outcomes, alerts };
  }
  const fresh = () => {
    const sql = nodeSql();
    for (const q of SETTLER_SCHEMA) sql.exec(q);
    return sql;
  };
  const q = (sql: SqlStorage, s: string, ...a: unknown[]) => sql.exec(s, ...a).toArray() as Record<string, unknown>[];
  const position = async (who: ReturnType<typeof key>, option = 0) => (await pub.readContract({ address: exchange, abi: EXCHANGE_ABI as never, functionName: 'positionOf', args: [1n, option, who.address] } as never)) as bigint;

  it('settles one direct match: encoded from records, simulated, estimated, sent, receipted', async () => {
    const sql = fresh();
    const { s, outcomes } = settler(sql);
    const sell = await order(MAKER, { isBuy: false, price: 55 });
    const buy = await order(TAKER, { isBuy: true, price: 60 });
    const before = await position(TAKER);
    expect(await s.submit(direct(buy, sell))).toEqual({ accepted: true });
    for (let i = 0; i < 6 && outcomes.length === 0; i++) await s.run();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].applied).toEqual([{ hash: buy.hash, fill: '20000000' }, { hash: sell.hash, fill: '20000000' }]);
    expect(await position(TAKER)).toBe(before + 20n * SHARE);
    const log = q(sql, 'SELECT status, charge, reserved, gas_limit FROM send_log');
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('settled');
    expect(BigInt(log[0].charge as string)).toBeGreaterThan(0n);
    expect(BigInt(log[0].charge as string)).toBeLessThanOrEqual(BigInt(log[0].reserved as string));
    expect(q(sql, 'SELECT sends FROM counters')).toEqual([{ sends: 1 }]);
  });

  it('an InsufficientCash found in the simulation drops the order, counts nothing, and sends nothing', async () => {
    const sql = fresh();
    const { s, outcomes } = settler(sql);
    const sell = await order(MAKER, { isBuy: false, price: 55 });
    const broke = await order(BROKE, { isBuy: true, price: 60 }); // BROKE has no cash in the exchange
    const nonceBefore = await pub.getTransactionCount({ address: OPERATOR.address });
    await s.submit(direct(broke, sell));
    for (let i = 0; i < 4 && outcomes.length === 0; i++) await s.run();
    expect(outcomes[0].dropped).toEqual([{ hash: broke.hash, reason: 'insufficient_cash' }]);
    expect(outcomes[0].applied).toBeUndefined();
    expect(q(sql, 'SELECT COUNT(*) AS n FROM failures')).toEqual([{ n: 0 }]);
    expect(q(sql, 'SELECT COUNT(*) AS n FROM send_log')).toEqual([{ n: 0 }]);
    expect(await pub.getTransactionCount({ address: OPERATOR.address })).toBe(nonceBefore);
  });

  it('a revert in a SENT transaction is read from debug_traceTransaction, dropped and counted once', async () => {
    const sql = fresh();
    const sell = await order(MAKER, { isBuy: false, price: 55 });
    const buy = await order(TAKER2, { isBuy: true, price: 60 }); // TAKER2 has exactly 100 shares of cash
    // between the simulation and the inclusion TAKER2 withdraws its cash: the sent call reverts InsufficientCash
    const { s, outcomes } = settler(sql, async () => {
      const h = await wallet(TAKER2).writeContract({ address: exchange, abi: EXCHANGE_ABI as never, functionName: 'withdraw', args: [100n * SHARE] } as never);
      await pub.waitForTransactionReceipt({ hash: h });
    });
    methods.length = 0;
    await s.submit(direct(buy, sell));
    for (let i = 0; i < 8 && outcomes.length === 0; i++) await s.run();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].dropped).toEqual([{ hash: buy.hash, reason: 'insufficient_cash' }]);
    expect(q(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'reverted' }]);
    expect(q(sql, 'SELECT n FROM failures')).toEqual([{ n: 1 }]);
    // the error came from the mined transaction's trace, and no eth_call was made after the send
    const afterSend = methods.slice(methods.indexOf('eth_sendRawTransaction') + 1);
    expect(afterSend).toContain('debug_traceTransaction');
    expect(afterSend).not.toContain('eth_call');
    expect(afterSend).not.toContain('debug_traceCall');
  });
});
