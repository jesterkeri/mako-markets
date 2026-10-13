// The diagnostic error line never carries a URL, the Telegram token, a key or long hex.
import { describe, expect, it } from 'vitest';

import { describeError } from '../src/run';

describe('describeError', () => {
  it('keeps the type and drops every secret shape', () => {
    const msg = 'fetch failed for https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage key=0x' + 'ab'.repeat(32) + ' hc https://hc-ping.com/1234-uuid';
    const out = describeError(new TypeError(msg));
    expect(out.startsWith('TypeError: ')).toBe(true);
    for (const leak of ['telegram.org', '123456789:AAH', 'hc-ping', 'abab']) expect(out).not.toContain(leak);
    expect(out.length).toBeLessThanOrEqual(160);
  });
  it('handles non-Error throws', () => {
    expect(describeError('plain')).toBe('string: plain');
  });
});
