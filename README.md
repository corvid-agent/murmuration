# murmuration

A **flock counter with a quiet-round pot** on Algorand TestNet, ticked by
[Arcron](https://github.com/CorvidLabs/arcron) keepers. Sibling of
[epitaph](https://github.com/corvid-agent/epitaph),
[arcron-beacon](https://github.com/corvid-agent/arcron-beacon) and
[plod](https://github.com/corvid-agent/plod).

**Unaudited. TestNet only. Not deployed (appId = 0).** Deploy needs a
human's explicit go — see issue #1.

## What it does

Anyone can **join** the flock by paying at least **0.1 ALGO** into the app
account. Every join grows the **pot**, increments the flock, and resets the
quiet clock. If no bird joins for `quiet_rounds` (default **20000 rounds ≈
15.6 h**), the next Arcron keeper call to `tick()` pays the **entire pot**
to the **last joiner** via an inner payment.

**When the flock goes quiet, the last bird gets the pot.**

## The game theory

Joining is a bet on silence. Every join resets the clock — so joining
*delays* the payout — but it also grows the very pot you might win, and it
makes *you* the bird in line for it. The flock is a musical-chairs game
played at blockchain tempo: join early and you feed a pot someone else will
likely take; join last and you take everything everyone else paid in. The
keeper is the referee that calls the game when the music stops. There is no
house edge, no fee skim — the pot pays out whole — so the only cost of
playing is 0.1 ALGO plus the certainty that one more joiner can steal your
seat. The longer the quiet window, the more rounds of doubt each holder of
the last seat must sweat through.

## The fee note (inner payments and the group pool)

`tick()` pays the pot with an **inner payment whose own fee is 0**. That
zero is deliberate: the inner fee draws from the **group fee pool**. The
CorvidLabs keeper bots that execute Arcron upkeeps attach **2,000+ µALGO
extra** on the outer execution call, which covers the 1,000 µALGO inner
minimum with room to spare. Do not "fix" the inner fee to 1,000 — at 0 it
pools; at 1,000 it would still pool but the zero keeps the accounting
honest about who pays (the keeper's execution fee, per the registration
recipe below).

## The traps this contract avoids

Read [docs/integrating.md](https://github.com/CorvidLabs/arcron/blob/main/docs/integrating.md)
in the Arcron repo first. Every one of these was learned the hard way:

1. **Zero create args.** A uint64 create_arg is how a sloppy deploy script
   confuses the keeper app id with a cadence and locks an interval at ~68
   years. `create()` takes nothing; the default quiet window (20000 rounds)
   is initialized *inside* create, the keeper is named once via
   `set_keeper`, the window is owner-tunable via `set_quiet`.
2. **Keeper auth is `Application(keeper).address`, never `itob`.** Arcron's
   inner call comes from the keeper *application account*. Comparing the
   sender against `itob(keeper_app_id)` compares 8 bytes to a 32-byte
   address and never matches.
3. **Fail soft after keeper auth.** A hook that rejects gets exponentially
   backed off by keeper bots and burns upkeep escrow on retries. After the
   two authorization asserts in `tick()`, every no-work path **returns 0**
   — empty flock, empty pot, flock still chatty, all of them. Nothing
   asserts once the keeper is authenticated.
4. **`set_keeper` is one-time, creator-only.** Set once after deploy,
   before registration; it cannot be re-pointed.
5. **Compile clean.** Verified: puyapy 5.10.1 compiles this contract with
   zero errors (artifacts committed under `smart_contracts/murmuration/out/`;
   the arc56 blob hash is pinned in git).
6. **Inner fee 0, pooled.** See the fee note above.

## State layout (global)

Declared order; keys are stored by name. Schema from the compiled arc56:
**5 uint64 + 1 byte slice**, no local state.

| slot | key               | type          | meaning                                     |
| ---- | ----------------- | ------------- | ------------------------------------------- |
| 0    | `keeper_app`      | uint64        | Arcron keeper app id; 0 until `set_keeper`  |
| 1    | `flock`           | uint64        | total joins since deploy                    |
| 2    | `pot`             | uint64        | accumulated join payments, in µALGO         |
| 3    | `last_join_round` | uint64        | round of the most recent join               |
| 4    | `quiet_rounds`    | uint64        | silence that triggers payout (def. 20000)   |
| 5    | `last_joiner`     | bytes (32)    | address in line for the pot                 |

Payout condition: `flock > 0` and `pot > 0` and
`Global.round - last_join_round > quiet_rounds`.

## ABI

Selectors are `sha512_256(signature)[:4]`, as compiled by puyapy 5.10.1.

| method                   | selector     | auth                    | notes                                   |
| ------------------------ | ------------ | ----------------------- | --------------------------------------- |
| `create()void`           | `0x4c5c61ba` | (create)                | zero create args, on purpose            |
| `set_keeper(uint64)void` | `0xc4c1d8f7` | creator, one-time       | ABI lowers `Application` to `uint64`    |
| `set_quiet(uint64)void`  | `0x2f96f12c` | owner (= creator)       | floor 1000 rounds                       |
| `join(pay)void`          | `0x3114b16f` | anyone                  | payment ≥ 100000 µALGO to app account   |
| `tick()uint64`           | `0x4d4d5f0b` | keeper app account      | fail-soft; returns 1 the round it pays  |
| `status()uint64`         | `0x77a7af15` | readonly                | rounds of quiet so far; 0 if no flock   |

## Keeper registration recipe

Register an upkeep on the Arcron TestNet keeper app **769891898**
(address `M4YFP33L5VIFRF53X53WUMQWBOWSLYQNBSSAJV2SORGF43L36XBY7OREUA`) via

```
register(pay,pay,uint64,byte[][],uint64,uint64,uint64,uint64,uint64,uint64)uint64
```

with:

- **target app** = the deployed murmuration app id; **call args** = the bare
  `tick()` selector (`0x4d4d5f0b`), ABI-encoded as `byte[][]`
  (10 bytes on the wire: count + offset + length + selector).
- **interval = 30857 rounds** (~daily at ~2.8 s/round). The pot pays on the
  first tick after the flock goes quiet — with the default 20000-round
  quiet window, payout lands within about one interval of going quiet.
- **fee per execution = 4000 µALGO** — comfortably covers the outer call
  plus the pooled 0-fee inner payment (see the fee note).
- **skip policy = 1 (SKIP_AHEAD)** — a missed call is harmless; quiet is
  computed from round arithmetic, not call counts. Never leave the zero
  default.
- **payment 1 = MBR**, to the keeper app address:
  `2500 + 400 × (139 + len(call_args))` µALGO → for the bare selector,
  `2500 + 400 × 149 = 62100` µALGO.
- **payment 2 = escrow**, to the keeper app address: **500000 µALGO**
  (125 executions at 4000 µALGO; top up before it runs dry).
- Both payments go to the **keeper app address** (escrow address of app
  769891898), not to murmuration.
- After registering, read the upkeep box `u` + `itob(upkeep_id)` **fresh**
  from the keeper app (indexer `/v2/applications/769891898/box?name=...`) —
  never trust a cached copy when checking `next_execution_round`.

Order matters: deploy → `set_keeper` → (optional `set_quiet`) → register,
because `tick` hard-asserts until the keeper is set (and fail-softs until
the flock has joined and gone quiet).

## How a human deploys this later

**TestNet only. Never commit a mnemonic. Never deploy without the human go
(issue #1).**

1. Fund a throwaway TestNet account (dispenser). The mnemonic lives in
   env/CI secrets, never in git.
2. Compile: `puyapy smart_contracts/murmuration/contract.py --out-dir out`
   (or reuse the committed artifacts).
3. Deploy the app with **zero create args**. Record the app id. Fund the
   app account with at least its MBR (0.1 ALGO) so inner payments have
   balance headroom — the pot itself rides on top.
4. Call `set_keeper` with keeper app **769891898** (creator-only, one-time).
5. Optionally call `set_quiet` to tune the window (≥ 1000 rounds; default
   20000 was set at create).
6. Register the upkeep on keeper 769891898 per the recipe above (issue #2).
7. Set `"appId"` in `docs/deploy.json` — the board lights up on its own
   (issue #3).

## Layout

```
smart_contracts/murmuration/contract.py   the Puya (Algorand Python) source — the whole thing
smart_contracts/murmuration/out/          committed puyapy 5.10.1 artifacts (arc56 + TEAL)
docs/                                     GitHub Pages split-flap board (NOT DEPLOYED until appId > 0)
docs/deploy.json                          {"appId": 0, ...} — the board's single source of config
```

Compiled artifacts are committed here on purpose so the reviewed bytecode
hash is pinned in git.

**Pending:** the token that wrote this repo lacks the `workflow` scope, so
no Pages publish workflow is committed. **A human must enable GitHub Pages
from `/docs` on `main` in the repository settings** (Settings → Pages →
Source: Deploy from a branch → `main` `/docs`).

## Build locally

```bash
pip install puyapy==5.10.1
puyapy smart_contracts/murmuration/contract.py --out-dir out
```

Verified at authoring time: compiles clean on puyapy 5.10.1; global schema
5 uint64 + 1 byte slice; selectors as tabulated above. Mock-chain tests
cannot prove keeper integration (inner calls, MBR, fee pooling) — that
belongs to a LocalNet/TestNet e2e at deploy time.

## The board

`docs/` is a split-flap/CRT status board in the spirit of
[corvid-agent/epitaph](https://github.com/corvid-agent/epitaph). While
`appId` is 0 it shows **NOT DEPLOYED**. Once `appId > 0` it reads the app's
global state from the public indexer
(`https://testnet-idx.algonode.cloud`) and flaps out FLOCKING / QUIET /
POT PAID, the flock size, the pot in ALGO, the quiet countdown against
`quiet_rounds`, and the last joiner's short address. If the feed is
unreachable it falls back to the last good snapshot (marked STALE) rather
than guessing. Read-only, no wallet, no keys.

Unaudited. TestNet only. Not deployed.
