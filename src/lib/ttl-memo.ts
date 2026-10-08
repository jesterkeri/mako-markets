// A value computed at most once per `ttlMs` and shared by every caller, with a HARD age limit: it is never served once
// older than `ttlMs`, and a failed refresh is a failure, not the previous value. Next's `unstable_cache` cannot promise
// either: past its revalidate time it returns the old entry and refreshes in the background, and when that refresh
// fails it keeps returning the old entry (adversary on d5b3701), so a quiet spell or an outage showed old figures as
// fresh. Per server instance; the CDN in front shares one answer across viewers.
//
// Age is measured on the monotonic clock (`performance.now()`), which never steps: a wall clock stepped back by any
// amount must not make an old value look fresh (adversary on bfc40c3). The wall-clock time `at` is kept only to tell
// readers when the value was read, corrected by the monotonic age when it is served. Both are stamped when the read
// STARTS, so an age is never understated by how long the read took. A value counts as fresh only when both clocks say
// so.

export type Memoized<T> = { value: T; at: number };

export function ttlMemo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<Memoized<T>> {
  let last: (Memoized<T> & { mono: number }) | null = null;
  let inflight: Promise<Memoized<T>> | null = null;
  return () => {
    if (last) {
      const monoAge = performance.now() - last.mono;
      const wallAge = Date.now() - last.at;
      // Fresh only if BOTH clocks agree it is (adversary on 0a9ed23): the monotonic clock cannot be fooled by a wall
      // clock step, and the wall clock still advances if the process is ever frozen while the monotonic clock is not.
      if (monoAge < ttlMs && wallAge >= 0 && wallAge < ttlMs) {
        // When it was read, never later than the truth: a wall clock that was fast at the read and has since been
        // stepped back would otherwise make the figures look newer than they are.
        return Promise.resolve({ value: last.value, at: Math.min(last.at, Date.now() - monoAge) });
      }
    }
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
