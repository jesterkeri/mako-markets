#!/usr/bin/env bash
# Put mako-rounds-watch's Data Streams and Healthchecks secrets into Cloudflare from Bitwarden, without any
# value passing through a chat, a command argument, a file or shell history. Values go to
# `wrangler secret put` on stdin only.
#
#   DATASTREAMS_API_KEY      from the note "Chainlink Data Streams testnet"     (field DATA_STREAMS_API_KEY)
#   DATASTREAMS_API_SECRET   from the same note                                 (field DATA_STREAMS_USER_SECRET)
#   HEALTHCHECKS_PING_URL    pasted when asked (hidden); its OWN check, period 5 min, grace 15 min
#
# The Telegram token and chat id go in the way the V4 watchdog's did:
#   ../../mako-design/scripts/bw-secret-to-worker.sh "<bot token item>" TELEGRAM_BOT_TOKEN .
#   ../../mako-design/scripts/bw-secret-to-worker.sh "<chat id item>"  TELEGRAM_CHAT_ID .
#
# Usage (in your own terminal, from the rounds-watch/ directory, logged in with `wrangler login`):
#   export BW_SESSION=$(bw unlock --raw)
#   scripts/watch-secrets.sh
set -euo pipefail
set +x

DS_NOTE="${DS_NOTE:-Chainlink Data Streams testnet}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v bw >/dev/null || die "bw not found"
command -v python3 >/dev/null || die "python3 not found"
[[ -f wrangler.toml ]] && grep -q '^name = "mako-rounds-watch"' wrangler.toml || die "run this from the rounds-watch/ directory"
[[ -n "${BW_SESSION:-}" ]] || die 'vault is not unlocked: run  export BW_SESSION=$(bw unlock --raw)  first'

cleanup() { unset v HC; bw lock >/dev/null 2>&1 || true; }
trap cleanup EXIT

bw sync >/dev/null

# field NOTE FIELD -> the value on stdout (captured, never printed by this script)
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

put() { # put NAME VALUE-on-stdin
  npx wrangler secret put "$1" >/dev/null || die "wrangler secret put $1 failed"
  printf 'set %s\n' "$1"
}

v=$(field "$DS_NOTE" DATA_STREAMS_API_KEY) || die "could not read the Data Streams key id"
printf '%s' "$v" | put DATASTREAMS_API_KEY
v=$(field "$DS_NOTE" DATA_STREAMS_USER_SECRET) || die "could not read the Data Streams secret"
printf '%s' "$v" | put DATASTREAMS_API_SECRET
unset v

printf 'Healthchecks ping URL (paste it; nothing will show): '
IFS= read -rs HC
printf '\n'
[[ "$HC" =~ ^https://hc-ping\.com/[A-Za-z0-9/_-]+$ ]] || die "that does not look like an https://hc-ping.com/... URL"
printf '%s' "$HC" | put HEALTHCHECKS_PING_URL

printf 'Data Streams and Healthchecks secrets set; Telegram via bw-secret-to-worker.sh, ROUNDS_ADDRESS in wrangler.toml [vars]\n'
