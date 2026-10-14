#!/usr/bin/env bash
# Put the scheduler Worker's two secrets into Cloudflare from Bitwarden, without any value passing through a chat,
# a command argument, a file or shell history. Values go to `wrangler secret put` on stdin only.
#
#   HOUSE_1_PRIVATE_KEY   from the note "Mako rounds house creator 1 (testnet)"   (house-keys.sh creates it)
#   HOUSE_2_PRIVATE_KEY   from the note "Mako rounds house creator 2 (testnet)"
#
# Usage (in your own terminal, from the rounds-scheduler/ directory, logged in with `wrangler login`):
#   export BW_SESSION=$(bw unlock --raw)
#   scripts/scheduler-secrets.sh
set -euo pipefail
set +x

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v bw >/dev/null || die "bw not found"
command -v python3 >/dev/null || die "python3 not found"
[[ -f wrangler.toml ]] && grep -q '^name = "mako-rounds-scheduler"' wrangler.toml || die "run this from the rounds-scheduler/ directory"
[[ -n "${BW_SESSION:-}" ]] || die 'vault is not unlocked: run  export BW_SESSION=$(bw unlock --raw)  first'

cleanup() { unset v; bw lock >/dev/null 2>&1 || true; }
trap cleanup EXIT

bw sync >/dev/null

field() {
  bw list items --search "$1" | NOTE="$1" FIELD="$2" python3 -c '
import sys, json, os
note, name = os.environ["NOTE"], os.environ["FIELD"]
hits = [i for i in json.load(sys.stdin) if i.get("name") == note]
if len(hits) != 1: sys.exit("expected one note named %r, found %d" % (note, len(hits)))
f = {x["name"]: x.get("value") for x in hits[0].get("fields") or []}
v = f.get(name)
if not v: sys.exit("note %r has no field %r" % (note, name))
sys.stdout.write(v.strip())'
}

put() {
  npx wrangler secret put "$1" >/dev/null || die "wrangler secret put $1 failed"
  printf 'set %s\n' "$1"
}

v=$(field "Mako rounds house creator 1 (testnet)" HOUSE_PRIVATE_KEY) || die "could not read house key 1"
printf '%s' "$v" | put HOUSE_1_PRIVATE_KEY
v=$(field "Mako rounds house creator 2 (testnet)" HOUSE_PRIVATE_KEY) || die "could not read house key 2"
printf '%s' "$v" | put HOUSE_2_PRIVATE_KEY
unset v

printf 'both secrets set; ROUNDS_ADDRESS, HOUSE_1_ADDRESS and HOUSE_2_ADDRESS still go in wrangler.toml [vars]\n'
