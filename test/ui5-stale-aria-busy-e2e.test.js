// ============================================================
// B24 — runFiori de punta a punta: una tabla que se queda con aria-busy="true" tras filtrar
// (job e7535b43).
//
// «Manage Launchpad Pages» de mentira. Al buscar, la tabla se marca ocupada como UI5 (clase
// sapUiLocalBusy, capa de bloqueo y aria-busy) 1,6 s; un clic durante ese tiempo se pierde. Al acabar
// quita la clase y la capa pero, como la tabla real, DEJA aria-busy="true".
//   - aria-busy colgado: antes la fila exacta se daba por ocupada 30 s y el paso fallaba con «ninguna
//     fila se llama exactamente así (filas visibles: «la misma»)». Ahora se pulsa.
//   - ocupada de verdad (el indicador no se quita nunca): falla, pero el mensaje dice que la fila
//     está y que UI5 sigue cargando, no que el nombre no exista.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~45 s. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const V = 'application-FLPPage-manage-component---pageOverview--';
const PAGES = ['Z_BR_MMSAP_PRC_PG_PURCHASING_OVR', 'Z_BR_MMSAP_PRC_PG_PO_PROCESSING', 'Z_BR_MMSAP_PRC_PG_SOURCING'];
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:600px;min-height:300px">
  <input id="${V}customerCreatedSearchField" style="width:200px">
  <div id="${V}pagesTable" class="sapMList sapMListTblCnt" style="position:relative;width:500px"></div>
</div>
<script>
  const stuck = new URLSearchParams(location.search).get('stuck') === '1';
  const PAGES = ${JSON.stringify(PAGES)};
  const hit = (what) => fetch('/hit?' + encodeURIComponent(what));
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}, parent = null) { Object.assign(this, { id, type, props, parent, busy: false }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return this.parent; } getBusy() { return this.busy; } getEnabled() { return true; }
  }
  const view = new Ctl('application-FLPPage-manage-component', 'sap.ui.core.mvc.XMLView');
  const table = new Ctl('${V}pagesTable', 'sap.m.Table', {}, view);
  const search = new Ctl('${V}customerCreatedSearchField', 'sap.m.SearchField', {}, view);
  let n = 0;
  const render = (pages) => {
    for (const id of [...reg.keys()]) if (/ColumnListItem/.test(id)) reg.delete(id);
    const t = table.getDomRef(); t.querySelectorAll('.sapMLIB').forEach((r) => r.remove());
    pages.forEach((p) => {
      const id = '${V}pagesColumnListItemPage-__clone' + (n++);
      new Ctl(id, 'sap.m.ColumnListItem', { type: 'DetailAndActive' }, table);
      t.insertAdjacentHTML('beforeend', '<div id="' + id + '" class="sapMLIB sapMListTblRow" style="height:24px"><span class="sapMText">' + p + '</span></div>');
      document.getElementById(id).addEventListener('click', () => hit((table.busy ? 'lost:' : 'open:') + p));
    });
  };
  // Como UI5: setBusy(true) pinta clase + capa + aria-busy; setBusy(false) quita clase y capa,
  // y la tabla de SAP se queda con aria-busy="true".
  const setBusy = (on) => {
    const d = table.getDomRef(); table.busy = on; d.classList.toggle('sapUiLocalBusy', on);
    if (on) { d.setAttribute('aria-busy', 'true');
              d.insertAdjacentHTML('beforeend', '<div id="${V}pagesTable-busyIndicator" class="sapUiBlockLayer sapUiLocalBusyIndicator" style="position:absolute;inset:0"></div>'); }
    else document.getElementById('${V}pagesTable-busyIndicator')?.remove();
  };
  render(PAGES);
  search.setValue = (v) => { document.getElementById(search.id).value = v; };
  search.fireEvent = () => {};
  search.fireSearch = ({ query }) => {
    setBusy(true);
    render(PAGES.filter((p) => p.includes(query)));   // filas ya pintadas debajo de la capa
    if (!stuck) setTimeout(() => setBusy(false), 1600);
  };
  window.sap = { ui: { getCore() { return { byId: (id) => reg.get(id) || null, applyChanges() {} }; },
                       core: { Element: { registry: { forEach: (f) => [...reg.values()].forEach(f) } } } } };
</script></body></html>`;

const hits = [];
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hit?')) { hits.push(decodeURIComponent(req.url.slice(5))); return res.end(); }
    if (req.method === 'POST') {
        req.resume();
        req.on('end', () => { res.writeHead(302, { location: '/sap/bc/ui2/flp?sap-client=100', 'set-cookie': 'S=ok; Path=/' }); res.end(); });
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(/S=ok/.test(req.headers.cookie || '')
        ? LAUNCHPAD
        : `<!doctype html><html><body data-sap-login="${sapLogin}"><form method="post" action="/sap/bc/ui2/flp">
             <label for="u">User</label><input id="u" name="sap-user"><label for="p">Password</label><input id="p" type="password" name="sap-password">
             <button type="submit">Log On</button></form></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

let captured = '';
const orig = { log: console.log, warn: console.warn };
const capture = (on) => { for (const k of Object.keys(orig)) console[k] = on ? (...a) => { captured += a.map(String).join(' ') + '\n'; } : orig[k]; };

// Selectores como los grabó MIMO (job e7535b43).
const PAGE = 'Z_BR_MMSAP_PRC_PG_PO_PROCESSING';
const STEPS = [
    { technology: 'UI5', action: 'fill', value: PAGE, wdi5_selector: { id: `${V}customerCreatedSearchField`, controlType: 'sap.m.SearchField' } },
    { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.ColumnListItem', properties: { type: 'DetailAndActive', title: null, text: null }, id: `${V}customerCreatedColumnListItemPage-__clone0` } },
];
const run = async (stuck) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_APP_TO_SECTION', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp?stuck=${stuck ? 1 : 0}#FLPPage-manage`, code: STEPS }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== la tabla termina de filtrar pero se queda con aria-busy="true" (job e7535b43) ==');
let r = await run(false);
ok(r.success === true, 'el intent termina bien (antes: «ninguna fila se llama exactamente así»)', r.failure?.message?.slice(0, 200));
ok(hits.join() === `open:${PAGE}`, 'abre la página buscada, sin clics perdidos', hits.join());

console.log('\n== la tabla sigue ocupada de verdad ==');
r = await run(true);
const m = r.failure?.message || '';
ok(r.success === false && new RegExp(`Tras buscar «${PAGE}», la fila con ese nombre exacto está en pantalla, pero no se dio por lista en 30 s: UI5 sigue mostrando su indicador de carga sobre ella\\. No es un problema del nombre`).test(m),
   'falla diciendo que la fila está y UI5 sigue cargando', m.slice(0, 240));
ok(!/ninguna fila de resultados se llama/.test(m), 'y no culpa al nombre');
ok(hits.length === 0, 'sin pulsar nada', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
