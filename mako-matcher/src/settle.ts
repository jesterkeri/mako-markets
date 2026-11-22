// The settlement logic (plan 6.1, 6.2 "Settle", the revert table and blame rules, 6.3 counters and wallet short,
// 6.5 "State the settler keeps"). It runs inside MatcherSettler, one transaction at a time, and it never signs or
// broadcasts anything itself: `signRaw` and `broadcast` are handed in by src/settler.ts, the only module that
// holds the operator key or names a send method.
//
// Everything fails closed. A value that is not there (K, the funder cap, the key, the primary RPC) means: send
// nothing, hold every market, alert. A read that fails means: try again next tick. A trace that cannot be read
// means: stop that market (sent transaction) or hold the match (simulation).
import { keccak256, type Hex } from 'viem';
import type { Alert } from './alerts';
import {
  baseFee,
  ChainError,
  estimateGas,
  getBalance,
  getCode,
  getNonce,
  getReceipt,
  getStorageAt,
  getTxInput,
  priorityFee,
  readFunderCap,
  readIsOperator,
  readPaused,
  traceCall,
  traceTransaction,
  type ChainCtx,
  type Receipt,
} from './chain';
import { decodeMatch, encodeMatch, parseProposal, toTuple, type Rec, type WireProposal } from './encode';
import { orderHash, recoverStrict } from './order';
import type { Outcome } from './outcome';
import { checkFrames, outsiders, parseTrace, topRevert, type CallFrame, type RevertInfo } from './trace';
import { classifyCode, FALLBACK_HANDLER_SLOT, isSupportedSafe } from './wallets';

/// Plan 6.2 step 2: (3,000,000 + 11 x 60,000) x 1.10.
export const GAS_CEILING = 4_026_000n;
/// Plan 6.2: a counted `BadSignature` or gas blame refuses the account at the first one; the other reasons at 3.
export const REFUSE_AT_BADSIG = 1;
export const REFUSE_AT_OTHER = 3;
export const RECEIPT_POLLS = 8;
export const RECEIPT_POLL_MS = 400;
/// How many times one match is rebuilt without a party that failed a check, before it is held.
const MAX_REBUILDS = 4;

export const SETTLER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refused_accounts (maker TEXT NOT NULL, utc_day TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (maker, utc_day))`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // One proposal waiting for its turn, and one transaction in flight: the settler holds at most one of each.
  `CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK (id = 1), market_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS in_flight (id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT NOT NULL, sender TEXT NOT NULL, nonce INTEGER NOT NULL, gas_limit TEXT NOT NULL, max_fee TEXT NOT NULL, reserved TEXT NOT NULL, utc_day TEXT NOT NULL, raw TEXT NOT NULL, market_id TEXT NOT NULL, body TEXT NOT NULL)`,
  // Written BEFORE the transaction is broadcast; the charge is added on the receipt.
  `CREATE TABLE IF NOT EXISTS send_log (hash TEXT PRIMARY KEY, sender TEXT NOT NULL, nonce INTEGER NOT NULL, gas_limit TEXT NOT NULL, max_fee TEXT NOT NULL, reserved TEXT NOT NULL, charge TEXT, utc_day TEXT NOT NULL, market_id TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`,
  // Keyed by UTC day, never by key (plan 6.3, 6.5).
  `CREATE TABLE IF NOT EXISTS counters (utc_day TEXT PRIMARY KEY, sends INTEGER NOT NULL, mon_reserved TEXT NOT NULL, cap_wei TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS failures (maker TEXT NOT NULL, utc_day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (maker, utc_day))`,
  // What still has to be told to a market object.
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT NOT NULL, body TEXT NOT NULL)`,
];

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface TxFields {
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: Hex;
  data: Hex;
}

export interface SettleDeps {
  sql: SqlStorage;
  chain: ChainCtx;
  /// Proves the endpoint is the exchange's chain (once per object lifetime).
  verifyChain(): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /// The operator address, or null when no usable key is configured.
  sender: Hex | null;
  signRaw(tx: TxFields): Promise<Hex>;
  broadcast(raw: Hex): Promise<void>;
  /// K from [vars]; null when unset or not a positive integer.
  K: bigint | null;
  /// FUNDER_ADDRESS; null when unset.
  funder: Hex | null;
  /// GATE_GT_PASSED is exactly "true".
  gateGt: boolean;
  alert: Alert;
  report(marketId: string, body: Outcome): Promise<void>;
}

type Held = { held: true; reason: string };

const hexes = (p: WireProposal): Hex[] => [p.taker.hash, ...p.makers.map((m) => m.hash)];
const allRecs = (p: WireProposal): Rec[] => [p.taker, ...p.makers];

/// Rebuilds a direct match without one party. A set match needs every leg, and nothing is left without the taker.
function without(p: WireProposal, hash: Hex): WireProposal | null {
  if (p.taker.hash === hash) return null;
  const i = p.makers.findIndex((m) => m.hash === hash);
  if (i < 0) return p;
  if (p.kind !== 'direct' || p.makers.length === 1) return null;
  const takerFill = BigInt(p.takerFill) - BigInt(p.fills[i]);
  if (takerFill <= 0n) return null;
  return { ...p, makers: p.makers.filter((_, j) => j !== i), fills: p.fills.filter((_, j) => j !== i), takerFill: takerFill.toString() };
}

export class Settler {
  constructor(private d: SettleDeps) {}

  // ------------------------------------------------------------------ storage helpers
  private meta(k: string): string | null {
    const r = this.d.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? r.v : null;
  }
  private setMeta(k: string, v: string) {
    this.d.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }
  private today(): string {
    return utcDay(this.d.now());
  }
  /// One alert per reason per UTC day (a held settler would otherwise alert every tick).
  private alertOnce(reason: string, detail: string) {
    const key = `alerted:${reason}:${this.today()}`;
    if (this.meta(key) !== null) return;
    this.setMeta(key, '1');
    this.d.alert(reason, detail);
  }

  hasWork(): boolean {
    const n = (t: string) => Number(this.d.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).one().n);
    return n('pending') + n('in_flight') + n('outbox') > 0;
  }

  /// A counter's row for today. Created on the first use of the UTC day, reading `cap` from the funder then.
  private async dayRow(): Promise<{ key: string; sends: number; reserved: bigint; cap: bigint } | null> {
    const day = this.today();
    const get = () => this.d.sql.exec<{ sends: number; mon_reserved: string; cap_wei: string }>(`SELECT sends, mon_reserved, cap_wei FROM counters WHERE utc_day = ?`, day).toArray()[0];
    let r = get();
    if (!r) {
      if (!this.d.funder) return null;
      const cap = await readFunderCap(this.d.chain, this.d.funder);
      if (cap === null) return null;
      this.d.sql.exec(`INSERT OR IGNORE INTO counters (utc_day, sends, mon_reserved, cap_wei) VALUES (?, 0, '0', ?)`, day, cap.toString());
      r = get();
    }
    return { key: day, sends: Number(r.sends), reserved: BigInt(r.mon_reserved), cap: BigInt(r.cap_wei) };
  }

  /// Status for people and for the release check (phase B's counters and what they are held to).
  async status() {
    const row = this.d.sql.exec<{ utc_day: string; sends: number; mon_reserved: string; cap_wei: string }>(`SELECT * FROM counters WHERE utc_day = ?`, this.today()).toArray()[0];
    return {
      day: this.today(),
      K: this.d.K === null ? null : this.d.K.toString(),
      funder: this.d.funder,
      gateGtPassed: this.d.gateGt,
      sender: this.d.sender,
      sends: row ? Number(row.sends) : 0,
      reservedWei: row ? row.mon_reserved : '0',
      capWei: row ? row.cap_wei : null,
      pending: this.d.sql.exec(`SELECT COUNT(*) AS n FROM pending`).one().n,
      inFlight: this.d.sql.exec(`SELECT COUNT(*) AS n FROM in_flight`).one().n,
    };
  }

  // ------------------------------------------------------------------ entry points
  /// The market object hands over a proposal. Accepted means: the settler has it, will settle or release it, and
  /// will report either way.
  async submit(body: unknown): Promise<{ accepted: boolean; reason?: string }> {
    const p = parseProposal(body);
    if (!p) return { accepted: false, reason: 'bad_proposal' };
    const gate = this.configHeld();
    if (gate) {
      this.alertOnce(gate.reason, 'the settler sends nothing until this is set');
      return { accepted: false, reason: gate.reason };
    }
    if (this.hasWorkInFlight()) return { accepted: false, reason: 'busy' };
    this.d.sql.exec(`INSERT INTO pending (id, market_id, body, at) VALUES (1, ?, ?, ?)`, p.marketId, JSON.stringify(p), this.d.now());
    return { accepted: true };
  }

  private hasWorkInFlight(): boolean {
    return Number(this.d.sql.exec<{ n: number }>(`SELECT (SELECT COUNT(*) FROM pending) + (SELECT COUNT(*) FROM in_flight) AS n`).one().n) > 0;
  }

  /// K unset, the funder unset, or no key: nothing is sent (plan 10.1 [r28], the brief's fail-closed values).
  private configHeld(): Held | null {
    if (this.d.K === null) return { held: true, reason: 'held_k_unset' };
    if (this.d.funder === null) return { held: true, reason: 'held_funder_unset' };
    if (this.d.sender === null) return { held: true, reason: 'held_no_key' };
    return null;
  }

  /// One step of work: tell the markets, resolve a transaction in flight, or settle the pending proposal.
  async run(): Promise<void> {
    await this.flushOutbox();
    try {
      await this.d.verifyChain();
    } catch (err) {
      if (err instanceof ChainError) {
        this.alertOnce('settler_rpc', `${err.method} ${err.kind}`);
        return; // a node that is not the exchange's chain is believed about nothing
      }
      throw err;
    }
    try {
      if (Number(this.d.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM in_flight`).one().n) > 0) {
        await this.recover();
      } else {
        const p = this.d.sql.exec<{ body: string }>(`SELECT body FROM pending`).toArray()[0];
        if (p) await this.processPending(parseProposal(JSON.parse(p.body))!);
      }
    } catch (err) {
      if (err instanceof ChainError) this.alertOnce('settler_rpc', `${err.method} ${err.kind}`);
      else throw err;
    }
    await this.flushOutbox();
  }

  // ------------------------------------------------------------------ reporting
  private finish(p: WireProposal, o: Partial<Omit<Outcome, 'id'>>) {
    const body: Omit<Outcome, 'id'> = { ...o, release: hexes(p) };
    this.d.sql.exec(`INSERT INTO outbox (market_id, body) VALUES (?, ?)`, p.marketId, JSON.stringify(body));
    this.d.sql.exec(`DELETE FROM pending`);
    this.d.sql.exec(`DELETE FROM in_flight`);
  }

  /// Set once, when this storage first reports. Outbox ids restart at 1 if the settler's storage is ever lost; a
  /// random epoch per storage keeps a new outcome from reusing an id a market already applied.
  private epoch(): string {
    let e = this.meta('outbox_epoch');
    if (e === null) {
      e = crypto.randomUUID().replaceAll('-', '');
      this.setMeta('outbox_epoch', e);
    }
    return e;
  }

  private async flushOutbox() {
    const failed = new Set<string>(); // a market that did not take one outcome gets none of its later ones this pass
    for (const r of this.d.sql.exec<{ id: number; market_id: string; body: string }>(`SELECT id, market_id, body FROM outbox ORDER BY id`).toArray()) {
      if (failed.has(r.market_id)) continue;
      try {
        // The outbox id goes with the outcome: a retry after a lost answer carries the same id, and the market applies
        // each id once.
        await this.d.report(r.market_id, { ...(JSON.parse(r.body) as Outcome), id: `${this.epoch()}-${r.id}` });
        this.d.sql.exec(`DELETE FROM outbox WHERE id = ?`, r.id);
      } catch {
        failed.add(r.market_id);
        this.alertOnce('report_failed', `market ${r.market_id} did not take the outcome; it is kept and retried`);
      }
    }
  }

  /// Nothing is sent and nothing is counted: the match goes back to the book. The hold itself drops nothing; parties
  /// already dropped for their own reason while the match was rebuilt (refused, unsupported wallet) are reported, so
  /// the next proposal is built without them and no order the market marked is left unreported.
  private hold(p: WireProposal, reason: string, detail: string, dropped: { hash: Hex; reason: string }[] = []) {
    this.alertOnce(reason, detail);
    this.finish(p, dropped.length ? { dropped } : {});
  }

  // ------------------------------------------------------------------ building and simulating
  private async contractParties(p: WireProposal): Promise<Rec[]> {
    const out: Rec[] = [];
    for (const r of allRecs(p)) if ((await recoverStrict(r.hash, r.signature)) !== r.order.maker) out.push(r);
    return out;
  }

  private async processPending(p0: WireProposal) {
    const d = this.d;
    const gate = this.configHeld();
    if (gate) return this.hold(p0, gate.reason, 'the settler sends nothing until this is set');
    const sender = d.sender!;
    if (await readPaused(d.chain)) return this.hold(p0, 'held_paused', 'the exchange is paused; every market is held');
    if (!(await readIsOperator(d.chain, sender))) return this.hold(p0, 'not_operator', 'the key the settler sends from is not an operator on the exchange; nothing is sent');
    const day = await this.dayRow();
    if (!day) return this.hold(p0, 'held_funder_unreadable', 'the funder cap could not be read; nothing is sent');

    let p: WireProposal = p0;
    const dropped: { hash: Hex; reason: string }[] = [];
    let data: Hex | null = null;
    let gasLimit = 0n;
    for (let round = 0; ; round++) {
      // Round 0 is the match as proposed; rounds 1 to MAX_REBUILDS are rebuilds. One more drop past that holds it.
      if (round > MAX_REBUILDS) return this.hold(p0, 'held_rebuild', 'a match kept losing parties; it is held', dropped);
      // An account refused for the rest of the UTC day is in no settlement (plan 6.2: refused accounts).
      const refusedParty = allRecs(p).find((r) => this.isRefusedToday(r.order.maker));
      if (refusedParty) {
        dropped.push({ hash: refusedParty.hash, reason: 'refused' });
        const next = without(p, refusedParty.hash);
        if (!next) return this.finish(p0, { dropped, refusedMakers: [refusedParty.order.maker] });
        p = next;
        continue;
      }
      const enc = encodeMatch(p);
      if (!enc.ok) {
        // A maker from another market: build and send nothing, abandon, alert (drops and counts nothing).
        this.d.alert('market_mismatch', `maker ${enc.hash} is not in market ${p.taker.order.marketId}`);
        return this.finish(p0, {});
      }
      data = enc.data;

      // Before simulating: every contract party is still a supported wallet, read at the latest block (plan 4.6).
      const contract = await this.contractParties(p);
      let lost: Rec | null = null;
      for (const r of contract) {
        const code = await getCode(d.chain, r.order.maker);
        const single = await getStorageAt(d.chain, r.order.maker, `0x${'0'.repeat(64)}`);
        const handler = await getStorageAt(d.chain, r.order.maker, FALLBACK_HANDLER_SLOT);
        if (classifyCode(code) !== 'contract' || !isSupportedSafe(code, single, handler)) {
          lost = r;
          break;
        }
      }
      if (lost) {
        dropped.push({ hash: lost.hash, reason: 'unsupported_wallet' });
        const next = without(p, lost.hash);
        if (!next) return this.finish(p0, { dropped });
        p = next;
        continue;
      }

      // The simulation: debug_traceCall, only now that the previous transaction has its receipt.
      const trace = parseTrace(await traceCall(d.chain, sender, data));
      if (!trace) return this.hold(p0, 'simulation_unavailable', 'no call trace could be read for the simulation; the match is held', dropped);
      const rev = topRevert(trace);
      if (rev) return this.onRevert(p, rev, { sent: false, data, dropped });
      this.d.sql.exec(`DELETE FROM meta WHERE k = 'insufficient_gas_streak'`); // "in a row": a clean simulation ends it

      // Every frame inside each contract party's check frame ran only allowlisted code.
      const frames = checkFrames(trace, d.chain.exchange, contract.map((r) => r.order.maker));
      let bad: Rec | null = null;
      for (const r of contract) {
        const f = frames.get(r.order.maker);
        if (!f) return this.hold(p0, 'check_frame_missing', `the trace shows no signature check for ${r.order.maker}; the match is held`, dropped);
        if (outsiders(f, r.order.maker).length > 0) {
          bad = r;
          break;
        }
      }
      if (bad) {
        dropped.push({ hash: bad.hash, reason: 'unsupported_wallet' });
        const next = without(p, bad.hash);
        if (!next) return this.finish(p0, { dropped });
        p = next;
        continue;
      }

      const est = await estimateGas(d.chain, sender, data);
      if (!est.ok) return this.hold(p0, 'estimate_failed', 'eth_estimateGas failed after a clean simulation; the match is held', dropped);
      gasLimit = (((est.gas * 11n + 9n) / 10n + 999n) / 1000n) * 1000n;
      break;
    }
    if (data === null) return;
    if (gasLimit > GAS_CEILING) {
      this.d.alert('gas_ceiling', `limit ${gasLimit} is above ${GAS_CEILING}; nothing is sent, nothing is dropped, matching in market ${p.marketId} stops`);
      return this.finish(p0, { stopMarket: `gas limit ${gasLimit} above the ceiling ${GAS_CEILING}`, dropped });
    }

    // Fees: type 2, maxFeePerGas at least twice the latest block's base fee.
    const base = await baseFee(d.chain);
    const prio = await priorityFee(d.chain);
    const maxFee = 2n * base + prio;
    const reserve = gasLimit * maxFee;

    // Wallet short: below the worst charge, send nothing, hold every market, drop and count nothing.
    if ((await getBalance(d.chain, sender)) < reserve) return this.hold(p0, 'wallet_short', 'the operator balance is below the worst charge; nothing is sent until it is funded', dropped);

    // The daily caps (plan 6.3): a send that would pass either is not sent.
    if (BigInt(day.sends) + 1n > d.K!) return this.hold(p0, 'cap_count', `today's count cap K = ${d.K} is reached`, dropped);
    if (day.reserved + reserve > day.cap) return this.hold(p0, 'cap_mon', `today's MON cap would be passed (${day.reserved + reserve} > ${day.cap})`, dropped);

    // The nonce is the chain's plus the log's: never below a logged one.
    const chainNonce = await getNonce(d.chain, sender, 'pending');
    const logged = d.sql.exec<{ n: number | null }>(`SELECT MAX(nonce) AS n FROM send_log WHERE sender = ?`, sender).one().n;
    const nonce = logged !== null && BigInt(logged) + 1n > chainNonce ? BigInt(logged) + 1n : chainNonce;
    const tx: TxFields = { chainId: d.chain.chainId, nonce: Number(nonce), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, to: d.chain.exchange, data };
    const raw = await d.signRaw(tx);
    const hash = keccak256(raw);

    // The caps above were checked against the counters of the UTC day read at the start. If midnight passed during
    // the reads since, nothing is sent: the orders go back and the next tick checks against the new day's row.
    if (this.today() !== day.key) return this.finish(p0, dropped.length ? { dropped } : {});
    // Log first, broadcast second, in one synchronous block (reservation, counters, log, in-flight row).
    const dayKey = day.key;
    d.sql.exec(`INSERT INTO send_log (hash, sender, nonce, gas_limit, max_fee, reserved, charge, utc_day, market_id, status, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'sent', ?)`, hash, sender, tx.nonce, gasLimit.toString(), maxFee.toString(), reserve.toString(), dayKey, p.marketId, d.now());
    d.sql.exec(`INSERT INTO in_flight (id, hash, sender, nonce, gas_limit, max_fee, reserved, utc_day, raw, market_id, body) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, hash, sender, tx.nonce, gasLimit.toString(), maxFee.toString(), reserve.toString(), dayKey, raw, p.marketId, JSON.stringify(p));
    d.sql.exec(`UPDATE counters SET sends = sends + 1, mon_reserved = ? WHERE utc_day = ?`, (day.reserved + reserve).toString(), dayKey);
    d.sql.exec(`DELETE FROM pending`);
    if (dropped.length) this.setMeta('carry_dropped', JSON.stringify(dropped));
    else this.d.sql.exec(`DELETE FROM meta WHERE k = 'carry_dropped'`);
    this.alert70(day.sends + 1, day.reserved + reserve, day.cap);

    try {
      await d.broadcast(raw);
    } catch {
      // Not knowing whether the node took it is not a reason to send again: recovery re-broadcasts the same
      // signed bytes (same hash), or finds it on chain.
      this.alertOnce('broadcast_unconfirmed', 'the node did not confirm the broadcast; the logged transaction is recovered from the chain');
    }
    await this.awaitReceipt();
  }

  private alert70(sends: number, reserved: bigint, cap: bigint) {
    const k = this.d.K!;
    if (BigInt(sends) * 100n >= k * 70n) this.alertOnce('cap_70_count', `${sends} of ${k} sends today`);
    if (cap > 0n && reserved * 100n >= cap * 70n) this.alertOnce('cap_70_mon', `${reserved} of ${cap} wei reserved today`);
  }

  // ------------------------------------------------------------------ the transaction in flight
  private inFlight() {
    return this.d.sql
      .exec<{ hash: Hex; sender: Hex; nonce: number; gas_limit: string; max_fee: string; reserved: string; utc_day: string; raw: Hex; market_id: string; body: string }>(`SELECT * FROM in_flight`)
      .toArray()[0];
  }

  /// The parties dropped while the match in flight was being built (set at its send).
  private carried(): { hash: Hex; reason: string }[] {
    const v = this.meta('carry_dropped');
    return v ? JSON.parse(v) : [];
  }

  private async awaitReceipt() {
    for (let i = 0; i < RECEIPT_POLLS; i++) {
      const row = this.inFlight();
      if (!row) return;
      const r = await getReceipt(this.d.chain, row.hash);
      if (r) return this.onReceipt(row, r);
      await this.d.sleep(RECEIPT_POLL_MS);
    }
  }

  /// After a restart, or when the receipt was slow: resolve the one transaction in flight from the chain. Never
  /// builds a second one while this exists.
  private async recover() {
    const row = this.inFlight();
    if (!row) return;
    const d = this.d;
    const r = await getReceipt(d.chain, row.hash);
    if (r) return this.onReceipt(row, r);
    const p = parseProposal(JSON.parse(row.body))!;
    if (row.sender !== d.sender) {
      // A different key: wait for the old hash's receipt, or for the old key's nonce to pass it without one, or
      // for the exchange to stop listing the old key as an operator (plan 6.5).
      const passed = (await getNonce(d.chain, row.sender, 'latest')) > BigInt(row.nonce);
      const listed = await readIsOperator(d.chain, row.sender);
      if (passed || !listed) return this.strand(row, p, passed ? 'its nonce passed it' : 'the exchange no longer lists its key');
      return;
    }
    if ((await getNonce(d.chain, row.sender, 'latest')) > BigInt(row.nonce)) return this.strand(row, p, 'its nonce passed it with no receipt (replaced)');
    if ((await getTxInput(d.chain, row.hash)) === null) {
      // Logged but not known to the node: the same signed bytes go out again (same hash, same nonce).
      try {
        await d.broadcast(row.raw);
      } catch {
        this.alertOnce('broadcast_unconfirmed', 'the logged transaction could not be re-broadcast; trying again next tick');
      }
    }
    await this.awaitReceipt();
  }

  /// The transaction will never mine as logged. Its reservation stays counted (the charge is unknown, so the
  /// whole reservation is kept), and its orders go back to the book.
  private async strand(row: NonNullable<ReturnType<Settler['inFlight']>>, p: WireProposal, why: string) {
    // The receipt is read again AFTER the nonce: a transaction mined between the first receipt read and the nonce
    // read passed its own nonce, and stranding it would hand settled orders back to the book.
    const late = await getReceipt(this.d.chain, row.hash);
    if (late) return this.onReceipt(row, late);
    this.d.sql.exec(`UPDATE send_log SET status = 'stranded', charge = reserved WHERE hash = ?`, row.hash);
    this.d.alert('stranded_transaction', `${row.hash}: ${why}; its orders go back to the book`);
    // Parties left out when the match was rebuilt are dropped here too: the market marked them in flight as well.
    this.finish(p, { dropped: this.carried() });
  }

  private async onReceipt(row: NonNullable<ReturnType<Settler['inFlight']>>, r: Receipt) {
    const d = this.d;
    const p = parseProposal(JSON.parse(row.body))!;
    // Monad charges the gas limit: the charge replaces the reservation.
    const charge = BigInt(row.gas_limit) * (r.effectiveGasPrice ?? BigInt(row.max_fee));
    // Once per transaction: a reverted one reads the chain again below, and a failed read retries this whole step
    // next tick. Only the write that fills the charge moves the reservation to the charge.
    const first = d.sql.exec(`UPDATE send_log SET charge = ?, status = ? WHERE hash = ? AND charge IS NULL`, charge.toString(), r.status === 1 ? 'settled' : 'reverted', row.hash).rowsWritten === 1;
    const c = d.sql.exec<{ mon_reserved: string }>(`SELECT mon_reserved FROM counters WHERE utc_day = ?`, row.utc_day).toArray()[0];
    if (first && c) d.sql.exec(`UPDATE counters SET mon_reserved = ? WHERE utc_day = ?`, (BigInt(c.mon_reserved) - BigInt(row.reserved) + charge).toString(), row.utc_day);
    const dropped = this.carried();
    if (r.status === 1) {
      const applied = [{ hash: p.taker.hash, fill: p.takerFill }, ...p.makers.map((m, i) => ({ hash: m.hash, fill: p.fills[i] }))];
      return this.finish(p, { applied, dropped });
    }
    // A reverted settlement: the error comes from the mined transaction's own trace, never a replayed eth_call.
    const trace = parseTrace(await traceTransaction(d.chain, row.hash));
    const tx = await getTxInput(d.chain, row.hash);
    if (!trace || !tx) {
      this.d.alert('no_trace', `the revert of ${row.hash} cannot be read; matching in market ${p.marketId} stops and nothing is dropped or counted`);
      return this.finish(p, { stopMarket: 'a sent transaction reverted and its trace could not be read', dropped });
    }
    const rev = topRevert(trace) ?? { name: null, args: [], outOfGas: false };
    return this.onRevert(p, rev, { sent: true, data: tx.input, dropped, trace });
  }

  // ------------------------------------------------------------------ the revert table (plan 6.2)
  private owner(p: WireProposal, hash: Hex): Rec | undefined {
    return allRecs(p).find((r) => r.hash === hash);
  }

  private isRefusedToday(maker: Hex): boolean {
    return this.d.sql.exec(`SELECT 1 FROM refused_accounts WHERE maker = ? AND utc_day = ?`, maker, this.today()).toArray().length > 0;
  }

  /// Counts one failure against `maker` for the UTC day; true when the account is now refused for the rest of it.
  private count(maker: Hex, kind: 'badsig' | 'other', reason: string): boolean {
    const day = this.today();
    this.d.sql.exec(`INSERT INTO failures (maker, utc_day, n) VALUES (?, ?, 1) ON CONFLICT(maker, utc_day) DO UPDATE SET n = n + 1`, maker, day);
    const n = Number(this.d.sql.exec<{ n: number }>(`SELECT n FROM failures WHERE maker = ? AND utc_day = ?`, maker, day).one().n);
    if (n < (kind === 'badsig' ? REFUSE_AT_BADSIG : REFUSE_AT_OTHER)) return false;
    this.d.sql.exec(`INSERT OR IGNORE INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)`, maker, day, reason, this.d.now());
    this.d.alert('account_refused', `${maker} is refused for ${day}: ${reason}`);
    return true;
  }

  private async onRevert(p: WireProposal, rev: RevertInfo, ctx: { sent: boolean; data: Hex; dropped: { hash: Hex; reason: string }[]; trace?: CallFrame }) {
    const dropped = [...ctx.dropped];
    const refusedMakers: Hex[] = [];
    const hash = (rev.args[0] as Hex | undefined)?.toLowerCase() as Hex | undefined;
    const drop = (h: Hex | undefined, reason: string, counted?: 'badsig' | 'other') => {
      if (!h) return;
      dropped.push({ hash: h, reason });
      const rec = this.owner(p, h);
      if (rec && counted && ctx.sent && this.count(rec.order.maker, counted, `${rev.name ?? 'revert'}`)) refusedMakers.push(rec.order.maker);
    };
    const done = (extra: Partial<Outcome> = {}) => this.finish(p, { dropped, ...(refusedMakers.length ? { refusedMakers } : {}), ...extra });
    const abandon = (why: string) => {
      this.d.alert('match_abandoned', `${rev.name ?? 'unknown revert'}: ${why}`);
      return done();
    };
    const name = rev.name;

    // Out of gas, or InsufficientGas, in a SENT transaction: rules 1 to 5 (plan 6.2).
    // (a sent revert always has its trace here: with none, onReceipt has already stopped the market)
    if (ctx.sent && rev.outOfGas && ctx.trace) return this.onOutOfGas(p, dropped, ctx.trace);

    switch (name) {
      case 'NotOperator':
        this.alertOnce('not_operator', 'the exchange says the sending key is not an operator; nothing is sent until a deploy gives it one');
        return done();
      case 'Paused':
        this.alertOnce('held_paused', 'the exchange is paused; every market is held');
        return done();
      case 'TradingClosed':
        return done({ closed: true });
      case 'InsufficientGas': {
        // In the simulation: hold, and look again next tick; alert on the third in a row.
        const n = Number(this.meta('insufficient_gas_streak') ?? 0) + 1;
        this.setMeta('insufficient_gas_streak', String(n));
        if (n >= 3) this.d.alert('insufficient_gas_streak', `${n} simulations in a row ended in InsufficientGas`);
        return this.finish(p, dropped.length ? { dropped } : {});
      }
      case 'NonceMismatch':
        drop(hash, 'nonce');
        return done();
      case 'OrderCancelled':
        drop(hash, 'cancelled');
        return done();
      case 'Expired':
      case 'Overfill':
      case 'PartyRefused':
        drop(hash, name.toLowerCase());
        return done();
      case 'SelfMatch':
      case 'PriceNotCrossed':
      case 'WrongKind':
        return abandon('a matcher error; the match is abandoned');
      case 'BadMakerCount':
      case 'LengthMismatch':
      case 'BadSignatureLength':
      case 'FillMismatch':
      case 'SetPriceSum':
      case 'BadOrderField':
      case 'MarketMismatch':
        return abandon('a matcher or settler bug; a person looks at it');
      case 'BadSignature': {
        // Blame comes from bytes, never from an eth_call: the pair at that hash in the calldata that was
        // simulated or mined must equal the stored record, byte for byte.
        const rec = hash ? this.owner(p, hash) : undefined;
        if (!rec || !hash || !this.pairEquals(ctx.data, hash, rec)) {
          this.d.alert('bad_signature_mismatch', 'the pair in the call differs from the stored record (a settler bug); the market stops');
          return this.finish(p, { stopMarket: 'BadSignature with a pair that differs from the stored record', dropped });
        }
        drop(hash, 'bad_signature', 'badsig');
        return done();
      }
      case 'InsufficientCash':
      case 'InsufficientShares':
      case 'PositionCap':
        drop(hash, name === 'PositionCap' ? 'position_cap' : name === 'InsufficientCash' ? 'insufficient_cash' : 'insufficient_shares', 'other');
        return done();
      default:
        // Not a row of the table (a panic, an empty revert, another error): stop and look.
        this.d.alert('unknown_revert', `${name ?? 'no decodable error'}; the market stops`);
        return this.finish(p, { stopMarket: `an unrecognised revert (${name ?? 'none'})`, dropped });
    }
  }

  /// Plan 6.2 rules 1 to 5. Only a party whose sent check frame ran code outside the allowlist is blamed, and only
  /// once gate G-T has passed; anything else stops the market and nothing is dropped, counted or re-sent.
  private onOutOfGas(p: WireProposal, dropped: { hash: Hex; reason: string }[], trace: CallFrame) {
    const stop = (why: string) => {
      this.d.alert('out_of_gas_unattributed', why);
      return this.finish(p, { stopMarket: why, dropped });
    };
    if (!this.d.gateGt) return stop('a sent transaction ran out of gas; gate G-T has not passed, so no party is blamed automatically');
    return this.blame(p, dropped, trace, stop);
  }

  private async blame(p: WireProposal, dropped: { hash: Hex; reason: string }[], trace: CallFrame, stop: (why: string) => void) {
    const contract = await this.contractParties(p);
    const frames = checkFrames(trace, this.d.chain.exchange, contract.map((r) => r.order.maker));
    const blamed = contract.filter((r) => {
      const f = frames.get(r.order.maker);
      return f !== undefined && outsiders(f, r.order.maker).length > 0;
    });
    if (blamed.length === 0) return stop('a sent transaction ran out of gas and no party\'s check frame ran code outside the allowlist');
    const refusedMakers: Hex[] = [];
    for (const r of blamed) {
      dropped.push({ hash: r.hash, reason: 'out_of_gas_blame' });
      if (this.count(r.order.maker, 'badsig', 'out of gas in a sent transaction')) refusedMakers.push(r.order.maker);
    }
    this.finish(p, { dropped, refusedMakers });
  }

  private pairEquals(data: Hex, hash: Hex, rec: Rec): boolean {
    const m = decodeMatch(data);
    if (!m) return false;
    const pairs = [
      { o: m.taker, s: m.takerSig },
      ...m.makers.map((o, i) => ({ o, s: m.makerSigs[i] })),
    ].filter((x) => orderHash(x.o, this.d.chain) === hash);
    if (pairs.length === 0) return false;
    const want = toTuple(rec.order);
    return pairs.every((x) => x.s.toLowerCase() === rec.signature.toLowerCase() && (Object.keys(want) as (keyof typeof want)[]).every((k) => (k === 'maker' ? String(x.o.maker).toLowerCase() === want.maker : x.o[k] === want[k])));
  }
}
