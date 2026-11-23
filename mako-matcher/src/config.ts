import { getAddress, isAddress, type Hex } from 'viem';
import type { Env } from './env';

/// Plan 4.1: the order's price is whole cents, 1 to 99.
export const MIN_PRICE = 1;
export const MAX_PRICE = 99;
/// Plan 4.1: size is a multiple of 10^4 share base units (the lot); 1 share = 10^6.
export const LOT = 10_000n;
/// Plan 6.2 step 1: an order rests only at 10 shares or more (10 x 10^6 base units).
export const MIN_RESTING_SIZE = 10_000_000n;
/// Plan 4.3: expiration is at most 7 days ahead; the app never signs 0 and intake refuses it.
export const MAX_EXPIRY_AHEAD_S = 7 * 24 * 3600;
/// Plan 4.2 / 4.4: the contract's MAX_SIG_LEN. Intake refuses anything longer (copy C5) and anything empty.
export const MAX_SIG_LEN = 195;
/// Plan 6.2 step 2: the gas allowance of the isValidOrderSignature eth_call.
export const SIG_CHECK_CALL_GAS = 1_000_000n;
/// Plan 5: 20 open orders per wallet per market.
export const MAX_OPEN_ORDERS = 20;
/// Codex MATCHER R3 F2 (owner, 2026-11-22): at most this many resting orders in one market, so one search and one
/// tick have a bound. Intake refuses a new order while the market holds this many.
export const MAX_BOOK_ORDERS = 1_000;
/// Adversary R9 on 32f230f: the work one alarm tick may spend searching, in the units `MatchOpts.work` counts (one per
/// order scanned per option, per price level read per candidate fill, per subset-sum shift; see match.ts). Counted, not
/// timed: a Worker's clock does not advance during computation. A tick stops before the next taker once this is spent
/// (always trying at least one), and the next tick continues below it. Calibrated in workerd so the slowest tick on
/// the worst books found (test/adv9-cpu.test.ts, test/tick-budget.test.ts) stays near 1 s.
export const TICK_WORK = 40_000_000;
/// Codex MATCHER R4 F1: the first proposal of a matching pass checks every maker on the book at once, the refused
/// roles in multicalls of this many wallets and the settler's refusal list for the day in one read. With
/// MAX_BOOK_ORDERS that is at most 4 + 1 reads per pass; with the alarm's other reads (chain id 1, block number 1, up
/// to MAX_LOG_CHUNKS_PER_TICK log chunks, the settler's held list 1, the hand-off 1) or intake's (at most 9), an
/// invocation stays well under wrangler.toml's `subrequests = 50`.
export const ROLE_CHUNK = 250;
/// An idle book (a whole pass found nothing and nothing changed) is still searched again at least this often, for
/// what the book does not show (a refused role lifted on chain).
export const IDLE_RECHECK_MS = 10 * 60_000;
/// Plan 3.1: MAX_MAKERS.
export const MAX_MAKERS = 10;
/// The market Durable Object wakes this often while its book is not empty.
export const TICK_MS = 10_000;
/// Plan 6.2: the book feed is at most this old.
export const FEED_MAX_AGE_MS = 2_000;
/// The public Monad RPC caps eth_getLogs at 100 blocks (DONE.md, reference_mako_rpc_reality).
export const LOG_CHUNK_BLOCKS = 100;
export const MAX_LOG_CHUNKS_PER_TICK = 5;
/// An outbound HTTP request is cut off after this long.
export const FETCH_TIMEOUT_MS = 10_000;
/// The largest request body, in characters, either the Worker or a market object will read.
export const MAX_BODY_BYTES = 8_192;
/// A whole request (all its chain reads) is cut off after this long.
export const REQUEST_BUDGET_MS = 25_000;
/// Alerts kept in the Durable Object's own table (newest).
export const MAX_ALERT_ROWS = 200;

export class ConfigError extends Error {}

export interface Config {
  exchange: Hex;
  chainId: number;
  rpcUrl: string;
  cancelSecret: string | null;
}

/// Reads the configuration, naming only the variable on failure (a URL can carry a key).
export function readConfig(env: Pick<Env, 'EXCHANGE_ADDRESS' | 'CHAIN_ID' | 'PUBLIC_RPC_URL' | 'PRIMARY_RPC_URL' | 'CANCEL_SECRET'>): Config {
  const rawExchange = env.EXCHANGE_ADDRESS?.trim();
  if (!rawExchange) throw new ConfigError('EXCHANGE_ADDRESS is not set');
  if (!isAddress(rawExchange, { strict: false })) throw new ConfigError('EXCHANGE_ADDRESS is not a valid address');
  const chainId = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || String(chainId) !== env.CHAIN_ID?.trim()) throw new ConfigError('CHAIN_ID is not a positive integer');
  // Phase A reads chain state only. The primary provider is used when its secret is set; the public RPC is the
  // default for local work. Phase B (traces) will require the primary one.
  const rpc = (env.PRIMARY_RPC_URL?.trim() || env.PUBLIC_RPC_URL?.trim() || '').trim();
  if (!rpc) throw new ConfigError('PRIMARY_RPC_URL and PUBLIC_RPC_URL are not set');
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new ConfigError('the RPC URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new ConfigError('the RPC URL must be HTTPS');
  return {
    exchange: getAddress(rawExchange),
    chainId,
    rpcUrl: rpc,
    cancelSecret: env.CANCEL_SECRET?.trim() || null,
  };
}

/// A refusal for UTC day D drops the orders booked before the end of D plus this. The market stamps an order with its own
/// clock and the settler stamps a refusal with its own day; a few seconds' difference at midnight must not let an order
/// booked "after" the refused day by one clock and "on" it by the other survive (adversary R17). Cost: a refused
/// account's orders booked in the first minute of the next day are dropped too.
export const DAY_EDGE_SLACK_MS = 60_000;

/// A market's in-flight mark older than this, for orders the settler holds nothing for, is released (the hand-off
/// that set it never reached the settler). The hand-off itself is one subrequest; this is far above it.
export const STALE_MARK_MS = 120_000;
