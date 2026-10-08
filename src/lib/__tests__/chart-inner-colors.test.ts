// The chart library cannot parse color-mix(), so its grid and line colours are derived from the theme's hex tokens.
import { describe, expect, it, vi } from 'vitest';

vi.mock('lightweight-charts', () => ({ ColorType: { Solid: 'solid' }, CrosshairMode: {}, LineStyle: {}, createChart: vi.fn() }));

import { withAlpha } from '@/components/chart/ChartInner';

describe('withAlpha', () => {
  it('turns #rgb and #rrggbb into rgba at the given opacity', () => {
    expect(withAlpha('#EBE5D9', 0.06)).toBe('rgba(235, 229, 217, 0.06)');
    expect(withAlpha('#000', 0.12)).toBe('rgba(0, 0, 0, 0.12)');
    expect(withAlpha(' #FACC15 ', 0.5)).toBe('rgba(250, 204, 21, 0.5)');
  });

  it('anything else is null, so the caller keeps its fallback', () => {
    for (const v of ['', 'transparent', 'rgb(0,0,0)', 'color-mix(in srgb, #000 12%, transparent)', '#12345', '#ggg']) expect(withAlpha(v, 0.5), v).toBeNull();
  });
});
