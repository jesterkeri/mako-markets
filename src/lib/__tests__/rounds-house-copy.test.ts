// Rounds are hosted by the house, Mako Market's own scheduler (Joshua, 2026-10-08): no user-facing Rounds copy calls
// the host "a creator", including the house account's own fee readout (Codex RELEASE_R5 F1).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listStateCopy } from '../list-states';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Rounds copy says the house, not a creator', () => {
  it('the empty Rounds state', () => {
    const body = listStateCopy('rounds', 'empty').body;
    expect(body).toContain('the moment the house schedules it');
    expect(body).not.toMatch(/creator/i);
  });

  it('the round page, the schedule page', () => {
    for (const p of ['src/app/rounds/[id]/RoundClient.tsx', 'src/app/rounds/new/ScheduleClient.tsx']) {
      expect(read(p)).not.toMatch(/round&apos;s creator|invited creators|A creator can have/);
    }
    expect(read('src/app/rounds/[id]/RoundClient.tsx')).toContain('2% of the smaller side to the house');
    // Every user-facing string in the Rounds UI, not only the three phrases above (adversary on 2076459 found the
    // settled-round receipt's fee row): no "creator" as a word in quoted text.
    for (const p of ['src/app/rounds/[id]/RoundClient.tsx', 'src/app/rounds/new/ScheduleClient.tsx', 'src/app/rounds/RoundsClient.tsx', 'src/lib/use-round-tx.ts']) {
      const strings = read(p).match(/(['"`])(?:\\.|(?!\1).)*\1/g) ?? [];
      expect(strings.filter((q) => /\b(?:the|a|round's|round&apos;s) creators?\b/i.test(q)), p).toEqual([]);
    }
  });

  // Codex RELEASE_R5 F1: the phrase list above missed "Creator fee" labels. Every Rounds UI file, comments stripped:
  // no standalone "creator" at all. Identifiers (creatorFeeDue, isCreator) and property reads (round.creator) are code.
  it('no standalone "creator" anywhere in the Rounds UI code', () => {
    const files = [
      'src/app/rounds/[id]/RoundClient.tsx',
      'src/app/rounds/new/ScheduleClient.tsx',
      'src/app/rounds/new/page.tsx',
      'src/app/rounds/RoundsClient.tsx',
      'src/app/rounds/page.tsx',
      'src/lib/use-round-tx.ts',
    ];
    for (const p of files) {
      const code = read(p)
        .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      const hits = code.split('\n').filter((l) => /(?<![.\w])creators?\b/i.test(l));
      expect(hits, p).toEqual([]);
    }
  });
});
