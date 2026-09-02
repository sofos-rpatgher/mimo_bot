# mimo_bot tests

Plain-Node harnesses (no test framework, no deps). Run with `npm test` or `node test/<file>`.

## `progress-normalize.test.js`
Verifies `normalizeEvent` in `src/progress.js` — the function that turns a raw `fiori.js`
`onProgress` event into exactly the shape MIMO's `reportProgress` action accepts.

OData V4 is strict, so the invariants that matter (a wrong type 400s the whole batch and the
console silently loses events):

- polymorphic context fields (`block`, `instance`, `intent`, …) go out as **Strings**
  (e.g. `block:'BUSINESS_CATALOG'`, `instance:2 → "2"`, `instance:'<uuid>'` stays a string);
- counters (`done`, `total`, `step_no`) are **Integers**; `percent` is forwarded;
- **no stray fields** ride along;
- missing fields become `undefined` (omitted on the wire); `level` defaults to `INFO`;
- `message`/`block` are length-bounded; an empty event never throws.

**If you change the event shape the bot sends, update `normalizeEvent` and run this.**
The shape must stay in sync with MIMO's `ProgressEvent` type (`srv/mimo.scheduler.srv.cds`) and the
`JobEvents` entity (`db/mimo.bots.db.cds`) in the mimo100 repo.
