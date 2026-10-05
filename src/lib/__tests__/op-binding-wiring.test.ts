// Every sponsored signature must pass the browser's signing check (src/lib/op-binding.ts). The only call to the
// embedded wallet's signSafeOpHash is inside aa-client's signSponsoredOp, which runs assertSignableOp first; any new
// direct call elsewhere fails this test (INBOX_GAP_PLAN r10 item 3 and item 6).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('signing wiring', () => {
  it('signSafeOpHash is called only inside signSponsoredOp, after assertSignableOp', () => {
    const callers = sources('src').filter((p) => !p.endsWith('embedded-signer.ts') && /\bsignSafeOpHash\(/.test(readFileSync(p, 'utf8')));
    expect(callers).toEqual([join('src', 'lib', 'aa-client.ts')]);
    const client = readFileSync(join('src', 'lib', 'aa-client.ts'), 'utf8');
    expect(client.match(/\bsignSafeOpHash\(/g)).toHaveLength(1);
    const helper = client.slice(client.indexOf('async function signSponsoredOp('));
    const body = helper.slice(0, helper.indexOf('\n}\n'));
    expect(body.indexOf('assertSignableOp(')).toBeGreaterThan(-1);
    expect(body.indexOf('assertSignableOp(')).toBeLessThan(body.indexOf('signSafeOpHash('));
  });
});
