// Fixed numbers from WATCHDOG_PLAN.md r15. Tests import these, so a change
// here shows up as a test diff rather than a silent drift.

export const CHAIN_ID = 10143;

/// Multicall3 at its canonical CREATE2 address (src/lib/chain.ts).
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/// Market ids per aggregate3 call, calls per HTTP request, requests per run.
export const IDS_PER_CALL = 50;
export const CALLS_PER_REQUEST = 4;
export const MAX_PAGE_REQUESTS = 10;
/// Ids a run can read: 10 x 4 x 50.
export const ID_BUDGET = IDS_PER_CALL * CALLS_PER_REQUEST * MAX_PAGE_REQUESTS;

/// Past this many markets full coverage is unavailable: the run is
/// ineffective and raises the out-of-envelope critical (r15 §5.1).
export const ENVELOPE_N = 2_000;

export const FETCH_TIMEOUT_MS = 10_000;
export const RUN_DEADLINE_MS = 200_000;
export const LEASE_MS = 270_000;

/// Workers allow six simultaneous connections per invocation (F23).
export const MAX_PARALLEL = 6;

/// Telegram: at most 4 messages (and 4 requests) per run; 4,096 characters each.
export const TELEGRAM_MAX_MESSAGES = 4;
export const TELEGRAM_MESSAGE_CHARS = 4_096;
export const CRITICAL_MESSAGES = 3;

/// Healthchecks body cap. The manifest is at most 10,040 bytes in-envelope.
export const HEALTHCHECKS_BODY_MAX = 20_000;

/// Critical reminders and the non-critical deferral limit (S3).
export const REMINDER_MS = 6 * 3600_000;
export const NONCRITICAL_MAX_WAIT_MS = 30 * 60_000;

/// Provider B's answer is only used if it is plausible (review r1, finding 1):
/// the finalized block's time must be within these bounds of the Worker's
/// clock, and the finalized block at most this far behind latest.
export const FINALIZED_MAX_AHEAD_MS = 60_000;
export const FINALIZED_MAX_BEHIND_MS = 15 * 60_000;
export const FINALIZED_MAX_LAG_BLOCKS = 1_000;

/// Second-source confirmation: the public RPC re-reads, at the same finalized
/// block, every id before a one-way transition (resolved bit, creation cursor)
/// and before any refund command. One request of 4 x 50 ids per run; more is
/// deferred to later runs (a large bootstrap is staged this way).
export const CONFIRM_IDS_PER_RUN = 200;
/// How long a stored alert may go without an independent re-read before the
/// run stops calling itself effective (slice-1 review r10).
///
/// This is a backstop for rotation being BROKEN, not a bound on ordinary
/// queueing, so it sits well above the worst case a healthy queue produces.
/// That worst case: at the 2,000-market envelope the recovery category's
/// reserved share is at least floor(200/3) = 66 ids a run, so every stored
/// alert is re-read within ceil(2000/66) = 31 runs, about 2 h 35 m at the
/// 5-minute cadence. 24 hours is roughly ten times that, so tripping it means
/// the queue is not rotating or the second source has been failing all day,
/// either of which the dead-man switch should hear about. A row merely waiting
/// its turn never trips it.
export const STALE_ALERT_MS = 24 * 3600_000;

/// Refund commands offered in one run. The command is meant to be copied and
/// run, so the list stays short; the rest keep their alerts due and are
/// offered in later runs (review r4).
export const MAX_COMMANDS_PER_RUN = 50;

/// Resolver RPC must be within this many blocks of provider B, either way (r4 §5.4).
export const RR_MAX_LAG_BLOCKS = 30;

/// Resolver gas balance warning (wei). resolveMarket costs about 0.01 MON.
export const RESOLVER_BALANCE_WARN_WEI = 500_000_000_000_000_000n; // 0.5 MON

/// Daily digest at 08:00 UTC.
export const DIGEST_HOUR_UTC = 8;

/// Probe target: market 74 exists, has a stable title and an empty comment list.
export const PROBE_MARKET_ID = 74;
export const PROBE_MARKET_TITLE = '<title>Will ETH close below $1,827 in 3 days? · Mako Market</title>';
export const PROBE_CHART_SYMBOL = 'BTC';

/// The command Joshua runs by hand, from the gas-only mako-refunder keystore.
export const REFUND_RPC = 'https://testnet-rpc.monad.xyz/';
export const REFUND_ACCOUNT = 'mako-refunder';

/// V4 forceRefund opens at closeTime + RESOLUTION_GRACE (d088ced L138, L579).
export const RESOLUTION_GRACE_S = 24 * 3600;
