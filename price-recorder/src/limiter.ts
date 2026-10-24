// ----------------------------------------------------------------------------
// price-recorder/src/limiter.ts
//
// The per-tick call limiter and budget (CHARTS_DS_PLAN 4.1, 4.4). Every Data Streams call of a tick goes through one
// Limiter, which starts a call only when ALL of these hold:
//   * the tick has not been halted (a 429 or a whole-key failure stops every further call, plan 4.1);
//   * fewer than MAX_PAGES_PER_TICK calls have started (34 live + 296 backfill = 330, plan 4.1);
//   * less than CALL_WINDOW_MS has passed since the lease was acquired (no new call after 45 s, plan 4.1, 4.4);
//   * fewer than RATE_PER_S calls started in the last RATE_WINDOW_MS (8/s: 80 % of the 10/s per endpoint, plan 4.1),
//     i.e. any half-open window [t, t + 1000 ms) holds at most 8 starts;
//   * fewer than CONCURRENCY calls are in flight (the 6 outgoing connections, plan 1).
// Grants are serialised in arrival order, so only one caller ever waits on the clock (which also keeps a test's
// virtual clock exact). A refused caller makes no call and is told why.
//
// The deadlines that bound the lease (plan 4.4), all measured on the worker from just before the lease was taken:
// no call starts after 45 s; each call times out at 8 s (REPORT_TIMEOUT_MS, client.ts), so fetching ends by 53 s; the
// write batch must be SENT by 58 s or the tick writes nothing; D1 bounds the batch at 30 s; 58 + 30 = 88 < 90 s TTL.
// ----------------------------------------------------------------------------

export const RATE_PER_S = 8;
export const RATE_WINDOW_MS = 1_000;
export const CONCURRENCY = 6;
export const MAX_PAGES_PER_TICK = 330;
export const CALL_WINDOW_MS = 45_000;
export const BATCH_DEADLINE_MS = 58_000;
/// Plan 3.4: at most 5 pages for the live minute, and at most 5 catch-up pages per feed per tick.
export const LIVE_PAGE_CAP = 5;
export const CATCHUP_PAGE_CAP = 5;

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type Refusal = 'halted' | 'budget' | 'deadline';
export type Limited<T> = { ran: true; value: T } | { ran: false; refusal: Refusal };

export class Limiter {
  /// Start times of every call, in order (tests read them).
  readonly starts: number[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];
  private turn: Promise<unknown> = Promise.resolve();
  private haltReason: string | null = null;

  constructor(
    private readonly clock: Clock,
    /// Worker time taken just before the lease statement was sent.
    private readonly startMs: number,
    private readonly maxCalls: number = MAX_PAGES_PER_TICK,
  ) {}

  /// Calls granted and sent. A granted call that was not sent (notSent) keeps its place in the pacing window.
  get calls(): number {
    return this.starts.length - this.unsentN;
  }

  private unsentN = 0;
  notSent(): void {
    this.unsentN++;
  }

  get halted(): string | null {
    return this.haltReason;
  }

  /// Stops every further call of this tick (calls already in flight finish).
  halt(reason: string): void {
    if (this.haltReason === null) this.haltReason = reason;
  }

  private async grant(): Promise<Refusal | null> {
    for (;;) {
      if (this.haltReason !== null) return 'halted';
      if (this.starts.length >= this.maxCalls) return 'budget';
      if (this.active >= CONCURRENCY) {
        await new Promise<void>((r) => this.waiters.push(r));
        continue;
      }
      const now = this.clock.now();
      if (now - this.startMs >= CALL_WINDOW_MS) return 'deadline';
      const k = this.starts.length - RATE_PER_S;
      const free = k >= 0 ? this.starts[k] + RATE_WINDOW_MS : now;
      if (now >= free) {
        this.starts.push(now);
        this.active++;
        return null;
      }
      await this.clock.sleep(free - now);
    }
  }

  /// Runs `fn` as one call when the limiter allows it; otherwise does not run it and says why.
  async run<T>(fn: () => Promise<T>): Promise<Limited<T>> {
    const granted = this.turn.then(() => this.grant());
    this.turn = granted.catch(() => undefined);
    const refusal = await granted;
    if (refusal !== null) return { ran: false, refusal };
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
