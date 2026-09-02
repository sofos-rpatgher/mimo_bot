# RPA → Live Console: `onProgress` contract

To power MIMO's **live execution console**, the RPA engine (`src/rpa/fiori.js`) must emit
**execution events** as it runs. The worker collects them and streams them to MIMO; MIMO stores
them per job and renders them live. This is the **only** change needed in `fiori.js` — everything
else (buffering, batching, POSTing, storage, UI) is already done outside it.

## What the worker passes in

`runFiori(script, config)` is now called with an `onProgress` callback on the second argument:

```js
result = await runFiori(parsed, { ...config, onProgress: progress.onProgress });
```

- `config.onProgress` **may be absent** (e.g. tests, other callers). Guard every call:
  ```js
  const emit = (e) => { try { config.onProgress && config.onProgress(e); } catch {} };
  ```
- Calls are **fire-and-forget**: `onProgress` returns immediately (no `await`), never throws, and
  must never change control flow. Emitting is best-effort telemetry — if the console misses an
  event nothing breaks; the existing `notify()` result stays the source of truth for the outcome.
- **Do not** batch, throttle, or POST anything yourself. Just call `onProgress` once per event; the
  worker (`src/progress.js`) assigns `seq`/`at`, buffers, and flushes.

## When to emit (granularity: full step trace)

Emit at the same points you already `console.log` the terminal trace:

| level | emit when | volume |
|---|---|---|
| `STEP` | **every RPA step** (each decoded action executed) — the line-for-line terminal trace | high |
| `MILESTONE` | when an **instance** finishes, and when an **instruction/block** starts or finishes | low |
| `ERROR` | on the failing step, right before you populate `result.failure` | one |
| `INFO` | optional: run start / end, navigation, login | few |

Full step trace is intended — the console is meant to replace watching the bot terminal.

## Event shape

```js
config.onProgress({
  level:       'STEP',              // STEP | MILESTONE | INFO | WARN | ERROR
  done:         37,                 // items processed so far (e.g. instances done) — optional
  total:        60,                 // total items — optional
  block:        2,                  // same indices you already use in result.failure
  instruction:  'REFERENCE_TILES',  // instruction id/label (String) — optional
  instance:     37,                 // 1-based instance index — optional
  intent:       'ADD_TILE',         // intent id/label (String) — optional
  step_no:      4,                  // step index within the intent — optional
  action:       'click',            // RPA action name for STEP events — optional
  message:      'Referencing tile F0842 in catalog ZBC_SALES',  // the console line (<=1000 chars)
});
```

- Only `message` is really needed for the console line; the structured fields drive the progress
  bar (`done`/`total`) and let the UI filter by context. Send what you have; omit the rest.
- `message` is truncated to 1000 chars server-side — keep it to one human-readable line.
- Reuse the **same** `block`/`instruction`/`instance`/`intent`/`step`/`action` values you already
  compute for `result.failure`, so a failure line in the console lines up with the failure summary.

## `done` / `total` for the progress bar

Pick one consistent counter for the whole run so `done/total` is monotonic — **instances processed
across the batch** is the natural choice (what a user reads as "37 of 60"). Set it on `MILESTONE`
(and optionally `STEP`) events. It's fine to leave it null on low-level steps; the last non-null
value wins in MIMO's denormalized progress.

## Nothing else changes

- `runFiori`'s return value is unchanged (`{ success, failure?, completedInstanceIids, ... }`).
- No new dependencies, no network code in `fiori.js`.
- If `onProgress` is missing, behaviour is identical to today.
