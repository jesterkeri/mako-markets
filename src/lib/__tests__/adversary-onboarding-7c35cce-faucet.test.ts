// Adversary pass on 7c35cce (owner spec 2026-10-09, rule 2 and 3): every shipped file that links to Circle's faucet
// also names the network to choose, and the faucet lines carry no em dash, no "we/our/us" and the singular brand.
// src/app/dev is excluded: those pages 404 outside MAKO_STAGE=dev (src/lib/dev-pages.ts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FAUCET_NETWORK, listStateCopy } from '@/lib/list-states';
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

const FAUCET_LINK = /CIRCLE_FAUCET_URL|TOUR_FAUCET_URL|faucet\.circle\.com/;

describe('adversary 7c35cce: faucet network everywhere', () => {
  it('every shipped file with a faucet link also names the network', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join('lib', 'list-states.ts')) && !f.endsWith(join('lib', 'tour.ts')))
      .filter((f) => {
        const s = readFileSync(f, 'utf8');
        const linksOut = /href=\{(CIRCLE_FAUCET_URL|TOUR_FAUCET_URL)\}|href="https:\/\/faucet\.circle\.com/.test(s);
        return linksOut && !/FAUCET_NETWORK|Monad Testnet/.test(s) && !/TOUR_STEPS|step\.body/.test(s);
      })
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
    expect(walk(SRC).some((f) => FAUCET_LINK.test(readFileSync(f, 'utf8')))).toBe(true);
  });

  it('the Test USDC tour copy and the empty Me state keep the copy rules', () => {
    const step = TOUR_STEPS.find((s) => s.name === 'Test USDC');
    const lines = [step?.body ?? '', step?.bodyMobile ?? '', listStateCopy('me', 'empty').body];
    for (const l of lines) {
      expect(l).toContain(FAUCET_NETWORK);
      expect(l).not.toMatch(/—/);
      expect(l).not.toMatch(/\b(we|our|us)\b/i);
      expect(l).not.toMatch(/Mako Markets/);
    }
  });
});
