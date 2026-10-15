// Adversary pass on 110af9e (owner spec 2026-10-15): email accounts get SPONSOR_CAP_PER_USER_PER_DAY (20) gas-free
// transactions a day, and every user-facing place that states the number reads it from that one constant. The tour
// has a desktop body and a mobile body (HowToPlay.tsx renders step.bodyMobile on small screens), so both count.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SPONSOR_CAP_PER_USER_PER_DAY } from '@/lib/aa-constants';
import { TOUR_STEPS } from '@/lib/tour';

const SRC = join(process.cwd(), 'src');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || p === join(SRC, 'app', 'dev')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('adversary 110af9e: the gas-free daily cap is stated from the constant everywhere', () => {
  it('every tour line that states the gas-free daily count, desktop and mobile, states the constant', () => {
    const lines = TOUR_STEPS.flatMap((s) => [s.body, s.bodyMobile]).filter((l) => /no gas|gas-free/i.test(l ?? ''));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const n = l.match(/up to (\d+)/)?.[1];
      if (n !== undefined) expect(Number(n), l).toBe(SPONSOR_CAP_PER_USER_PER_DAY);
    }
  });

  it('no shipped source line hard-codes a number for the gas-free daily cap', () => {
    const literal = /(no gas|gas-free|gas sponsored)[^`'"\n]{0,60}\bup to \d+\b/i;
    const offenders = walk(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${f.slice(SRC.length + 1)}:${i + 1}` }))
        .filter(({ line }) => literal.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
