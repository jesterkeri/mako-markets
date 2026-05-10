// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/alerting.test.ts
//
// Phase 2B-5 sub-phase D: structured-log helpers. Tests assert the
// JSON shape + severity + scoping of `console.warn`/`console.error`
// emissions inside process* handlers.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  alertInvariantViolation,
  logObservation,
  logMetric,
  logCronError,
  type PmStructuredLogContext,
} from '../alerting';

afterEach(() => {
  vi.restoreAllMocks();
});

const baseCtx: PmStructuredLogContext = {
  component: 'pm-indexer',
  handler: 'processStaked',
  chainId: 10143,
  contractAddress: '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f',
  marketId: 7,
};

describe('alertInvariantViolation', () => {
  it('emits a single-line JSON to console.error with kind=pm.alert + severity=error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    alertInvariantViolation('options-row-missing', baseCtx);
    expect(errSpy).toHaveBeenCalledOnce();
    const line = errSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.kind).toBe('pm.alert');
    expect(parsed.code).toBe('options-row-missing');
    expect(parsed.severity).toBe('error');
    expect(parsed.component).toBe('pm-indexer');
    expect(parsed.handler).toBe('processStaked');
    expect(parsed.chainId).toBe(10143);
    expect(parsed.marketId).toBe(7);
    expect(typeof parsed.ts).toBe('string');
  });
});

describe('logObservation', () => {
  it('emits to console.warn (NOT console.error) with kind=pm.observation', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logObservation('orphan-event', baseCtx);
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.kind).toBe('pm.observation');
    expect(parsed.severity).toBe('warn');
  });

  it('round-trips optional fields (txHash, logIndex)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logObservation('orphan-event', {
      ...baseCtx,
      txHash: '0xaa',
      logIndex: 3,
    });
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.txHash).toBe('0xaa');
    expect(parsed.logIndex).toBe(3);
  });
});

describe('logMetric', () => {
  it('emits to console.info with kind=pm.metric', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logMetric('resnapshot', {
      component: 'pm-maintenance',
      handler: 'resnapshotConfirmed',
      chainId: 10143,
      contractAddress: '0xabc',
      resnapped: 5,
      skipped: 2,
    });
    const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(parsed.kind).toBe('pm.metric');
    expect(parsed.severity).toBe('info');
    expect(parsed.resnapped).toBe(5);
    expect(parsed.skipped).toBe(2);
  });
});

describe('logCronError', () => {
  it('emits to console.error with kind=pm.error and errorMessage', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logCronError('pm-indexer-failed', {
      component: 'pm-indexer',
      handler: 'runPmIndexerCron',
      chainId: 10143,
      contractAddress: '0xabc',
      errorMessage: 'rpc 500',
    });
    const parsed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(parsed.kind).toBe('pm.error');
    expect(parsed.severity).toBe('error');
    expect(parsed.errorMessage).toBe('rpc 500');
  });
});

// ----------------------------------------------------------------------------
// Codex r2 m2 + r4 m2: regression assertion that no `process*` handler
// body in indexer.ts contains a raw `console.warn` / `console.error` —
// only the dedicated alerting helpers. The orchestrator's
// `releaseMutex` `console.error` (outside `process*` bodies) is allowed.
// ----------------------------------------------------------------------------

describe('handler regression: process* bodies use helpers, not raw console', () => {
  it('no console.warn/error inside process<EventName> function bodies', () => {
    const path = resolve('src/lib/private-markets/indexer.ts');
    const source = readFileSync(path, 'utf-8');

    // Find every `export async function process<X>(` declaration and
    // capture the body via a brace-balance count starting at the first
    // `{` after the opening paren.
    const fnRegex = /export\s+async\s+function\s+(process[A-Z]\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    const offenders: Array<{ fn: string; line: number; snippet: string }> = [];

    while ((match = fnRegex.exec(source)) !== null) {
      const fnName = match[1];
      // Find the opening brace of the function body. Skip past the
      // parameter list closing paren.
      let depth = 0;
      let i = match.index;
      let bodyStart = -1;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            // Skip until next '{'
            let j = i + 1;
            while (j < source.length && source[j] !== '{') j++;
            bodyStart = j;
            break;
          }
        }
        i++;
      }
      if (bodyStart < 0) continue;

      // Brace-balance to find body end.
      let bDepth = 0;
      let bodyEnd = -1;
      for (let k = bodyStart; k < source.length; k++) {
        const ch = source[k];
        if (ch === '{') bDepth++;
        else if (ch === '}') {
          bDepth--;
          if (bDepth === 0) {
            bodyEnd = k;
            break;
          }
        }
      }
      if (bodyEnd < 0) continue;

      const body = source.slice(bodyStart, bodyEnd + 1);
      const consoleHits = body.match(/console\.(warn|error)\s*\(/g);
      if (consoleHits) {
        const lineNumber =
          source.slice(0, bodyStart).split('\n').length;
        offenders.push({
          fn: fnName,
          line: lineNumber,
          snippet: consoleHits.join(', '),
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
