// A model of the avatar sweep set (src/lib/avatar-sweep.ts) as the Upstash store holds it: one sorted set of Blob
// pathnames scored by the store's clock. Stands in for `upstashCommand` and understands exactly the three scripts
// avatar-sweep.ts sends (mark, read a batch past the grace, remove if the score is unchanged), told apart by the Redis
// commands each one runs.
export type FakeSweepStore = {
  /// pathname -> score (ms on the store's clock)
  members: Map<string, number>;
  /// The store's clock; tests move it.
  now: number;
  /// When true every command fails as if the store were unreachable.
  down: boolean;
  /// A pathname here fails its marks (the store refuses that write), others still work.
  failMark: Set<string>;
  /// Every mark, in order, as `mark <pathname>`; a test can point this at its own call log.
  log: string[];
  upstash: (args: (string | number)[]) => Promise<unknown>;
};

export function fakeSweepStore(log: string[] = []): FakeSweepStore {
  const s: FakeSweepStore = {
    members: new Map(),
    now: 1_800_000_000_000,
    down: false,
    failMark: new Set(),
    log,
    upstash: async (args) => {
      if (s.down) throw new Error('upstash unreachable');
      const [, script, , , ...argv] = args.map(String);
      if (script.includes('ZRANGEBYSCORE')) {
        const [graceMs, limit] = argv.map(Number);
        return [...s.members]
          .filter(([, score]) => score <= s.now - graceMs)
          .sort((a, b) => a[1] - b[1])
          .slice(0, limit)
          .flatMap(([m, score]) => [m, String(score)]);
      }
      if (script.includes('ZREM')) {
        const [member, score] = argv;
        if (s.members.has(member) && String(s.members.get(member)) === score) {
          s.members.delete(member);
          return 1;
        }
        return 0;
      }
      if (script.includes('ZADD')) {
        const [member] = argv;
        s.log.push(`mark ${member}`);
        if (s.failMark.has(member)) throw new Error('upstash refused');
        s.members.set(member, s.now);
        return s.now;
      }
      throw new Error(`unscripted ${script}`);
    },
  };
  return s;
}
