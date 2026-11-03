// ============================================================
// B15 — qué cuenta como arranque de una app y cómo se describe en los diagnósticos.
//
// Job cbe25b0b: «sap.m.Button: total=0 visibles=0» parecía una app ausente y era una app que aún
// bajaba su código (core-ext-light, library-preload, ShellBar/Component-preload).
//
// Run:  node test/boot-load.test.js       (exit 0 = pass, 1 = fail)
// ============================================================
import { __internals as H } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };
const B = H.isBootResource;
const R = 'https://vhdqwws1wd01.sap.grupomar.local:44380/sap/bc/ui5_ui5/ui2/ushell/resources/~20240101~';

console.log('== arranque ==');
ok(B(`${R}/sap/ui/core/library-preload.js`) && B(`${R}/sap/fiori/core-ext-light-3.js?sap-client=100`), 'library-preload y core-ext-light (con query)');
ok(B(`${R}/sap/ushell/components/shell/ShellBar/Component-preload.js`), 'Component-preload de la barra de shell');
ok(B(`${R}/sap/ushell/manifest.json`) && B(`${R}/sap/m/messagebundle_es.properties`), 'manifest.json y textos .properties');

console.log('\n== no es arranque ==');
ok(!B('https://h/sap/opu/odata/UI2/PAGE_BUILDER_PERS/$batch'), 'OData');
ok(!B('https://h/sap/opu/odata/sap/x/Things.json'), 'OData aunque acabe en .json');
ok(!B('https://h/sap/bc/ui2/flp?sap-client=100#FLPPage-manage'), 'el documento del launchpad');
ok(!B(`${R}/sap/ushell/themes/sap_horizon/library.css`) && !B('https://h/x/logo.png'), 'estilos e imágenes');
ok(!B(undefined) && !B(''), 'sin URL');

console.log('\n== descripción ==');
ok(H.describeBootLoad({ readyState: 'complete', pending: [] }) === 'carga: readyState=complete, nada pendiente', 'nada pendiente');
const d = H.describeBootLoad({ readyState: 'complete', pending: [
    { url: `${R}/sap/fiori/core-ext-light-3.js?x=1`, ageMs: 9000 },
    { url: `${R}/sap/ushell/components/shell/ShellBar/Component-preload.js`, ageMs: 31400 },
    { url: `${R}/sap/ui/unified/library-preload.js`, ageMs: 2000 },
] });
ok(d === 'carga: readyState=complete, 3 fichero(s) de arranque pendiente(s), el más antiguo ShellBar/Component-preload.js (31 s)', 'cuántos y el más antiguo, con su antigüedad', d);
ok(/readyState=\?/.test(H.describeBootLoad({ pending: [] })), 'readyState desconocido → ?');

console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
