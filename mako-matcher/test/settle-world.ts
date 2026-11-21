// The settler's fake node: on top of test/fake.ts's World it answers the reads and the send the settler makes
// (balance, nonces, fees, estimate, traces, a raw send, receipts). A scenario says what the node does by setting
// `sim` (what simulating a call shows) and `onSend` (what happens to a sent transaction); return data and
// revert data are encoded against the REAL exchange ABI, and a sent transaction is parsed (signature recovered)
// so a test can check exactly what the settler signed. Traces follow the geth callTracer format.
import { encodeErrorResult, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EXCHANGE_ABI, type OrderTuple } from '../src/abi';
import { decodeMatch } from '../src/encode';
import { Settler, SETTLER_SCHEMA, type SettleDeps, type TxFields } from '../src/settle';
import { ECRECOVER, IS_VALID_SIGNATURE } from '../src/trace';
import { rpc } from '../src/chain';
import type { Outcome } from '../src/outcome';
import { SAFE_4337_MODULE, SAFE_SINGLETON } from '../src/wallets';
import { EXCHANGE, makeFetch, NOW_MS, World, type RpcAnswer } from './fake';

export const FUNDER: Hex = '0xf00d000000000000000000000000000000000001';
/// A key derived from a public label: it controls nothing.
export const OP_KEY = keccak256(new TextEncoder().encode('mako-matcher test operator key (public label, controls nothing)') as unknown as Hex);
export const OP2_KEY = keccak256(new TextEncoder().encode('mako-matcher test operator key two (public label, controls nothing)') as unknown as Hex);
export const OP = privateKeyToAccount(OP_KEY);
export const OP2 = privateKeyToAccount(OP2_KEY);
export const GWEI = 10n ** 9n;

export type Sim = { revert?: { name: string; args?: unknown[] }; oog?: boolean; extraRan?: Hex[]; /** only this party's check frame runs the extra code */ extraFor?: Hex; noTrace?: boolean; /** the trace shows no signature-check frames */ noFrames?: boolean };
export interface Sent {
  hash: Hex;
  from: Hex;
  tx: TransactionSerializableEIP1559;
  input: Hex;
  raw: Hex;
}
export interface SendResult {
  /// Not mined at all (it stays pending).
  pending?: boolean;
  status?: 0 | 1;
  revert?: { name: string; args?: unknown[] };
  oog?: boolean;
  extraRan?: Hex[];
  extraFor?: Hex;
  noTrace?: boolean;
  /// What the node answers to the raw send.
  rejectSend?: boolean;
}

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;

export class SettleWorld extends World {
  balance = 10n ** 21n;
  confirmedNonce = new Map<Hex, bigint>();
  baseFeePerGas = 100n * GWEI;
  prio = 2n * GWEI;
  estimate = 300_000n;
  funderCap: bigint | null = 10n ** 20n;
  sim: (d: ReturnType<typeof decodeMatch>) => Sim = () => ({});
  onSend: (s: Sent, n: number) => SendResult = () => ({ status: 1 });
  sent: Sent[] = [];
  receipts = new Map<Hex, { status: 0 | 1; effectiveGasPrice: bigint }>();
  traces = new Map<Hex, unknown>();
  known = new Map<Hex, Sent>();
  failMethod: Record<string, 'down' | undefined> = {};
  /// Changes the input the node reports for a mined transaction (a settler bug, injected).
  inputOverride: ((input: Hex) => Hex) | null = null;

  constructor() {
    super();
    this.operators.add(OP.address.toLowerCase() as Hex);
    this.hooks = (m, p) => this.settleHook(m, p);
  }

  nonceOf(a: Hex) {
    return this.confirmedNonce.get(a.toLowerCase() as Hex) ?? 0n;
  }

  /// Synthesises the trace of the match call: the exchange's own frame, and a check frame for each party that is a contract.
  private matchTrace(d: NonNullable<ReturnType<typeof decodeMatch>>, s: Sim, from: Hex, input: Hex) {
    const parties: OrderTuple[] = [d.taker, ...d.makers];
    const calls: unknown[] = [];
    for (const o of parties) {
      const code = s.noFrames ? undefined : this.code.get(o.maker.toLowerCase() as Hex);
      if (!code || code === '0x' || code.startsWith('0xef0100')) continue;
      const inner: unknown[] = [
        { type: 'CALL', from: o.maker, to: SAFE_4337_MODULE, input: IS_VALID_SIGNATURE, calls: [{ type: 'STATICCALL', from: SAFE_4337_MODULE, to: ECRECOVER, input: '0x' }] },
      ];
      for (const x of !s.extraFor || s.extraFor.toLowerCase() === o.maker.toLowerCase() ? (s.extraRan ?? []) : []) inner.push({ type: 'CALL', from: SAFE_4337_MODULE, to: x, input: '0x' });
      calls.push({ type: 'STATICCALL', from: EXCHANGE, to: o.maker, input: `${IS_VALID_SIGNATURE}${'00'.repeat(8)}`, calls: [{ type: 'DELEGATECALL', from: o.maker, to: SAFE_SINGLETON, input: IS_VALID_SIGNATURE, calls: inner }] });
    }
    const top: Record<string, unknown> = { type: 'CALL', from, to: EXCHANGE, input, gas: '0x1', gasUsed: '0x1', output: '0x', calls };
    if (s.revert) {
      top.error = 'execution reverted';
      top.output = encodeErrorResult({ abi: EXCHANGE_ABI, errorName: s.revert.name, args: s.revert.args ?? [] } as never);
    } else if (s.oog) {
      top.error = 'out of gas';
      top.output = '0x';
    }
    return top;
  }

  private async settleHook(method: string, params: unknown[]): Promise<RpcAnswer | null> {
    if (this.failMethod[method] === 'down') return { error: { code: -32000, message: 'node down' } };
    const lower = (a: unknown) => String(a).toLowerCase() as Hex;
    switch (method) {
      case 'eth_getBalance':
        return { result: hex(this.balance) };
      case 'eth_getTransactionCount': {
        const a = lower(params[0]);
        const pendingSent = this.sent.filter((s) => s.from === a && !this.receipts.has(s.hash)).length;
        return { result: hex(this.nonceOf(a) + (params[1] === 'pending' ? BigInt(pendingSent) : 0n)) };
      }
      case 'eth_getBlockByNumber':
        return { result: { number: hex(this.block), baseFeePerGas: hex(this.baseFeePerGas) } };
      case 'eth_maxPriorityFeePerGas':
        return { result: hex(this.prio) };
      case 'eth_estimateGas': {
        const tx = params[0] as { from: Hex; data: Hex };
        const d = decodeMatch(tx.data);
        const s = d ? this.sim(d) : {};
        if (s.revert) return { error: { code: 3, message: 'execution reverted' } };
        return { result: hex(this.estimate) };
      }
      case 'debug_traceCall': {
        const tx = params[0] as { from: Hex; data: Hex };
        const d = decodeMatch(tx.data);
        const s = d ? this.sim(d) : {};
        if (s.noTrace) return { error: { code: -32601, message: 'the method debug_traceCall does not exist' } };
        return { result: this.matchTrace(d!, s, tx.from, tx.data) };
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw) as TransactionSerializableEIP1559;
        const from = lower(await recoverTransactionAddress({ serializedTransaction: raw as never }));
        const hash = keccak256(raw);
        if (!this.known.has(hash)) {
          const sent: Sent = { hash, from, tx, input: tx.data as Hex, raw };
          this.sent.push(sent);
          this.known.set(hash, sent);
          const r = this.onSend(sent, this.sent.length);
          if (!r.pending) {
            const status = r.status ?? (r.revert || r.oog ? 0 : 1);
            this.receipts.set(hash, { status, effectiveGasPrice: this.baseFeePerGas + this.prio });
            this.confirmedNonce.set(from, this.nonceOf(from) + 1n);
            if (status === 0 && !r.noTrace) {
              const d = decodeMatch(sent.input)!;
              this.traces.set(hash, this.matchTrace(d, { revert: r.revert, oog: r.oog, extraRan: r.extraRan, extraFor: r.extraFor }, from, sent.input));
            }
          }
          if (r.rejectSend) return { error: { code: -32000, message: 'rejected' } };
        }
        return { result: hash };
      }
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(lower(params[0]));
        return { result: r ? { status: r.status === 1 ? '0x1' : '0x0', effectiveGasPrice: hex(r.effectiveGasPrice), gasUsed: '0x5208', blockNumber: hex(this.block) } : null };
      }
      case 'eth_getTransactionByHash': {
        const s = this.known.get(lower(params[0]));
        return { result: s ? { input: this.inputOverride ? this.inputOverride(s.input) : s.input, from: s.from, nonce: hex(BigInt(s.tx.nonce ?? 0)) } : null };
      }
      case 'debug_traceTransaction': {
        const t = this.traces.get(lower(params[0]));
        return t ? { result: t } : { error: { code: -32601, message: 'no trace' } };
      }
      case 'eth_call': {
        const tx = params[0] as { to: Hex; data: Hex };
        if (lower(tx.to) === lower(FUNDER) && tx.data === '0x355274ea') {
          if (this.funderCap === null) return { error: { code: 3, message: 'execution reverted' } };
          return { result: `0x${this.funderCap.toString(16).padStart(64, '0')}` };
        }
        return null;
      }
      default:
        return null;
    }
  }
}

export interface Rig {
  w: SettleWorld;
  outcomes: { marketId: string; body: Outcome }[];
  alerts: { code: string; detail: string }[];
  /// Overrides for the next `deps` (K, funder, sender...).
  over: Partial<SettleDeps> & { key?: ReturnType<typeof privateKeyToAccount> | null };
  broadcastLog: (sql: SqlStorage) => void;
  deps(sql: SqlStorage): SettleDeps;
  settler(sql: SqlStorage): Settler;
}

export function rig(w: SettleWorld = new SettleWorld()): Rig {
  const r: Rig = {
    w,
    outcomes: [],
    alerts: [],
    over: {},
    broadcastLog: () => undefined,
    deps(sql) {
      const chain = { net: { fetch: makeFetch(w), now: () => w.nowMs, deadlineAt: Number.MAX_SAFE_INTEGER }, rpcUrl: 'https://rpc.test/', exchange: EXCHANGE, chainId: 10143 };
      const key = r.over.key === undefined ? OP : r.over.key;
      const d: SettleDeps = {
        sql,
        chain,
        verifyChain: async () => undefined,
        now: () => w.nowMs,
        sleep: async (ms) => {
          w.nowMs += ms;
        },
        sender: key ? (key.address.toLowerCase() as Hex) : null,
        async signRaw(tx: TxFields) {
          if (!key) throw new Error('no key');
          return key.signTransaction({ type: 'eip1559', value: 0n, ...tx });
        },
        async broadcast(raw) {
          r.broadcastLog(sql);
          const res = await rpc(chain.net, chain.rpcUrl, 'eth_sendRawTransaction', [raw]);
          if (!res.ok) throw new Error(res.kind);
        },
        K: 100n,
        funder: FUNDER,
        gateGt: false,
        alert: (code, detail) => r.alerts.push({ code, detail }),
        async report(marketId, body) {
          r.outcomes.push({ marketId, body });
        },
      };
      const { key: _k, ...rest } = r.over;
      void _k;
      return { ...d, ...rest };
    },
    settler(sql) {
      return new Settler(r.deps(sql));
    },
  };
  return r;
}

export const SETTLER_TABLES = ['refused_accounts', 'meta', 'pending', 'in_flight', 'send_log', 'counters', 'failures', 'outbox'];
export function resetSettlerStorage(sql: SqlStorage) {
  for (const t of SETTLER_TABLES) sql.exec(`DROP TABLE IF EXISTS ${t}`);
  for (const s of SETTLER_SCHEMA) sql.exec(s);
}
void NOW_MS;
