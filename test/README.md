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

## `job-check.test.js`
C1 y C2 del contrato MIMO fase 2 (`src/job-check.js`): un job Fiori sin `sap_system`, `server_origin`,
`sap_client`, `sap_user` o `sap_password` se rechaza con `phase: 'job-check'` y `rejected: true` antes de
abrir el navegador (`sap_system` vacío, en cualquier job); un sistema que no está en `sap_systems` del
config, con `phase: 'system-check'` y `rejected: true`. El `sap_system` de las fases 0 y 1 vale como lista
de uno. Las huellas TLS (`tlsPinnedKeys`) se pasan sólo las del sistema del job. Sustituye a
`job-target.test.js` (fase 1).

## `tls-e2e.test.js` (`npm run test:rpa`, necesita navegador y `openssl`)
C3 y C4 de la fase 2: `runFiori` contra un logon servido por HTTPS con un certificado de otro nombre
(como el de SofOS). Sin huella, o con la de otro certificado, falla al conectar sin enviar el POST de
logon; con la huella SPKI en `tlsPinnedKeys`, entra. La contraseña no aparece en la consola, el
resultado, los eventos ni el trace.

## `aggregated-group.test.js` y `aggregated-e2e.test.js` (este, en `npm run test:rpa`)
C1 del contrato de correcciones: un item de un grupo de `aggregated_intents` sólo cuenta como completo
si el grupo se guardó (`finalize` y el settle de escrituras del grupo terminan bien). El primero prueba
la regla (`runAggregatedGroup`) con los escenarios del contrato; el segundo, `runFiori` de punta a punta:
`completedInstanceIids`, `failure.group_stage`/`group_key` y los eventos (MILESTONE por item sólo tras
guardar; WARN por item si el grupo no se guardó).

## `sapgui-result.test.js`
C2 del contrato de correcciones: `runSapgui` devuelve `{ success, failure?, logs_url,
completedInstanceIids, resultReported }` como `runFiori` (antes devolvía el `logs_url` como cadena y todo
job de SAP GUI acababa `FAILED`). Simula el servicio C# sustituyendo `fetch`. Necesita `config.json`.

## `login-check-e2e.test.js` (`npm run test:rpa`, necesita navegador y `config.json`)
Fase 2b: un job `login-check` por el worker (`runJob`), que sólo hace login y logout para verificar la
contraseña de un usuario SAP. Contra un logon de mentira, con `fetch` sustituido para capturar los
`notify`: contraseña buena → `COMPLETED` con logoff y sin abrir ninguna app; mala →
`INVALID_CREDENTIALS` sin reintentos; sin `sap_password` → rechazo (`rejected: true`) sin tocar SAP; nada
va al servicio de SAP GUI, no hay eventos de progreso ni trace, y la contraseña no aparece en ningún sitio.

Fase 2c (en `job-check.test.js` y `tls-e2e.test.js`): la validación TLS viaja en el job (`tls_mode`
VERIFY | PINNED | INSECURE, `tls_pins`) y manda sobre `tlsPinnedKeys` del config, que sólo se usa si el
job no trae `tls_mode`. Modo desconocido → VERIFY; PINNED sin huellas válidas → rechazo `job-check`;
INSECURE sólo si `allowInsecureTls` del config lo permite para ese sistema (si no, rechazo `job-check`),
con aviso en el log y evento WARN. El error de certificado apunta a *SAP Systems* en MIMO.

## `write-detection.test.js` y `write-detection-e2e.test.js` (este, en `npm run test:rpa`)
B14: qué cuenta como escritura OData para la vigilancia de escrituras (B10/B12). Un `$batch` siempre es
`POST`; sólo cuenta si lleva un changeset o una petición con método de escritura (o, en un `$batch` JSON
de V4, alguna que no sea `GET`). El primero prueba la clasificación con los cuerpos literales del job
8b209885 (FORMS-0000005), cuyos listados cancelados por el buscador el bot daba por «escrituras sin
confirmar». El segundo reproduce ese job con `runFiori` (listado cancelado + escritura con 201 → el
intent termina bien) y comprueba que una escritura cancelada sigue haciendo fallar el intent (B10).
