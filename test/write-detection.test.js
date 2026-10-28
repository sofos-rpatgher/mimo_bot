// ============================================================
// B14 — qué cuenta como escritura OData para la vigilancia de escrituras (B10/B12).
//
// Un $batch siempre es POST; sólo cuenta como escritura si lleva un changeset o alguna petición
// con método de escritura. Los dos cuerpos de lectura son los literales del job 8b209885
// (FORMS-0000005): listados que la app de SAP cancela al escribir en un buscador, y que el bot
// daba por «escrituras sin confirmar».
//
// Run:  node test/write-detection.test.js       (exit 0 = pass, 1 = fail)
// ============================================================
import { __internals as H } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const W = H.isWriteRequest;
const URL_ = 'https://sap.example:44380/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/$batch?sap-client=100';
const MP = 'multipart/mixed; boundary=batch_b5d2-abca-f5ff';

const READ_PAGES = `--batch_b5d2-abca-f5ff
Content-Type: application/http
Content-Transfer-Encoding: binary

GET pageSet?sap-client=100&$skip=0&$top=20&$orderby=modifiedOn desc&$select=id&$inlinecount=allpages HTTP/1.1
sap-cancel-on-close: true

--batch_b5d2-abca-f5ff--`;
const READ_CATALOGS = `--batch_697f-2c5d-e2d1
Content-Type: application/http

GET catalogSet?sap-client=100&$skip=0&$top=20&$inlinecount=allpages HTTP/1.1
sap-cancel-on-close: true
--batch_697f-2c5d-e2d1--`;
const WRITE_PAGE = `--batch_1
Content-Type: multipart/mixed; boundary=changeset_1

--changeset_1
Content-Type: application/http

POST pageSet?sap-client=100 HTTP/1.1
Content-Type: application/json

{"id":"Z_MM_SAP_PRC_PG_PO_PROCESSING"}
--changeset_1--
--batch_1--`;

console.log('== $batch de sólo lectura (job 8b209885) ==');
ok(W('POST', URL_, READ_PAGES, MP) === false, 'GET pageSet con sap-cancel-on-close → no es escritura');
ok(W('POST', URL_, READ_CATALOGS, MP) === false, 'GET catalogSet con sap-cancel-on-close → no es escritura');

console.log('\n== escrituras ==');
ok(W('POST', URL_, WRITE_PAGE, MP) === true, '$batch con changeset (POST pageSet) → escritura');
ok(W('POST', URL_, READ_PAGES.replace('--batch_b5d2-abca-f5ff--', '') + WRITE_PAGE, MP) === true, 'lectura + changeset en el mismo $batch → escritura');
ok(W('POST', URL_, '--b\nContent-Type: application/http\n\nPATCH Things(1) HTTP/1.1\n\n{}\n--b--', MP) === true, 'V4 multipart: escritura fuera de changeset → escritura');
ok(W('POST', 'https://h/sap/opu/odata/UI2/INTEROP/PersContainers', '{"id":"x"}', 'application/json') === true, 'POST normal (no $batch) → escritura');
ok(W('MERGE', 'https://h/sap/opu/odata/X/Things(1)', '{}', 'application/json') === true, 'MERGE → escritura');
ok(W('DELETE', 'https://h/sap/opu/odata/X/Things(1)', null, '') === true, 'DELETE sin cuerpo → escritura');

console.log('\n== OData V4, $batch JSON ==');
const V4 = 'https://h/sap/opu/odata4/sap/x/0001/$batch';
ok(W('POST', V4, JSON.stringify({ requests: [{ id: '1', method: 'GET', url: 'A' }, { id: '2', method: 'get', url: 'B' }] }), 'application/json') === false, 'sólo GET → no es escritura');
ok(W('POST', V4, JSON.stringify({ requests: [{ id: '1', method: 'GET', url: 'A' }, { id: '2', method: 'PATCH', url: 'B' }] }), 'application/json') === true, 'con un PATCH → escritura');
ok(W('POST', V4, '{no es json', 'application/json') === true, 'JSON ilegible → escritura (ante la duda, vigilar)');

console.log('\n== ante la duda, escritura ==');
ok(W('POST', URL_, null, MP) === true, '$batch sin cuerpo legible → escritura');
ok(W('GET', URL_, null, '') === false && W('HEAD', URL_, null, '') === false, 'GET y HEAD → no');

console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
