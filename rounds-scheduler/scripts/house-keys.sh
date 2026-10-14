#!/usr/bin/env bash
# Create the two Rounds "house" creator keys and save each to Bitwarden, without a key ever passing through a
# chat, a command argument, a file or shell history. Prints ONLY the public addresses.
#
# A house key is one of MakoRoundsV1's immutable CREATORS. The settlement keeper uses it to call `schedule`
# (one BTC round an hour, the two keys alternating) and `claim` for the creator fee. It holds testnet MON for gas
# and the creator fees it earns, nothing else: it is not the deployer, the treasury, or the keeper's settle key.
#
# Usage (in your own terminal, from any directory):
#   export BW_SESSION=$(bw unlock --raw)
#   bash ~/myvscode_linux/mako-design/house-keys.sh
#
# Refuses to run if either note already exists: replacing a key that is on the creator list would strand that
# creator slot forever (the list cannot change after deployment).
set -euo pipefail
set +x

NOTES=("Mako rounds house creator 1 (testnet)" "Mako rounds house creator 2 (testnet)")

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v bw >/dev/null || die "bw not found"
command -v cast >/dev/null || die "cast (Foundry) not found"
command -v python3 >/dev/null || die "python3 not found"
[[ -n "${BW_SESSION:-}" ]] || die 'vault is not unlocked: run  export BW_SESSION=$(bw unlock --raw)  first'

cleanup() { unset HOUSE_KEY HOUSE_ADDR NOTE_NAME wallet item_json base saved; bw lock >/dev/null 2>&1 || true; }
trap cleanup EXIT

status=$(bw status | python3 -c 'import sys, json; print(json.load(sys.stdin).get("status", ""))')
[[ "$status" == "unlocked" ]] || die "vault status is '$status', expected 'unlocked'"
bw sync >/dev/null

# Check both names first, so a half-finished run never leaves one new key beside an old one.
for NOTE_NAME in "${NOTES[@]}"; do
  hits=$(bw list items --search "$NOTE_NAME" | NOTE_NAME="$NOTE_NAME" python3 -c '
import sys, json, os
print(sum(1 for i in json.load(sys.stdin) if i.get("name") == os.environ["NOTE_NAME"]))') || die "lookup failed"
  [[ "$hits" == "0" ]] || die "a note named \"$NOTE_NAME\" already exists; this script never replaces a key"
done

base=$(bw get template item)
addresses=()
n=0
for NOTE_NAME in "${NOTES[@]}"; do
  n=$((n + 1))
  # Generate. The JSON stays in a variable; only the address is ever printed.
  wallet=$(cast wallet new --json 2>/dev/null) || die "cast wallet new failed"
  HOUSE_ADDR=$(printf '%s' "$wallet" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["address"])')
  HOUSE_KEY=$(printf '%s' "$wallet" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["private_key"])')
  unset wallet
  export HOUSE_ADDR HOUSE_KEY NOTE_NAME

  python3 - <<'EOF' || die "generated values look wrong, nothing was saved"
import os, re, sys
if not re.fullmatch(r"0x[0-9a-fA-F]{40}", os.environ["HOUSE_ADDR"]): sys.exit("bad address")
if not re.fullmatch(r"0x[0-9a-fA-F]{64}", os.environ["HOUSE_KEY"]): sys.exit("bad key")
EOF

  item_json=$(BASE="$base" python3 - <<'EOF'
import json, os
item = json.loads(os.environ["BASE"])
item.update({
    "type": 2,
    "name": os.environ["NOTE_NAME"],
    "secureNote": {"type": 0},
    "login": None, "card": None, "identity": None,
    "notes": "Rounds house creator key for MakoRoundsV1 on Monad testnet (one of the immutable CREATORS). "
             "The settlement keeper uses it to schedule rounds and claim the creator fee. Holds testnet MON "
             "for gas and the fees it earns; never the deployer, the treasury or the keeper's settle key.",
    "fields": [
        {"name": "HOUSE_ADDRESS", "value": os.environ["HOUSE_ADDR"], "type": 0},
        {"name": "HOUSE_PRIVATE_KEY", "value": os.environ["HOUSE_KEY"], "type": 1},
    ],
})
print(json.dumps(item))
EOF
)
  saved=$(printf '%s' "$item_json" | bw encode | bw create item)
  unset item_json
  bw sync >/dev/null

  item_id=$(printf '%s' "$saved" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
  unset saved
  bw get item "$item_id" | python3 -c '
import sys, json, os
f = {x["name"]: x.get("value") for x in json.load(sys.stdin).get("fields") or []}
ok = f.get("HOUSE_PRIVATE_KEY") == os.environ["HOUSE_KEY"] and f.get("HOUSE_ADDRESS") == os.environ["HOUSE_ADDR"]
sys.exit(0 if ok else "read-back did not match")
' || die "house $n saved, but the read-back check failed; open the note in Bitwarden and check it"

  printf 'saved "%s"; read-back matches\n' "$NOTE_NAME"
  addresses+=("$HOUSE_ADDR")
  unset HOUSE_KEY
done

printf '\nhouse creator 1: %s\nhouse creator 2: %s\n' "${addresses[0]}" "${addresses[1]}"
printf 'next: send each a little testnet MON, and send both addresses to Claude for the creator list.\n'
