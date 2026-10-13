// The diagnostic error line never carries a URL, the Telegram token, a key or long hex.
import { describe, expect, it } from 'vitest';

import { describeError } from '../src/run';

describe('describeError', () => {
  it('keeps the type and drops every secret shape', () => {
    // A token-SHAPED value built at runtime (digits ':' 35 filler chars), so no secret scanner sees a literal token.
    const fakeToken = `${'9'.repeat(9)}:${'x'.repeat(35)}`;
    const msg = `fetch failed for https://api.telegram.org/bot${fakeToken}/sendMessage key=0x${'ab'.repeat(32)} hc https://hc-ping.com/1234-uuid ${fakeToken}`;
    const out = describeError(new TypeError(msg));
    expect(out.startsWith('TypeError: ')).toBe(true);
    for (const leak of ['telegram.org', '999999999:xxx', 'hc-ping', 'abab']) expect(out).not.toContain(leak);
    expect(out.length).toBeLessThanOrEqual(160);
  });
  it('handles non-Error throws', () => {
    expect(describeError('plain')).toBe('string: plain');
  });
});
