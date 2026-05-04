// ----------------------------------------------------------------------------
// recovery-codes.test.ts
//
// Pins:
//   - generateRecoveryCodes returns N codes, all in `XXXX-XXXX-XX` shape,
//     drawn from the documented alphabet, distinct within the batch
//   - hashRecoveryCode round-trips via bcrypt.compare and is case/dash
//     insensitive at the verify boundary
//   - verifyAndConsumeRecoveryCode under a mocked tx:
//       * returns { ok: false } when no candidate matches
//       * returns { ok: true, consumedId } when a candidate matches
//         and the conditional UPDATE returns 1 row
//       * returns { ok: false } when the conditional UPDATE returns
//         0 rows (race-lost path)
//       * holds the SELECT FOR UPDATE through the bcrypt loop (asserted
//         by .for('update') being called on the select chain)
//
// The mock tx exposes the chained Drizzle DSL surface the helper uses
// (select / from / where / for, update / set / where / returning) just
// enough to drive the three branches deterministically.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyAndConsumeRecoveryCode,
} from '../recovery-codes';

const ALPHABET_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{4}-[23456789abcdefghjkmnpqrstuvwxyz]{2}$/;

function makeTx(opts: {
  candidates: Array<{ id: string; codeHash: string }>;
  updateReturns: Array<{ id: string }>;
}) {
  const forUpdate = vi.fn().mockResolvedValue(opts.candidates);
  const selectWhere = { for: forUpdate };
  const selectFrom = { where: vi.fn().mockReturnValue(selectWhere) };
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue(selectFrom),
  });

  const updateReturning = vi.fn().mockResolvedValue(opts.updateReturns);
  const updateWhere = { returning: updateReturning };
  const updateSet = { where: vi.fn().mockReturnValue(updateWhere) };
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue(updateSet),
  });

  return {
    tx: { select, update } as never,
    forUpdate,
    selectFromWhere: selectFrom.where,
    update,
    updateWhere: updateSet.where,
  };
}

describe('recovery-codes', () => {
  it('generateRecoveryCodes produces 10 codes in XXXX-XXXX-XX shape from the safe alphabet', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      expect(c).toMatch(ALPHABET_RE);
    }
    // Distinct within the batch.
    expect(new Set(codes).size).toBe(10);
  });

  it('generateRecoveryCodes excludes ambiguous chars (0, o, i, l, 1)', () => {
    const codes = generateRecoveryCodes(50);
    const joined = codes.join('').replace(/-/g, '');
    expect(joined).not.toMatch(/[01oil]/);
  });

  it('hashRecoveryCode round-trips via bcrypt.compare', async () => {
    const code = 'abcd-efgh-jk';
    const hash = await hashRecoveryCode(code);
    const bcrypt = await import('bcryptjs');
    expect(await bcrypt.compare('abcdefghjk', hash)).toBe(true);
  });

  it('hashRecoveryCode is case-insensitive and dash-insensitive at verify boundary', async () => {
    const hash = await hashRecoveryCode('ABCD-EFGH-JK');
    const bcrypt = await import('bcryptjs');
    // The helper normalizes by stripping dashes + lowercasing on both
    // sides; the stored hash is over the normalized plaintext, so the
    // raw plaintext-with-dashes does NOT compare. This pins that
    // discipline.
    expect(await bcrypt.compare('ABCD-EFGH-JK', hash)).toBe(false);
    expect(await bcrypt.compare('abcdefghjk', hash)).toBe(true);
  });

  it('verifyAndConsumeRecoveryCode returns ok:true on match + successful conditional UPDATE', async () => {
    const code = 'abcd-efgh-jk';
    const hash = await hashRecoveryCode(code);
    const candidate = { id: 'row-1', codeHash: hash };

    const { tx, forUpdate, update, updateWhere } = makeTx({
      candidates: [candidate],
      updateReturns: [{ id: 'row-1' }],
    });

    const result = await verifyAndConsumeRecoveryCode({
      tx,
      userId: 'user-1',
      code,
    });
    expect(result).toEqual({ ok: true, consumedId: 'row-1' });
    expect(forUpdate).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it('verifyAndConsumeRecoveryCode returns ok:false when no candidate matches', async () => {
    const otherHash = await hashRecoveryCode('other-code-zz');
    const { tx, update } = makeTx({
      candidates: [{ id: 'row-1', codeHash: otherHash }],
      updateReturns: [], // unused on this path
    });

    const result = await verifyAndConsumeRecoveryCode({
      tx,
      userId: 'user-1',
      code: 'abcd-efgh-jk',
    });
    expect(result).toEqual({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('verifyAndConsumeRecoveryCode returns ok:false on race-lost (UPDATE returns 0 rows)', async () => {
    const code = 'abcd-efgh-jk';
    const hash = await hashRecoveryCode(code);

    const { tx, update } = makeTx({
      candidates: [{ id: 'row-1', codeHash: hash }],
      updateReturns: [], // concurrent consume already won
    });

    const result = await verifyAndConsumeRecoveryCode({
      tx,
      userId: 'user-1',
      code,
    });
    expect(result).toEqual({ ok: false });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('verifyAndConsumeRecoveryCode iterates candidates until first match', async () => {
    const matchingCode = 'abcd-efgh-jk';
    const matchingHash = await hashRecoveryCode(matchingCode);
    const otherHash = await hashRecoveryCode('other-code-zz');

    const { tx } = makeTx({
      candidates: [
        { id: 'row-other-1', codeHash: otherHash },
        { id: 'row-match', codeHash: matchingHash },
        { id: 'row-other-2', codeHash: otherHash },
      ],
      updateReturns: [{ id: 'row-match' }],
    });

    const result = await verifyAndConsumeRecoveryCode({
      tx,
      userId: 'user-1',
      code: matchingCode,
    });
    expect(result).toEqual({ ok: true, consumedId: 'row-match' });
  });
});
