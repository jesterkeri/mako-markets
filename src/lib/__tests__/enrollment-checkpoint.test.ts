// The browser secret that binds an enrollment checkpoint to the browser that saw it (migration 0014).
import { describe, expect, it } from 'vitest';

import { checkpointHashFrom, checkpointTokenFrom, ENROLL_CHECKPOINT_COOKIE, hashCheckpointToken, newCheckpointToken } from '@/lib/enrollment-checkpoint';

const withCookie = (cookie?: string) => new Request('http://localhost/api/user/auth', { headers: cookie ? { cookie } : {} });

describe('the checkpoint secret', () => {
  it('is 32 random bytes, base64url, different every time; only its SHA-256 is stored', () => {
    const a = newCheckpointToken();
    const b = newCheckpointToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashCheckpointToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCheckpointToken(a)).not.toContain(a);
  });
  it('is read from its own cookie only, among others, and a malformed value counts as none', () => {
    const t = newCheckpointToken();
    expect(checkpointTokenFrom(withCookie(`a=1; ${ENROLL_CHECKPOINT_COOKIE}=${t}; b=2`))).toBe(t);
    expect(checkpointHashFrom(withCookie(`${ENROLL_CHECKPOINT_COOKIE}=${t}`))).toBe(hashCheckpointToken(t));
    expect(checkpointTokenFrom(withCookie())).toBeNull();
    expect(checkpointTokenFrom(withCookie(`x${ENROLL_CHECKPOINT_COOKIE}=${t}`))).toBeNull();
    expect(checkpointTokenFrom(withCookie(`${ENROLL_CHECKPOINT_COOKIE}=short`))).toBeNull();
    expect(checkpointTokenFrom(withCookie(`${ENROLL_CHECKPOINT_COOKIE}=${'a'.repeat(64)}`))).toBeNull(); // a hash is not a secret
    expect(checkpointHashFrom(withCookie())).toBeNull();
  });
});
