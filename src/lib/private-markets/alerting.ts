// ----------------------------------------------------------------------------
// src/lib/private-markets/alerting.ts
//
// Phase 2B-5: structured-log helpers for the indexer + maintenance
// surfaces. Replaces the ad-hoc console.warn lines from 2B-3 / 2B-4
// with typed single-line JSON emissions on console.error (alerts) /
// console.warn (observations) / console.info (metrics).
//
// The schema is the canonical contract a future Phase 5 log-aggregation
// layer (Sentry / Datadog / etc) reads from WITHOUT changes to the
// handler call sites — see the Phase 5 forward-compat note in the 2B-5
// plan.
// ----------------------------------------------------------------------------

export type PmComponent = 'pm-indexer' | 'pm-maintenance' | 'pm-query';

/// Invariant violations — bugs / schema-drift / chain-DB disagreements
/// that should ALWAYS produce a loud, actionable alert.
export type PmAlertCode =
  | 'options-row-missing'
  | 'state-mismatch'
  | 'unknown-reason';

/// Expected observations — events that are part of normal operation
/// (cross-chunk ordering during backfill, transient RPC failures
/// during pending-claim queries) but worth logging for post-hoc
/// analysis.
export type PmObservation = 'orphan-event' | 'pending-claim-read-failed';

/// Operational metrics — periodic counters from sweep / resnapshot
/// ticks. Suppressed entirely on no-op ticks so logs stay quiet.
export type PmMetricCode =
  | 'stale-pending-swept'
  | 'resnapshot'
  | 'resnapshot-orphan-recovery'
  | 'resnapshot-state-deferred';

/// Errors — uncaught exceptions caught at cron-helper boundary so the
/// route can return 500 with sanitized payload while the full detail
/// lands in logs.
export type PmErrorCode = 'pm-indexer-failed' | 'pm-maintenance-failed';

export interface PmStructuredLogContext {
  component: PmComponent;
  /// `process<EventName>` for handler-emitted alerts; `cron`/`sweep`/
  /// `resnapshot` for maintenance-emitted alerts.
  handler: string;
  chainId: number;
  contractAddress: string;
  /// Optional for cron-level metrics that don't pertain to a single
  /// market (e.g. per-tick sweep summary).
  marketId?: number;
  txHash?: string;
  logIndex?: number;
  [k: string]: unknown;
}

/// Severity tier exposed in the JSON line — log aggregators key on
/// this when promoting individual lines to alerts vs breadcrumbs.
type PmSeverity = 'error' | 'warn' | 'info';

interface BasePmLogLine {
  kind: 'pm.alert' | 'pm.observation' | 'pm.metric' | 'pm.error';
  code: string;
  severity: PmSeverity;
  ts: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emit(severity: PmSeverity, line: object): void {
  const json = JSON.stringify(line);
  if (severity === 'error') {
    // eslint-disable-next-line no-console
    console.error(json);
  } else if (severity === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(json);
  } else {
    // eslint-disable-next-line no-console
    console.info(json);
  }
}

export function alertInvariantViolation(
  code: PmAlertCode,
  context: PmStructuredLogContext,
): void {
  const line: BasePmLogLine & PmStructuredLogContext = {
    kind: 'pm.alert',
    code,
    severity: 'error',
    ts: nowIso(),
    ...context,
  };
  emit('error', line);
}

export function logObservation(
  code: PmObservation,
  context: PmStructuredLogContext,
): void {
  const line: BasePmLogLine & PmStructuredLogContext = {
    kind: 'pm.observation',
    code,
    severity: 'warn',
    ts: nowIso(),
    ...context,
  };
  emit('warn', line);
}

export function logMetric(
  code: PmMetricCode,
  context: PmStructuredLogContext & {
    swept?: number;
    resnapped?: number;
    skipped?: number;
    auditRowCount?: number;
    eventName?: string;
    [k: string]: unknown;
  },
): void {
  const line: BasePmLogLine & typeof context = {
    kind: 'pm.metric',
    code,
    severity: 'info',
    ts: nowIso(),
    ...context,
  };
  emit('info', line);
}

export function logCronError(
  code: PmErrorCode,
  context: PmStructuredLogContext & {
    errorMessage: string;
    /// Optional raw error — when supplied, the cause chain is walked
    /// and postgres-js / driver fields (code, severity, detail, hint,
    /// position, internalPosition, where, schema, table, column,
    /// dataType, constraint, file, routine) are captured per link.
    /// Without this, Drizzle's "Failed query: <SQL>\nparams: ..."
    /// wrapper hides the actual PG error, which is what made the
    /// 2B-5 sweep failures opaque to debug.
    error?: unknown;
  },
): void {
  const { error, ...rest } = context;
  const line: BasePmLogLine & typeof rest & { errorCauseChain?: unknown[] } = {
    kind: 'pm.error',
    code,
    severity: 'error',
    ts: nowIso(),
    ...rest,
  };
  if (error !== undefined) {
    line.errorCauseChain = serializeCauseChain(error);
  }
  emit('error', line);
}

/// Walk the `.cause` chain (Node's standard error-chaining) and pull
/// the diagnostic fields driver libraries expose. Stops at depth 8 to
/// guard against pathological circular chains.
function serializeCauseChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    chain.push(serializeError(current));
    if (
      current instanceof Error &&
      current.cause &&
      current.cause !== current
    ) {
      current = current.cause;
    } else if (
      typeof current === 'object' &&
      current !== null &&
      'cause' in current &&
      (current as { cause?: unknown }).cause !== current
    ) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return chain;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const driverFields = [
      'code',
      'severity',
      'detail',
      'hint',
      'position',
      'internalPosition',
      'where',
      'schema',
      'table',
      'column',
      'dataType',
      'constraint',
      'file',
      'routine',
    ] as const;
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    for (const f of driverFields) {
      const v = (err as unknown as Record<string, unknown>)[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }
  return { value: String(err) };
}
