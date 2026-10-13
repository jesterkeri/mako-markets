// Me finds an account's rounds through the indexer (src/lib/me-rounds-indexer.ts) and reads them on the app's Rounds
// contract: both must be the SAME contract, or Me could miss a claim (adversary on 6469ed3). This pins the indexer's
// configured MakoRoundsV1 address to the app's release record.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUNDS_RELEASE_RECORD } from '../rounds-release-record';

describe('the indexer indexes the Rounds contract the app reads', () => {
  it('indexer/config.yaml MakoRoundsV1 address equals the release record', () => {
    const yaml = readFileSync(join(process.cwd(), 'indexer/config.yaml'), 'utf8');
    const block = yaml.slice(yaml.indexOf('- name: MakoRoundsV1'));
    const m = /address:\s*\n\s*-\s*"(0x[0-9a-fA-F]{40})"/.exec(block);
    expect(m).not.toBeNull();
    expect(ROUNDS_RELEASE_RECORD).not.toBeNull();
    expect(m![1].toLowerCase()).toBe(ROUNDS_RELEASE_RECORD!.address.toLowerCase());
  });
});
