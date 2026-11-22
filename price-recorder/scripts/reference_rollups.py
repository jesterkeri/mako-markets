"""Independent reference for the rollups (CHARTS_DS_PLAN 3.5, 15.4).

Shares no code with the TypeScript recorder. Its input is test/fixtures/reference-ohlc.json, the minutes that
scripts/reference_ohlc.py computed on its own from the raw captured pages (and that the TypeScript candle builder must
match exactly, test/reference.test.ts). From those minutes it computes, with its own arithmetic on Python integers:
  * for every (symbol, UTC hour) holding a minute: the four 15m buckets and the 1h bucket, from the hour's minutes;
  * for every (symbol, UTC day) holding a minute: the 1d bucket, from that day's 1h buckets;
  * the 2h and 4h buckets, from the 1h buckets;
each at several horizons (the second up to which a minute with no row counts as elapsed, so as missing data).

Rules it implements (plan 3.5): OHLC over open minutes only (open of the first, close of the last, max of the highs,
min of the lows; closed and gap minutes carry no price); n_min_open, n_min_closed; n_min_gap = gap-state minutes
(unknown, stale, empty, incomplete, conflict) plus missing minutes that have elapsed (M + 60 <= horizon); n_min_retry
= missing minutes, elapsed or not, plus incomplete ones. A bucket built from sub-buckets sums their counters and
counts a missing sub-bucket as all its minutes missing.

Writes test/fixtures/reference-rollups.json; test/rollup-reference.test.ts requires the TypeScript rollups to match it
exactly, and CI re-runs this script with --check.

Run: python3 -I scripts/reference_rollups.py        (from price-recorder/)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(os.path.dirname(HERE), "test", "fixtures")

# 2026-10-15 13:31:30, 2026-10-15 20:01:30 and 2026-10-17 00:00:00 UTC: inside the NYSE-open hour, inside the hour
# that starts at the NYSE close, and after every captured minute.
HORIZONS = [1792071090, 1792094490, 1792195200]
GAP = {"unknown", "stale", "empty", "incomplete", "conflict"}
SPAN = {"15m": 900, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}


def floor_to(t, w):
    return t - t % w


def from_minutes(rows, start, span, horizon):
    """rows: {t: minute} for one symbol."""
    o = h = l = c = None
    n_open = n_closed = gap = retry = 0
    for m in range(start, start + span, 60):
        r = rows.get(m)
        if r is None:
            retry += 1
            if m + 60 <= horizon:
                gap += 1
            continue
        s = r["state"]
        if s == "open":
            n_open += 1
            ro, rh, rl, rc = int(r["o"]), int(r["h"]), int(r["l"]), int(r["c"])
            if o is None:
                o, h, l = ro, rh, rl
            h, l, c = max(h, rh), min(l, rl), rc
        elif s == "closed":
            n_closed += 1
        elif s in GAP:
            gap += 1
            if s == "incomplete":
                retry += 1
        else:
            raise SystemExit("unknown state %r" % s)
    return bucket(start, o, h, l, c, n_open, n_closed, gap, retry)


def from_buckets(subs, start, span, sub_span, horizon):
    """subs: {t: bucket} of width sub_span for one symbol."""
    o = h = l = c = None
    n_open = n_closed = gap = retry = 0
    for t in range(start, start + span, sub_span):
        b = subs.get(t)
        if b is None:
            retry += sub_span // 60
            gap += max(0, min(sub_span // 60, (horizon - t) // 60))
            continue
        n_open += b["n_min_open"]
        n_closed += b["n_min_closed"]
        gap += b["n_min_gap"]
        retry += b["n_min_retry"]
        if b["o"] is not None:
            bo, bh, bl, bc = int(b["o"]), int(b["h"]), int(b["l"]), int(b["c"])
            if o is None:
                o, h, l = bo, bh, bl
            h, l, c = max(h, bh), min(l, bl), bc
    return bucket(start, o, h, l, c, n_open, n_closed, gap, retry)


def bucket(t, o, h, l, c, n_open, n_closed, gap, retry):
    s = lambda v: None if v is None else str(v)
    return {"t": t, "o": s(o), "h": s(h), "l": s(l), "c": s(c), "n_min_open": n_open, "n_min_closed": n_closed, "n_min_gap": gap, "n_min_retry": retry}


def main():
    with open(os.path.join(FIX, "reference-ohlc.json")) as f:
        minutes = json.load(f)
    by_symbol = {}
    for r in minutes:
        rows = by_symbol.setdefault(r["symbol"], {})
        if r["t"] in rows:
            raise SystemExit("two minutes for %s %d" % (r["symbol"], r["t"]))
        rows[r["t"]] = r
    out = []
    for horizon in HORIZONS:
        for symbol in sorted(by_symbol):
            rows = by_symbol[symbol]
            hours = sorted({floor_to(t, 3600) for t in rows})
            days = sorted({floor_to(t, 86400) for t in rows})
            h1 = {}
            for hs in hours:
                for q in range(hs, hs + 3600, 900):
                    out.append(dict(from_minutes(rows, q, 900, horizon), horizon=horizon, symbol=symbol, tf="15m"))
                h1[hs] = from_minutes(rows, hs, 3600, horizon)
                out.append(dict(h1[hs], horizon=horizon, symbol=symbol, tf="1h"))
            for ds in days:
                out.append(dict(from_buckets(h1, ds, 86400, 3600, horizon), horizon=horizon, symbol=symbol, tf="1d"))
            for tf in ("2h", "4h"):
                for ws in sorted({floor_to(t, SPAN[tf]) for t in h1}):
                    out.append(dict(from_buckets(h1, ws, SPAN[tf], 3600, horizon), horizon=horizon, symbol=symbol, tf=tf))
    path = os.path.join(FIX, "reference-rollups.json")
    text = json.dumps(out, indent=1, sort_keys=True) + "\n"
    if "--check" in sys.argv[1:]:
        with open(path) as f:
            if f.read() != text:
                sys.exit("test/fixtures/reference-rollups.json differs from a fresh run of this script")
        print("reference ok: %d buckets" % len(out))
        return
    with open(path, "w") as f:
        f.write(text)
    print("wrote %d buckets" % len(out))


main()
