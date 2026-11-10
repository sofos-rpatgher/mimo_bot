// ============================================================
// B17 — runFiori de punta a punta con una lista UI5 que aún filtra (job e0b7365f).
//
// «Manage Launchpad Pages» de mentira: la tabla arranca con la lista entera, ordenada por fecha de
// cambio (primero la página del intent anterior). El paso 1 escribe la página en el buscador y la
// tabla se queda ocupada (busy) 1,6 s mientras filtra; el paso 2 clica la primera fila; el paso 3,
// Edit en la página abierta.
//   - bloqueo: como en el job, un clic sobre la tabla ocupada se pierde. Antes: Edit no aparecía en
//     30 s. Ahora espera a que acabe de filtrar y abre la página buscada.
//   - sin bloqueo: UI5 tarda en pintar su indicador (busyIndicatorDelay) y el clic sí llega. Antes:
//     abría la página equivocada (la del intent anterior). Ahora, la buscada.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~30 s. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const V = 'application-FLPPage-manage-component---pageOverview--';
// Un registro UI5 mínimo: controles con id, tipo, propiedades, DOM, padre y busy.
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:600px;min-height:300px">
  <input id="${V}customerCreatedSearchField" style="width:200px">
  <div id="${V}table" style="position:relative;width:500px"></div>
  <button id="application-FLPPage-manage-component---view--buttonEdit" style="display:none">Edit</button>
</div>
<script>
  const block = new URLSearchParams(location.search).get('block') !== '0';
  const hit = (what) => fetch('/hit?' + what);
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}, parent = null) { Object.assign(this, { id, type, props, parent, busy: false }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return this.parent; } getBusy() { return this.busy; } getEnabled() { return true; }
  }
  const view = new Ctl('application-FLPPage-manage-component', 'sap.ui.core.mvc.XMLView');
  const table = new Ctl('${V}table', 'sap.m.Table', {}, view);
  const edit = new Ctl('application-FLPPage-manage-component---view--buttonEdit', 'sap.m.Button', { text: 'Edit', type: 'Emphasized' }, view);
  const search = new Ctl('${V}customerCreatedSearchField', 'sap.m.SearchField', {}, view);
  let rowsN = 0;
  const render = (pages) => {
    for (const id of [...reg.keys()]) if (/ColumnListItem/.test(id)) reg.delete(id);
    const t = document.getElementById(table.id); t.innerHTML = '';
    pages.forEach((p) => {
      const id = '${V}pagesColumnListItemPage-__clone' + (rowsN++);
      new Ctl(id, 'sap.m.ColumnListItem', { type: 'DetailAndActive' }, table);
      t.insertAdjacentHTML('beforeend', '<div id="' + id + '" class="sapMLIB sapMListTblRow" style="height:24px"><span class="sapMText">' + p + '</span></div>');
      document.getElementById(id).addEventListener('click', () => {
        if (table.busy && block) return hit('lost');   // la tabla ocupada se traga el clic
        hit('open:' + p);
        edit.getDomRef().style.display = 'inline-block';
      });
    });
  };
  render(['Z_PG_RBTE_MNTN', 'Z_PG_PUR_SUPPL_EVAL', 'Z_PG_REQ_PROCESSING']);
  search.setValue = (v) => { search.value = v; document.getElementById(search.id).value = v; };
  search.fireEvent = () => {};
  search.fireSearch = ({ query }) => {
    table.busy = true;
    setTimeout(() => { render([query]); table.busy = false; }, 1600);
  };
  edit.getDomRef().addEventListener('click', () => hit('edit'));
  window.sap = { ui: { getCore() { return { byId: (id) => reg.get(id) || null, applyChanges() {} }; },
                       core: { Element: { registry: { forEach: (f) => [...reg.values()].forEach(f) } } } } };
</script></body></html>`;

const hits = [];
const sapLogin = Buffer.from(encodeURIComponent(JSON.stringify({ login_params: {}, languages: {}, texts: {}, properties: {}, messages: [] })), 'latin1').toString('base64');
const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/hit?')) { hits.push(req.url.slice(5)); return res.end(); }
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

// Los selectores tal cual los grabó MIMO (job e0b7365f).
const STEPS = [
    { technology: 'UI5', action: 'fill', value: 'Z_PG_REQ_PROCESSING', wdi5_selector: { id: `${V}customerCreatedSearchField`, controlType: 'sap.m.SearchField' } },
    { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.ColumnListItem', properties: { type: 'DetailAndActive', title: null, text: null }, id: `${V}customerCreatedColumnListItemPage-__clone0` } },
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { type: 'Emphasized', title: null, text: 'Edit' }, controlType: 'sap.m.Button', id: 'application-FLPPage-manage-component---view--buttonEdit' } },
];
const run = async (block) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_TILES_TO_PAGE', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp?block=${block ? 1 : 0}#FLPPage-manage`, code: STEPS }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== bloqueo: la tabla ocupada se traga el clic (job e0b7365f) ==');
let r = await run(true);
ok(r.success === true, 'el intent termina bien (antes: Edit no aparece en 30 s)', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'open:Z_PG_REQ_PROCESSING,edit', 'abre la página buscada, sin clics perdidos', hits.join());

console.log('\n== sin bloqueo: el clic llega aunque la tabla filtre ==');
r = await run(false);
ok(r.success === true, 'el intent termina bien', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'open:Z_PG_REQ_PROCESSING,edit', 'abre la página buscada (antes: la del intent anterior)', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
