// ----------------------------------------------------------------------------
// src/components/__tests__/outcome-label-for-market.test.ts
//
// Behavioral-table tests for the round-3 helper rule:
//
//   outcomeLabelForMarket overrides ONLY outcomes 1 and 2 when
//   `mType === MAKO` AND `labels !== null`. Every other case
//   delegates to the pure `outcomeLabel(o)` so REFUND, PENDING, and
//   the non-MAKO path stay byte-identical.
//
// The exhaustive 10-row table from the codex review plan is the
// invariant under test. A future refactor that "shortens" the helper
// into something like `[label1, label2, "REFUND", "—"][outcome]`
// would silently stomp on outcome 0 — these tests catch that.
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { MarketType } from '@/lib/contract';
import {
  outcomeLabel,
  outcomeLabelForMarket,
} from '@/components/admin-shared';
import type { MakoOutcomeLabels } from '@/lib/mako-labels';

const LABELS: MakoOutcomeLabels = { label1: 'APC', label2: 'PDP' };

describe('outcomeLabel (pure helper — must NOT change)', () => {
  it('returns the live contract values for each outcome', () => {
    expect(outcomeLabel(0)).toBe('—');
    expect(outcomeLabel(1)).toBe('YES');
    expect(outcomeLabel(2)).toBe('NO');
    expect(outcomeLabel(3)).toBe('REFUND');
  });
});

describe('outcomeLabelForMarket — MAKO with labels', () => {
  const market = { mType: MarketType.MAKO };

  it('outcome 1 → label_1', () => {
    expect(outcomeLabelForMarket(market, LABELS, 1)).toBe('APC');
  });

  it('outcome 2 → label_2', () => {
    expect(outcomeLabelForMarket(market, LABELS, 2)).toBe('PDP');
  });

  it('outcome 3 → REFUND (delegated, NOT overridden)', () => {
    expect(outcomeLabelForMarket(market, LABELS, 3)).toBe('REFUND');
  });

  it('outcome 0 → "—" (delegated, NOT overridden)', () => {
    expect(outcomeLabelForMarket(market, LABELS, 0)).toBe('—');
  });
});

describe('outcomeLabelForMarket — MAKO without DB labels (fallback)', () => {
  const market = { mType: MarketType.MAKO };

  it('outcome 1 → YES (default)', () => {
    expect(outcomeLabelForMarket(market, null, 1)).toBe('YES');
  });

  it('outcome 2 → NO (default)', () => {
    expect(outcomeLabelForMarket(market, null, 2)).toBe('NO');
  });

  it('outcome 3 → REFUND (delegated)', () => {
    expect(outcomeLabelForMarket(market, null, 3)).toBe('REFUND');
  });

  it('outcome 0 → "—" (delegated)', () => {
    expect(outcomeLabelForMarket(market, null, 0)).toBe('—');
  });
});

describe('outcomeLabelForMarket — non-MAKO market types', () => {
  it('FOOTBALL with labels present still delegates (labels are MAKO-only)', () => {
    /// Defensive: someone wired the labels prop through to a FOOTBALL
    /// row by mistake. The helper must NOT override — labels only
    /// apply to MAKO markets.
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, LABELS, 1),
    ).toBe('YES');
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, LABELS, 2),
    ).toBe('NO');
  });

  it('FOOTBALL without labels delegates', () => {
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, null, 1),
    ).toBe('YES');
  });

  it('FOOTBALL with outcome 3 (REFUND) delegates', () => {
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, null, 3),
    ).toBe('REFUND');
    /// And with labels — still REFUND, not stomped.
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, LABELS, 3),
    ).toBe('REFUND');
  });

  it('CRYPTO behaves identically to FOOTBALL (non-MAKO path)', () => {
    expect(
      outcomeLabelForMarket({ mType: MarketType.CRYPTO }, LABELS, 1),
    ).toBe('YES');
  });
});

describe('outcomeLabelForMarket — regression guard against index-style refactor', () => {
  /// If a future hand "shortens" the helper to something like
  /// `[labels?.label1 ?? '—', labels?.label2 ?? 'YES', 'REFUND', '—'][outcome]`
  /// every cell of the behavioral table below stays the same except
  /// for outcome 0 on a labeled MAKO market, which would shift from
  /// "—" to something derived from labels. This test pins outcome 0
  /// explicitly so the refactor would fail loudly.
  it('outcome 0 stays "—" regardless of MAKO/labels combination', () => {
    expect(
      outcomeLabelForMarket({ mType: MarketType.MAKO }, LABELS, 0),
    ).toBe('—');
    expect(outcomeLabelForMarket({ mType: MarketType.MAKO }, null, 0)).toBe(
      '—',
    );
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, LABELS, 0),
    ).toBe('—');
    expect(
      outcomeLabelForMarket({ mType: MarketType.FOOTBALL }, null, 0),
    ).toBe('—');
  });
});
