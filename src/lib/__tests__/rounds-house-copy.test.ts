// Rounds are hosted by the house, Mako Market's own scheduler (Joshua, 2026-10-08): no user-facing Rounds copy calls
// the host "a creator". (The house account's own fee readout, shown only to it, keeps its internal name.)
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
  });
});
