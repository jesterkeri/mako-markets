// A value computed at most once per `ttlMs` and shared by every caller, with a HARD age limit: it is never served once
// older than `ttlMs`, and a failed refresh is a failure, not the previous value. Next's `unstable_cache` cannot promise
// either: past its revalidate time it returns the old entry and refreshes in the background, and when that refresh
// fails it keeps returning the old entry (adversary on d5b3701), so a quiet spell or an outage showed old figures as
// fresh. Per server instance; the CDN in front shares one answer across viewers.

export type Memoized<T> = { value: T; at: number };

export function ttlMemo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<Memoized<T>> {
  let last: Memoized<T> | null = null;
  let inflight: Promise<Memoized<T>> | null = null;
  return () => {
    if (last && Date.now() - last.at < ttlMs) return Promise.resolve(last);
    // Concurrent callers share one refresh rather than each starting their own.
    if (!inflight) {
      inflight = fn()
        .then((value) => (last = { value, at: Date.now() }))
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
