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

## `logon.test.js`
C3 del contrato MIMO fase 0: el veredicto del login (`src/rpa/logon.js`), sin navegador. Decodifica
el `data-sap-login` de la página de logon Fiori con la forma medida en las trazas reales, clasifica
los mensajes de SAP en `failure.code` (`INVALID_CREDENTIALS`, `USER_LOCKED`,
`PASSWORD_CHANGE_REQUIRED`, `LOGIN_REJECTED`, `LAUNCHPAD_TIMEOUT`) y comprueba que el mensaje del job
nunca lleva la contraseña.

**Pendiente:** el formato de un mensaje de rechazo real no se ha visto todavía. Cuando haya un intento
con un usuario inexistente contra DS4, guardad el `data-sap-login` de esa página como fixture aquí.

## `logon-e2e.test.js` (`npm run test:rpa`, necesita navegador)
`runFiori` de punta a punta contra un logon de SAP de mentira: el rechazo falla en segundos con su
código y sin reintentar; el trace no contiene la contraseña (ni el `fill` ni el cuerpo del POST de
logon, C4); y la sesión SAP se cierra al terminar.

## `job-target.test.js`
C1 del contrato MIMO fase 1 (`src/job-target.js`): el `server_origin` y el `sap_client` que trae el job
tienen que coincidir con los del `config.json`; si no, el job se rechaza con `phase: 'system-check'`
antes de abrir el navegador. El contrato pedía sólo avisar y usar el del job; se rechaza porque en esta
fase las credenciales salen del config y no deben mandarse a otro host. Campos vacíos → se usa el config.
