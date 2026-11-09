// ============================================================
// B18 — runFiori de punta a punta con la vista de «Page Details» ocupada tras Edit (job 7ac95023).
//
// Registro UI5 de mentira con la jerarquía real: vista > IconTabFilter «Page Content» (su DOM es sólo
// la cabecera de la pestaña) > OverflowToolbar > botón «···». Paso 1: Edit. Paso 2: «···». Paso 3:
// «Catalogs» en el menú que abre.
//   - vista ocupada: tras Edit la vista queda ocupada 3 s (indicador local, como UI5) y repinta la
//     barra al terminar; un clic sobre la vista ocupada se pierde. Antes: B17 cortaba la subida en la
//     pestaña, no veía la vista ocupada, el clic se perdía y «Catalogs» no aparecía en 30 s.
//   - repintado: UI5 sustituye el «···» por uno nuevo, aún oculto, justo al ir a pulsarlo (1,5 s).
//     Antes: «Element is not visible». Ahora espera a que se vea y reintenta.
//   - diálogo: la vista sigue ocupada detrás de un diálogo abierto desde ella (su padre UI5 es la
//     vista, pero su DOM está fuera). El botón del diálogo no espera a la vista.
//
// Logon de mentira (como logon-e2e.test.js). Tarda ~40 s. Va en `npm run test:rpa`.
// ============================================================
import http from 'http';
import { runFiori } from '../src/rpa/fiori.js';

let fails = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? `   (${extra})` : '')); if (!cond) fails++; };

const VW = 'application-FLPPage-manage-component---view';
const OVF = `${VW}--tileSelectorToolbar-overflowButton`;
const LAUNCHPAD = `<!doctype html><html><body>
<div id="application-FLPPage-manage-component" style="width:700px;min-height:300px">
  <div id="${VW}--tabs-header"><div id="${VW}--tabContent" style="height:20px">Page Content</div></div>
  <div id="${VW}" style="position:relative;min-height:200px">
    <button id="${VW}--buttonEdit">Edit</button>
    <div id="${VW}--tabs-content"><div id="${VW}--tileSelectorToolbar" class="sapMOTB" style="height:30px"></div></div>
  </div>
</div>
<button id="${VW}--catalogs" style="display:none">Catalogs</button>
<script>
  const mode = new URLSearchParams(location.search).get('mode');
  const hit = (what) => fetch('/hit?' + what);
  const reg = new Map();
  class Ctl {
    constructor(id, type, props = {}, parent = null) { Object.assign(this, { id, type, props, parent, busy: false }); reg.set(id, this);
      for (const k of Object.keys(props)) this['get' + k[0].toUpperCase() + k.slice(1)] = () => this.props[k]; }
    getId() { return this.id; } getMetadata() { return { getName: () => this.type }; }
    getDomRef() { return document.getElementById(this.id); } getFocusDomRef() { return this.getDomRef(); }
    getParent() { return this.parent; } getBusy() { return this.busy; } getEnabled() { return true; }
  }
  const view = new Ctl('${VW}', 'sap.ui.core.mvc.XMLView');
  const tab = new Ctl('${VW}--tabContent', 'sap.m.IconTabFilter', {}, view);          // DOM = cabecera
  const bar = new Ctl('${VW}--tileSelectorToolbar', 'sap.m.OverflowToolbar', {}, tab);
  new Ctl('${VW}--buttonEdit', 'sap.m.Button', { text: 'Edit', type: 'Emphasized' }, view);
  new Ctl('${VW}--catalogs', 'sap.m.Button', { text: 'Catalogs' }, mode === 'dialog' ? view : null);
  new Ctl('${OVF}', 'sap.m.ToggleButton', { type: 'Transparent' }, bar);
  const paintOverflow = (hidden) => {
    const b = document.getElementById(bar.id);
    b.innerHTML = '<button id="${OVF}" aria-haspopup="menu" title="Additional Options" style="' + (hidden ? 'display:none' : '') + '">···</button>';
    document.getElementById('${OVF}').addEventListener('click', () => {
      if (view.busy) return hit('lost');   // la vista ocupada se traga el clic
      hit('menu'); document.getElementById('${VW}--catalogs').style.display = 'inline-block';
    });
  };
  paintOverflow(false);
  const setBusy = (on) => { view.busy = on; const d = view.getDomRef();
    d.classList.toggle('sapUiLocalBusy', on); if (on) d.setAttribute('aria-busy', 'true'); else d.removeAttribute('aria-busy'); };
  document.getElementById('${VW}--buttonEdit').addEventListener('click', () => {
    hit('edit');
    if (mode === 'busy') { setBusy(true); setTimeout(() => { paintOverflow(false); setBusy(false); }, 3000); }
    if (mode === 'dialog') { setBusy(true); document.getElementById('${VW}--catalogs').style.display = 'inline-block'; }
  });
  document.getElementById('${VW}--catalogs').addEventListener('click', () => hit('catalogs'));
  // repintado: al marcar el bot el «···» para pulsarlo, UI5 lo sustituye por uno nuevo aún oculto.
  if (mode === 'repaint') {
    let done = false;
    new MutationObserver(() => {
      const b = document.getElementById('${OVF}');
      if (done || !b || !b.hasAttribute('data-fiori-click')) return;
      done = true; paintOverflow(true);
      setTimeout(() => { document.getElementById('${OVF}').style.display = ''; }, 1500);
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-fiori-click'] });
  }
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

// Selectores como los grabó MIMO (job 7ac95023).
const STEPS = [
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { type: 'Emphasized', title: null, text: 'Edit' }, controlType: 'sap.m.Button', id: `${VW}--buttonEdit` } },
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { type: 'Transparent', text: null, title: null }, id: OVF, controlType: 'sap.m.ToggleButton' } },
    { technology: 'UI5', action: 'click', wdi5_selector: { properties: { text: 'Catalogs' }, controlType: 'sap.m.Button', id: `${VW}--catalogs` } },
];
const run = async (mode, code = STEPS) => {
    captured = ''; hits.length = 0;
    capture(true);
    try {
        return await runFiori({ blocks: [{ block_id: 'B', block_seq: 1, instructions: [{ instruction_id: 'I', instruction_seq: 1,
            instances: [{ instance_seq: 1, instance_iid: 'i1', intents: [{ intent_id: 'ADD_APP_TO_SECTION', intent_seq: 1,
                APP_LINK: `${origin}/sap/bc/ui2/flp?mode=${mode}#FLPPage-manage`, code }] }] }] }] },
            { serverOrigin: origin, sapClient: '100', username: 'U', password: 'p', headless: true });
    } finally { capture(false); if (process.env.DEBUG_LOG) orig.log(captured); }
};

console.log('== vista ocupada tras Edit, botón dentro de una pestaña (job 7ac95023) ==');
let r = await run('busy');
ok(r.success === true, 'el intent termina bien (antes: «Catalogs» no aparece en 30 s)', r.failure?.message?.slice(0, 160));
ok(hits.join() === 'edit,menu,catalogs', 'espera a la vista y el «···» abre el menú, sin clics perdidos', hits.join());

console.log('\n== el «···» se repinta oculto justo al pulsarlo ==');
r = await run('repaint');
ok(r.success === true, 'el intent termina bien (antes: «Element is not visible»)', r.failure?.message?.slice(0, 160));
ok(/se repintó durante el clic \(UI5 seguía montando la pantalla\); se espera a que esté listo y se reintenta/.test(captured), 'el log dice que se repintó y reintenta');
ok(hits.join() === 'edit,menu,catalogs', 'el reintento abre el menú', hits.join());

console.log('\n== diálogo sobre la vista ocupada ==');
const t = Date.now();
r = await run('dialog', [STEPS[0], STEPS[2]]);
ok(r.success === true && hits.join() === 'edit,catalogs', 'el botón del diálogo se pulsa', hits.join());
ok(Date.now() - t < 25000, 'sin esperar a la vista de detrás', `${((Date.now() - t) / 1000).toFixed(1)} s`);

srv.closeAllConnections();
srv.close();
console.log(fails ? `\n✗ ${fails} fallo(s)` : '\n✓ all assertions passed');
process.exit(fails ? 1 : 0);
