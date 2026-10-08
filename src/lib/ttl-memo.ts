// A value computed at most once per `ttlMs` and shared by every caller, with a HARD age limit: it is never served once
// older than `ttlMs`, and a failed refresh is a failure, not the previous value. Next's `unstable_cache` cannot promise
// either: past its revalidate time it returns the old entry and refreshes in the background, and when that refresh
// fails it keeps returning the old entry (adversary on d5b3701), so a quiet spell or an outage showed old figures as
// fresh. Per server instance; the CDN in front shares one answer across viewers.
//
// Age is measured on the monotonic clock (`performance.now()`), which never steps: a wall clock stepped back by any
// amount must not make an old value look fresh (adversary on bfc40c3). The wall-clock time `at` is kept only to tell
// readers when the value was read. Both are stamped when the read STARTS, so an age is never understated by how long
// the read took.

export type Memoized<T> = { value: T; at: number };

export function ttlMemo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<Memoized<T>> {
  let last: (Memoized<T> & { mono: number }) | null = null;
  let inflight: Promise<Memoized<T>> | null = null;
  return () => {
    if (last && performance.now() - last.mono < ttlMs) return Promise.resolve({ value: last.value, at: last.at });
    // Concurrent callers share one refresh rather than each starting their own.
    if (!inflight) {
      const mono = performance.now();
      const at = Date.now();
      inflight = fn()
        .then((value) => {
          last = { value, at, mono };
          return { value, at };
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
