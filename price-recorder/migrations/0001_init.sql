-- price-recorder D1 schema, database mako-price-recorder (CHARTS_DS_PLAN r21, section 5.2).
-- Primary keys only, no secondary indexes (5.2), except the UNIQUE the plan names on checker_shard (3.6).
-- Prices are exact decimal strings of the 18-decimal integer (3.2): the database never compares prices.
-- The config row is seeded serve = 0, record = 0, so the Worker deploys dark and idle (section 11, 16 step 4).
-- Comments here use no semicolon: the migration reader splits statements on it.

-- One-minute candles (3.3). Every recorded minute has a row, closed and gap minutes included (no OHLC unless open).
CREATE TABLE candles_1m (
  feed TEXT NOT NULL,
  t INTEGER NOT NULL CHECK (typeof(t) = 'integer' AND t % 60 = 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown', 'stale', 'empty', 'incomplete', 'conflict')),
  o TEXT,
  h TEXT,
  l TEXT,
  c TEXT,
  n_reports INTEGER NOT NULL,
  n_open INTEGER NOT NULL,
  n_rejected INTEGER NOT NULL,
  open_obs INTEGER,
  close_obs INTEGER,
  max_stale_s INTEGER,
  fp TEXT,
  n_valid INTEGER NOT NULL,
  raw_fp TEXT,
  n_raw INTEGER NOT NULL,
  raw_rule INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  CHECK ((state = 'open') = (o IS NOT NULL AND h IS NOT NULL AND l IS NOT NULL AND c IS NOT NULL)),
  CHECK (state = 'open' OR (o IS NULL AND h IS NULL AND l IS NULL AND c IS NULL)),
  PRIMARY KEY (feed, t)
) WITHOUT ROWID;

-- Rollups (3.5): 15m and 1h from the bucket's 1m rows, 1d from the day's 1h rows. Coverage counters on every row.
CREATE TABLE candles_15m (
  feed TEXT NOT NULL,
  t INTEGER NOT NULL CHECK (typeof(t) = 'integer' AND t % 900 = 0),
  o TEXT,
  h TEXT,
  l TEXT,
  c TEXT,
  n_min_open INTEGER NOT NULL,
  n_min_closed INTEGER NOT NULL,
  n_min_gap INTEGER NOT NULL,
  n_min_retry INTEGER NOT NULL,
  CHECK ((o IS NULL) = (n_min_open = 0) AND (o IS NULL) = (h IS NULL) AND (o IS NULL) = (l IS NULL) AND (o IS NULL) = (c IS NULL)),
  PRIMARY KEY (feed, t)
) WITHOUT ROWID;

CREATE TABLE candles_1h (
  feed TEXT NOT NULL,
  t INTEGER NOT NULL CHECK (typeof(t) = 'integer' AND t % 3600 = 0),
  o TEXT,
  h TEXT,
  l TEXT,
  c TEXT,
  n_min_open INTEGER NOT NULL,
  n_min_closed INTEGER NOT NULL,
  n_min_gap INTEGER NOT NULL,
  n_min_retry INTEGER NOT NULL,
  CHECK ((o IS NULL) = (n_min_open = 0) AND (o IS NULL) = (h IS NULL) AND (o IS NULL) = (l IS NULL) AND (o IS NULL) = (c IS NULL)),
  PRIMARY KEY (feed, t)
) WITHOUT ROWID;

CREATE TABLE candles_1d (
  feed TEXT NOT NULL,
  t INTEGER NOT NULL CHECK (typeof(t) = 'integer' AND t % 86400 = 0),
  o TEXT,
  h TEXT,
  l TEXT,
  c TEXT,
  n_min_open INTEGER NOT NULL,
  n_min_closed INTEGER NOT NULL,
  n_min_gap INTEGER NOT NULL,
  n_min_retry INTEGER NOT NULL,
  CHECK ((o IS NULL) = (n_min_open = 0) AND (o IS NULL) = (h IS NULL) AND (o IS NULL) = (l IS NULL) AND (o IS NULL) = (c IS NULL)),
  PRIMARY KEY (feed, t)
) WITHOUT ROWID;

-- Newest report per feed (8.2). Its own timestamps, ages computed by the reader. v3 reports have no lastUpdate or status.
CREATE TABLE latest (
  feed TEXT PRIMARY KEY,
  price TEXT NOT NULL,
  obs INTEGER NOT NULL,
  last_update_ns TEXT,
  market_status INTEGER
);

-- The kill switch and the operator settings (section 11). Exactly one row, id = 1, integers only. serve and record
-- carry no declared type on purpose: an INTEGER column converts the text '1' to the integer 1 before any CHECK runs,
-- so the typeof CHECK could never reject it. Without a type the value is stored as given and '1' is refused.
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  serve NOT NULL CHECK (typeof(serve) = 'integer' AND serve IN (0, 1)),
  record NOT NULL CHECK (typeof(record) = 'integer' AND record IN (0, 1)),
  p_bf INTEGER NOT NULL CHECK (p_bf BETWEEN 0 AND 296),
  updated_at INTEGER NOT NULL,
  feeds_refused TEXT NOT NULL DEFAULT '["BAC","MA"]' CHECK (json_valid(feeds_refused) AND json_type(feeds_refused) = 'array'),
  live_unsupported TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(live_unsupported) AND json_type(live_unsupported) = 'array')
);
INSERT INTO config (id, serve, record, p_bf, updated_at) VALUES (1, 0, 0, 74, CAST(strftime('%s', 'now') AS INTEGER));

-- Single-writer lease and its fence (4.4). lease_guard is normally empty.
CREATE TABLE lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  until INTEGER NOT NULL,
  holder TEXT
);
INSERT INTO lease (id, until, holder) VALUES (1, 0, NULL);

CREATE TABLE lease_guard (
  ok INTEGER CHECK (ok = 1)
);

-- Backfill units (section 6).
CREATE TABLE todo (
  feed TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (typeof(hour) = 'integer' AND hour % 3600 = 0),
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (feed, hour)
) WITHOUT ROWID;

-- Evidence of contradictions (3.4, 3.5). same_second: two different valid reports at one second. refetch_mismatch: the
-- raw bytes of a proven minute changed between fetches. Never pruned.
CREATE TABLE conflicts (
  feed TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('same_second', 'refetch_mismatch')),
  minute INTEGER NOT NULL,
  obs INTEGER,
  keccak_a TEXT,
  keccak_b TEXT,
  fp_old TEXT,
  fp_new TEXT,
  n_valid_old INTEGER,
  n_valid_new INTEGER,
  raw_fp_old TEXT,
  raw_fp_new TEXT,
  n_raw_old INTEGER,
  n_raw_new INTEGER,
  rules_version_old TEXT,
  rules_version_new TEXT,
  seen_at INTEGER NOT NULL,
  CHECK (kind <> 'same_second' OR (obs IS NOT NULL AND keccak_a IS NOT NULL AND keccak_b IS NOT NULL AND rules_version_new IS NOT NULL)),
  CHECK (kind <> 'refetch_mismatch' OR (raw_fp_old IS NOT NULL AND raw_fp_new IS NOT NULL AND rules_version_old IS NOT NULL AND rules_version_new IS NOT NULL))
);

-- One row per tick (4.1, 4.2), pruned at 7 days. calls = Data Streams calls made (8.6 reads calls > 0).
CREATE TABLE runs (
  t INTEGER PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  n_429 INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  lag_s INTEGER,
  unauthorized TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unauthorized) AND json_type(unauthorized) = 'array'),
  key_failure INTEGER NOT NULL DEFAULT 0 CHECK (key_failure IN (0, 1))
);

-- Production invariant checker (3.6): the materialised shard list, its results and the cycle. Pruned 7 days after
-- the cycle completed.
CREATE TABLE checker_cycle (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  anchor_day INTEGER NOT NULL,
  feed_list_json TEXT NOT NULL CHECK (json_valid(feed_list_json) AND json_type(feed_list_json) = 'array'),
  feed_list_hash TEXT NOT NULL,
  checker_version TEXT NOT NULL,
  shards_total INTEGER NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0,
  n_ok INTEGER NOT NULL DEFAULT 0,
  n_diff INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER
);

CREATE TABLE checker_shard (
  cycle_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  feed TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, ordinal),
  UNIQUE (cycle_id, feed, day)
);

CREATE TABLE checker_result (
  cycle_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  feed TEXT NOT NULL,
  day INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'diff')),
  n_buckets INTEGER NOT NULL,
  n_diff INTEGER NOT NULL,
  first_diff TEXT,
  PRIMARY KEY (cycle_id, ordinal)
);

-- Symbols refused for new pools (8.6). Code only inserts (ON CONFLICT DO NOTHING): the tick and the live publisher.
-- Only the operator deletes, with the guarded command of 8.6. At most 34 rows.
CREATE TABLE feed_holds (
  symbol TEXT PRIMARY KEY,
  since INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('tick', 'publisher', 'operator'))
) WITHOUT ROWID;
