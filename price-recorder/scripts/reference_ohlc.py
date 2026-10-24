"""Independent reference for the one-minute candles (CHARTS_DS_PLAN 15.4).

Shares no code with the TypeScript recorder: its own ABI slicing of `fullReport` and of the report blob, its own
validity checks and its own minute rules (plan 3.1 and 3.3), from the raw page JSON of every vendored capture.
Writes test/fixtures/reference-ohlc.json; test/reference.test.ts requires the TypeScript builder to match it exactly,
and CI re-runs this script and fails if the committed file differs.

Run: python3 -I scripts/reference_ohlc.py        (from price-recorder/)
"""
import json
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(ROOT, "test", "fixtures")
STALE_EXCLUDE_S = 900
NS = 10**9


def load_feeds():
    feeds = {}
    for name in ("crypto-feeds.json", "rwa-feeds.json"):
        with open(os.path.join(ROOT, "..", "cf-worker", "src", name)) as f:
            for x in json.load(f)["feeds"]:
                feeds[x["feedId"].lower()] = (x["symbol"], int(x["schema"]))
    return feeds


def word(b, i):
    return b[32 * i : 32 * (i + 1)]


def uint(w):
    return int.from_bytes(w, "big", signed=False)


def sint(w):
    return int.from_bytes(w, "big", signed=True)


def blob_of(full_hex):
    """fullReport = (bytes32[3], bytes, bytes32[], bytes32[], bytes32): bytes32[3] inline in words 0..2, then the
    offset of the `bytes` field in word 3; at that offset, a length word and the data."""
    if not isinstance(full_hex, str) or not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*", full_hex):
        return None
    try:
        b = bytes.fromhex(full_hex[2:])
    except ValueError:
        return None
    if len(b) < 32 * 7:
        return None
    off = uint(word(b, 3))
    if off % 32 or off + 32 > len(b):
        return None
    n = uint(b[off : off + 32])
    if off + 32 + n > len(b):
        return None
    return b[off + 32 : off + 32 + n]


def second(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v >= 0 else None
    # A JSON number written 1792071096.0 parses as a float here but as the integer 1792071096 in JavaScript, which
    # the recorder cannot tell apart; accept an integral float so both sides read such a page alike.
    if isinstance(v, float):
        return int(v) if v.is_integer() and 0 <= v < 2**53 else None
    if isinstance(v, str) and re.fullmatch(r"0|[1-9][0-9]{0,14}", v):  # ASCII digits only, as the recorder
        return int(v)
    return None


def decode(e, feed_id, schema):
    """Returns (obs, report_hex_lower, fields) for a valid entry, else None."""
    if not isinstance(e.get("feedID"), str) or e["feedID"].lower() != feed_id:
        return None
    obs = second(e.get("observationsTimestamp"))
    if obs is None:
        return None
    blob = blob_of(e.get("fullReport"))
    if blob is None or len(blob) != 288:
        return None
    if blob[:2] != (b"\x00\x03" if schema == 3 else b"\x00\x08"):
        return None
    if "0x" + word(blob, 0).hex() != feed_id:
        return None
    valid_from, o = uint(word(blob, 1)), uint(word(blob, 2))
    if o != obs or valid_from > o:
        return None
    if schema == 3:
        price = sint(word(blob, 6))
        f = {"price": price, "status": None, "last": None}
    else:
        last, price, status = uint(word(blob, 6)), sint(word(blob, 7)), uint(word(blob, 8))
        if not (0 < last < (obs + 1) * NS):
            return None
        f = {"price": price, "status": status, "last": last}
    if price <= 0:
        return None
    return obs, e["fullReport"].lower(), f


def minute(entries, feed_id, schema, m):
    end = m + 60
    witness = False
    inputs = {}
    for e in entries:
        d = decode(e, feed_id, schema)
        if d is None:
            continue
        obs, rep, f = d
        if obs >= end:
            witness = True
        if m <= obs < end:
            inputs[(obs, rep)] = f
    if not witness:
        return {"state": "incomplete"}
    seconds = {}
    for (obs, rep) in inputs:
        seconds.setdefault(obs, []).append(rep)
    if any(len(v) > 1 for v in seconds.values()):
        return {"state": "conflict"}
    if not inputs:
        return {"state": "empty", "n_reports": 0}
    rows = sorted((obs, f) for (obs, _), f in inputs.items())
    fresh, cls = [], []
    max_stale = None
    for obs, f in rows:
        if schema == 3:
            c = "fresh"
        elif f["status"] == 2:
            age_ns = obs * NS - f["last"]
            c = "stale" if age_ns > STALE_EXCLUDE_S * NS else "fresh"
            s = age_ns // NS
            max_stale = s if max_stale is None else max(max_stale, s)
        elif f["status"] == 1:
            c = "closed"
        else:
            c = "unknown"
        cls.append(c)
        if c == "fresh":
            fresh.append((obs, f["price"]))
    out = {"n_reports": len(seconds), "n_open": len(fresh), "max_stale_s": max_stale}
    if fresh:
        prices = [p for _, p in fresh]
        out.update({"state": "open", "o": str(fresh[0][1]), "h": str(max(prices)), "l": str(min(prices)), "c": str(fresh[-1][1]), "open_obs": fresh[0][0], "close_obs": fresh[-1][0]})
    elif "stale" in cls:
        out["state"] = "stale"
    elif "unknown" in cls:
        out["state"] = "unknown"
    else:
        out["state"] = "closed"
    return out


def main():
    feeds = load_feeds()
    result = []
    d = os.path.join(FIX, "capture-2026-10-16")
    for name in sorted(os.listdir(d)):
        with open(os.path.join(d, name)) as f:
            cap = json.load(f)
        # Two shapes: a span capture ({feedId, pages: [{reports}]}) or one live-style page ({path, reports}).
        entries = [r for p in cap["pages"] for r in p["reports"]] if "pages" in cap else cap["reports"]
        feed_id = (cap.get("feedId") or entries[0]["feedID"]).lower()
        symbol, schema = feeds[feed_id]
        obs_all = [second(r.get("observationsTimestamp")) for r in entries]
        lo = min(o for o in obs_all if o is not None)
        start = lo - lo % 60
        hi = max(o for o in obs_all if o is not None)
        for m in range(start, hi + 1 - (hi % 60) + 60, 60):
            if m > hi:
                break
            row = minute(entries, feed_id, schema, m)
            row.update({"file": "capture-2026-10-16/" + name, "symbol": symbol, "t": m})
            result.append(row)
    out = os.path.join(FIX, "reference-ohlc.json")
    text = json.dumps(result, indent=1, sort_keys=True) + "\n"
    if "--check" in sys.argv[1:]:
        with open(out) as f:
            if f.read() != text:
                sys.exit("test/fixtures/reference-ohlc.json differs from a fresh run of this script")
        print("reference ok: %d minutes" % len(result))
        return
    with open(out, "w") as f:
        f.write(text)
    print("wrote %d minutes" % len(result))


main()
