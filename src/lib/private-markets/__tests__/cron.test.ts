// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/cron.test.ts
//
// Phase 2B-5 sub-phase A + maintenance: lib helpers behind the
// /api/cron/pm-indexer and /api/cron/pm-maintenance routes. Tests
// the orchestration glue (helper passes args through, catches+logs+
// rethrows on indexer; sweep + resnapshot run independently for
// maintenance) — not the underlying handlers (those have their own
// suites).
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

import { runPmIndexerCron, runPmMaintenanceCron } from '../cron';
import * as cleanupMod from '../cleanup';
import * as resnapshotMod from '../resnapshot';
import * as indexerMod from '../indexer';

const CHAIN_ID = 10143;
const CONTRACT = '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f' as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeDb(): unknown {
  return { __fake: true } as never;
}

function fakeClient(): PublicClient {
  return {} as PublicClient;
}

describe('runPmIndexerCron', () => {
  it('happy path: forwards args to runIndexerOnce, returns result + durationMs', async () => {
    const spy = vi
      .spyOn(indexerMod, 'runIndexerOnce')
      .mockResolvedValue({
        chainId: CHAIN_ID,
        mutex: 'acquired',
        fromBlock: 100,
        toBlock: 200,
        decodedEventCount: 0,
        marketsWritten: 0,
      });

    const r = await runPmIndexerCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 30685165n,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(r.chainId).toBe(CHAIN_ID);
    expect(r.result.mutex).toBe('acquired');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates mutex:busy without converting to throw', async () => {
    vi.spyOn(indexerMod, 'runIndexerOnce').mockResolvedValue({
      chainId: CHAIN_ID,
      mutex: 'busy',
      fromBlock: null,
      toBlock: null,
      decodedEventCount: 0,
      marketsWritten: 0,
    });
    const r = await runPmIndexerCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      deployBlock: 30685165n,
    });
    expect(r.result.mutex).toBe('busy');
  });

  it('throw → emits pm.error structured-log, rethrows', async () => {
    vi.spyOn(indexerMod, 'runIndexerOnce').mockRejectedValue(
      new Error('rpc 500'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runPmIndexerCron({
        db: fakeDb() as never,
        publicClient: fakeClient(),
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        deployBlock: 30685165n,
      }),
    ).rejects.toThrow('rpc 500');

    const errorLines = errSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((l) => l && l.kind === 'pm.error');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0].errorMessage).toBe('rpc 500');
  });
});

describe('runPmMaintenanceCron', () => {
  it('runs sweep + resnapshot, returns combined result', async () => {
    vi.spyOn(cleanupMod, 'sweepStalePending').mockResolvedValue({
      swept: 3,
    });
    vi.spyOn(resnapshotMod, 'resnapshotConfirmed').mockResolvedValue({
      resnapped: 5,
      skipped: 2,
    });

    const r = await runPmMaintenanceCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
    });

    expect(r.sweep).toEqual({ swept: 3 });
    expect(r.resnapshot).toEqual({ resnapped: 5, skipped: 2 });
    expect(r.sweepError).toBeUndefined();
    expect(r.resnapshotError).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('Codex r2 m3: sweep throw does NOT prevent resnapshot from running', async () => {
    vi.spyOn(cleanupMod, 'sweepStalePending').mockRejectedValue(
      new Error('sweep boom'),
    );
    const resnapSpy = vi
      .spyOn(resnapshotMod, 'resnapshotConfirmed')
      .mockResolvedValue({ resnapped: 7, skipped: 0 });

    const r = await runPmMaintenanceCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
    });

    expect(resnapSpy).toHaveBeenCalledOnce();
    expect(r.sweep).toBeNull();
    expect(r.sweepError).toBe('sweep boom');
    expect(r.resnapshot).toEqual({ resnapped: 7, skipped: 0 });
  });

  it('Codex r3 m3: resnapshot throw does NOT prevent sweep from running', async () => {
    const sweepSpy = vi
      .spyOn(cleanupMod, 'sweepStalePending')
      .mockResolvedValue({ swept: 4 });
    vi.spyOn(resnapshotMod, 'resnapshotConfirmed').mockRejectedValue(
      new Error('resnapshot boom'),
    );

    const r = await runPmMaintenanceCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
    });

    expect(sweepSpy).toHaveBeenCalledOnce();
    expect(r.sweep).toEqual({ swept: 4 });
    expect(r.resnapshot).toBeNull();
    expect(r.resnapshotError).toBe('resnapshot boom');
  });

  it('logs pm.error structured line on each independent throw', async () => {
    vi.spyOn(cleanupMod, 'sweepStalePending').mockRejectedValue(
      new Error('sweep boom'),
    );
    vi.spyOn(resnapshotMod, 'resnapshotConfirmed').mockRejectedValue(
      new Error('resnapshot boom'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPmMaintenanceCron({
      db: fakeDb() as never,
      publicClient: fakeClient(),
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
    });

    const errors = errSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.kind === 'pm.error');
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.handler).sort()).toEqual([
      'resnapshotConfirmed',
      'sweepStalePending',
    ]);
  });
});
