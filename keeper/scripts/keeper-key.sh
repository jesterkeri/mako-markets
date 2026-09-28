#!/usr/bin/env bash
# Create the rounds keeper's gas-only key and save it to Bitwarden, without the key ever passing through a
# chat, a command argument, a file or shell history. Prints ONLY the public address.
#
# The key signs `settle` and nothing else. It must hold testnet MON for gas and nothing more: it is not the
# deployer, not the treasury, and owns nothing (PREFLIGHT: "the keeper signs with a gas-only key, never the
# owner key").
#
# Usage (in your own terminal):
#   export BW_SESSION=$(bw unlock --raw)
#   keeper/scripts/keeper-key.sh
# Then: fund the printed address with a little testnet MON, set KEEPER_ADDRESS to it, and run
# keeper/scripts/keeper-secrets.sh to put the secrets into the Worker.
#
# Refuses to run if the note already exists: replacing a key that holds gas would strand it.
set -euo pipefail
set +x

NOTE_NAME="${NOTE_NAME:-Mako rounds keeper key (testnet)}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v bw >/dev/null || die "bw not found"
command -v cast >/dev/null || die "cast (Foundry) not found"
command -v python3 >/dev/null || die "python3 not found"
[[ -n "${BW_SESSION:-}" ]] || die 'vault is not unlocked: run  export BW_SESSION=$(bw unlock --raw)  first'

cleanup() { unset KEEPER_KEY KEEPER_ADDR wallet item_json base; bw lock >/dev/null 2>&1 || true; }
trap cleanup EXIT

status=$(bw status | python3 -c 'import sys, json; print(json.load(sys.stdin).get("status", ""))')
[[ "$status" == "unlocked" ]] || die "vault status is '$status', expected 'unlocked'"
bw sync >/dev/null

hits=$(bw list items --search "$NOTE_NAME" | NOTE_NAME="$NOTE_NAME" python3 -c '
import sys, json, os
print(sum(1 for i in json.load(sys.stdin) if i.get("name") == os.environ["NOTE_NAME"]))') || die "lookup failed"
[[ "$hits" == "0" ]] || die "a note named \"$NOTE_NAME\" already exists; this script never replaces a key"

# Generate. The JSON stays in a variable; only the address is ever printed.
wallet=$(cast wallet new --json 2>/dev/null) || die "cast wallet new failed"
KEEPER_ADDR=$(printf '%s' "$wallet" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["address"])')
KEEPER_KEY=$(printf '%s' "$wallet" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["private_key"])')
unset wallet
export KEEPER_ADDR KEEPER_KEY

python3 - <<'EOF' || die "generated values look wrong, nothing was saved"
import os, re, sys
if not re.fullmatch(r"0x[0-9a-fA-F]{40}", os.environ["KEEPER_ADDR"]): sys.exit("bad address")
if not re.fullmatch(r"0x[0-9a-fA-F]{64}", os.environ["KEEPER_KEY"]): sys.exit("bad key")
EOF
# No `cast wallet address --private-key` check here: it would put the key on a command line, visible to other
# processes. The Worker checks instead: it refuses to start unless KEEPER_PRIVATE_KEY derives KEEPER_ADDRESS.

base=$(bw get template item)
item_json=$(BASE="$base" NOTE_NAME="$NOTE_NAME" python3 - <<'EOF'
import json, os
item = json.loads(os.environ["BASE"])
item.update({
    "type": 2,
    "name": os.environ["NOTE_NAME"],
    "secureNote": {"type": 0},
    "login": None, "card": None, "identity": None,
    "notes": "Gas-only key for mako-rounds-keeper (Cloudflare Worker). Signs MakoRoundsV1.settle on Monad "
             "testnet and nothing else. Holds testnet MON for gas only; never the deployer or treasury.",
    "fields": [
        {"name": "KEEPER_ADDRESS", "value": os.environ["KEEPER_ADDR"], "type": 0},
        {"name": "KEEPER_PRIVATE_KEY", "value": os.environ["KEEPER_KEY"], "type": 1},
    ],
})
print(json.dumps(item))
EOF
)
saved=$(printf '%s' "$item_json" | bw encode | bw create item)
unset item_json base
bw sync >/dev/null

item_id=$(printf '%s' "$saved" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
bw get item "$item_id" | python3 -c '
import sys, json, os
f = {x["name"]: x.get("value") for x in json.load(sys.stdin).get("fields") or []}
ok = f.get("KEEPER_PRIVATE_KEY") == os.environ["KEEPER_KEY"] and f.get("KEEPER_ADDRESS") == os.environ["KEEPER_ADDR"]
sys.exit(0 if ok else "read-back did not match")
' || die "saved, but the read-back check failed; open the note in Bitwarden and check it"

printf 'saved the Secure Note "%s" (id %s); read-back matches\n' "$NOTE_NAME" "$item_id"
printf 'keeper address: %s\n' "$KEEPER_ADDR"
printf 'next: send it a little testnet MON, set KEEPER_ADDRESS to it, then run keeper/scripts/keeper-secrets.sh\n'
