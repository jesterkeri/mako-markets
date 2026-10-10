# rounds-settle: settling Mako rounds with Chainlink CRE

A Chainlink CRE workflow that settles Mako's BTC "rounds" (`MakoRoundsV1`) on Monad testnet using
Chainlink Data Streams. It is built for the Monad Metropolis prize "Best workflow with CRE": it connects
a blockchain (Monad testnet) to an external data source (Data Streams), and CRE does the orchestration.

## What it does

Every minute:

1. **Cron trigger** (CRE `CronCapability`, schedule `15 * * * * *`: second 15 of every minute. Rounds close on
   minute marks, so the first run after a close comes 15 s later, past the 10 s settle delay; ten rounds closing
   together then all get a turn by close + 555 s).
2. **EVM reads**, two here (Monad testnet, at the last finalized block) and a third in step 4, within SPEC §5.5a's
   "at most 3":
   `pendingSettlement()` on `MakoRoundsV1` at `0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921`, then `DURATION()`
   and every `closeTimeOf(id)` in one Multicall3 `aggregate3` (`0xcA11bde05977b3631167028862bE2a173976CA11`).
   It picks one round at least `settleDelaySeconds` (10) past its close. If none is due, the run ends with
   `nothing-due`.
3. **HTTP fetch** (CRE `HTTPClient`, results checked by DON consensus) of the two BTC/USD Data Streams full
   reports the round needs: one observed at exactly `startTime`, one at exactly `closeTime`. Requests are signed
   with Chainlink's HMAC scheme. A report for the wrong feed or the wrong second is refused before anything is sent.
4. **Settle simulation** (SPEC §5.5 step 3, N20; the keeper does the same): an `eth_call` of
   `settle(roundId, anchor, close)` at the latest block. If it reverts (fee manager on, spread too wide, already
   settled), the run stops with `settle simulation reverted: nothing submitted` and no gas is spent.
5. **EVM write**: the DON signs `abi.encode(roundId, anchorReport, closeReport)` and CRE delivers it through
   Chainlink's KeystoneForwarder to `MakoRoundsCreAdapter.onReport`. The adapter calls `MakoRoundsV1.settle`.

The workflow never computes a price or an outcome. `MakoRoundsV1` checks both reports on-chain through
Chainlink's VerifierProxy (`0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64`) and works out the result itself.
A wrong report causes a revert. It can never produce a wrong settlement.

### Why an adapter

CRE's EVM write calls `onReport(bytes,bytes)` on a receiver contract. The deployed `MakoRoundsV1` has no
`onReport`. Its bytecode contains the `settle` selector `0x577b64a0` and not `0x805f2132`. A newer source
version has `onReport`, but that version is not deployed. `cre/contracts/src/MakoRoundsCreAdapter.sol` fills
the gap:

- only the configured forwarder can call `onReport`, and on the deployed-workflow instance only for a report
  whose workflow owner is the configured one (SPEC §5.1; the workflow ID is not checked, see below);
- it decodes `(uint256, bytes, bytes)` and calls the permissionless `settle`;
- it passes any revert from `settle` through unchanged.

It holds no funds: nothing is payable and there is no `receive` or `fallback`. It has no owner, no storage
and no settings, and it grants no privilege, because anyone can call `settle` directly with the same
arguments.

## Layout

```
cre/
  .gitignore                     keeps .env, node_modules, *.wasm and Foundry output out of git
  rounds-settle/                 CRE project root (run every cre command from here)
    project.yaml                 Monad testnet RPC (public, keyless)
    secrets.yaml                 secret NAMES -> environment variable names (no values)
    settle-rounds/               the workflow
      main.ts                    the handler: read -> fetch -> report -> write
      logic.ts                   pure logic (config, round picking, signing, report checks, encoding)
      rounds-abi.ts              MakoRoundsV1 ABI subset (selectors checked against the deployed bytecode)
      config.staging.json        Monad testnet config
      workflow.yaml              target "staging-settings"
      test/                      bun tests (39) + a real Data Streams fixture
  contracts/                     Foundry project for the adapter
    src/MakoRoundsCreAdapter.sol
    test/MakoRoundsCreAdapter.t.sol   15 unit tests + 1 fork test against the deployed contracts
```

## Facts this relies on, with sources

| Fact | Value | Source |
|---|---|---|
| CRE chain selector name for Monad testnet | `monad-testnet`, chain id 10143, selector `2183018362218727504` | `@chainlink/cre-sdk` 1.23.0 `dist/generated/chain-selectors/testnet/evm/monad-testnet.js` |
| KeystoneForwarder, Monad testnet (deployed workflows) | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | CRE forwarder directory (docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts); on-chain `typeAndVersion()` = `KeystoneForwarder 1.0.0` |
| MockKeystoneForwarder, Monad testnet (`simulate --broadcast`) | `0xB9F79d863261869B234c481D1f9A7af84AeAd192` | same directory; on-chain `typeAndVersion()` = `MockKeystoneForwarder 1.0.0` |
| BTC/USD Data Streams feed (testnet) | `0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439` | pinned by MakoRoundsV1; same id in the keeper |
| Data Streams REST | `https://api.testnet-dataengine.chain.link`, `GET /api/v1/reports?feedID=…&timestamp=…` | keeper code on `origin/feat/rounds-keeper` |

The forwarder directory says addresses can differ per CRE tenant. After `cre login`, confirm with
`cre workflow supported-chains`.

The signing, report checks and round selection are ported from the reviewed keeper code
(`origin/feat/rounds-keeper:rounds-delivery/src/index.ts`, commit `25e02c0`). That way both settlement
paths accept and refuse exactly the same reports. There are two differences, and both are documented in
`logic.ts`:

- HMAC uses `@noble/hashes`, because CRE's WASM runtime has no WebCrypto.
- CRE keeps no state between runs, so the keeper's "least recently tried" order cannot be copied, and no
  stateless rule matches it once a round is stuck. The rule: minute m serves the due rounds whose id mod 10 is
  m mod 10 (one per visit), and otherwise rotates over all due rounds. With no stuck round each run settles one
  round, so ten rounds closing together all get a turn by close + 555 s. A round alone in its slot gets a turn
  at least every 10 minutes. Rounds can share a slot through ordinary scheduling (rounds are booked up to 7 days
  ahead), and with a stuck round there is **no hard bound**: the measured worst first turn of a healthy round is
  17 runs in the adversary's targeted cases (pinned by a test) and 24 over 100,000 random cases. The keeper,
  which first tries at close + 300 s with least-recently-tried order, is the latency backstop and the capacity
  release gate (TASKS T0.1c); CRE latency is measured, not guaranteed.
- The workflow raises no alert of its own: a failed run shows as a failed CRE execution. N20's alerts come from
  the keeper and the watchdog.

The keeper waits 300 s after close, so CRE settles first whenever it is healthy.

## Checks that run without any secret

From `cre/rounds-settle/settle-rounds`:

```bash
bun install
bun test                 # 39 pass
bunx tsc --noEmit        # clean
```

From `cre/rounds-settle`:

```bash
cre workflow build settle-rounds --target staging-settings --non-interactive   # compiles to WASM
```

From `cre/contracts`:

```bash
forge test                                                                       # 16 pass
MONAD_RPC_URL=https://testnet-rpc.monad.xyz forge test --network monad --match-contract Fork -vv
```

The fork test deploys the adapter on a Monad testnet fork, wired to the real KeystoneForwarder and the real
`MakoRoundsV1`. It then shows that the deployed contract decodes the forwarded call and that its revert
(`NoSuchRound`) comes back through the adapter unchanged.

## Running `cre workflow simulate` (Joshua)

**1. Log in.** CRE CLI v1.34.0 refuses to simulate without a login. It stops with
`✗ Authentication required: not logged in and no CRE_API_KEY set`. Run `cre login` and finish the sign-in
in the browser.

**2. Supply the Data Streams secrets in this shell only.** Nothing gets written to disk, and the
variable names match `secrets.yaml`:

```bash
read -rs -p "Data Streams API key: " DATASTREAMS_API_KEY_VAR; echo; export DATASTREAMS_API_KEY_VAR
read -rs -p "Data Streams API secret: " DATASTREAMS_API_SECRET_VAR; echo; export DATASTREAMS_API_SECRET_VAR
```

These are the same Data Streams testnet credentials the keeper uses. They are only read when a round is due.

**3. Simulate.** Run this from `cre/rounds-settle`:

```bash
cre workflow simulate settle-rounds --target staging-settings --non-interactive --trigger-index 0
```

### What output proves success

- **No round due.** This was the state on 2026-10-10, when `pendingSettlement()` returned `[]`. The log shows
  `[USER LOG] nothing due: pendingSettlement() is empty` and the result is `"nothing-due"`. That proves the
  cron trigger fired and that the EVM read of the deployed contract on Monad testnet worked through CRE.
- **A round is due.** A round shows up in `pendingSettlement()` once it has closed with stakes on both sides,
  and stays there for up to 24 h. The log shows `round N due: anchor B=…, close B=…`, then
  `both reports fetched and checked`. This proves the external data source. Then:
  - if `adapterAddress` is still empty (as committed), the run stops with
    `config.adapterAddress is empty: deploy MakoRoundsCreAdapter and set it`. That message is deliberate.
  - once the adapter is deployed and configured, add `--broadcast`. You need a funded key for this
    (`CRE_ETH_PRIVATE_KEY`, exported the same way). The run ends with
    `settled round N tx 0x…`, and the round's status on chain becomes Settled or Refunded(Tie).
- A missing close report gives `waiting-report round N B=…`. This is normal for a few seconds after close.
  Any other report problem fails the run with its reason, for example
  `report error unauthorized 401`. No request id is included (it can differ per node and would break consensus). Neither the key nor the provider's text is ever included.

## Deploying the adapter (needs Joshua's go; nothing has been deployed)

The forwarder address is fixed at construction, so each use needs its own instance:

| Instance | `forwarder` | `expectedAuthor` | Used by |
|---|---|---|---|
| simulation | `0xB9F79d863261869B234c481D1f9A7af84AeAd192` (MockKeystoneForwarder) | `0x0000000000000000000000000000000000000000` | `cre workflow simulate --broadcast` |
| deployed workflow | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` (KeystoneForwarder) | the workflow owner address shown after `cre login` | `cre workflow deploy` |

**Workflow identity.** SPEC §5.1 asks for a matching workflow owner and ID. The deployed-workflow instance
checks the owner from the report metadata (bytes 42 to 62: id, then a 10-byte name, then the owner). The
simulation instance checks nothing, because Chainlink's docs say the MockKeystoneForwarder passes no workflow
metadata and any metadata check fails every simulation. **The workflow ID is not checked by either instance**:
the ID is derived from the workflow's config, the config holds the adapter's address, and the adapter is
immutable with no owner, so it cannot learn an ID after it is deployed. This is a recorded deviation from
§5.1. It moves no value, because `settle` is open to everyone.

The `rounds` argument is `0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921` in both instances. The mock forwarder
does not check DON signatures, so anyone can push a report through the simulation instance. That is harmless,
because the adapter only reaches a permissionless call.

- **Gas.** `eth_estimateGas` for the deployment on Monad testnet was **299,959 gas** before the owner check
  was added; re-estimate before deploying. At the 102 gwei gas price
  read on 2026-10-10, that is about 0.031 MON per instance. Monad charges on the gas limit, so keep the limit
  close to the estimate.
- **Command.** Run it from `cre/contracts`, with a Foundry keystore account so the key never reaches the shell:

  ```bash
  forge create src/MakoRoundsCreAdapter.sol:MakoRoundsCreAdapter \
    --rpc-url https://testnet-rpc.monad.xyz --account <keystore-name> --broadcast \
    --constructor-args <forwarder> 0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921 <expectedAuthor>
  ```

- **Config.** Put the deployed address in `settle-rounds/config.staging.json` as `adapterAddress`. Use the
  simulation instance while simulating, and the KeystoneForwarder instance for a deployed workflow.
- **Write gas.** `gasLimit` is `1500000`. The SPEC holds `settle` to at most 1,000,000 gas, and the extra
  covers the forwarder and the adapter. On Monad the limit is what gets charged.

## Before this branch can merge

The repo's root `tsconfig.json` includes `**/*.ts` and does not exclude `cre`. So the Next typecheck and
the Vercel build would try to compile these files, and `bun:test` and `@chainlink/cre-sdk` are not root
dependencies. Merging needs `"cre"` added to the root `exclude` list, the same way `cf-worker`, `keeper` and
`rounds-delivery` are excluded. Root ESLint may also need a `cre/**` ignore. Both are edits outside `cre/`,
so this branch leaves them out.
