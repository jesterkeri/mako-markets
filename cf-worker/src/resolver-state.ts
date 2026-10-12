// ----------------------------------------------------------------------------
// cf-worker/src/resolver-state.ts
//
// The rules of ResolverState, the resolver's one durable store (RESOLVER_PRICE_PLAN r56 §4.9), as a pure state
// machine with no Cloudflare dependency, so every rule is unit-tested in Node. The Durable Object that hosts it
// wraps each method below in ONE storage transaction; nothing here awaits, so each method is all-or-nothing.
//
// Time is always the store's own clock (`now`, ms), passed in by the host; the run's clock is never compared with it.
// Every mutating method is fenced: it runs only for the run holding the current, unexpired lease (exact token).
// ----------------------------------------------------------------------------

/// §4.9 Lease: 180 s.
export const LEASE_MS = 180_000;
/// §4.9 Lease: the re-check before the raw send needs at least this much lease left (r41).
export const RECHECK_MIN_LEFT_MS = 20_000;
/// §4.9 Lease: released tokens are remembered this long, so a late take for one is refused (r46).
export const RELEASED_TOKEN_TTL_MS = 24 * 3600_000;
/// §4.9 Turns: an armed journal entry holds its nonce this long from its passing re-check (r52: Monad's 300 s pool
/// expiry, cited in the plan, plus the 8 s raw send before Monad's insert and margin for a forwarded copy).
export const NONCE_HOLD_MS = 345_000;
/// §4.9 Demotion: a candidate whose count reaches this is demoted at the start of the next run.
export const DEMOTE_AT = 2;
/// §4.9 Demotion: backoff 10 minutes, doubling with each level, capped at 1 hour.
export const BACKOFF_BASE_MS = 10 * 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;

export type TurnKind = 'no-data' | 'settlement';

export interface Lease {
  token: string;
  expiresAt: number;
}

export interface Candidate {
  marketId: number;
  /// Close second C, for ordering entrants that arrive in the same tick.
  close: number;
  /// Queue position from `nextSeq`; null while demoted (out of the ordering).
  position: number | null;
  count: number;
  level: number;
  /// Set while demoted; the first run after it re-enters the candidate.
  backoffEnd: number | null;
}

export type JournalResult = 'confirmed' | 'replaced' | 'dropped' | 'reverted' | 'nonce_consumed' | 'not_sent';

export interface JournalEntry {
  id: number;
  kind: TurnKind;
  marketId: number;
  nonce: number;
  calldataHash: string;
  /// The lease token of the run that wrote it: a release's outcome applies only to its own token's entries (r54).
  writer: string;
  /// The store's stamp on the entry write.
  enteredAt: number;
  /// The store's stamp from this entry's own passing re-check (r52). Only an armed entry holds its nonce, timed from
  /// here, hash or not; an entry whose re-check was refused, or that never reached one, holds nothing.
  armedAt: number | null;
  txHash: string | null;
  result: JournalResult | null;
  /// Set once the hold expired with no result (r49; not final: reconciliation may still resolve it).
  presumedDropped: boolean;
}

export interface LastTurn {
  kind: TurnKind;
  marketId: number;
  result: 'started' | 'sent' | 'failed' | 'stored-ready' | 'nonce-hold' | 'out-of-funds';
}

/// The turn's own effects, kept so a held turn can be voided without touching entries or returns (r48).
interface TurnUndo {
  prevLastTurn: LastTurn | null;
  marketId: number | null;
  prevPosition: number | null;
  prevCount: number;
}

export interface State {
  lease: Lease | null;
  /// Released tokens by `releasedKey(token)`, with their release time.
  released: Record<string, number>;
  newestVersion: number;
  nextSeq: number;
  candidates: Record<number, Candidate>;
  lastTurn: LastTurn | null;
  turnUndo: TurnUndo | null;
  journal: JournalEntry[];
  nextEntryId: number;
}

export const emptyState = (): State => ({
  lease: null,
  released: {},
  newestVersion: 0,
  nextSeq: 1,
  candidates: {},
  lastTurn: null,
  turnUndo: null,
  journal: [],
  nextEntryId: 1,
});

/// What the run's one release after a store timeout knows about its journal entry (r53).
export interface ReleaseOutcome {
  outcome: 'not-sent' | 'sent';
  entryId?: number;
  entry?: { kind: TurnKind; marketId: number; nonce: number; calldataHash: string };
}

export type TakeResult = 'granted' | 'held' | 'older' | 'token-released';

/// A prefixed key, so no token text ('__proto__', 'constructor') can collide with an object's own machinery.
const releasedKey = (token: string) => `t:${token}`;

export class FenceError extends Error {
  constructor() {
    super('fenced: not the current, unexpired lease');
  }
}

export class ResolverStateCore {
  constructor(public s: State) {}

  // ---------------------------------------------------------------- lease (§4.9 Lease and timing)

  /// The run's take, a conditional write (r44): an older version writes nothing and gets no lease; a token already
  /// released is refused however late the take lands (r45, r46); a live lease is not taken over.
  /// The version is recorded whatever else the take answers, so a newer run that finds the lease held still shuts
  /// out every later run of an older version (r43).
  take(token: string, version: number, now: number): TakeResult {
    // A malformed version is treated as older: it writes nothing and never lowers the newest seen.
    if (!Number.isSafeInteger(version) || version < this.s.newestVersion) return 'older'; // writes nothing at all
    this.s.newestVersion = version;
    this.forgetOldReleases(now);
    if (Object.hasOwn(this.s.released, releasedKey(token))) return 'token-released';
    if (this.s.lease && this.s.lease.expiresAt > now) return 'held';
    this.s.lease = { token, expiresAt: now + LEASE_MS };
    return 'granted';
  }

  /// Exact fencing (r42): the current lease's token, unexpired. A released or expired lease has no current token.
  fenced(token: string, now: number): boolean {
    return this.s.lease !== null && this.s.lease.token === token && this.s.lease.expiresAt > now;
  }

  private fence(token: string, now: number): void {
    if (!this.fenced(token, now)) throw new FenceError();
  }

  /// Fenced release (compare, then delete). Every release records its token, whether or not it deleted (r46).
  /// After a store timeout the run's one release, made after its raw send if any, also carries what the run knows
  /// about that send (r53, r54). It is applied whether or not the lease is still the run's, but only to an entry this
  /// token wrote, since it concerns only the run's own send:
  /// - `not-sent`: no raw send started, or the node answered it with an error (any JSON-RPC error object: it never
  ///   entered the pool, r55), so the entry (armed by a late re-check, or not) is `not_sent` and holds nothing;
  /// - `sent`: a raw send of either kind was made (a hash, or no answer), so the run's own `not_sent` mark is cleared
  ///   and an unarmed entry is armed from now, after Monad's insert (an entry armed by its re-check keeps that time),
  ///   or one is written armed from `entry` when none was (the entry write timed out, or the store-unavailable path).
  /// A release is applied whatever the run's version (r56): r43's "an older version writes nothing" covers decision
  /// state, while a release touches only the run's own token, lease and send. So a run that held the lease when a
  /// newer version's take was recorded still frees it, and a re-check of its landing late is refused.
  release(token: string, now: number, after?: ReleaseOutcome): boolean {
    if (after) this.applyOutcome(token, now, after);
    this.s.released[releasedKey(token)] = now;
    if (this.s.lease && this.s.lease.token === token) {
      this.s.lease = null;
      return true;
    }
    return false;
  }

  private applyOutcome(token: string, now: number, o: ReleaseOutcome): void {
    const e = o.entryId === undefined ? undefined : this.s.journal.find((x) => x.id === o.entryId);
    if (e && e.writer !== token) return; // another run's entry: not this release's to change
    if (e && e.result !== null && e.result !== 'not_sent') return; // reconciled already: final
    if (o.outcome === 'not-sent') {
      if (e) e.result = 'not_sent';
      return;
    }
    if (e) {
      e.result = null; // the run's own not_sent mark (a refused re-check) no longer holds: it sent after all (r55)
      if (e.armedAt === null) e.armedAt = now; // armed by its passing re-check: that time stands (r55)
      return;
    }
    if (!o.entry) throw new Error('a sent refund with no entry needs its nonce and calldata hash');
    const id = this.s.nextEntryId++;
    this.s.journal.push({ id, ...o.entry, writer: token, enteredAt: now, armedAt: now, txHash: null, result: null, presumedDropped: false });
  }

  private forgetOldReleases(now: number): void {
    for (const [t, at] of Object.entries(this.s.released)) if (now - at > RELEASED_TOKEN_TTL_MS) delete this.s.released[t];
  }

  /// The last store call before the raw send (r41, r49): enough lease left, and no OTHER armed, unreconciled entry
  /// holding `nonce`. A pass arms the asking entry `entryId` (r52); a refusal leaves it unarmed. Armed entries older
  /// than the hold are marked presumed_dropped and no longer hold (r49, r51).
  recheck(
    token: string,
    now: number,
    nonce: number,
    entryId: number,
  ): { ok: true } | { ok: false; reason: 'lease' | 'time-left' | 'nonce-held' } {
    if (!this.fenced(token, now)) return { ok: false, reason: 'lease' };
    if (this.s.lease!.expiresAt - now < RECHECK_MIN_LEFT_MS) return { ok: false, reason: 'time-left' };
    const own = this.s.journal.find((e) => e.id === entryId);
    if (!own || own.result !== null || own.armedAt !== null) throw new Error(`entry ${entryId} is not an open, unarmed entry`);
    let held = false;
    for (const e of this.s.journal) {
      // The asking entry is still unarmed here (checked above), so it is never its own hold.
      if (e.armedAt === null || e.result !== null || e.nonce < nonce) continue;
      if (now - e.armedAt < NONCE_HOLD_MS) held = true;
      else e.presumedDropped = true;
    }
    if (held) return { ok: false, reason: 'nonce-held' };
    own.armedAt = now;
    return { ok: true };
  }

  // ---------------------------------------------------------------- queue (§4.9 Within a settlement turn)

  /// One batch at run start (r34): every candidate whose count reached DEMOTE_AT leaves the ordering with a backoff.
  demoteBatch(token: string, now: number): number[] {
    this.fence(token, now);
    const demoted: number[] = [];
    for (const c of Object.values(this.s.candidates)) {
      if (c.backoffEnd !== null || c.count < DEMOTE_AT) continue;
      c.backoffEnd = now + Math.min(BACKOFF_BASE_MS * 2 ** c.level, BACKOFF_CAP_MS);
      c.level += 1;
      c.position = null;
      demoted.push(c.marketId);
    }
    return demoted;
  }

  /// The undemoted settlement candidate with the smallest position (read-only).
  head(skip: ReadonlySet<number> = new Set()): Candidate | null {
    let best: Candidate | null = null;
    for (const c of Object.values(this.s.candidates)) {
      if (c.position === null || c.backoffEnd !== null || skip.has(c.marketId)) continue;
      if (best === null || c.position < best.position!) best = c;
    }
    return best;
  }

  /// The kind this tick takes (§4.9 Turns): the one `lastTurn` did not, when both have candidates.
  chooseKind(hasNoData: boolean, hasSettlement: boolean): TurnKind | null {
    if (hasNoData && hasSettlement) return this.s.lastTurn?.kind === 'no-data' ? 'settlement' : 'no-data';
    if (hasNoData) return 'no-data';
    if (hasSettlement) return 'settlement';
    return null;
  }

  /// The start transaction (r33, r48): candidate bookkeeping from this run's read, then the turn's own effects.
  /// `entrants` are markets read as settlement candidates this run; `gone` were read and are no longer candidates;
  /// unread markets appear in neither and keep their positions (r29).
  startTurn(
    token: string,
    now: number,
    read: { entrants: { marketId: number; close: number }[]; gone: number[] },
    turn: { kind: TurnKind; marketId: number } | null,
  ): void {
    this.fence(token, now);
    // Every check before the first write, so a refused start transaction changes nothing.
    if (turn?.kind === 'settlement') {
      const c = this.s.candidates[turn.marketId];
      const standing = c !== undefined && c.position !== null && c.backoffEnd === null && !read.gone.includes(turn.marketId);
      const arriving =
        read.entrants.some((e) => e.marketId === turn.marketId) &&
        (c === undefined || (c.backoffEnd !== null && c.backoffEnd <= now));
      if (!standing && !arriving) {
        throw new Error(`market ${turn.marketId} is not an undemoted candidate`);
      }
    }
    for (const id of read.gone) delete this.s.candidates[id]; // absence ends count, level and position (r28, r29)
    // Entrants and returns from backoff take positions in (C, market id) order, before the turn's candidate (r27).
    const arriving: Candidate[] = [];
    for (const e of read.entrants) {
      const c = this.s.candidates[e.marketId];
      if (!c) {
        const fresh: Candidate = { marketId: e.marketId, close: e.close, position: null, count: 0, level: 0, backoffEnd: null };
        this.s.candidates[e.marketId] = fresh;
        arriving.push(fresh);
      } else if (c.backoffEnd !== null && c.backoffEnd <= now) {
        c.backoffEnd = null;
        c.count = 1; // one more counted turn demotes it again at the next level
        arriving.push(c);
      }
    }
    arriving.sort((a, b) => a.close - b.close || a.marketId - b.marketId);
    for (const c of arriving) c.position = this.s.nextSeq++;

    if (turn === null) {
      this.s.turnUndo = null;
      return;
    }
    const undo: TurnUndo = { prevLastTurn: this.s.lastTurn, marketId: null, prevPosition: null, prevCount: 0 };
    if (turn.kind === 'settlement') {
      const c = this.s.candidates[turn.marketId]!; // checked above
      undo.marketId = c.marketId;
      undo.prevPosition = c.position;
      undo.prevCount = c.count;
      c.position = this.s.nextSeq++; // to the back, after this tick's arrivals
      c.count += 1;
    }
    this.s.lastTurn = { kind: turn.kind, marketId: turn.marketId, result: 'started' };
    this.s.turnUndo = undo;
  }

  // ---------------------------------------------------------------- journal (§4.9 Journal)

  journalEntry(token: string, now: number, e: { kind: TurnKind; marketId: number; nonce: number; calldataHash: string }): number {
    this.fence(token, now);
    const id = this.s.nextEntryId++;
    this.s.journal.push({ id, ...e, writer: token, enteredAt: now, armedAt: null, txHash: null, result: null, presumedDropped: false });
    return id;
  }

  /// Reconciliation (accounting only, r31): never touches counts, positions or backoffs.
  reconcile(token: string, now: number, entryId: number, result: JournalResult): void {
    this.fence(token, now);
    const e = this.s.journal.find((x) => x.id === entryId);
    if (e) e.result = result;
  }

  // ---------------------------------------------------------------- the result transaction (§4.9 Turns)

  /// Records the turn's result. A decision-storing turn and both holds undo the count; holds also restore the
  /// position (r47, r48); only a nonce hold restores `lastTurn`, so an out-of-funds hold moves to the other kind.
  /// An out-of-funds answer is the node refusing the raw send before its pool, so the entry is `not_sent` and stops
  /// holding its nonce at once (plan r53); otherwise the refund at that nonce would wait 345 s.
  resultTurn(
    token: string,
    now: number,
    r: { result: LastTurn['result']; entryId?: number; txHash?: string; notSent?: boolean },
  ): void {
    this.fence(token, now);
    if (r.entryId !== undefined) {
      const e = this.s.journal.find((x) => x.id === r.entryId);
      if (e) {
        if (r.txHash) e.txHash = r.txHash;
        if (r.notSent || r.result === 'out-of-funds') e.result = 'not_sent';
      }
    }
    const undo = this.s.turnUndo;
    const c = undo?.marketId != null ? this.s.candidates[undo.marketId] : undefined;
    if (r.result === 'stored-ready' && c) c.count = undo!.prevCount;
    if ((r.result === 'nonce-hold' || r.result === 'out-of-funds') && c) {
      c.count = undo!.prevCount;
      c.position = undo!.prevPosition;
    }
    if (r.result === 'nonce-hold') this.s.lastTurn = undo?.prevLastTurn ?? null;
    else if (this.s.lastTurn) this.s.lastTurn = { ...this.s.lastTurn, result: r.result };
    this.s.turnUndo = null;
  }
}
