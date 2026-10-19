# Aggregated Intents — RPA Executor Contract

Mimo can now collapse a repetitive intent (e.g. "add 60 tiles to a catalog") into a **single
navigation + loop**, instead of one full navigation per item. This document is the contract the
Fiori RPA executor (`src/rpa/fiori.js`) must implement. **Only the executor side is described here;
the mimo/script-generation side is already done.**

## What changes in the script

Nothing changes for existing (non-aggregatable) intents — they keep the current
`blocks → instructions → instances → intents → { code }` shape and run exactly as today.

For **aggregatable** intents, mimo emits a new sibling array on the instruction:

```jsonc
"instruction": {
  "instruction_id": "…", "instruction_seq": 2,
  "instances": [ /* non-aggregatable intents only — unchanged */ ],
  "aggregated_intents": [
    {
      "intent_iid": "…", "intent_id": "ADD_TILE", "intent_seq": 1,
      "APP_LINK": "…/manage/catalog…",
      "aggregated": true,
      "group_key": "Z_CATALOG_A",
      "setup":    [ /* steps — run ONCE, before the loop */ ],
      "items": [
        { "instance_iid": "…tile1…", "code": [ /* steps for tile 1 */ ] },
        { "instance_iid": "…tile2…", "code": [ /* steps for tile 2 */ ] }
        // … one entry per tile in this catalog group …
      ],
      "finalize": [ /* steps — run ONCE, after the loop */ ],
      "rollback": []
    }
    // … one aggregated intent per catalog group (2 catalogs → 2 entries) …
  ]
}
```

- Steps inside `setup`, each `items[].code`, and `finalize` are the **same shape** as today's
  `code` steps — no new step format, so the existing step executor is reused unchanged.
- `setup`/`finalize` are already decoded once (with the group's shared values). `items[].code` is
  decoded per tile (its own value baked in). There is **no redundancy** to dedupe.
- One `aggregated_intents[]` entry per key group. Multiple catalogs ⇒ multiple entries (each is its
  own navigation).

## Execution semantics

Process an instruction's `instances` exactly as today. Then, for **each** entry in
`aggregated_intents`:

1. **Navigate once** — `goto(APP_LINK)`.
2. Run **`setup`** steps.
3. For **each** `items[i]`: run its `code` steps **without navigating again** (stay on the page).
4. **Always** run **`finalize`** steps — including when an item failed mid-loop (a `finally` block).

That's the whole win: one navigation for the whole group instead of one per item.

## Completion reporting (drives complementary batches — important)

`completedInstanceIids` is reported at the **item** level, but an item only counts as completed once
its **group is saved** — that is, once `finalize` and the group's write settle finish without error
(corrections contract, C1). Finishing an item's `code` steps is not enough: until the group is saved,
SAP may hold nothing of it.

| What fails | Items reported completed |
|---|---|
| Nothing | All items of the group |
| `setup` | None (no items run, `finalize` is not run) |
| Item *k* | Items before *k*, **only if** `finalize` (which still runs) succeeds; otherwise none |
| `finalize` or its write settle | **None** of the group |

- On an item failure: **stop the loop**, still run `finalize`, then apply the table above. The failed
  item and everything after are *not* completed.
- `intentsCompleted` follows the same rule.

Example: 60 tiles, tile 30 fails, `finalize` saves → tiles 1–29 reported completed, failure recorded at
tile 30; Mimo's complementary batch re-runs tiles 30–60. If `finalize` had failed too, none of the 60
would be reported, and the complementary batch re-runs the whole group.

Known trade-off: a group whose items are saved one by one as they run (no save in `finalize`) still
reports none completed if `finalize` fails, so the complementary batch re-runs items that are already
in SAP and may hit "already exists". That is preferred to the alternative — work marked done that SAP
never saved, which nobody would notice.

### Live console

An item's `MILESTONE` (`✓ Instance N — 100% completed`) is emitted only **after** its group is saved.
If the group is not saved, each item whose steps finished gets a `WARN`
(`⚠ Instance N — steps done, but group "…" was NOT saved: not completed`) on its own line, besides the
`ERROR` of the failure.

## Failure object

The `failure` you already return should point at the failing item — include its `instance_iid`
(and the usual block/instruction/intent/step context) so mimo can locate it. For a group it also
carries `group_key` and **`group_stage`**: `SETUP`, `ITEM` or `FINALIZE` — where in the group it
failed. When an item fails, `group_stage` stays `ITEM` even if `finalize` then fails too. When
`finalize` fails, `instance` / `instance_iid` are `null` (it belongs to no item). Everything else
about the `result` shape (`success`, `completedInstanceIids`, `failure`, `durationMs`) is unchanged.

## Summary of the executor's new job

- Detect `instruction.aggregated_intents` (new array).
- Per entry: navigate once → `setup` → loop `items` (no re-nav) → **always** `finalize`.
- Report `completedInstanceIids` per item, as items succeed; on failure, stop, finalize, report
  what succeeded.
- Non-aggregatable `instances` are untouched.
