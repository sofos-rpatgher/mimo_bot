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

Keep reporting `completedInstanceIids` as you do now, at the **item** level:

- An item's `instance_iid` is reported **completed** once its `code` steps succeed.
- On an item failure: **stop the loop**, still run `finalize`, and report the items that succeeded
  **before** the failure. The failed item and everything after are *not* completed.
- Because `finalize` always runs, the successful items are persisted (auto-save per item, or the
  end-of-group Save), so re-running won't hit "already exists."

Example: 60 tiles, tile 30 fails → tiles 1–29 reported completed, `finalize` runs, failure recorded
at tile 30. Mimo's complementary batch then re-runs tiles 30–60 only. No special "atomic group"
handling — per-item completion + always-finalize covers both auto-save and save-at-end intents.

## Failure object

The `failure` you already return should point at the failing item — include its `instance_iid`
(and the usual block/instruction/intent/step context) so mimo can locate it. Everything else about
the `result` shape (`success`, `completedInstanceIids`, `failure`, `durationMs`) is unchanged.

## Summary of the executor's new job

- Detect `instruction.aggregated_intents` (new array).
- Per entry: navigate once → `setup` → loop `items` (no re-nav) → **always** `finalize`.
- Report `completedInstanceIids` per item, as items succeed; on failure, stop, finalize, report
  what succeeded.
- Non-aggregatable `instances` are untouched.
