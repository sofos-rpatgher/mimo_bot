// ============================================================
// B19 — runFiori de punta a punta: tras una búsqueda, el clic va a la fila con el nombre EXACTO
// (job 7ac95023).
//
// Selector de tiles y lista de páginas de mentira que, como SAP, buscan por «contiene» (en título y
// subtítulo) y devuelven primero otra fila. MIMO graba «buscar» y «pulsar Add de la primera fila».
// Casos reales del job:
//   - «Operational Supplier Evaluation» → primero «Adjust Operational Supplier Evaluation Score».
//   - «Purchasing Spend» → primero «Contract Leakage» (subtítulo «Purchasing Spend without …»).
//   - «Supplier Evaluation By Quality» → primero «Supplier Evaluation by Quality».
//   - página «Z_PG_SOURCING» → primero «Z_PG_SOURCING_OVR».
// Antes: se añadía/abría la primera fila y el intent salía bien. Ahora, la exacta. Y si ninguna fila
// se llama así, el paso falla diciendo qué filas había, sin pulsar nada.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~1 min. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const VW = 'application-FLPPage-manage-component---view';
const TILES = [
    ['Adjust Operational Supplier Evaluation Score', ''], ['Operational Supplier Evaluation', ''],
    ['Contract Leakage', 'Purchasing Spend without Contract Reference'], ['Purchasing Spend', ''],
    ['Supplier Evaluation by Quality', ''], ['Supplier Evaluation By Quality', ''],
    ['Nope Tile Extended', ''],
];
const PAGES = ['Z_PG_SOURCING_OVR', 'Z_PG_SOURCING', 'Z_PG_RBTE_MNTN'];
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:700px;min-height:300px">
  <input id="${VW}--tileSelectorSearchField"><button id="${VW}--tileSelectorAddButton" disabled>Add</button>
  <ul id="${VW}--tiles"></ul>
  <input id="${VW}--pageSearchField"><div id="${VW}--pages"></div>
</div>
<script>
  const TILES = ${JSON.stringify(TILES)}, PAGES = ${JSON.stringify(PAGES)};
  const hit = (what) => fetch('/hit?' + encodeURIComponent(what));
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}, parent = null) { Object.assign(this, { id, type, props, parent, busy: false }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return this.parent; } getBusy() { return this.busy; } getEnabled() { return this.props.enabled !== false; }
  }
  const view = new Ctl('${VW}', 'sap.ui.core.mvc.XMLView');
  new Ctl('${VW}--tileSelectorAddButton', 'sap.m.Button', { text: 'Add', enabled: false }, view);
  let n = 0;
  const clear = (re) => { for (const id of [...reg.keys()]) if (re.test(id)) reg.delete(id); };
  // Como SAP: «contiene», en título y subtítulo, y en el orden de la lista.
  const has = (q, ...t) => t.some((x) => x.toLowerCase().includes(q.toLowerCase()));
  const searchField = (id, onSearch) => {
    const c = new Ctl(id, 'sap.m.SearchField', {}, view);
    c.setValue = (v) => { document.getElementById(id).value = v; }; c.fireEvent = () => {};
    c.fireSearch = ({ query }) => onSearch(query);
  };
  searchField('${VW}--tileSelectorSearchField', (q) => {
    clear(/tileSelector(CustomListItem|TileButtonAdd)/);
    const ul = document.getElementById('${VW}--tiles'); ul.innerHTML = '';
    for (const [title, sub] of TILES.filter(([t, s]) => has(q, t, s))) {
      const k = n++, li = '${VW}--tileSelectorCustomListItem-__clone' + k, add = '${VW}--tileSelectorTileButtonAdd-__clone' + k + '-internalSplitBtn';
      ul.insertAdjacentHTML('beforeend', '<li id="' + li + '" class="sapMLIB sapMCLI"><span><span>' + title + '</span></span>'
        + (sub ? '<span class="sapMText">' + sub + '</span>' : '') + '<button id="' + add + '"><bdi>Add</bdi></button></li>');
      const row = new Ctl(li, 'sap.m.CustomListItem', {}, view);
      new Ctl(add, 'sap.m.Button', { text: 'Add' }, row);
      document.getElementById(add).addEventListener('click', () => hit('add:' + title));
    }
  });
  searchField('${VW}--pageSearchField', (q) => {
    clear(/ColumnListItemPage/);
    const t = document.getElementById('${VW}--pages'); t.innerHTML = '';
    for (const p of PAGES.filter((p) => has(q, p))) {
      const id = '${VW}--pagesColumnListItemPage-__clone' + (n++);
      t.insertAdjacentHTML('beforeend', '<div id="' + id + '" class="sapMLIB sapMListTblRow" style="height:24px"><span class="sapMText">' + p + '</span></div>');
      new Ctl(id, 'sap.m.ColumnListItem', { type: 'DetailAndActive' }, view);
      document.getElementById(id).addEventListener('click', () => hit('open:' + p));
    }
  });
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

// Selectores como los grabó MIMO (job 7ac95023).
const addTile = (title) => [
    { technology: 'UI5', action: 'fill', value: title, wdi5_selector: { id: `${VW}--tileSelectorSearchField`, controlType: 'sap.m.SearchField' } },
    { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.Button', properties: { text: 'Add' }, id: `${VW}--tileSelectorTileButtonAdd-__clone45-internalSplitBtn` } },
];
const openPage = (p) => [
    { technology: 'UI5', action: 'fill', value: p, wdi5_selector: { id: `${VW}--pageSearchField`, controlType: 'sap.m.SearchField' } },
    { technology: 'UI5', action: 'click', wdi5_selector: { controlType: 'sap.m.ColumnListItem', properties: { type: 'DetailAndActive', title: null }, id: `${VW}--customerCreatedColumnListItemPage-__clone0` } },
];
const run = async (code, extra = {}) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_APP_TO_SECTION', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp#FLPPage-manage`, code }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true, ...extra });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== tiles: la búsqueda devuelve primero otro tile ==');
let r = await run([...addTile('Operational Supplier Evaluation'), ...addTile('Purchasing Spend'),
                   ...addTile('Supplier Evaluation By Quality'), ...addTile('Supplier Evaluation by Quality')]);
ok(r.success === true, 'el intent termina bien', r.failure?.message?.slice(0, 160));
ok(hits.join(' | ') === 'add:Operational Supplier Evaluation | add:Purchasing Spend | add:Supplier Evaluation By Quality | add:Supplier Evaluation by Quality',
   'añade exactamente los tiles buscados (antes: Adjust…, Contract Leakage, by Quality dos veces)', hits.join(' | '));

console.log('\n== páginas: «Z_PG_SOURCING» también encuentra «Z_PG_SOURCING_OVR» ==');
r = await run(openPage('Z_PG_SOURCING'));
ok(r.success === true && hits.join() === 'open:Z_PG_SOURCING', 'abre la página buscada (antes: Z_PG_SOURCING_OVR)', hits.join());

console.log('\n== ninguna fila se llama así ==');
r = await run(addTile('Nope Tile'));
ok(r.success === false && /Tras buscar «Nope Tile», ninguna fila de resultados se llama exactamente así \(filas visibles: «Nope Tile Extended»\)/.test(r.failure?.message || ''),
   'falla diciendo qué filas había', r.failure?.message?.slice(0, 200));
ok(hits.length === 0, 'y no pulsa nada', hits.join());

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
