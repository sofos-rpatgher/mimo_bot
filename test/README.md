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

## `boot-load.test.js` y `slow-boot-e2e.test.js` (este, en `npm run test:rpa`; tarda ~4 min)
B15: una app que tarda en llegar no es una app ausente (job cbe25b0b: tras una recarga limpia el
arranque de UI5 tardó diez veces lo normal y el paso falló con «sap.m.Button: total=0»). El primero
prueba qué cuenta como fichero de arranque (`.js`, `.json`, `.properties`, nunca OData) y cómo se
describe en los diagnósticos. El segundo usa `runFiori` contra un launchpad cuyo código llega tarde:
espera a la app mientras siga bajando (hasta 120 s); si el `goto` de playwright-sap agota sus 30 s
esperando a `load` con el documento ya ahí, sigue; si la app no llega nunca, recarga UNA vez y el paso
falla con el estado de carga (`readyState`, ficheros pendientes, el más antiguo) en el mensaje y el DIAG.

## `webgui-busy-e2e.test.js` (en `npm run test:rpa`) y la sección B16 de `webgui-frame.test.js`
B16: la señal de que SAP WebGUI está ocupado es su indicador de carga (`#ur-loading`), no sólo el
`.lsBlockLayer` (job df7e6729: con los popups del filtro abiertos, la única capa era el fondo modal y el
bot dio por quieta una pantalla que SAP seguía procesando). `webgui-frame` prueba `settleWebgui` y
`webguiBusy`: con popups y sin carga, quieta enseguida; con el indicador, espera a que se apague; si no
se apaga, `false` al agotar su techo. El e2e reproduce el job con `runFiori`: si SAP tarda 8 s en el
Enter del filtro, el paso siguiente espera y el clic llega a la fila; si no termina nunca, el paso
falla diciendo que SAP no terminó de procesar, sin hacer clic sobre la pantalla vieja.

## `ui5-busy-list-e2e.test.js` (en `npm run test:rpa`)
B17: un control UI5 dentro de un contenedor ocupado (`getBusy()`) todavía no está listo para el paso
(job e0b7365f: tras escribir la página en el buscador de «Manage Launchpad Pages», el bot clicó la
primera fila de la lista aún sin filtrar, bajo el indicador de UI5; el clic se perdió y Edit no apareció).
El e2e reproduce el buscador con una tabla que filtra 1,6 s. Si la tabla ocupada se traga el clic, antes
fallaba por timeout; si el clic llega, antes abría la página equivocada (la del intent anterior, primera
por fecha de cambio). Ahora espera a que la tabla termine y abre la página buscada en los dos casos.

## `ui5-busy-view-e2e.test.js` (en `npm run test:rpa`)
B18: dos huecos de B17 (job 7ac95023, «Element is not visible» en el «···» de la barra de tiles tras Edit).
La subida por los padres se cortaba en la pestaña «Page Content» (un `IconTabFilter`, cuyo DOM es sólo
su cabecera) y no llegaba a la vista ocupada; ahora un padre que no contiene al control se salta, y además
se mira el DOM (`sapUiLocalBusy`/`aria-busy`) y el indicador global de UI5. Y si UI5 repinta el control
durante el clic, se espera a que vuelva a estar listo y se reintenta una vez. El e2e reproduce las dos
cosas (antes: clic perdido; «Element is not visible») y comprueba que un diálogo abierto sobre una vista
ocupada no se queda esperando a la vista.

## `ui5-search-exact-e2e.test.js` (en `npm run test:rpa`)
B19: tras escribir en un buscador, el clic siguiente sobre una fila de resultados (un elemento de lista,
o un control dentro de uno, como el «Add» de cada tile) sólo vale para la fila que se llama exactamente
como lo buscado. Los buscadores de SAP buscan por «contiene» y MIMO graba «la primera fila» (job
7ac95023: se añadieron «Adjust Operational Supplier Evaluation Score», «Contract Leakage» y «… by
Quality» en lugar de los tiles pedidos, y los intents salieron bien). El e2e reproduce esos casos y el de
páginas (`…_SOURCING` / `…_SOURCING_OVR`); si ninguna fila se llama así, el paso falla diciendo qué filas
había, sin pulsar nada.

## `webgui-popup-topmost-e2e.test.js` (en `npm run test:rpa`)
B20: con varias ventanas de SAP abiertas encima de la del paso, el error cita la de más arriba (la que
SAP acaba de abrir) y después las de debajo. Si alguna dice «already exists» / «ya existe», el paso falla
al momento con ese texto y qué hacer (la tanda no es idempotente: borrar en SAP antes de relanzar). Job
41beb341: el catálogo ya existía, SAP lo dijo en wnd[2] y el error citó wnd[1] «Create Catalog». El e2e
reproduce las dos ventanas apiladas.

## `write-rejected-e2e.test.js` (en `npm run test:rpa`)
B21: si SAP rechaza una escritura (HTTP ≥ 400, o un changeset rechazado dentro de un $batch), el intent
falla al empezar el paso siguiente con el mensaje del servidor; si el rechazo llega mientras ese paso
espera y el paso falla, el error lleva el rechazo delante como causa. Antes sólo se comprobaba al cerrar
el intent (job 6ee54fd1: «Create» de una página que ya existía → POST pageSet 400 «Exists already»; el
paso siguiente esperó 30 s un «Edit» imposible y el error fue ese timeout). El e2e reproduce los dos casos.

## `webgui-maxlength-e2e.test.js` (en `npm run test:rpa`)
B22: antes de escribir en un campo WEBGUI (o WebDynpro) se mira su `maxlength`; si el valor no cabe, el
paso falla sin escribir, diciendo cómo quedaría recortado. Job ad52a241: el ID del catálogo de 36
caracteres entró en un campo de 35 y el catálogo se creó como «…_CATALO», sin aviso. El e2e reproduce el
caso (36: no se crea nada) y el límite exacto (35: se escribe completo).
