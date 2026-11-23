// Intake (plan 6.2 "Place an order", steps 1 to 4, and 4.6 "Where it is checked", point 2).
//
// Every refusal is a stable code. `copy` names the plan 7.4 user-facing text where the plan names one: C5 (this
// account's signature check cannot be used on Mako's own markets) and C7 (unsupported wallet). Nothing is stored
// or reserved by a refusal.
import type { Hex } from 'viem';
import type { OrderTuple } from './abi';
import { MARKET_STATUS_OPEN } from './abi';
import { allOrders, buyCost, getMeta, insertOrder, reservations, setMeta, type BookOrder, getOrder } from './book';
import { blockNumber, ChainError, getCode, getStorageAt, isValidOrderSignature, readIntake, type ChainCtx } from './chain';
import { LOT, MAX_BOOK_ORDERS, MAX_EXPIRY_AHEAD_S, MAX_OPEN_ORDERS, MAX_PRICE, MAX_SIG_LEN, MIN_PRICE, MIN_RESTING_SIZE, type Config } from './config';
import type { Alert } from './alerts';
import { orderHash, parseOrderBody, recoverStrict, isSafeFormSignature } from './order';
import { classifyCode, FALLBACK_HANDLER_SLOT, isSupportedSafe } from './wallets';

export type Refusal = { ok: false; status: number; code: string; copy?: 'C5' | 'C7' };
export type IntakeResult = { ok: true; hash: Hex; order: BookOrder } | Refusal;

export interface IntakeDeps {
  sql: SqlStorage;
  cfg: Config;
  chain: ChainCtx;
  now(): number;
  alert: Alert;
  /// The market this Durable Object has proven it is (plan 6.1).
  marketId: bigint;
  /// Reads the settler's daily refusal list (plan 6.2: N = 1 / N = 3). True means refused for the rest of the UTC day.
  refusedToday(maker: Hex): Promise<boolean>;
  /// Checks the RPC endpoint is the exchange's chain, once per Durable Object lifetime.
  verifyChain(): Promise<void>;
}

const refuse = (code: string, status = 400, copy?: 'C5' | 'C7'): Refusal => ({ ok: false, status, code, ...(copy ? { copy } : {}) });

export async function intakeOrder(d: IntakeDeps, rawBody: unknown): Promise<IntakeResult> {
  const parsed = parseOrderBody(rawBody);
  if (!parsed.ok) return refuse('bad_request');
  const { order, signature } = parsed;

  // Step 1: the fields. The market first, so an order sent to another market's object is never booked here.
  if (order.marketId !== d.marketId) return refuse('wrong_market');
  const nowS = Math.floor(d.now() / 1000);
  if (order.expiration === 0n || order.expiration > BigInt(nowS + MAX_EXPIRY_AHEAD_S)) return refuse('bad_expiration');
  if (order.expiration <= BigInt(nowS)) return refuse('expired');
  if (order.price < MIN_PRICE || order.price > MAX_PRICE) return refuse('bad_price');
  if (order.size === 0n || order.size % LOT !== 0n) return refuse('bad_size');
  if (order.size < MIN_RESTING_SIZE) return refuse('size_below_minimum');
  const sigBytes = (signature.length - 2) / 2;
  if (sigBytes === 0) return refuse('bad_signature');
  if (sigBytes > MAX_SIG_LEN) return refuse('signature_too_long', 400, 'C5');

  const hash = orderHash(order, d.cfg);
  try {
    // Step 2: the signature. Local recovery with the contract's own step-1 rules first, for every maker; the chain
    // is asked only when that fails, and the endpoint is proven to be the right chain before it is believed.
    const sig = await checkSignature(d, order, hash, signature);
    if (sig) return sig;
    await d.verifyChain();

    // The log cursor must start no later than the state this order is judged on (plan 6.2: cancels made on chain).
    // Read for every order, not only when no cursor exists: another intake or the alarm can move or clear the cursor
    // while this one awaits the chain.
    const judgedFrom = await blockNumber(d.chain);

    // Step 3: one multicall: market, nonce, the order's own state, the maker's cash or shares.
    const chain = await readIntake(d.chain, order, hash);
    if (chain.market.status !== MARKET_STATUS_OPEN) return refuse('market_not_open');
    if (BigInt(nowS) >= chain.market.tradingClose) return refuse('market_closed');
    if (order.option >= chain.market.nOptions) return refuse('bad_option');
    if (order.nonce !== chain.nonce) return refuse('nonce_mismatch');
    if (chain.cancelled) return refuse('order_cancelled');
    if (chain.filled >= order.size) return refuse('order_filled');
    if (order.size - chain.filled < MIN_RESTING_SIZE) return refuse('size_below_minimum');

    // The settler's daily refusal list (Phase B writes it; the read side is here).
    let refused: boolean;
    try {
      refused = await d.refusedToday(order.maker);
    } catch {
      return refuse('refusal_list_unavailable', 503);
    }
    if (refused) return refuse('account_refused_today');

    // Step 4, in ONE synchronous block: nothing awaits between the checks below and the insert, so two orders in
    // flight at once cannot both pass the cap or the reservation check.
    // expired while this request awaited the chain or the settler (adversary R21): refused, not booked
    if (order.expiration <= BigInt(Math.floor(d.now() / 1000))) return refuse('expired');
    const live = allOrders(d.sql).filter((o) => o.expiration > BigInt(nowS));
    if (live.some((o) => o.hash === hash) || getOrder(d.sql, hash)) return refuse('duplicate_order');
    if (live.filter((o) => o.maker === order.maker).length >= MAX_OPEN_ORDERS) return refuse('too_many_orders');
    // Codex MATCHER R3 F2: a market-wide cap, so the matcher's work per search and per tick has a bound.
    if (live.length >= MAX_BOOK_ORDERS) return refuse('book_full', 409);
    const remaining = order.size - chain.filled;
    const res = reservations(live, order.maker, order.option);
    if (order.isBuy) {
      const need = buyCost(remaining, order.price, chain.fee, order.size);
      if (chain.balance < res.cash + need) return refuse('insufficient_cash');
    } else if (chain.balance < res.shares + remaining) {
      return refuse('insufficient_shares');
    }
    insertOrder(d.sql, order, hash, signature, chain.fee, chain.filled, d.now());
    // The option count never changes after creation; the matcher needs it for set matches.
    setMeta(d.sql, 'n_options', String(chain.market.nOptions));
    // Moved back, never forward: re-reading a block's cancels is harmless (a cancelled hash is refused at intake, and a
    // live order's nonce is at least any logged one), skipping one is not.
    const cur = getMeta(d.sql, 'log_cursor');
    if (cur === null || BigInt(cur) > judgedFrom) setMeta(d.sql, 'log_cursor', judgedFrom.toString());
    return { ok: true, hash, order: getOrder(d.sql, hash)! };
  } catch (err) {
    if (err instanceof ChainError) {
      d.alert('chain_read_failed', `${err.method} ${err.kind}`);
      return refuse('chain_read_failed', 503);
    }
    throw err;
  }
}

/// Plan 6.2 step 2 and 4.6. Returns a refusal, or null when the signature is acceptable.
async function checkSignature(d: IntakeDeps, o: OrderTuple, hash: Hex, signature: Hex): Promise<Refusal | null> {
  const rec = await recoverStrict(hash, signature);
  if (rec === o.maker) return null; // step 1 of the contract passes: no wallet code will run, whatever code the address holds

  // The signature does not recover the maker. A maker with no code, or only a 7702 delegation, must pass step 1:
  // otherwise the contract would go on to run the delegation's code (plan 4.6).
  await d.verifyChain();
  const code = await getCode(d.chain, o.maker);
  const kind = classifyCode(code);
  if (kind === 'none' || kind === 'delegation') return refuse('bad_signature');

  // Other code: only a supported wallet, signing in the Safe's plain form, read with eth_getCode and
  // eth_getStorageAt and never through the wallet's own functions. C7, before any eth_call.
  if (!isSafeFormSignature(signature)) return refuse('unsupported_wallet', 400, 'C7');
  const singleton = await getStorageAt(d.chain, o.maker, `0x${'0'.repeat(64)}`);
  const handler = await getStorageAt(d.chain, o.maker, FALLBACK_HANDLER_SLOT);
  if (!isSupportedSafe(code, singleton, handler)) return refuse('unsupported_wallet', 400, 'C7');

  // A supported wallet then goes through the exchange's own check. A failure there is C5: the address has code.
  const v = await isValidOrderSignature(d.chain, o, signature);
  if (v.kind === 'valid') return null;
  if (v.kind === 'invalid') return refuse('signature_check_failed', 400, 'C5');
  if (v.name === 'BadSignatureLength') return refuse('bad_signature');
  d.alert('signature_view_reverted', v.name);
  return refuse('chain_read_failed', 503);
}
